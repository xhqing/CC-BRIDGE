'use strict';

// Background (detached) process management: start/stop/status/logs.
// pid + log files live under ~/.claude-proxy/.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { pidPath, logPath, ensureDir } = require('./config');
const { waitReady, probeHealth, clearPort, sleep } = require('./util');

const SERVER_JS = path.resolve(__dirname, 'server.js');

function printBanner(cfg) {
  console.log(`[claude-proxy] proxy ready  (port ${cfg.PORT})`);
  console.log(`[claude-proxy] upstream   : ${cfg.API_BASE}`);
  console.log(`[claude-proxy] spoof→real : ${cfg.SPOOF_MODEL} → ${cfg.TARGET_MODEL}`);
}

function tailLog() {
  const lp = logPath();
  if (!fs.existsSync(lp)) {
    console.log(`[claude-proxy] no log file at ${lp}`);
    return;
  }
  // `tail -f` for live follow; Ctrl-C exits.
  const child = spawn('tail', ['-n', '50', '-f', lp], { stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { child.kill(sig); process.exit(0); });
  }
}

// Spawn `node lib/server.js` detached, writing stdout/stderr to proxy.log.
// Records the child pid, waits for /health, prints the banner, then exits
// (the detached child keeps running).
function startDaemon(cfg) {
  ensureDir();
  clearPort(cfg.PORT);

  const logFd = fs.openSync(logPath(), 'a');
  const child = spawn(process.execPath, [SERVER_JS], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, CLAUDE_PROXY_CONFIG: cfg.configPath },
  });
  fs.writeFileSync(pidPath(), String(child.pid));
  child.unref();

  waitReady(cfg.PORT, child.pid).then((ok) => {
    if (!ok) {
      console.error('[claude-proxy] proxy did not become ready within 10s.');
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
      try { fs.unlinkSync(pidPath()); } catch { /* gone */ }
      try {
        const tail = fs.readFileSync(logPath(), 'utf-8').split('\n').slice(-20).join('\n');
        if (tail.trim()) console.error(tail);
      } catch { /* no log */ }
      process.exit(1);
    }
    printBanner(cfg);
    console.log('');
    console.log('[claude-proxy] daemon mode. Proxy runs in the background.');
    console.log(`[claude-proxy] stop : claude-proxy stop   (or: kill ${child.pid})`);
    console.log('[claude-proxy] logs : claude-proxy logs');
    process.exit(0);
  });
}

function stopDaemon(cfg) {
  // Prefer the recorded pid; fall back to lsof on the port.
  let pid = null;
  try { pid = Number(fs.readFileSync(pidPath(), 'utf-8').trim()); } catch { /* no pid file */ }

  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[claude-proxy] stopped (pid ${pid})`);
    } catch (e) {
      console.log(`[claude-proxy] pid ${pid} not running (${e.message})`);
    }
    try { fs.unlinkSync(pidPath()); } catch { /* gone */ }
    return;
  }

  let pids = [];
  try {
    pids = execFileSync('lsof', ['-ti', `:${cfg.PORT}`], { encoding: 'utf-8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { /* port free */ }
  if (pids.length) {
    for (const p of pids) { try { process.kill(Number(p), 'SIGTERM'); } catch { /* gone */ } }
    console.log(`[claude-proxy] stopped process on :${cfg.PORT} (pid ${pids.join(' ')})`);
  } else {
    console.log('[claude-proxy] not running (no pid file, port free).');
  }
}

// stop → wait for the port to actually free up → start. Useful after a code
// change (the running server has the old code in memory; only a fresh process
// loads the new lib/*). stopDaemon sends SIGTERM and returns synchronously, but
// the old process keeps exiting asynchronously — so we poll clearPort until the
// socket is released before spawning the new one, else bind hits EADDRINUSE.
async function restartDaemon(cfg) {
  console.log('[claude-proxy] restarting…');
  stopDaemon(cfg);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const remaining = clearPort(cfg.PORT);
    if (!remaining.length) break;
    await sleep(300);
  }
  startDaemon(cfg);
}

async function statusDaemon(cfg) {
  let pid = null;
  try { pid = Number(fs.readFileSync(pidPath(), 'utf-8').trim()); } catch { /* none */ }

  let alive = false;
  if (pid) { try { process.kill(pid, 0); alive = true; } catch { /* dead */ } }

  const healthy = await probeHealth(cfg.PORT);

  if (alive && healthy) {
    console.log(`[claude-proxy] running  (pid ${pid}, port ${cfg.PORT})  ✓`);
  } else if (alive) {
    console.log(`[claude-proxy] process alive (pid ${pid}) but /health not responding on :${cfg.PORT}`);
  } else if (healthy) {
    console.log(`[claude-proxy] something is serving :${cfg.PORT} (no pid file — not this daemon)`);
  } else {
    console.log(`[claude-proxy] not running  (port ${cfg.PORT} free)`);
  }
}

module.exports = { startDaemon, stopDaemon, restartDaemon, statusDaemon, tailLog, printBanner };
