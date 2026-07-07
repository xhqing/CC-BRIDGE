'use strict';

// Shared process/IO helpers (zero dependencies — Node built-ins only).

const http = require('http');
const { execFileSync } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Kill anything already bound to `port` (mirrors start.sh's `lsof -ti:PORT | xargs kill`).
// Returns the pids that were signalled. Silently no-ops when the port is free.
function clearPort(port) {
  let pids = [];
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8' });
    pids = out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    // lsof exits non-zero when nothing holds the port — that's the common case.
  }
  if (!pids.length) return pids;
  console.log(`[claude-proxy] killing existing process on :${port} (pid ${pids.join(' ')})`);
  for (const p of pids) {
    try { process.kill(Number(p), 'SIGTERM'); } catch { /* already gone */ }
  }
  // Give the kernel a moment to release the socket.
  try { execFileSync('sleep', ['0.5']); } catch { /* ignore */ }
  return pids;
}

// GET /health on the local proxy. Resolves true on HTTP 200, false otherwise.
function probeHealth(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume();
      res.on('end', () => done(res.statusCode === 200));
    });
    req.on('error', () => done(false));
    req.setTimeout(1000, () => { req.destroy(); done(false); });
  });
}

// Poll /health until it answers (max ~10s). If `pid` is given and that pid dies
// before health comes up, resolve false immediately (proxy crashed on boot).
async function waitReady(port, pid) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (pid != null) {
      try { process.kill(pid, 0); } catch { return false; }
    }
    if (await probeHealth(port)) return true;
    await sleep(500);
  }
  return false;
}

module.exports = { sleep, clearPort, probeHealth, waitReady };
