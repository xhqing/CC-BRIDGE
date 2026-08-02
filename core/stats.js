'use strict';

// 按模型 token 统计展示：读 server 落盘的 stats-<upstream>.json，排版输出
// 请求数 / 输入 / 输出 / 缓存命中 / 命中率（按 target 模型分行 + 合计行）。
// 只读不改：server 侧（core/server.js）负责累计与写盘，本模块不依赖 daemon
// 是否在运行——daemon 停掉后仍能展示最近一次落盘的快照。

const fs = require('fs');
const { statsPathFor } = require('./config');

// 读取 stats 快照。文件不存在 / 解析失败返回 null（首次使用或尚未落盘）。
function loadStats(upstream, configPath) {
  const file = statsPathFor(upstream, configPath);
  try {
    const stats = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { file, stats };
  } catch {
    return { file, stats: null };
  }
}

// ISO 时间戳 → 本地时间字符串（YYYY-MM-DD HH:MM:SS），解析失败返回 '-'。
function fmtTime(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const fmt = (n) => (n || 0).toLocaleString('en-US');

// 命中率 = 缓存命中 token / 总输入（总输入已含命中，口径与 server 累计一致）。
function hitPct(inputTokens, cacheHitTokens) {
  return inputTokens > 0 ? (cacheHitTokens / inputTokens * 100).toFixed(1) + '%' : '-';
}

// `cc-bridge stats <upstream>` 主入口：读快照并输出按模型分列的统计表。
function showStats(cfg) {
  const { file, stats } = loadStats(cfg.upstream, cfg.configPath);
  if (!stats) {
    console.log(`[bridge] no stats for upstream '${cfg.upstream}' yet (no file at ${file})`);
    console.log('[bridge] start the daemon and make a few requests, then re-run.');
    return;
  }

  const models = Object.entries(stats.models || {})
    .filter(([, s]) => s && s.requests > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (!models.length) {
    console.log(`[bridge] no requests recorded for upstream '${cfg.upstream}' (file at ${file})`);
    return;
  }

  console.log(`[bridge] ${cfg.upstream} — per-model token stats`);
  console.log(`[bridge] window    : ${fmtTime(stats.startedAt)} → ${fmtTime(stats.updatedAt)}`);
  console.log(`[bridge] file      : ${file}`);
  console.log('');

  // 按模型分行 + 合计行；列宽随模型名动态对齐。
  const rows = models.map(([model, s]) => ({ model, s }));
  const total = rows.reduce((t, { s }) => {
    t.requests += s.requests; t.inputTokens += s.inputTokens;
    t.outputTokens += s.outputTokens; t.cacheHitTokens += s.cacheHitTokens;
    t.cacheCreatedTokens += s.cacheCreatedTokens;
    return t;
  }, { requests: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheCreatedTokens: 0 });

  const w = Math.max('model'.length, ...rows.map((r) => r.model.length));
  const pad = (s) => String(s).padEnd(w);
  const num = (s, w2) => String(s).padStart(w2);
  const W = { req: 7, tok: 12, pct: 7 };

  console.log(`  ${pad('model')}  ${num('reqs', W.req)}  ${num('input', W.tok)}  ${num('cache-hit', W.tok)}  ${num('hit%', W.pct)}  ${num('output', W.tok)}`);
  for (const { model, s } of rows) {
    console.log(`  ${pad(model)}  ${num(fmt(s.requests), W.req)}  ${num(fmt(s.inputTokens), W.tok)}  ${num(fmt(s.cacheHitTokens), W.tok)}  ${num(hitPct(s.inputTokens, s.cacheHitTokens), W.pct)}  ${num(fmt(s.outputTokens), W.tok)}`);
  }
  console.log(`  ${pad('total')}  ${num(fmt(total.requests), W.req)}  ${num(fmt(total.inputTokens), W.tok)}  ${num(fmt(total.cacheHitTokens), W.tok)}  ${num(hitPct(total.inputTokens, total.cacheHitTokens), W.pct)}  ${num(fmt(total.outputTokens), W.tok)}`);
  console.log('');
  console.log('[bridge] input = 输入 token 合计（已含缓存命中）；hit% = cache-hit / input；');
  console.log('[bridge] 命中率只计 server 侧能解析 usage 的请求（上游未返回 usage 的请求仅计入 reqs）。');
}

module.exports = { loadStats, showStats };
