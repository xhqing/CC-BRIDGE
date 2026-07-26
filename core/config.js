'use strict';

// Config loading & management. Each upstream has its own config file at
// ~/.cc-bridge/<upstream>.env (e.g. ~/.cc-bridge/glm.env), so the installed CLI
// finds it from any working directory and multiple upstreams can coexist with
// independent settings (port / keys / model …).

const fs = require('fs');
const path = require('path');
const os = require('os');

const { REGISTRY } = require('./adapter');

const DIR = path.join(os.homedir(), '.cc-bridge');

const configDir = () => DIR;
const configPathFor = (upstream) => path.join(DIR, `${upstream}.env`);
const pidPathFor = (upstream) => path.join(DIR, `${upstream}.pid`);
const logPathFor = (upstream) => path.join(DIR, `${upstream}.log`);

// 每上游的配置模板：cc-<name>-bridge/.env.example（随包发布，按上游区分）。上游未
// 注册时返回 null。`cc-bridge <upstream> config` 首次生成配置时复制的就是它。
const templatePath = (upstream) => {
  const entry = REGISTRY[upstream];
  if (!entry) return null;
  return path.resolve(__dirname, '..', entry.dir, '.env.example');
};

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

// 解析模型映射为 [{spoof, target}, ...]。支持三种写法（优先级从高到低）：
//   1) MODEL_MAP="spoofA->targetA,spoofB->targetB"  多对（推荐：单上游内多模型路由，
//                                                   如 opus 和 haiku 都指向 glm-5.2）
//   2) SPOOF_MODEL + TARGET_MODEL                    单对（向后兼容旧配置）
//   3) 两者都没配                                     返回 []（由 server 用 adapter 默认兜底）
// 第一对约定为「主力对」：claude.js 用它的 spoof 作为启动 claude 时的 ANTHROPIC_MODEL。
// 格式错误抛 Error（带清晰信息）；loadConfig 会捕获并入 validate 报告，保持不抛契约。
function parseModelMap(rawMap, rawSpoof, rawTarget) {
  const pairs = [];
  const map = (rawMap || '').trim();
  if (map) {
    for (const part of map.split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const arrow = seg.indexOf('->');
      if (arrow === -1) {
        throw new Error(`invalid entry "${seg}" — expected "spoof->target"`);
      }
      const spoof = seg.slice(0, arrow).trim();
      const target = seg.slice(arrow + 2).trim();
      if (!spoof || !target) {
        throw new Error(`invalid entry "${seg}" — both spoof and target are required around '->'`);
      }
      pairs.push({ spoof, target });
    }
    if (!pairs.length) throw new Error('MODEL_MAP is set but contains no valid entries');
    return pairs;
  }
  // 单对兼容：SPOOF_MODEL / TARGET_MODEL（缺一边则留空，由 server 用 adapter 默认补齐）。
  if ((rawSpoof || '').trim() || (rawTarget || '').trim()) {
    return [{ spoof: (rawSpoof || '').trim(), target: (rawTarget || '').trim() }];
  }
  return [];
}

// 收集所有 API KEY，支持两种写法（可混用、合并去空、不去重）：
//   1) 编号变量 API_KEY_1 / API_KEY_2 / API_KEY_3 …（推荐）。每个 KEY 独立成行，可单独
//      写注释标注账号来源（如「# 工作账号」「# 个人账号」），也可单独注释掉整行来临时
//      禁用某个 KEY——比在一长串逗号串里增删值方便得多。编号按数字大小升序排列（不是
//      字典序，所以 API_KEY_10 仍排在 API_KEY_2 之后）。
//   2) 旧式单变量 API_KEY=k1,k2,k3（逗号分隔，向后兼容）。若同时配了编号变量，老式
//      API_KEY 的值会「追加」在编号变量之后，不会覆盖。
// process.env 与文件 env 都查（process.env 优先，与 get() 语义一致）。
function collectKeys(env, get) {
  const re = /^API_KEY_\d+$/;
  const names = new Set();
  for (const k of Object.keys(process.env)) if (re.test(k)) names.add(k);
  for (const k of Object.keys(env)) if (re.test(k)) names.add(k);
  const ordered = [...names].sort(
    (a, b) => parseInt(a.slice('API_KEY_'.length), 10) - parseInt(b.slice('API_KEY_'.length), 10)
  );
  const vals = ordered.map((n) => get(n, ''));
  const legacy = get('API_KEY', '');
  if (legacy) vals.push(...legacy.split(','));
  return vals.map((k) => k.trim()).filter(Boolean);
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

  // 多 KEY 容灾：支持编号变量 API_KEY_1 / API_KEY_2 / …（推荐）与旧式 API_KEY=k1,k2
  // （向后兼容）两种写法，详见 collectKeys。某 KEY 被判失效 / 欠费（401/403）或同 KEY
  // 瞬态重试用尽时，自动切换到下一个 KEY——URL 不变，只换 KEY。
  const normBase = (v) => (v || '').replace(/\/+$/, '');
  const KEYS = collectKeys(env, get);

  // 模型映射（多对 spoof→target）。解析失败不抛——错误存入 modelMapError，由 validate
  // 报给用户，保持 loadConfig「永不抛错」的契约。
  let PAIRS = [];
  let modelMapError = null;
  try {
    PAIRS = parseModelMap(get('MODEL_MAP', ''), get('SPOOF_MODEL', ''), get('TARGET_MODEL', ''));
  } catch (e) {
    modelMapError = e.message;
  }

  return {
    upstream,
    PORT: parseInt(get('PROXY_PORT', '8787'), 10) || 8787,
    API_BASE: normBase(get('API_BASE', '')),
    KEYS,
    API_KEY: KEYS[0] || '', // 首个 KEY，向后兼容只读单 KEY 的旧代码
    // 模型映射：[{spoof, target}, ...]。空数组 → server 用 adapter 默认单对兜底。
    PAIRS,
    SPOOF_MODEL: PAIRS[0] ? PAIRS[0].spoof : '',   // 主力 spoof（兼容旧字段，= 第一对）
    TARGET_MODEL: PAIRS[0] ? PAIRS[0].target : '', // 主力 target（同上）
    CONTEXT_WINDOW: parseInt(get('CONTEXT_WINDOW', '0'), 10) || 0,
    MAX_OUTPUT_TOKENS: parseInt(get('MAX_OUTPUT_TOKENS', '0'), 10) || 0,
    VERBOSE: (get('PROXY_LOG', '1') !== '0'),
    DUMP: (get('PROXY_DUMP', '0') === '1'),
    modelMapError,
    configPath: file,
  };
}

