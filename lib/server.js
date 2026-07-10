'use strict';

/**
 * Claude Code effort-unlock proxy (transparent pass-through).
 *
 * Problem it solves:
 *   Claude Code gates the `max`/`xhigh` effort tiers behind a client-side
 *   check: the active model ID must be on a Claude whitelist, OR the provider
 *   must be first-party/Bedrock/Foundry. A third-party gateway (e.g. Aliyun
 *   MaaS serving glm-5.2) fails both, so `/effort max` silently falls back to
 *   `high`.
 *
 * How it works:
 *   1. Claude Code is pointed at this local proxy with a spoofed model ID
 *      (`SPOOF_MODEL`, e.g. claude-opus-4-8) → whitelist passes → max offered.
 *   2. This proxy rewrites `body.model` to the real `TARGET_MODEL` (e.g. glm-5.2)
 *      and forwards the request — including `output_config.effort` — to the
 *      real upstream (which already speaks the native Anthropic API).
 *   3. The upstream response (streaming SSE or JSON) is piped back unchanged.
 *
 * Unlike a format-translating proxy, this one does NOT touch message shape,
 * tool-call format, or SSE events — it only rewrites the model field and
 * passes everything else through verbatim.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bridge = require('./openai-bridge');

// --- 同 pair 瞬态重试（方案 2）-------------------------------------------------
// 上游遇瞬态错误（DNS 失败 / 连接挂断 / 429 / 5xx）时，对同一 pair 重试 N 次、指数退避，
// 吸收毫秒级短抖动。重试只发生在「响应头尚未写给客户端」之前——一旦开始流式写回就不能再切。
// 跨 pair fallback（方案 1）未实现：这里只做同 pair 重试。
const UPSTREAM_RETRY_DELAYS = [200, 500]; // 第 1、2 次重试前的退避时长（毫秒）

// 判定是否为瞬态错误（这类才重试；4xx 业务错误不重试，按原逻辑直接返回客户端）。
function isTransient(err, status) {
  if (err && /ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|hang up|socket|timeout/i.test(err.message)) {
    return true;
  }
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return false;
}

// Create and start the proxy server from an already-loaded config object.
function startServer(cfg) {
  const PORT = cfg.PORT;
  const MODEL_PAIRS = cfg.MODEL_PAIRS || [];
  const VERBOSE = cfg.VERBOSE;

  if (!MODEL_PAIRS.length || !MODEL_PAIRS[0].apiBase) {
    console.error('[proxy] API_BASE not set (pair #1)'); process.exit(1);
  }
  if (!MODEL_PAIRS[0].apiKey) {
    console.error('[proxy] API_KEY not set (pair #1)'); process.exit(1);
  }

  const DEFAULT_PAIR = MODEL_PAIRS[0];
  const DEFAULT_TARGET = DEFAULT_PAIR.target; // pair #1 target (surfaced in /health; no longer an unknown-model fallback)

  // Build routing tables. Each pair carries its own upstream + key.
  //   spoofToPair : client-visible spoof ID → pair (rewrite + use its upstream)
  //   targetToPair: real target ID → pair (pass-through, but use its upstream)
  //   upstreamCache: apiBase string → parsed URL (avoid re-parsing per request)
  const spoofToPair = new Map();
  const targetToPair = new Map();
  const upstreamCache = new Map();
  for (const p of MODEL_PAIRS) {
    if (p.spoof && p.target) {
      spoofToPair.set(p.spoof, p);
      targetToPair.set(p.target, p);
    }
    if (p.apiBase && !upstreamCache.has(p.apiBase)) {
      upstreamCache.set(p.apiBase, new URL(p.apiBase));
    }
  }

  // 方案 3：每行日志带 ISO 时间戳，便于把 proxy.log 与实时故障逐请求对齐定位。
  const log = (...a) => { if (VERBOSE) console.log(`[proxy ${new Date().toISOString()}]`, ...a); };

  // --- 模型能力表 ---------------------------------------------------------
  // GLM 系列模型的最大输出 token 上限（来自 z.ai 文档）。
  // 用于 #8：把 Claude Code 设的 max_tokens 钳到 target model 的合法范围。
  const MODEL_MAX_TOKENS = {
    'glm-5.2': 131072,
    'glm-5.1': 131072,
    'glm-5-turbo': 131072,
    'glm-5v-turbo': 131072,
    'glm-5': 131072,
    'glm-4.7': 131072,
    'glm-4.6': 131072,
    'glm-4.5': 98304,
    'glm-4.5-air': 98304,
    'glm-4.5-x': 98304,
    'glm-4.5-airx': 98304,
    'glm-4.5-flash': 98304,
  };

  // --- modelUsage 注入 ----------------------------------------------------
  // 如果 pair 配置了 contextWindow / maxOutputTokens，构建 modelUsage 对象
  // 用于注入 API 响应，让 CLI 传递正确的上下文窗口给 webview。
  // 同时用 spoof 和 target 两个 key 注入，因为不确定 CLI 的 currentMainLoopModel
  // 取的是响应里的 model（target 名）还是它自己记录的请求 model（spoof 名）——
  // 两个 key 都放，无论它按哪个查都能命中。
  function buildModelUsage(pair) {
    if (!pair.contextWindow && !pair.maxOutputTokens) return null;
    const entry = {};
    if (pair.contextWindow) entry.contextWindow = pair.contextWindow;
    if (pair.maxOutputTokens) entry.maxOutputTokens = pair.maxOutputTokens;
    const mu = {};
    if (pair.target) mu[pair.target] = entry;
    if (pair.spoof && pair.spoof !== pair.target) mu[pair.spoof] = entry;
    return mu;
  }

  // --- effort 映射 --------------------------------------------------------
  // Claude Code 的 output_config.effort 等级 → GLM-5.2 的 reasoning_effort。
  // 依据 z.ai Coding Plan 接入文档的映射表。
  // 用于 #1（OpenAI pair）和 #3（Anthropic pair 显式加字段）。
  function mapEffortToGLM(effort) {
    if (!effort) return null;
    const e = String(effort).toLowerCase();
    // z.ai 官方映射：max/xhigh→max, high/medium/low→high, minimal/none→不思考
    if (e === 'max' || e === 'xhigh') return 'max';
    if (e === 'high' || e === 'medium' || e === 'low') return 'high';
    if (e === 'minimal' || e === 'none') return 'none';
    return null; // 未知值不写
  }

  // SiliconFlow GLM-5.2 的 thinking_budget 最大值。
  // SiliconFlow API 文档：thinking_budget 控制思考 token 上限，最大 32768。
  const SF_THINKING_BUDGET_MAX = 32768;

  // --- 请求体改写 ---------------------------------------------------------
  // 对 Claude Code 发出的 Anthropic 请求体做一系列清洗/适配，让 GLM 上游更稳。
  // 改写项：
  //   #2 thinking.type: adaptive → enabled （z.ai 只认 enabled/disabled）
  //   #3 显式加 reasoning_effort 字段（双保险，防 output_config 失效）
  //   #4 剥离 context_management （Claude Code 专有，z.ai 不识别）
  //   #5 清洗 metadata.user_id （设备指纹/session_id 发给 z.ai 无意义且泄露隐私）
  //   #6 剥离 cache_control:{type:ephemeral} （z.ai 响应里 cache_read_input_tokens=0，无效）
  //   #8 钳 max_tokens 到 target model 的合法范围
  //   #9 剥离 Anthropic 专有 system 段（billing header / Agent SDK 声明等）
  //   #10 给 tools 数组尾部打 cache_control 标记（触发 z.ai context caching）
  //   per-pair: siliconflow 强制 thinking_budget 最大值
  //   per-pair: mimo 强制 reasoning_effort=high
  function rewriteBody(obj, pair) {
    if (!obj || typeof obj !== 'object') return obj;

    const targetModel = pair.target;
    const isSiliconFlow = /siliconflow/i.test(pair.apiBase || '');
    const isMimo = /mimo/i.test(pair.apiBase || '');

    // #2 thinking.type: adaptive → enabled
    if (obj.thinking && obj.thinking.type === 'adaptive') {
      obj.thinking.type = 'enabled';
    }

    // #3 + #1 reasoning_effort 映射
    if (isMimo) {
      // mimo 不认 GLM 的 max/none 值，强制 reasoning_effort=high
      obj.reasoning_effort = 'high';
    } else {
      // z.ai / siliconflow: 按 effort 等级映射
      const effort = obj.output_config?.effort || obj.effort;
      const glmEffort = mapEffortToGLM(effort);
      if (glmEffort) {
        obj.reasoning_effort = glmEffort;
      }
    }

    // siliconflow: 强制 thinking_budget 最大值
    if (isSiliconFlow) {
      // 确保 thinking 已启用
      if (!obj.thinking || obj.thinking.type !== 'enabled') {
        obj.thinking = { type: 'enabled' };
      }
      obj.thinking.budget_tokens = SF_THINKING_BUDGET_MAX;
    }

    // #4 剥离 context_management
    if (obj.context_management) {
      delete obj.context_management;
    }

    // #5 清洗 metadata.user_id
    if (obj.metadata) {
      if ('user_id' in obj.metadata) {
        obj.metadata.user_id = '';
      }
    }

    // #6 剥离 cache_control（递归 messages / system / tools）
    stripCacheControl(obj);

    // #8 钳 max_tokens
    if (obj.max_tokens != null) {
      const cap = MODEL_MAX_TOKENS[targetModel];
      if (cap != null) {
        // 不主动放大，只在用户值超上限时钳住
        if (obj.max_tokens > cap) obj.max_tokens = cap;
      }
    }

    // #9 剥离 Anthropic 专有 system 段
    if (Array.isArray(obj.system)) {
      obj.system = obj.system.filter((block) => {
        if (!block || typeof block !== 'object') return true;
        const t = block.text || '';
        // 剥离 billing header 和 Agent SDK 声明（Anthropic 专有，z.ai 无意义）
        if (t.startsWith('x-anthropic-billing-header:')) return false;
        if (t.startsWith('You are a Claude agent, built on Anthropic')) return false;
        return true;
      });
      // 过滤后若为空，整个字段删掉
      if (obj.system.length === 0) delete obj.system;
    }

    // #10 给 tools 数组尾部打 cache_control（触发 z.ai context caching）
    // 仅对 Anthropic 格式 pair（z.ai / siliconflow）生效
    if (pair.format === 'anthropic' && Array.isArray(obj.tools) && obj.tools.length > 0) {
      const last = obj.tools[obj.tools.length - 1];
      if (last && typeof last === 'object') {
        last.cache_control = { type: 'ephemeral' };
      }
    }

    return obj;
  }

  // 递归剥离所有 cache_control 字段（#6）。
  // z.ai 不认 Anthropic 的 cache_control 标记，留着只是请求体膨胀。
  function stripCacheControl(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) stripCacheControl(item);
      return;
    }
    delete node.cache_control;
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') stripCacheControl(v);
    }
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
        model_pairs: MODEL_PAIRS.map((p) => ({
          spoof: p.spoof,
          target: p.target,
          upstream: p.apiBase,
        })),
        default_target: DEFAULT_TARGET,
        default_upstream: DEFAULT_PAIR.apiBase,
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
      let pair = DEFAULT_PAIR; // which upstream+key to use (default = pair #1)
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
            if (spoofToPair.has(obj.model)) {
              // Known spoof → rewrite to its paired target, use that pair's upstream.
              pair = spoofToPair.get(obj.model);
              obj.model = pair.target;
              rewritten = obj.model;
            } else if (targetToPair.has(obj.model)) {
              // Already a known target → pass model through, use that pair's upstream.
              pair = targetToPair.get(obj.model);
            } else {
              // 未知 model 名：不静默兜底到 default target，直接 400 报错。
              // 客户端发的 model 必须显式匹配某个已配置的 SPOOF_MODEL / TARGET_MODEL，
              // 否则会在不知情的情况下被改写到别的模型（曾经的隐患行为）。
              log(`  rejected unknown model: ${obj.model}`);
              clientRes.writeHead(400, { 'Content-Type': 'application/json' });
              clientRes.end(JSON.stringify({
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: `claude-proxy: unknown model "${obj.model}" is not any configured SPOOF_MODEL / TARGET_MODEL. Add a pair in ~/.claude-proxy/.env, or switch Claude Code to a configured model.`,
                },
              }));
              return;
            }
          }
          // 在 model 改写之后调用 rewriteBody：所有 body 适配都在这里集中完成。
          rewriteBody(obj, pair);
          // 受 PROXY_DUMP=1 控制：dump 改写后的请求体（用于验证改写是否生效）
          if (process.env.PROXY_DUMP === '1' || cfg.DUMP) {
            try {
              // dump 目录跟随配置文件（默认 ~/.claude-proxy/dumps），与 proxy.log / pid 同处，
              // 不再写到项目目录。用 path.dirname(cfg.configPath) 派生，兼容 $CLAUDE_PROXY_CONFIG 覆盖。
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

      const upstream = upstreamCache.get(pair.apiBase);
      const apiKey = pair.apiKey;
      const isOAI = pair.format === 'openai' && isMessages;

      // count_tokens has no OpenAI equivalent — return a rough estimate so
      // Claude Code's context display keeps working without hitting upstream.
      if (pair.format === 'openai' && urlPath === '/v1/messages/count_tokens') {
        const est = Math.max(1, Math.ceil(body.length / 4));
        clientRes.writeHead(200, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ input_tokens: est }));
        return;
      }

      // Build the outbound body + upstream path.
      let upPath;
      if (isOAI && obj) {
        // Convert Anthropic body → OpenAI body. obj.model is already the target.
        const oaiBody = bridge.buildOpenAIRequest(obj);
        body = Buffer.from(JSON.stringify(oaiBody), 'utf-8');
        const upBasePath = upstream.pathname.replace(/\/+$/, '');
        upPath = upBasePath + '/v1/chat/completions';
      } else {
        // Anthropic-native (or non-messages): use rewritten body as-is, passthrough path.
        if (obj) body = Buffer.from(JSON.stringify(obj), 'utf-8');
        const upBasePath = upstream.pathname.replace(/\/+$/, '');
        upPath = upBasePath + clientReq.url;
      }

      // Curate forwarded headers.
      const headers = {};
      for (const [k, v] of Object.entries(clientReq.headers)) {
        if (DROP_HEADERS.has(k.toLowerCase())) continue;
        headers[k] = v;
      }
      headers['host'] = upstream.host;
      if (isOAI) {
        headers['authorization'] = `Bearer ${apiKey}`;
        // x-api-key omitted; anthropic-version harmless but unnecessary — drop it.
        delete headers['anthropic-version'];
      } else {
        headers['x-api-key'] = apiKey;
        if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
      }
      headers['content-length'] = String(body.length);

      const opts = {
        hostname: upstream.hostname,
        port: upstream.port || 443,
        path: upPath,
        method: clientReq.method,
        headers,
      };

      let t0 = Date.now(); // 当前 attempt 的起始时间；每次重试会重置，用于显示本次上游耗时
      log(
        `${clientReq.method} ${clientReq.url}  ` +
        `model=${modelIn || '-'}${rewritten ? ' → ' + rewritten : ' (passthrough)'}  ` +
        `effort=${effort || '-'}  stream=${stream}  ` +
        `fmt=${pair.format}  upstream=${pair.apiBase}`,
      );

      // 处理「已落到客户端的上游响应」：重试窗口（建连 / 拿到首个上游响应前）已过，
      // 后续 stream / non-stream / bridge 改写都不再切换。抽成函数以便重试逻辑复用。
      function handleUpstreamResponse(upRes) {
        log(`  ← ${upRes.statusCode}  ${Date.now() - t0}ms  ct=${upRes.headers['content-type'] || '-'}`);

        // OpenAI bridge path: convert the response back to Anthropic shape.
        if (isOAI) {
          const status = upRes.statusCode || 502;
          if (status !== 200) {
            // Buffer the error body, convert to Anthropic error.
            const errChunks = [];
            upRes.on('data', (c) => errChunks.push(c));
            upRes.on('end', () => {
              const errBody = Buffer.concat(errChunks).toString('utf-8');
              clientRes.writeHead(status, { 'Content-Type': 'application/json' });
              clientRes.end(JSON.stringify(bridge.convertOpenAIErrorToAnthropic(errBody, status)));
            });
            return;
          }
          if (stream) {
            clientRes.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            // OpenAI bridge: modelUsage key = spoof 名（bridge 用 clientModel 覆盖响应 model）
            const bridgeMu = buildModelUsage(pair);
            const conv = bridge.createStreamConverter(clientRes, modelIn || pair.spoof, bridgeMu);
            upRes.on('data', (c) => conv.feed(c));
            upRes.on('end', () => conv.end());
            upRes.on('error', () => { try { clientRes.destroy(); } catch {} });
            return;
          }
          // Non-streaming: buffer, convert, send.
          const respChunks = [];
          upRes.on('data', (c) => respChunks.push(c));
          upRes.on('end', () => {
            const raw = Buffer.concat(respChunks).toString('utf-8');
            try {
              const oai = JSON.parse(raw);
              const anthropicResp = bridge.convertOpenAIResponseToAnthropic(oai, modelIn || pair.spoof);
              // Inject modelUsage if configured.
              // Also ensure total_cost_usd so webview reads modelUsage.
              const bridgeMu = buildModelUsage(pair);
              if (bridgeMu) {
                anthropicResp.modelUsage = bridgeMu;
                if (anthropicResp.total_cost_usd === undefined) anthropicResp.total_cost_usd = 0;
              }
              clientRes.writeHead(200, { 'Content-Type': 'application/json' });
              clientRes.end(JSON.stringify(anthropicResp));
            } catch (e) {
              clientRes.writeHead(502, { 'Content-Type': 'application/json' });
              clientRes.end(JSON.stringify({
                type: 'error',
                error: { type: 'api_error', message: 'failed to parse upstream response: ' + e.message },
              }));
            }
          });
          return;
        }

        // Anthropic-native path: pipe upstream response straight back.
        // If pair has contextWindow configured and this is a /v1/messages response,
        // inject modelUsage into the response so the CLI passes correct context
        // window to the webview.
        const mu = isMessages ? buildModelUsage(pair) : null;
        if (!mu) {
          // No injection needed — fast path, direct pipe.
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
                // Try to inject modelUsage into message_delta data.
                // Also ensure total_cost_usd exists (webview only reads modelUsage
                // when total_cost_usd is present; non-Anthropic upstreams may omit it).
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
              const body = JSON.parse(raw);
              body.modelUsage = mu;
              if (body.total_cost_usd === undefined) body.total_cost_usd = 0;
              const modified = JSON.stringify(body);
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

      // 方案 2：同 pair 自动重试。瞬态错误（DNS 失败 / 连接挂断 / 429 / 5xx）时，
      // 在「响应头尚未写给客户端」之前重试同一 pair，指数退避（见 UPSTREAM_RETRY_DELAYS）。
      // 非瞬态错误（4xx 业务错误）或重试用尽，按原逻辑直接返回客户端。
      let activeUpReq = null;
      clientReq.on('error', () => { if (activeUpReq) { try { activeUpReq.destroy(); } catch {} } });

      function attempt(attemptNum) {
        t0 = Date.now();
        const canRetry = attemptNum < UPSTREAM_RETRY_DELAYS.length;
        activeUpReq = https.request(opts, (upRes) => {
          const status = upRes.statusCode || 502;
          // 瞬态响应码且还能重试：抽干响应体后退避重试（此时还没向客户端写头，安全）。
          if (isTransient(null, status) && canRetry) {
            upRes.resume();
            const delay = UPSTREAM_RETRY_DELAYS[attemptNum];
            log(`  ← ${status} 瞬态响应（${Date.now() - t0}ms），${delay}ms 后同 pair 重试`);
            setTimeout(() => attempt(attemptNum + 1), delay);
            return;
          }
          handleUpstreamResponse(upRes);
        });

        activeUpReq.on('error', (err) => {
          if (isTransient(err) && canRetry) {
            const delay = UPSTREAM_RETRY_DELAYS[attemptNum];
            log(`  upstream 瞬态错误：${err.message}（${Date.now() - t0}ms），${delay}ms 后同 pair 重试`);
            setTimeout(() => attempt(attemptNum + 1), delay);
            return;
          }
          log('  upstream error:', err.message);
          if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'application/json' });
            clientRes.end(JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: 'upstream: ' + err.message },
            }));
          } else {
            clientRes.destroy();
          }
        });

        if (body.length) activeUpReq.write(body);
        activeUpReq.end();
      }

      attempt(0);
    });

    clientReq.on('error', () => {
      if (!clientRes.headersSent) clientRes.destroy();
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[proxy] port ${PORT} already in use. Run 'claude-proxy stop' or change PROXY_PORT.`);
    } else {
      console.error('[proxy] server error:', err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[proxy] listening on http://127.0.0.1:${PORT}`);
    console.log(`[proxy] model pairs   : ${MODEL_PAIRS.length}`);
    for (const p of MODEL_PAIRS) {
      const tag = p.n === 1 ? 'default' : `#${p.n}`;
      console.log(`[proxy]   ${tag.padEnd(8)} ${p.spoof} → ${p.target}  @ ${p.apiBase}`);
    }
    console.log(`[proxy] logging       : ${VERBOSE ? 'on' : 'off'}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { console.log(`\n[proxy] ${sig} received, shutting down`); process.exit(0); });
  }

  return server;
}

// Allow `node lib/server.js` (used by daemon/claude spawn) — loads config from
// the default location or $CLAUDE_PROXY_CONFIG, validates, then starts.
if (require.main === module) {
  const { loadConfig, validate } = require('./config');
  const cfg = loadConfig();
  const missing = validate(cfg);
  if (missing.length) {
    console.error(`[proxy] missing required config: ${missing.join(', ')}`);
    console.error(`[proxy] run 'claude-proxy config' to edit ${cfg.configPath}`);
    process.exit(1);
  }
  startServer(cfg);
}

module.exports = { startServer };
