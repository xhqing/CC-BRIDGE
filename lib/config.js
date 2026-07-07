'use strict';

// Config loading & management. Config lives at ~/.claude-proxy/.env so the
// installed CLI can find it from any working directory (the old proxy.js read
// .env from __dirname, which breaks once installed globally).

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.claude-proxy');
const CONFIG = path.join(DIR, '.env');
const PID = path.join(DIR, 'claude-proxy.pid');
const LOG = path.join(DIR, 'proxy.log');
const TEMPLATE = path.resolve(__dirname, '..', '.env.example');

const configDir = () => DIR;
const configPath = () => CONFIG;
const pidPath = () => PID;
const logPath = () => LOG;
const templatePath = () => TEMPLATE;

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

// Parse a .env file into a plain object (same semantics as the old loadEnv:
// strips quotes, skips comments/blank lines). Does NOT touch process.env.
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

// Resolve which .env to read: explicit --config > $CLAUDE_PROXY_CONFIG > default.
function resolveConfigPath(override) {
  if (override) return override;
  if (process.env.CLAUDE_PROXY_CONFIG) return process.env.CLAUDE_PROXY_CONFIG;
  return CONFIG;
}

// Load and normalise config. process.env wins over the .env file (mirrors the
// old "does not override existing process env" behaviour). Never throws on
// missing fields — callers use validate() to check required ones.
function loadConfig(opts = {}) {
  const file = resolveConfigPath(opts.configPath);
  const env = parseEnv(file);
  const get = (k, d) => {
    if (process.env[k] !== undefined && process.env[k] !== '') return process.env[k];
    if (env[k] !== undefined) return env[k];
    return d;
  };

  // --- Multi-upstream / multi-model mapping ---------------------------------
  // Pair #1 is the unnumbered legacy keys (always present, backward compatible):
  //   API_BASE / API_KEY / SPOOF_MODEL / TARGET_MODEL
  // Additional pairs use numbered suffixes with no upper limit:
  //   API_BASE_2 / API_KEY_2 / SPOOF_MODEL_2 / TARGET_MODEL_2
  //   API_BASE_3 / API_KEY_3 / SPOOF_MODEL_3 / TARGET_MODEL_3
  //   ...
  // Each pair carries its OWN upstream (apiBase + apiKey) plus the
  // client-visible spoof ID → real upstream model ID mapping. A numbered pair
  // may omit API_BASE_n / API_KEY_n, in which case it falls back to pair #1's
  // values (so multi-model-single-upstream still works with less typing).
  // The proxy rewrites body.model from the spoof to its paired target and
  // forwards to that pair's upstream. Unknown models (not any configured
  // SPOOF_MODEL / TARGET_MODEL) are rejected with HTTP 400 — there is NO
  // fallback to pair #1, so a misrouted model fails loudly instead of silently
  // hitting the wrong upstream.
  const normBase = (v) => (v || '').replace(/\/+$/, '');
  const defaultApiBase = normBase(get('API_BASE', ''));
  const defaultApiKey = get('API_KEY', '');
  const defaultTarget = get('TARGET_MODEL', 'glm-5.2');
  const defaultSpoof = get('SPOOF_MODEL', 'claude-opus-4-8');
  const defaultFormat = (get('FORMAT', 'anthropic') || 'anthropic').toLowerCase();
  const pairs = [{
    n: 1,
    spoof: defaultSpoof,
    target: defaultTarget,
    apiBase: defaultApiBase,
    apiKey: defaultApiKey,
    format: defaultFormat,
    contextWindow: parseInt(get('CONTEXT_WINDOW', '0'), 10) || 0,
    maxOutputTokens: parseInt(get('MAX_OUTPUT_TOKENS', '0'), 10) || 0,
  }];

  // Collect every numbered suffix present in the file *or* process.env, so
  // users can override individual pairs from the shell too. Any of the five
  // keys with the same suffix counts.
  const indices = new Set();
  for (const src of [env, process.env]) {
    for (const k of Object.keys(src)) {
      const m = k.match(/^(?:SPOOF|TARGET)_MODEL_(\d+)$|^API_(?:BASE|KEY)_(\d+)$|^FORMAT_(\d+)$|^CONTEXT_WINDOW_(\d+)$|^MAX_OUTPUT_TOKENS_(\d+)$/);
      if (m) {
        const n = parseInt(m[1] || m[2] || m[3] || m[4] || m[5], 10);
        if (n >= 2) indices.add(n);
      }
    }
  }
  for (const n of [...indices].sort((a, b) => a - b)) {
    const spoof = get(`SPOOF_MODEL_${n}`, '');
    const target = get(`TARGET_MODEL_${n}`, '');
    if (!spoof || !target) continue; // a pair needs both spoof + target at minimum
    const fmt = (get(`FORMAT_${n}`, '') || defaultFormat).toLowerCase();
    pairs.push({
      n,
      spoof,
      target,
      apiBase: normBase(get(`API_BASE_${n}`, '')) || defaultApiBase,
      apiKey: get(`API_KEY_${n}`, '') || defaultApiKey,
      format: fmt,
      contextWindow: parseInt(get(`CONTEXT_WINDOW_${n}`, '0'), 10) || 0,
      maxOutputTokens: parseInt(get(`MAX_OUTPUT_TOKENS_${n}`, '0'), 10) || 0,
    });
  }

  return {
    PORT: parseInt(get('PROXY_PORT', '8787'), 10) || 8787,
    API_BASE: defaultApiBase,
    API_KEY: defaultApiKey,
    TARGET_MODEL: defaultTarget,
    SPOOF_MODEL: defaultSpoof,
    MODEL_PAIRS: pairs,
    VERBOSE: (get('PROXY_LOG', '1') !== '0'),
    DUMP: (get('PROXY_DUMP', '0') === '1'),
    configPath: file,
  };
}

