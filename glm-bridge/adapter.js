'use strict';

// GLM (z.ai) 上游适配器 —— Claude Code ↔ GLM-5.2 桥接的上游专属逻辑。
// 框架层（core/server.js）按统一 adapter 接口调用本文件。新增其它上游（Kimi、Qwen…）
// 时，在各自的 <name>-bridge/adapter.js 实现同一接口即可，无需改动 core/。

// GLM 系列模型的最大输出 token 上限（来自 z.ai 文档）。用于把 Claude Code 设的
// max_tokens 钳到目标模型的合法范围，避免过大请求被上游拒绝。
const MODEL_MAX_TOKENS = {
  'glm-5.2': 131072,
  'glm-5.1': 131072,
  'glm-5-turbo': 131072,
  'glm-5v-turbo': 131072,
  'glm-5': 131072,
  'glm-4.7': 131072,
  'glm-4.6': 131072,
  'glm-4.5': 98304,
  'glm-4.5-air': 98304,
  'glm-4.5-x': 98304,
  'glm-4.5-airx': 98304,
  'glm-4.5-flash': 98304,
};

// Claude Code 的 output_config.effort 等级 → GLM 的 reasoning_effort。
// 依据 z.ai Coding Plan 接入文档的映射表。仅在 forceMaxEffort=false（跟随客户端）时用。
function mapEffortToGLM(effort) {
  if (!effort) return null;
  const e = String(effort).toLowerCase();
  // z.ai 官方映射：max/xhigh→max, high/medium/low→high, minimal/none→不思考
  if (e === 'max' || e === 'xhigh') return 'max';
  if (e === 'high' || e === 'medium' || e === 'low') return 'high';
  if (e === 'minimal' || e === 'none') return 'none';
  return null; // 未知值不写
}

// 递归剥离所有 cache_control 字段。z.ai 不认 Anthropic 的 cache_control 标记，
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
  name: 'glm',
  displayName: 'GLM-5.2 (z.ai)',
  defaultTarget: 'glm-5.2',
  defaultSpoof: 'claude-opus-4-8',
  // 强制 GLM-5.2 始终以 max 思考等级运行：无论 Claude Code 传来什么 effort，都把
  // reasoning_effort 钉为 'max'（并同步 output_config.effort='max'、确保 thinking 启用）。
  // 设为 false 则退回「跟随客户端 effort 映射」的行为（见 mapEffortToGLM）。
  forceMaxEffort: true,
  modelMaxTokens: MODEL_MAX_TOKENS,

  // 改写 Anthropic 请求体（GLM 专属适配）。ctx = { target }。
  // 改写项：
  //   · thinking.type: adaptive → enabled （z.ai 只认 enabled/disabled）
  //   · reasoning_effort：强制 max 或按 effort 映射
  //   · 剥离 context_management （Claude Code 专有，z.ai 不识别）
  //   · 清洗 metadata.user_id （设备指纹/session_id 发给 z.ai 无意义且泄露隐私）
  //   · 递归剥离 cache_control （随后按需在 tools 尾部重新打标）
  //   · 钳 max_tokens 到目标模型上限
  //   · 剥离 Anthropic 专有 system 段（billing header / Agent SDK 声明）
  //   · tools 尾部打 cache_control（触发 z.ai context caching）
  adaptRequestBody(obj, ctx) {
    if (!obj || typeof obj !== 'object') return obj;
    const targetModel = (ctx && ctx.target) || this.defaultTarget;

    // thinking.type: adaptive → enabled
    if (obj.thinking && obj.thinking.type === 'adaptive') {
      obj.thinking.type = 'enabled';
    }

    // reasoning_effort：强制 max，或跟随客户端 effort 映射。
    // 强制模式下三条保险：reasoning_effort=max + thinking.enabled + output_config.effort=max，
    // 确保 z.ai 无论读哪个字段都按 max 思考。
    if (this.forceMaxEffort) {
      obj.reasoning_effort = 'max';
      if (!obj.thinking || obj.thinking.type !== 'enabled') {
        obj.thinking = { type: 'enabled' };
      }
      if (!obj.output_config || typeof obj.output_config !== 'object') obj.output_config = {};
      obj.output_config.effort = 'max';
    } else {
      const effort = obj.output_config?.effort || obj.effort;
      const glmEffort = mapEffortToGLM(effort);
      if (glmEffort) obj.reasoning_effort = glmEffort;
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

    // tools 尾部打 cache_control（触发 z.ai context caching）
    if (Array.isArray(obj.tools) && obj.tools.length > 0) {
      const last = obj.tools[obj.tools.length - 1];
      if (last && typeof last === 'object') {
        last.cache_control = { type: 'ephemeral' };
      }
    }

    return obj;
  },
};
