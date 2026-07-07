'use strict';

// `claude-proxy claude` — start the proxy as a child, point an ephemeral
// `claude` process at it (max/xhigh unlocked), and tear the proxy down when
// claude exits. Mirrors start.sh's --claude branch.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { logPath, ensureDir } = require('./config');
const { waitReady, clearPort } = require('./util');
const { printBanner } = require('./daemon');

const SERVER_JS = path.resolve(__dirname, 'server.js');

function runWithClaude(cfg, args) {
  ensureDir();
  clearPort(cfg.PORT);

  const logFd = fs.openSync(logPath(), 'a');
  const child = spawn(process.execPath, [SERVER_JS], {
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, CLAUDE_PROXY_CONFIG: cfg.configPath },
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
      console.error('[claude-proxy] proxy did not become ready within 10s.');
      cleanup();
      try {
        const tail = fs.readFileSync(logPath(), 'utf-8').split('\n').slice(-20).join('\n');
        if (tail.trim()) console.error(tail);
      } catch { /* no log */ }
      process.exit(1);
    }

    printBanner(cfg);

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${cfg.PORT}`,
      ANTHROPIC_API_KEY: cfg.API_KEY,
      ANTHROPIC_MODEL: cfg.SPOOF_MODEL,
    };
    delete env.ANTHROPIC_AUTH_TOKEN;

    console.log('');
    console.log('  \x1b[32m✅  claude will use this proxy (max/xhigh unlocked)\x1b[0m');
    console.log(`  \x1b[32m    BASE_URL : ${env.ANTHROPIC_BASE_URL}\x1b[0m`);
    console.log(`  \x1b[32m    MODEL    : ${env.ANTHROPIC_MODEL}  → ${cfg.TARGET_MODEL}\x1b[0m`);
    console.log('');

    const claudeProc = spawn('claude', args, { stdio: 'inherit', env });
    claudeProc.on('error', (e) => {
      console.error(`[claude-proxy] failed to launch 'claude': ${e.message}`);
      console.error("[claude-proxy] is the claude CLI installed and on your PATH?");
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
