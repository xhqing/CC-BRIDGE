'use strict';

// Config loading & management. Each upstream has its own config file at
// ~/.cc-bridge/<upstream>.env (e.g. ~/.cc-bridge/glm.env), so the installed CLI
// finds it from any working directory and multiple upstreams can coexist with
// independent settings (port / keys / model …).

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.cc-bridge');
const TEMPLATE = path.resolve(__dirname, '..', '.env.example');

const configDir = () => DIR;
const configPathFor = (upstream) => path.join(DIR, `${upstream}.env`);
const pidPathFor = (upstream) => path.join(DIR, `${upstream}.pid`);
const logPathFor = (upstream) => path.join(DIR, `${upstream}.log`);
const templatePath = () => TEMPLATE;

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

// Parse a .env file into a plain object (strips quotes, skips comments/blank
// lines). Does NOT touch process.env.
function parseEnv(filePath) {
  const obj = {};
  if (!fs.existsSync(filePath)) return obj;
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) obj[k] = v;
  }
  return obj;
}

// Resolve which .env to read: explicit --config > $CC_BRIDGE_CONFIG > per-upstream default.
function resolveConfigPath(upstream, override) {
  if (override) return override;
  if (process.env.CC_BRIDGE_CONFIG) return process.env.CC_BRIDGE_CONFIG;
  return configPathFor(upstream);
}

// Load and normalise config for an upstream. process.env wins over the .env file.
// Never throws on missing fields — callers use validate() to check required ones.
function loadConfig(opts = {}) {
  const upstream = opts.upstream || 'glm';
  const file = resolveConfigPath(upstream, opts.configPath);
  const env = parseEnv(file);
  const get = (k, d) => {
    if (process.env[k] !== undefined && process.env[k] !== '') return process.env[k];
    if (env[k] !== undefined) return env[k];
    return d;
  };

  // 多 KEY 容灾：API_KEY 逗号分隔配置多个（推荐至少 2 个）。某 KEY 被判失效 / 欠费
  // （401/403）或同 KEY 瞬态重试用尽时，自动切换到下一个 KEY——URL 不变，只换 KEY。
  const normBase = (v) => (v || '').replace(/\/+$/, '');
  const rawKeys = get('API_KEY', '');
  const KEYS = rawKeys.split(',').map((k) => k.trim()).filter(Boolean);

  return {
    upstream,
    PORT: parseInt(get('PROXY_PORT', '8787'), 10) || 8787,
    API_BASE: normBase(get('API_BASE', '')),
    KEYS,
    API_KEY: KEYS[0] || '', // 首个 KEY，向后兼容只读单 KEY 的旧代码
    TARGET_MODEL: get('TARGET_MODEL', ''),   // 空 → 由 adapter 默认值兜底
    SPOOF_MODEL: get('SPOOF_MODEL', ''),     // 空 → 由 adapter 默认值兜底
    CONTEXT_WINDOW: parseInt(get('CONTEXT_WINDOW', '0'), 10) || 0,
    MAX_OUTPUT_TOKENS: parseInt(get('MAX_OUTPUT_TOKENS', '0'), 10) || 0,
    VERBOSE: (get('PROXY_LOG', '1') !== '0'),
    DUMP: (get('PROXY_DUMP', '0') === '1'),
    configPath: file,
  };
}

function validate(cfg) {
  const missing = [];
  if (!cfg.API_BASE) missing.push('API_BASE');
  if (!cfg.KEYS.length) missing.push('API_KEY');
  return missing;
}

// Create ~/.cc-bridge/<upstream>.env from the bundled .env.example if absent.
function ensureConfig(upstream) {
  ensureDir();
  const CONFIG = configPathFor(upstream);
  if (!fs.existsSync(CONFIG)) {
    if (fs.existsSync(TEMPLATE)) {
      fs.copyFileSync(TEMPLATE, CONFIG);
    } else {
      fs.writeFileSync(CONFIG, `# cc-bridge (${upstream}) config — fill in API_BASE / API_KEY\n`);
    }
  }
  return CONFIG;
}

// Copy an existing .env into the per-upstream config slot.
function importConfig(upstream, srcPath) {
  if (!fs.existsSync(srcPath)) throw new Error(`source not found: ${srcPath}`);
  ensureDir();
  fs.copyFileSync(srcPath, configPathFor(upstream));
  return configPathFor(upstream);
}

// Open the config in $EDITOR (fallback vi).
function editConfig(upstream) {
  const CONFIG = ensureConfig(upstream);
  const editor = process.env.EDITOR || 'vi';
  const { spawnSync } = require('child_process');
  spawnSync(editor, [CONFIG], { stdio: 'inherit' });
}

function mask(key) {
  if (!key) return '(unset)';
  if (key.length <= 6) return '***';
  return key.slice(0, 6) + '***';
}

function showConfig(upstream) {
  const cfg = loadConfig({ upstream });
  console.log(`upstream      : ${cfg.upstream}`);
  console.log(`config file   : ${cfg.configPath}`);
  console.log(`PROXY_PORT    : ${cfg.PORT}`);
  console.log(`PROXY_LOG     : ${cfg.VERBOSE ? '1' : '0'}`);
  console.log(`api base      : ${cfg.API_BASE || '(unset)'}`);
  console.log(`spoof → target: ${cfg.SPOOF_MODEL || '(adapter default)'} → ${cfg.TARGET_MODEL || '(adapter default)'}`);
  console.log(`API_KEYs      : ${cfg.KEYS.length}`);
  cfg.KEYS.forEach((k, i) => {
    console.log(`  ${String('#' + (i + 1)).padEnd(8)} ${mask(k)}`);
  });
  if (cfg.CONTEXT_WINDOW) console.log(`context       : ${cfg.CONTEXT_WINDOW.toLocaleString()} tokens`);
  if (cfg.MAX_OUTPUT_TOKENS) console.log(`maxOut        : ${cfg.MAX_OUTPUT_TOKENS.toLocaleString()} tokens`);
}

module.exports = {
  configDir, configPathFor, pidPathFor, logPathFor, templatePath,
  parseEnv, resolveConfigPath, loadConfig, validate,
  ensureConfig, importConfig, editConfig, showConfig, mask, ensureDir,
};
