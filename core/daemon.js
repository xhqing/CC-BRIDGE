'use strict';

// Background (detached) process management: start/stop/status/logs.
// pid + log files live under ~/.cc-bridge/<upstream>.{pid,log}, so several
// upstreams can run as daemons side by side without clashing.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { pidPathFor, logPathFor, ensureDir } = require('./config');
const { waitReady, probeHealth, clearPort, sleep } = require('./util');

const SERVER_JS = path.resolve(__dirname, 'server.js');

function printBanner(cfg, adapter) {
  const spoof = cfg.SPOOF_MODEL || adapter.defaultSpoof;
  const target = cfg.TARGET_MODEL || adapter.defaultTarget;
  console.log(`[bridge] proxy ready  (port ${cfg.PORT})`);
  console.log(`[bridge] upstream     : ${adapter.displayName}`);
  console.log(`[bridge] api base     : ${cfg.API_BASE}`);
  console.log(`[bridge] spoof → target : ${spoof} → ${target}`);
  console.log(`[bridge] API keys     : ${cfg.KEYS.length}`);
}

function tailLog(upstream) {
  const lp = logPathFor(upstream);
  if (!fs.existsSync(lp)) {
    console.log(`[bridge] no log file at ${lp}`);
    return;
  }
  // `tail -f` for live follow; Ctrl-C exits.
  const child = spawn('tail', ['-n', '50', '-f', lp], { stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { child.kill(sig); process.exit(0); });
  }
}

// Spawn `node core/server.js` detached, writing stdout/stderr to the per-upstream
// log. Records the child pid, waits for /health, prints the banner, then exits
// (the detached child keeps running).
function startDaemon(cfg, adapter) {
  ensureDir();
  clearPort(cfg.PORT);

  const pidPath = pidPathFor(cfg.upstream);
  const logPath = logPathFor(cfg.upstream);
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [SERVER_JS], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, CC_BRIDGE_UPSTREAM: cfg.upstream, CC_BRIDGE_CONFIG: cfg.configPath },
  });
  fs.writeFileSync(pidPath, String(child.pid));
  child.unref();

  waitReady(cfg.PORT, child.pid).then((ok) => {
    if (!ok) {
      console.error('[bridge] proxy did not become ready within 10s.');
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
      try { fs.unlinkSync(pidPath); } catch { /* gone */ }
      try {
        const tail = fs.readFileSync(logPath, 'utf-8').split('\n').slice(-20).join('\n');
        if (tail.trim()) console.error(tail);
      } catch { /* no log */ }
      process.exit(1);
    }
    printBanner(cfg, adapter);
    console.log('');
    console.log('[bridge] daemon mode. Proxy runs in the background.');
    console.log(`[bridge] stop : cc-bridge ${cfg.upstream} stop   (or: kill ${child.pid})`);
    console.log(`[bridge] logs : cc-bridge ${cfg.upstream} logs`);
    process.exit(0);
  });
}

function stopDaemon(cfg) {
  const pidPath = pidPathFor(cfg.upstream);
  // Prefer the recorded pid; fall back to lsof on the port.
  let pid = null;
  try { pid = Number(fs.readFileSync(pidPath, 'utf-8').trim()); } catch { /* no pid file */ }

  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[bridge] stopped (pid ${pid})`);
    } catch (e) {
      console.log(`[bridge] pid ${pid} not running (${e.message})`);
    }
    try { fs.unlinkSync(pidPath); } catch { /* gone */ }
    return;
  }

  let pids = [];
  try {
    pids = execFileSync('lsof', ['-ti', `:${cfg.PORT}`], { encoding: 'utf-8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { /* port free */ }
  if (pids.length) {
    for (const p of pids) { try { process.kill(Number(p), 'SIGTERM'); } catch { /* gone */ } }
    console.log(`[bridge] stopped process on :${cfg.PORT} (pid ${pids.join(' ')})`);
  } else {
    console.log('[bridge] not running (no pid file, port free).');
  }
}

// stop → wait for the port to actually free up → start. Useful after a code
// change (the running server has the old code in memory; only a fresh process
// loads the new core/*).
async function restartDaemon(cfg, adapter) {
  console.log('[bridge] restarting…');
  stopDaemon(cfg);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const remaining = clearPort(cfg.PORT);
    if (!remaining.length) break;
    await sleep(300);
  }
  startDaemon(cfg, adapter);
}

async function statusDaemon(cfg) {
  const pidPath = pidPathFor(cfg.upstream);
  let pid = null;
  try { pid = Number(fs.readFileSync(pidPath, 'utf-8').trim()); } catch { /* none */ }

  let alive = false;
  if (pid) { try { process.kill(pid, 0); alive = true; } catch { /* dead */ } }

  const healthy = await probeHealth(cfg.PORT);

  if (alive && healthy) {
    console.log(`[bridge] running  (pid ${pid}, port ${cfg.PORT})  ✓`);
  } else if (alive) {
    console.log(`[bridge] process alive (pid ${pid}) but /health not responding on :${cfg.PORT}`);
  } else if (healthy) {
    console.log(`[bridge] something is serving :${cfg.PORT} (no pid file — not this daemon)`);
  } else {
    console.log(`[bridge] not running  (port ${cfg.PORT} free)`);
  }
}

module.exports = { startDaemon, stopDaemon, restartDaemon, statusDaemon, tailLog, printBanner };
