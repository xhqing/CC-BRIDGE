#!/usr/bin/env node
'use strict';

// claude-proxy — CLI entry point. Dispatches subcommands to lib/* modules.

const { loadConfig, validate, editConfig, showConfig, importConfig, configPath } = require('../lib/config');
const { startServer } = require('../lib/server');
const { startDaemon, stopDaemon, restartDaemon, statusDaemon, tailLog } = require('../lib/daemon');
const { runWithClaude } = require('../lib/claude');
const { probeHealth } = require('../lib/util');

const HELP = `claude-proxy — Claude Code effort-unlock proxy

Usage:
  claude-proxy start                 start service in foreground (Ctrl-C to stop)
  claude-proxy daemon                start in background (detached)
  claude-proxy claude [args...]      start proxy + launch claude pointed at it
  claude-proxy stop                  stop background service
  claude-proxy restart               restart background service (stop + start)
  claude-proxy status                show running status
  claude-proxy logs                  tail the proxy log (Ctrl-C to exit)
  claude-proxy health                probe /health
  claude-proxy config                edit config in $EDITOR
  claude-proxy config show           print config (API_KEY masked)
  claude-proxy config path           print config file path
  claude-proxy config --import <p>   import an existing .env into ~/.claude-proxy/
  claude-proxy version | -v | --version   print version
  claude-proxy help | -h | --help    this help

Options:
  --config <path>                    use this config file instead of ~/.claude-proxy/.env
`;

function fail(msg) {
  console.error(`[claude-proxy] ${msg}`);
  process.exit(1);
}

// Pull a global `--config <path>` (or `--config=<path>`) out of argv, leaving
// the rest intact. Returns { configPath, rest }.
function parseGlobalConfig(argv) {
  let configPath = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { configPath = argv[++i]; continue; }
    if (argv[i].startsWith('--config=')) { configPath = argv[i].slice('--config='.length); continue; }
    rest.push(argv[i]);
  }
  return { configPath, rest };
}

// Load + validate config for commands that actually start the proxy.
function loadOrThrow(configPath) {
  const cfg = loadConfig({ configPath });
  const missing = validate(cfg);
  if (missing.length) {
    fail(`missing required config: ${missing.join(', ')}. Run 'claude-proxy config' to edit ${cfg.configPath}.`);
  }
  return cfg;
}

async function main() {
  const argv = process.argv.slice(2);
  const { configPath: cfgPath, rest } = parseGlobalConfig(argv);
  const cmd = rest[0];
  const sub = rest.slice(1);

  if (!cmd) {
    console.log(HELP);
    process.exit(0);
  }

  switch (cmd) {
    case 'start':
    case '_serve':                       // internal: foreground server (used by daemon/claude spawn fallback)
      startServer(loadOrThrow(cfgPath));
      break;

    case 'daemon':
      startDaemon(loadOrThrow(cfgPath));
      break;

    case 'claude': {
      let args = sub;
      if (args[0] === '--') args = args.slice(1);   // allow `claude-proxy claude -- -p "hi"`
      runWithClaude(loadOrThrow(cfgPath), args);
      break;
    }

    case 'stop':
      stopDaemon(loadConfig({ configPath: cfgPath }));
      break;

    case 'restart':
      await restartDaemon(loadOrThrow(cfgPath));
      break;

    case 'status':
      await statusDaemon(loadConfig({ configPath: cfgPath }));
      break;

    case 'logs':
      tailLog();
      break;

    case 'health': {
      const cfg = loadConfig({ configPath: cfgPath });
      const ok = await probeHealth(cfg.PORT);
      console.log(ok ? `[claude-proxy] /health ok on :${cfg.PORT}` : `[claude-proxy] /health not responding on :${cfg.PORT}`);
      process.exit(ok ? 0 : 1);
      break;
    }

    case 'config': {
      const action = sub[0];
      if (!action || action === 'edit') { editConfig(); break; }
      if (action === 'show') { showConfig(); break; }
      if (action === 'path') { console.log(configPath()); break; }
      if (action === '--import' || action === 'import') {
        const src = sub[1];
        if (!src) fail('config --import <path> requires a source path');
        try {
          const dst = importConfig(src);
          console.log(`[claude-proxy] imported ${src} → ${dst}`);
        } catch (e) {
          fail(e.message);
        }
        break;
      }
      fail(`unknown config action '${action}'. Try: claude-proxy config show | path | --import <path>`);
      break;
    }

    case 'version':
    case '-v':
    case '--version': {
      // 版本取自 package.json（npm 安装后一定存在；与 VERSION 文件保持一致）。
      console.log(`claude-proxy ${require('../package.json').version}`);
      break;
    }

    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      break;

    default:
      console.error(`[claude-proxy] unknown command '${cmd}'\n`);
      console.error(HELP);
      process.exit(1);
  }
}

main();