function validate(cfg) {
  const missing = [];
  if (!cfg.API_BASE) missing.push('API_BASE');
  if (!cfg.API_KEY) missing.push('API_KEY');
  return missing;
}

// Create ~/.claude-proxy/.env from the bundled .env.example if absent.
function ensureConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG)) {
    if (fs.existsSync(TEMPLATE)) {
      fs.copyFileSync(TEMPLATE, CONFIG);
    } else {
      fs.writeFileSync(CONFIG, '# claude-proxy config — fill in API_BASE / API_KEY\n');
    }
  }
  return CONFIG;
}

// Copy an existing .env (e.g. the old project .env) into the user config dir.
function importConfig(srcPath) {
  if (!fs.existsSync(srcPath)) throw new Error(`source not found: ${srcPath}`);
  ensureDir();
  fs.copyFileSync(srcPath, CONFIG);
  return CONFIG;
}

// Open the config in $EDITOR (fallback vi).
function editConfig() {
  ensureConfig();
  const editor = process.env.EDITOR || 'vi';
  const { spawnSync } = require('child_process');
  spawnSync(editor, [CONFIG], { stdio: 'inherit' });
}

function mask(key) {
  if (!key) return '(unset)';
  if (key.length <= 6) return '***';
  return key.slice(0, 6) + '***';
}

function showConfig() {
  const cfg = loadConfig();
  console.log(`config file  : ${cfg.configPath}`);
  console.log(`PROXY_PORT    : ${cfg.PORT}`);
  console.log(`PROXY_LOG     : ${cfg.VERBOSE ? '1' : '0'}`);
  console.log(`MODEL_PAIRS   : ${cfg.MODEL_PAIRS.length}`);
  for (const p of cfg.MODEL_PAIRS) {
    const tag = p.n === 1 ? 'default' : `#${p.n}`;
    console.log(`  ${tag.padEnd(8)} ${p.spoof} → ${p.target}  [${p.format}]`);
    console.log(`           upstream : ${p.apiBase || '(unset)'}`);
    console.log(`           api key : ${mask(p.apiKey)}`);
    if (p.contextWindow) console.log(`           context  : ${p.contextWindow.toLocaleString()} tokens`);
    if (p.maxOutputTokens) console.log(`           maxOut   : ${p.maxOutputTokens.toLocaleString()} tokens`);
  }
}

module.exports = {
  configDir, configPath, pidPath, logPath, templatePath,
  parseEnv, resolveConfigPath, loadConfig, validate,
  ensureConfig, importConfig, editConfig, showConfig, mask, ensureDir,
};
