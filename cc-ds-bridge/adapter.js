'use strict';

// DeepSeek 上游适配器 —— Claude Code ↔ DeepSeek-V4 桥接的上游专属逻辑。
// 框架层（core/server.js）按统一 adapter 接口调用本文件。新增其它上游时，
// 在各自的 cc-<name>-bridge/adapter.js 实现同一接口即可，无需改动 core/。
//
// DeepSeek 的 Anthropic 兼容端点（/anthropic）不支持并发 tool_use（多个
// tool_use block 出现在同一 assistant 消息中会返回 400），但 OpenAI 兼容端点
// （/chat/completions）支持并发 tool_calls。因此本 adapter 实现
// makeUpstreamCall()：把 Anthropic 请求体转为 OpenAI 格式，调 DeepSeek 的
// OpenAI 端点，再把响应转回 Anthropic 格式——对 Claude Code 完全透明。

const https = require('https');
const {
  convertRequestToOpenAI,
  convertResponseToAnthropic,
  streamOpenAIToAnthropic,
  stripCacheControl,
} = require('../core/anthropic-openai-converter');

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

// stripCacheControl 从 converter 模块导入（与 GLM adapter 共用同一实现）。

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

  // 接管上游请求：Anthropic → OpenAI 格式转换 + 调 DeepSeek OpenAI 端点 +
  // OpenAI → Anthropic 格式转回。绕开 DeepSeek Anthropic 兼容端点的并发 tool_use 限制。
  //
  // 调用时机：server 在 send() 里检测到本方法存在时，把请求控制权交给 adapter；
  // adapter 自行构建 HTTPS 请求、处理上游响应、返回 Anthropic 格式结果。
  // server 在拿到返回结果后走 handleUpstreamResponse（注入 modelUsage / 统计 usage）。
  //
  // @param {object} ctx - { apiKey, anthropicBody, method, stream, log }
  // @returns {Promise<object>} - resolve Anthropic 格式的上游响应对象（stream / non-stream）
  //   non-stream: { status, headers, body: Buffer }
  //   stream: { status, headers, stream: Readable }
  // @throws {Object} - { status, err } 让 server 的 failover 逻辑判断重试 / 换 KEY
  makeUpstreamCall(ctx) {
    const { apiKey, anthropicBody, stream, log } = ctx;

    // 1. Anthropic → OpenAI 请求体
    const { body: openaiBody } = convertRequestToOpenAI(anthropicBody);

    // 2. DeepSeek OpenAI 端点参数
    //    base 从 this.apiBase（server 启动时注入）去掉 /anthropic 后缀，拼 /chat/completions。
    //    若 apiBase 不含 /anthropic 后缀，直接拼。
    const rawBase = (this.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');
    const openaiBase = rawBase.replace(/\/anthropic$/i, '');
    const url = new URL(`${openaiBase}/chat/completions`);
    const bodyStr = JSON.stringify(openaiBody);

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(bodyStr),
    };

    if (log) log(`  → OpenAI endpoint: ${url.hostname}${url.pathname}  stream=${stream}`);

    // 3. 发送请求
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      }, (upRes) => {
        const status = upRes.statusCode || 502;

        // 上游错误：读完错误响应体再向上抛——DeepSeek 的 4xx 体里带具体原因
        // （如 reasoning_content 未回传 / 模型不存在），丢失它会让排障变成盲猜。
        if (status >= 400) {
          const errChunks = [];
          upRes.on('data', (c) => errChunks.push(c));
          upRes.on('end', () => {
            const raw = Buffer.concat(errChunks).toString('utf-8');
            let detail = '';
            try { detail = (JSON.parse(raw).error || {}).message || ''; } catch { /* 非 JSON */ }
            if (!detail) detail = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
            const suffix = detail ? `: ${detail}` : '';
            reject({ status, err: new Error(`DeepSeek OpenAI endpoint returned ${status}${suffix}`) });
          });
          upRes.on('error', () => {
            reject({ status, err: new Error(`DeepSeek OpenAI endpoint returned ${status}`) });
          });
          return;
        }

        if (stream) {
          // 流式：逐 chunk 实时转换转发（thinking / text 实时输出，tool_calls 在
          // 流末尾批量输出）。边收边转让 Claude Code 逐字看到思考与正文，而不是
          // 等上游全部生成完再一次性返回（此前缓冲整流的做法会「卡很久然后突然
          // 闪出一大段」）。
          const anthropicStream = streamOpenAIToAnthropic(upRes, anthropicBody.model);
          resolve({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            stream: anthropicStream,
          });
          // upRes 的 error 由 streamOpenAIToAnthropic 内部转给 out 流（destroy）；
          // 这里不再 reject——resolve 已发出，reject 无意义。
        } else {
          // 非流式：缓冲完整响应，转为 Anthropic 格式
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            try {
              const openaiRes = JSON.parse(raw);
              const anthropicRes = convertResponseToAnthropic(openaiRes, anthropicBody.model);
              const anthropicBodyStr = JSON.stringify(anthropicRes);
              resolve({
                status: 200,
                headers: {
                  'content-type': 'application/json',
                  'content-length': String(Buffer.byteLength(anthropicBodyStr)),
                },
                body: Buffer.from(anthropicBodyStr, 'utf-8'),
              });
            } catch (e) {
              reject({ status, err: new Error(`Failed to convert OpenAI response: ${e.message}`) });
            }
          });
          upRes.on('error', (err) => reject({ status, err }));
        }
      });

      req.on('error', (err) => {
        reject({ status: 0, err });
      });

      req.write(bodyStr);
      req.end();
    });
  },
};