function validate(cfg) {
  const missing = [];
  if (!cfg.API_BASE) missing.push('API_BASE');
  if (!cfg.KEYS.length) missing.push('API_KEY_1 (or legacy API_KEY)');
  if (cfg.modelMapError) missing.push(`MODEL_MAP (${cfg.modelMapError})`);
  return missing;
}

// Create ~/.cc-bridge/<upstream>.env from the upstream's bundled .env.example if absent.
// 模板按上游区分：cc-<name>-bridge/.env.example（找不到则写一行占位注释）。
function ensureConfig(upstream) {
  ensureDir();
  const CONFIG = configPathFor(upstream);
  if (!fs.existsSync(CONFIG)) {
    const tpl = templatePath(upstream);
    if (tpl && fs.existsSync(tpl)) {
      fs.copyFileSync(tpl, CONFIG);
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
  if (cfg.PAIRS.length) {
    console.log(`model map     : ${cfg.PAIRS.length} pair(s)  (first pair = main model)`);
    cfg.PAIRS.forEach((p, i) => {
      const tag = i === 0 ? 'main' : '    ';
      console.log(`  ${tag} #${i + 1}  ${p.spoof || '(adapter default)'} → ${p.target || '(adapter default)'}`);
    });
  } else {
    console.log(`model map     : (unset — will use adapter default spoof → target)`);
  }
  if (cfg.modelMapError) console.log(`MODEL_MAP err : ${cfg.modelMapError}`);
  console.log(`API_KEYs      : ${cfg.KEYS.length}`);
  cfg.KEYS.forEach((k, i) => {
    console.log(`  ${String('#' + (i + 1)).padEnd(8)} ${mask(k)}`);
  });
  if (cfg.CONTEXT_WINDOW) console.log(`context       : ${cfg.CONTEXT_WINDOW.toLocaleString()} tokens`);
  if (cfg.MAX_OUTPUT_TOKENS) console.log(`maxOut        : ${cfg.MAX_OUTPUT_TOKENS.toLocaleString()} tokens`);
}

// 把 cfg.PAIRS 解析成 server/daemon 直接可用的「路由 + 展示用」对列表：
// 用户未配（PAIRS 空）→ 用 adapter 默认单对兜底；单边配置 → 另一边用 adapter 默认补齐。
// 供 server.js（路由）和 daemon.js（banner）共用，避免派生逻辑重复。
function resolvePairs(cfg, adapter) {
  const list = (cfg.PAIRS && cfg.PAIRS.length)
    ? cfg.PAIRS.map((p) => ({ spoof: p.spoof, target: p.target }))
    : [{ spoof: adapter.defaultSpoof, target: adapter.defaultTarget }];
  return list.map((p) => ({
    spoof: p.spoof || adapter.defaultSpoof,
    target: p.target || adapter.defaultTarget,
  }));
}

module.exports = {
  configDir, configPathFor, pidPathFor, logPathFor, templatePath,
  parseEnv, parseModelMap, resolvePairs, resolveConfigPath, loadConfig, validate,
  ensureConfig, importConfig, editConfig, showConfig, mask, ensureDir,
};
