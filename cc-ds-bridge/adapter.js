'use strict';

// DeepSeek 上游适配器 —— Claude Code ↔ DeepSeek-V4 桥接的上游专属逻辑。
// 框架层（core/server.js）按统一 adapter 接口调用本文件。新增其它上游时，
// 在各自的 cc-<name>-bridge/adapter.js 实现同一接口即可，无需改动 core/。
//
// DeepSeek 提供官方 Anthropic 兼容端点（base_url 为 https://api.deepseek.com/anthropic，
// 接收标准 Anthropic Messages API 格式），故本桥直接透传 Anthropic 请求体，只需做
// DeepSeek 专属的清洗与思考等级适配。兼容细节见 DeepSeek 官方文档
// 「Using the Anthropic API」一章的 compatibility 表。
//
// 历史：早期 /anthropic 端点对「同一 assistant 消息含多个 tool_use（并发工具调用）」
// 返回 400，故曾临时改走 OpenAI 兼容端点（makeUpstreamCall + core/anthropic-openai-
// converter，见 2.7.6~2.7.9 的 CHANGELOG）。2026-08 实测并发 tool_use 已放行（历史与
// 输出两个方向均 200），切回原生 Anthropic 直传路径——DeepSeek 隐式 Context Caching
// 按「完整前缀单元」匹配，直传时 system / tools / 会话历史前缀稳定，缓存命中率从转换
// 流的 ~65% 恢复到直传的 ~98%。

// DeepSeek 系列模型的最大输出 token 钳制值。DeepSeek-V4 系列（pro / flash）上下文
// 窗口 1M、单次输出能力充裕（官方未公布精确输出上限，第三方实测 v4-flash 可达 384K），
// 远超 Claude Code 单次实际输出。此处钳到 128K 为保守保护值——确保偶发的超大
// max_tokens 不触发上游拒绝，又不人为限制正常输出；需要更大输出可自行调高。
const MODEL_MAX_TOKENS = {
  'deepseek-v4-pro': 131072,
  'deepseek-v4-flash': 131072,
};

// Claude Code 的 output_config.effort 等级 → DeepSeek 的 reasoning_effort。
// DeepSeek-V4 思考分三态：Non-think / Think High / Think Max，与 GLM 的
// none / high / max 等级模型一致。预留：当前主路径按模型钉死思考等级（见
// MODEL_THINKING），不读客户端 effort，故本函数暂未被调用；保留供将来
// 「auto（跟随客户端 effort）」模式使用。
function mapEffortToDeepSeek(effort) {
  if (!effort) return null;
  const e = String(effort).toLowerCase();
  // DeepSeek reasoning_effort 取值：max（最高，对应 Think Max）/ high（对应 Think High）；
  // none / minimal → 关闭思考（thinking.type=disabled 时 reasoning_effort 会被上游忽略）。
  if (e === 'max' || e === 'xhigh') return 'max';
  if (e === 'high' || e === 'medium' || e === 'low') return 'high';
  if (e === 'minimal' || e === 'none') return 'none';
  return null; // 未知值不写
}

// 递归剥离所有 cache_control 字段。DeepSeek 官方兼容表明确 cache_control 标记为
// Ignored——DeepSeek 有自己的隐式 Context Caching（按 prompt 前缀自动匹配，不读
// Anthropic 的 cache_control 标记），留着只是请求体膨胀，故全量剥离。
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
  name: 'ds',
  displayName: 'DeepSeek-V4 (api.deepseek.com)',
  defaultTarget: 'deepseek-v4-pro',
  defaultSpoof: 'claude-opus-4-8',
  // 默认思考等级（max / high / none）。仅当 MODEL_THINKING 未列出某模型、且
  // MODEL_THINKING_DEFAULT 也未配时用它兜底。DeepSeek-V4 思考三态（Non-think /
  // Think High / Think Max）与 GLM 等级模型一致，故沿用 max。server 启动时会把
  // 用户配置注入 modelThinking（按模型等级表）和 thinkingDefault（MODEL_THINKING_DEFAULT）。
  defaultThinking: 'max',
  modelMaxTokens: MODEL_MAX_TOKENS,

  // 改写 Anthropic 请求体（DeepSeek 专属适配）。ctx = { target }。
  // 改写项：
  //   · thinking / reasoning_effort：按 target 模型查 MODEL_THINKING 的等级（max/high/none）
  //     钉死，忽略客户端 effort；未列出的模型用默认等级（见 defaultThinking）
  //   · 剥离 context_management （Claude Code 专有，DeepSeek 不识别）
  //   · 清洗 metadata.user_id （DeepSeek 虽支持 user_id 做限流隔离，但 CC 传的是设备
  //     指纹 / session_id，对单用户限流无意义且泄露隐私，故清空）
  //   · 递归剥离 cache_control （DeepSeek 忽略该标记；不另行在 tools 打标——DeepSeek
  //     缓存是隐式自动的，缓存命中由 framework 从上游 usage 旁路观测）
  //   · 钳 max_tokens 到目标模型上限
  //   · 剥离 Anthropic 专有 system 段（billing header / Agent SDK 声明）
  adaptRequestBody(obj, ctx) {
    if (!obj || typeof obj !== 'object') return obj;
    const targetModel = (ctx && ctx.target) || this.defaultTarget;

    // 思考等级：按 target 模型查 MODEL_THINKING（server 启动时注入 this.modelThinking），
    // 未列出则用 this.thinkingDefault（MODEL_THINKING_DEFAULT）→ 再退 this.defaultThinking。
    // DeepSeek-V4 思考三态与 GLM 等级模型完全对应：none→不思考，max/high→开思考并写对应
    // 等级（max=Think Max，high=Think High）。三处字段（thinking.type + reasoning_effort +
    // output_config.effort）对称写入，确保无论 DeepSeek 读哪个都一致：
    //   none  → thinking.disabled + reasoning_effort=none + effort=none（不思考）
    //   max/high → thinking.enabled + reasoning_effort=level + effort=level
    const level =
      (this.modelThinking && this.modelThinking[targetModel]) ||
      this.thinkingDefault || this.defaultThinking || 'max';
    if (!obj.output_config || typeof obj.output_config !== 'object') obj.output_config = {};
    if (level === 'none') {
      obj.thinking = { type: 'disabled' };
      obj.reasoning_effort = 'none';
      obj.output_config.effort = 'none';
    } else {
      obj.thinking = { type: 'enabled' };
      obj.reasoning_effort = level;
      obj.output_config.effort = level;
    }

    // 剥离 context_management
    if (obj.context_management) delete obj.context_management;

    // 清洗 metadata.user_id（DeepSeek 虽支持 user_id 做限流隔离，但 CC 传的值无意义）
    if (obj.metadata && 'user_id' in obj.metadata) obj.metadata.user_id = '';

    // 递归剥离 cache_control（DeepSeek 忽略该标记）
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

    // 注：不在 tools 尾部打 cache_control——DeepSeek 官方兼容表明确 cache_control 为
    // Ignored，其 Context Caching 是隐式自动的（按 prompt 前缀匹配），不读该标记。
    // 缓存命中情况由 framework 从上游响应的 usage 旁路观测（见 core/server.js 的
    // formatCacheUsage），无需在请求体打标。

    return obj;
  },
};
