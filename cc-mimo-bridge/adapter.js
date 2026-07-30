'use strict';

// MiMo（小米）上游适配器 —— Claude Code ↔ MiMo 桥接的上游专属逻辑。
// 框架层（core/server.js）按统一 adapter 接口调用本文件。新增其它上游时，
// 在各自的 cc-<name>-bridge/adapter.js 实现同一接口即可，无需改动 core/。

// MiMo 系列模型的最大输出 token 上限（来自小米 MIMO 文档）。用于把 Claude Code 设的
// max_tokens 钳到目标模型的合法范围，避免过大请求被上游拒绝。
const MODEL_MAX_TOKENS = {
  'mimo-v2.5-pro': 131072,
  'mimo-v2.5': 131072,
};

// Claude Code 的 output_config.effort 等级 → MiMo 的 thinking 开关。
// MiMo 官方 API 只支持两种状态（见官方文档）：
//   thinking.type = "enabled"  → 开启深度思考
//   thinking.type = "disabled" → 关闭深度思考
// 不支持中间等级（如 high/medium/low），因此将所有非 none 的 effort 映射为 enabled。
function mapEffortToMiMo(effort) {
  if (!effort) return null;
  const e = String(effort).toLowerCase();
  // none/minimal → 关闭思考
  if (e === 'none' || e === 'minimal') return 'disabled';
  // 其他所有值（max/xhigh/high/medium/low）→ 开启思考
  return 'enabled';
}

// 递归剥离所有 cache_control 字段。MiMo 不认 Anthropic 的 cache_control 标记，
// 留着只是请求体膨胀（随后按需在 tools 尾部重新打标）。
function stripCacheControl(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) stripCacheControl(item);
    return;
  }
  delete node.cache_control;
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') stripCacheControl(v);
  }
}

module.exports = {
  name: 'mimo',
  displayName: 'MiMo (Xiaomi)',
  defaultTarget: 'mimo-v2.5-pro',
  defaultSpoof: 'claude-opus-4-8',
  // 默认思考开关（enabled / disabled）。MiMo 官方 API 只支持这两种状态：
  //   enabled  → 开启深度思考
  //   disabled → 关闭深度思考
  // 仅当 MODEL_THINKING 未列出某模型、且 MODEL_THINKING_DEFAULT 也未配时用它兜底。
  // server 启动时会把用户配置注入 modelThinking 和 thinkingDefault。
  defaultThinking: 'enabled',
  modelMaxTokens: MODEL_MAX_TOKENS,

  // 改写 Anthropic 请求体（MiMo 专属适配）。ctx = { target }。
  // 改写项：
  //   · thinking / reasoning_effort：按 target 模型查 MODEL_THINKING 的等级（max/high/none）
  //     钉死，忽略客户端 effort；未列出的模型用默认等级（见 defaultThinking）
  //   · 剥离 context_management （Claude Code 专有，MiMo 不识别）
  //   · 清洗 metadata.user_id （设备指纹/session_id 发给 MiMo 无意义且泄露隐私）
  //   · 递归剥离 cache_control （随后按需在 tools 尾部重新打标）
  //   · 钳 max_tokens 到目标模型上限
  //   · 剥离 Anthropic 专有 system 段（billing header / Agent SDK 声明）
  //   · tools 尾部打 cache_control（触发 MiMo context caching）
  adaptRequestBody(obj, ctx) {
    if (!obj || typeof obj !== 'object') return obj;
    const targetModel = (ctx && ctx.target) || this.defaultTarget;

    // 思考开关：按 target 模型查 MODEL_THINKING（server 启动时注入 this.modelThinking），
    // 未列出则用 this.thinkingDefault（MODEL_THINKING_DEFAULT）→ 再退 this.defaultThinking。
    // MiMo 官方 API 只支持 thinking.type = "enabled" 或 "disabled"，不支持中间等级。
    //   disabled → thinking.disabled（不思考）
    //   enabled  → thinking.enabled（开启深度思考）
    const thinkingValue =
      (this.modelThinking && this.modelThinking[targetModel]) ||
      this.thinkingDefault || this.defaultThinking || 'enabled';
    if (thinkingValue === 'disabled') {
      obj.thinking = { type: 'disabled' };
    } else {
      obj.thinking = { type: 'enabled' };
    }

    // 剥离 context_management
    if (obj.context_management) delete obj.context_management;

    // 清洗 metadata.user_id
    if (obj.metadata && 'user_id' in obj.metadata) obj.metadata.user_id = '';

    // 递归剥离 cache_control
    stripCacheControl(obj);

    // 钳 max_tokens 到目标模型上限
    if (obj.max_tokens != null) {
      const cap = MODEL_MAX_TOKENS[targetModel];
      if (cap != null && obj.max_tokens > cap) obj.max_tokens = cap;
    }

    // 剥离 Anthropic 专有 system 段
    if (Array.isArray(obj.system)) {
      obj.system = obj.system.filter((block) => {
        if (!block || typeof block !== 'object') return true;
        const t = block.text || '';
        if (t.startsWith('x-anthropic-billing-header:')) return false;
        if (t.startsWith('You are a Claude agent, built on Anthropic')) return false;
        return true;
      });
      if (obj.system.length === 0) delete obj.system;
    }

    // tools 尾部打 cache_control（触发 MiMo context caching）
    if (Array.isArray(obj.tools) && obj.tools.length > 0) {
      const last = obj.tools[obj.tools.length - 1];
      if (last && typeof last === 'object') {
        last.cache_control = { type: 'ephemeral' };
      }
    }

    return obj;
  },
};
