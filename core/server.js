'use strict';

/**
 * CC-BRIDGE — Claude Code 上游桥接框架（公共服务器）。
 *
 * 本文件是与上游无关的公共框架：接收 Claude Code 的 /v1/messages 请求，按当前
 * adapter 做请求体适配，把 body.model 从 SPOOF_MODEL 改写为真实 TARGET_MODEL，
 * 转发到上游；响应原样回传（注入 modelUsage 让 webview 显示真实窗口）。
 *
 * 上游专属逻辑（GLM 的 thinking 归一化、reasoning_effort、请求体清洗等）由对应
 * adapter 提供（见 cc-glm-bridge/adapter.js），框架层通过 adapter.adaptRequestBody 调用。
 *
 * 多 KEY 容灾：API_KEY 支持逗号分隔多个，某 KEY 返回 401/403（失效/欠费）时熔断
 * 并切换下一个 KEY；瞬态错误先同 KEY 重试、用尽再换 KEY。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// --- 同 KEY 瞬态重试 --------------------------------------------------------
// 上游遇瞬态错误（DNS 失败 / 连接挂断 / 429 / 5xx）时，对同一 KEY 重试 N 次、
// 指数退避，吸收毫秒级短抖动。重试只发生在「响应头尚未写给客户端」之前——
// 一旦开始流式写回就不能再切。
const UPSTREAM_RETRY_DELAYS = [200, 500]; // 第 1、2 次重试前的退避时长（毫秒）

// --- KEY 熔断 ---------------------------------------------------------------
// 某个 KEY 被上游判定失效 / 欠费（401/403）后，在 KEY_BLOCK_SECONDS 秒内直接跳过它、
// 优先用其它 KEY，避免每条请求都先撞一次已知坏 KEY 制造延迟和日志噪音。熔断只针对
// 401/403（KEY 自身的问题）；瞬态错误（5xx/网络）不熔断 KEY——那是网关/链路问题，
// 换 KEY 也一样，不应连累无辜 KEY。
const KEY_BLOCK_SECONDS = 60;

// 判定是否为瞬态错误（这类才重试；4xx 业务错误中的 400/404 等不重试）。
function isTransient(err, status) {
  if (err && /ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|hang up|socket|timeout/i.test(err.message)) {
    return true;
  }
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return false;
}

// 判定是否为 KEY 级错误（该换 KEY）：401/403 表示这个 KEY 失效 / 欠费 / 无权限。
function isKeyError(status) {
  return status === 401 || status === 403;
}

// Create and start the bridge server from an already-loaded config + adapter.
function startServer(cfg, adapter) {
  const PORT = cfg.PORT;
  const KEYS = cfg.KEYS || [];
  const VERBOSE = cfg.VERBOSE;

  if (!cfg.API_BASE) {
    console.error(`[bridge] API_BASE not set for upstream '${adapter.name}'`); process.exit(1);
  }
  if (!KEYS.length) {
    console.error(`[bridge] API_KEY not set for upstream '${adapter.name}' (need at least one key)`); process.exit(1);
  }

  // 单一 pair：单上游 + 单模型。target/spoof 用 adapter 默认值兜底。
  const pair = {
    spoof: cfg.SPOOF_MODEL || adapter.defaultSpoof,
    target: cfg.TARGET_MODEL || adapter.defaultTarget,
    apiBase: cfg.API_BASE,
    contextWindow: cfg.CONTEXT_WINDOW,
    maxOutputTokens: cfg.MAX_OUTPUT_TOKENS,
  };
  const upstream = new URL(pair.apiBase);

  // 每个 KEY 的熔断到期时间戳（0 = 未熔断）。
  const keyBlockedUntil = new Array(KEYS.length).fill(0);

  // 每行日志带 ISO 时间戳，便于把日志与实时故障逐请求对齐定位。
  const log = (...a) => { if (VERBOSE) console.log(`[bridge ${new Date().toISOString()}]`, ...a); };

  // --- modelUsage 注入 ----------------------------------------------------
  // 如果配置了 contextWindow / maxOutputTokens，构建 modelUsage 对象注入 API 响应，
  // 让 CLI 传递真实的上下文窗口给 webview。同时用 spoof 和 target 两个 key 注入——
  // CLI 的 currentMainLoopModel 可能取响应里的 model（target 名），也可能取它自己
  // 记录的请求 model（spoof 名），两个 key 都放确保命中。
  function buildModelUsage() {
    if (!pair.contextWindow && !pair.maxOutputTokens) return null;
    const entry = {};
    if (pair.contextWindow) entry.contextWindow = pair.contextWindow;
    if (pair.maxOutputTokens) entry.maxOutputTokens = pair.maxOutputTokens;
    const mu = {};
    if (pair.target) mu[pair.target] = entry;
    if (pair.spoof && pair.spoof !== pair.target) mu[pair.spoof] = entry;
    return mu;
  }

  // Headers we must NOT blindly copy from the client request:
  //   host/connection/transfer-encoding  → hop-by-hop, we set our own
  //   accept-encoding                     → force identity so we can log & the body is plain
  //   content-length                      → recompute after body rewrite
  //   x-api-key                           → inject from config (overrides whatever client sent)
  const DROP_HEADERS = new Set([
    'host', 'connection', 'transfer-encoding',
    'accept-encoding', 'content-length', 'x-api-key',
  ]);

  const server = http.createServer((clientReq, clientRes) => {
    // Local health/readiness endpoint — does not hit upstream.
    if (clientReq.url === '/health' || clientReq.url === '/') {
      clientRes.writeHead(200, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        status: 'ok',
        upstream: adapter.name,
        display: adapter.displayName,
        api_base: pair.apiBase,
        spoof: pair.spoof,
        target: pair.target,
        keys: KEYS.length,
      }));
      return;
    }

    const chunks = [];
    clientReq.on('data', (c) => chunks.push(c));
    clientReq.on('end', () => {
      let body = Buffer.concat(chunks);
      let modelIn = null;
      let effort = null;
      let stream = false;
      let rewritten = false;
      let obj = null; // parsed Anthropic request body (if any)
      const urlPath = clientReq.url.split('?')[0];
      const isMessages = clientReq.method === 'POST' && urlPath.startsWith('/v1/messages') && !urlPath.startsWith('/v1/messages/count_tokens');

      // Only rewrite the model on /v1/messages POSTs with a JSON body.
      if (clientReq.method === 'POST' && urlPath.startsWith('/v1/messages') && body.length) {
        try {
          obj = JSON.parse(body.toString('utf-8'));
          modelIn = obj.model || null;
          effort = obj.output_config?.effort || obj.effort || null;
          stream = obj.stream === true;
          if (obj.model) {
            if (obj.model === pair.spoof) {
              // 已知 spoof → 改写为 target。
              obj.model = pair.target;
              rewritten = obj.model;
            } else if (obj.model === pair.target) {
              // 已是 target → 原样直传。
            } else {
              // 未知 model：不静默改写，直接 400 报错。客户端发的 model 必须显式
              // 等于配置的 SPOOF_MODEL 或 TARGET_MODEL，否则会在不知情的情况下被
              // 改写（曾经的隐患行为）。
              log(`  rejected unknown model: ${obj.model}`);
              clientRes.writeHead(400, { 'Content-Type': 'application/json' });
              clientRes.end(JSON.stringify({
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: `cc-bridge (${adapter.name}): unknown model "${obj.model}" is neither the configured SPOOF_MODEL (${pair.spoof}) nor TARGET_MODEL (${pair.target}). Edit ~/.cc-bridge/${adapter.name}.env, or switch Claude Code to the configured model.`,
                },
              }));
              return;
            }
          }
          // 在 model 改写之后调用 adapter 做上游专属请求体适配。
          adapter.adaptRequestBody(obj, { target: pair.target });
          body = Buffer.from(JSON.stringify(obj), 'utf-8');
          // 受 PROXY_DUMP=1 控制：dump 改写后的请求体（用于验证适配是否生效）
          if (process.env.PROXY_DUMP === '1' || cfg.DUMP) {
            try {
              // dump 目录跟随配置文件（默认 ~/.cc-bridge/dumps），与 log / pid 同处，
              // 不写到项目目录。用 path.dirname(cfg.configPath) 派生，兼容 $CC_BRIDGE_CONFIG 覆盖。
              const dumpDir = path.join(path.dirname(cfg.configPath), 'dumps');
              fs.mkdirSync(dumpDir, { recursive: true });
              const ts = new Date().toISOString().replace(/[:.]/g, '-');
              const safeTarget = (pair.target || 'unknown').replace(/[\/]/g, '-');
              const dumpFile = path.join(dumpDir, `${ts}-rewritten-${safeTarget}.json`);
              fs.writeFileSync(dumpFile, JSON.stringify(obj, null, 2));
              log(`  dumped rewritten request → ${dumpFile}`);
            } catch (e) {
              log(`  dump failed: ${e.message}`);
            }
          }
        } catch {
          // Not JSON / unparseable — forward the original body untouched.
        }
      }

      // Curate forwarded headers. The bridge sends x-api-key + anthropic-version per
      // attempt (the key itself rotates per attempt).
      const buildHeaders = (apiKey) => {
        const headers = {};
        for (const [k, v] of Object.entries(clientReq.headers)) {
          if (DROP_HEADERS.has(k.toLowerCase())) continue;
          headers[k] = v;
        }
        headers['host'] = upstream.host;
        headers['x-api-key'] = apiKey;
        if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
        headers['content-length'] = String(body.length);
        return headers;
      };

      const upPath = upstream.pathname.replace(/\/+$/, '') + clientReq.url;

      // 处理「已落到客户端的上游响应」：重试 / 换 KEY 窗口（建连 / 拿到首个上游
      // 响应前）已过，后续 stream / non-stream 改写都不再切换。
      function handleUpstreamResponse(upRes) {
        log(`  ← ${upRes.statusCode}  ${Date.now() - t0}ms  ct=${upRes.headers['content-type'] || '-'}  key=#${currentKey + 1}`);

        // 如果配置了 contextWindow，注入 modelUsage 到响应，让 CLI 把正确的上下文
        // 窗口传给 webview；否则直接 pipe（快速路径）。
        const mu = isMessages ? buildModelUsage() : null;
        if (!mu) {
          clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
          upRes.pipe(clientRes);
          return;
        }

        if (stream) {
          // Streaming: intercept SSE events, inject modelUsage into message_delta.
          const streamHeaders = { ...upRes.headers };
          delete streamHeaders['content-length'];  // chunked encoding, no fixed length
          streamHeaders['transfer-encoding'] = 'chunked';
          clientRes.writeHead(upRes.statusCode || 502, streamHeaders);
          let sseBuf = '';
          let pendingEvent = '';
          // TextDecoder stream 模式处理跨 chunk 的 UTF-8 多字节字符（中文 3 字节/字），
          // 避免 chunk 边界切断中文字符产生 U+FFFD 乱码（单 chunk toString 会丢字节）。
          const decoder = new TextDecoder('utf-8');
          upRes.on('data', (chunk) => {
            sseBuf += decoder.decode(chunk, { stream: true });
            let nl;
            while ((nl = sseBuf.indexOf('\n')) >= 0) {
              const line = sseBuf.slice(0, nl);
              sseBuf = sseBuf.slice(nl + 1);
              if (line.startsWith('event:')) {
                pendingEvent = line;
                clientRes.write(line + '\n');
              } else if (line.startsWith('data:') && pendingEvent.includes('message_delta')) {
                // 注入 modelUsage 到 message_delta data。同时确保 total_cost_usd 存在
                // （webview 只在 total_cost_usd 存在时才读 modelUsage；非官方上游可能省略它）。
                try {
                  const data = JSON.parse(line.slice(5).trim());
                  data.modelUsage = mu;
                  if (data.total_cost_usd === undefined) data.total_cost_usd = 0;
                  clientRes.write('data: ' + JSON.stringify(data) + '\n');
                } catch {
                  clientRes.write(line + '\n');
                }
                pendingEvent = '';
              } else {
                clientRes.write(line + '\n');
                if (line.trim() === '') pendingEvent = '';
              }
            }
          });
          upRes.on('end', () => {
            sseBuf += decoder.decode();  // flush 剩余字节（正常为空）
            if (sseBuf.trim()) clientRes.write(sseBuf);
            clientRes.end();
          });
          upRes.on('error', () => { try { clientRes.destroy(); } catch {} });
        } else {
          // Non-streaming: buffer JSON, inject modelUsage, send.
          const respChunks = [];
          upRes.on('data', (c) => respChunks.push(c));
          upRes.on('end', () => {
            const raw = Buffer.concat(respChunks).toString('utf-8');
            try {
              const respBody = JSON.parse(raw);
              respBody.modelUsage = mu;
              if (respBody.total_cost_usd === undefined) respBody.total_cost_usd = 0;
              const modified = JSON.stringify(respBody);
              const hdrs = { ...upRes.headers, 'content-length': String(Buffer.byteLength(modified)) };
              delete hdrs['transfer-encoding'];
              clientRes.writeHead(upRes.statusCode || 200, hdrs);
              clientRes.end(modified);
            } catch {
              // Parse failed — forward original.
              clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
              clientRes.end(raw);
            }
          });
        }
      }

      // --- 多 KEY failover -------------------------------------------------
      // tried 记录本轮请求已经试过的 KEY 索引，避免对同一 KEY 反复试导致死循环。
      // currentKey 是当前要用的 KEY 索引；attemptInKey 是当前 KEY 的第几次重试。
      const tried = new Set();
      let currentKey = -1;
      let attemptInKey = 0;
      let t0 = Date.now(); // 当前 attempt 的起始时间；每次重试 / 换 KEY 会重置

      // 从 startIdx 起找下一个可用的 KEY：优先「未试过且未熔断」；若未试过的都
      // 熔断了，退而取「未试过」的第一个（熔断只是优化、不是硬约束，总得试一个）；
      // 全试过了返回 -1。
      function pickNextKey() {
        for (let i = 0; i < KEYS.length; i++) {
          if (!tried.has(i) && Date.now() >= keyBlockedUntil[i]) return i;
        }
        for (let i = 0; i < KEYS.length; i++) {
          if (!tried.has(i)) return i;
        }
        return -1;
      }

      // 所有 KEY 都试遍仍失败：把最后的错误返回给客户端。
      function finalError(last) {
        if (clientRes.headersSent) { try { clientRes.destroy(); } catch {} return; }
        const status = last && last.status ? last.status : 502;
        let msg;
        if (last && last.err) {
          msg = `upstream error on all ${KEYS.length} key(s): ${last.err.message}`;
        } else if (last && last.status) {
          msg = `upstream returned ${last.status} on all ${KEYS.length} key(s)`;
        } else {
          msg = 'upstream error';
        }
        clientRes.writeHead(status, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({
          type: 'error',
          error: {
            type: (status === 401 || status === 403) ? 'authentication_error' : 'api_error',
            message: msg,
          },
        }));
      }

      let activeUpReq = null;
      clientReq.on('error', () => { if (activeUpReq) { try { activeUpReq.destroy(); } catch {} } });

      function send(keyIdx) {
        t0 = Date.now();
        const opts = {
          hostname: upstream.hostname,
          port: upstream.port || 443,
          path: upPath,
          method: clientReq.method,
          headers: buildHeaders(KEYS[keyIdx]),
        };
        log(
          `${clientReq.method} ${clientReq.url}  ` +
          `model=${modelIn || '-'}${rewritten ? ' → ' + rewritten : ' (passthrough)'}  ` +
          `effort=${effort || '-'}  stream=${stream}  key=#${keyIdx + 1}/${KEYS.length}`,
        );
        activeUpReq = https.request(opts, (upRes) => {
          const status = upRes.statusCode || 502;
          const canRetry = attemptInKey < UPSTREAM_RETRY_DELAYS.length;

          // KEY 级错误：熔断此 KEY，立即换下一个 KEY（不退避，这 KEY 死了等也没用）。
          if (isKeyError(status)) {
            keyBlockedUntil[keyIdx] = Date.now() + KEY_BLOCK_SECONDS * 1000;
            log(`  ← ${status}  key=#${keyIdx + 1} 认定失效 / 欠费，熔断 ${KEY_BLOCK_SECONDS}s 并切换`);
            upRes.resume();
            tried.add(keyIdx);
            attemptInKey = 0;
            currentKey = pickNextKey();
            if (currentKey === -1) return finalError({ status });
            send(currentKey);
            return;
          }

          // 瞬态错误 + 还能重试：同 KEY 退避重试。
          if (isTransient(null, status) && canRetry) {
            const delay = UPSTREAM_RETRY_DELAYS[attemptInKey];
            log(`  ← ${status} 瞬态响应（${Date.now() - t0}ms），${delay}ms 后同 KEY 重试`);
            upRes.resume();
            attemptInKey++;
            setTimeout(() => send(keyIdx), delay);
            return;
          }

          // 瞬态错误但同 KEY 重试用尽：换下一个 KEY 再来一轮。
          if (isTransient(null, status)) {
            log(`  ← ${status} 同 KEY 重试用尽，切换下一个 KEY`);
            upRes.resume();
            tried.add(keyIdx);
            attemptInKey = 0;
            currentKey = pickNextKey();
            if (currentKey === -1) return finalError({ status });
            send(currentKey);
            return;
          }

          // 成功，或非瞬态业务错误（400/404 等，换 KEY 也无用）：正常处理。
          handleUpstreamResponse(upRes);
        });

        activeUpReq.on('error', (err) => {
          const canRetry = attemptInKey < UPSTREAM_RETRY_DELAYS.length;
          if (isTransient(err) && canRetry) {
            const delay = UPSTREAM_RETRY_DELAYS[attemptInKey];
            log(`  upstream 瞬态错误：${err.message}（${Date.now() - t0}ms），${delay}ms 后同 KEY 重试`);
            attemptInKey++;
            setTimeout(() => send(keyIdx), delay);
            return;
          }
          // 同 KEY 用尽或非瞬态网络错误：换下一个 KEY 兜底。
          log(`  upstream 错误：${err.message}（${Date.now() - t0}ms），切换下一个 KEY`);
          tried.add(keyIdx);
          attemptInKey = 0;
          currentKey = pickNextKey();
          if (currentKey === -1) return finalError({ err });
          send(currentKey);
        });

        if (body.length) activeUpReq.write(body);
        activeUpReq.end();
      }

      // 开门第一发：从首个可用 KEY 起步。
      currentKey = pickNextKey();
      if (currentKey === -1) {
        finalError({});
        return;
      }
      send(currentKey);
    });

    clientReq.on('error', () => {
      if (!clientRes.headersSent) clientRes.destroy();
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[bridge] port ${PORT} already in use. Run 'cc-bridge stop' or change PROXY_PORT.`);
    } else {
      console.error('[bridge] server error:', err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[bridge] listening on http://127.0.0.1:${PORT}`);
    console.log(`[bridge] upstream     : ${adapter.displayName}`);
    console.log(`[bridge] api base     : ${pair.apiBase}`);
    console.log(`[bridge] spoof → target : ${pair.spoof} → ${pair.target}`);
    console.log(`[bridge] API keys     : ${KEYS.length}`);
    console.log(`[bridge] force max    : ${adapter.forceMaxEffort ? 'on' : 'off'}`);
    console.log(`[bridge] logging      : ${VERBOSE ? 'on' : 'off'}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { console.log(`\n[bridge] ${sig} received, shutting down`); process.exit(0); });
  }

  return server;
}

// Allow `node core/server.js` (used by daemon/claude spawn). Upstream comes from
// $CC_BRIDGE_UPSTREAM (default glm). Loads config from $CC_BRIDGE_CONFIG or the
// per-upstream default, validates, then starts.
if (require.main === module) {
  const { DEFAULT_UPSTREAM, loadAdapter } = require('./adapter');
  const { loadConfig, validate } = require('./config');
  const upstream = process.env.CC_BRIDGE_UPSTREAM || DEFAULT_UPSTREAM;
  let adapter;
  try {
    adapter = loadAdapter(upstream);
  } catch (e) {
    console.error(`[bridge] ${e.message}`);
    process.exit(1);
  }
  const cfg = loadConfig({ upstream });
  const missing = validate(cfg);
  if (missing.length) {
    console.error(`[bridge] missing required config: ${missing.join(', ')}`);
    console.error(`[bridge] run 'cc-bridge ${upstream} config' to edit ${cfg.configPath}`);
    process.exit(1);
  }
  startServer(cfg, adapter);
}

module.exports = { startServer };
