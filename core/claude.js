'use strict';

// `cc-bridge <upstream> claude` — start the bridge as a child, point an ephemeral
// `claude` process at it (max/xhigh unlocked), and tear the bridge down when
// claude exits.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { logPathFor, ensureDir } = require('./config');
const { waitReady, clearPort } = require('./util');
const { printBanner } = require('./daemon');

const SERVER_JS = path.resolve(__dirname, 'server.js');

function runWithClaude(cfg, adapter, args) {
  ensureDir();
  clearPort(cfg.PORT);

  const logPath = logPathFor(cfg.upstream);
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [SERVER_JS], {
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, CC_BRIDGE_UPSTREAM: cfg.upstream, CC_BRIDGE_CONFIG: cfg.configPath },
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  waitReady(cfg.PORT, child.pid).then((ok) => {
    if (!ok) {
      console.error('[bridge] proxy did not become ready within 10s.');
      cleanup();
      try {
        const tail = fs.readFileSync(logPath, 'utf-8').split('\n').slice(-20).join('\n');
        if (tail.trim()) console.error(tail);
      } catch { /* no log */ }
      process.exit(1);
    }

    printBanner(cfg, adapter);

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${cfg.PORT}`,
      ANTHROPIC_API_KEY: cfg.API_KEY,
      ANTHROPIC_MODEL: cfg.SPOOF_MODEL || adapter.defaultSpoof,
    };
    delete env.ANTHROPIC_AUTH_TOKEN;

    console.log('');
    console.log('  \x1b[32m✅  claude will use this bridge (max/xhigh unlocked)\x1b[0m');
    console.log(`  \x1b[32m    BASE_URL : ${env.ANTHROPIC_BASE_URL}\x1b[0m`);
    console.log(`  \x1b[32m    MODEL    : ${env.ANTHROPIC_MODEL}  → ${cfg.TARGET_MODEL || adapter.defaultTarget}\x1b[0m`);
    console.log('');

    const claudeProc = spawn('claude', args, { stdio: 'inherit', env });
    claudeProc.on('error', (e) => {
      console.error(`[bridge] failed to launch 'claude': ${e.message}`);
      console.error("[bridge] is the claude CLI installed and on your PATH?");
      cleanup();
      process.exit(1);
    });
    claudeProc.on('exit', (code) => {
      cleanup();
      process.exit(code ?? 0);
    });
  });
}

module.exports = { runWithClaude };
