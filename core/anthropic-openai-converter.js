'use strict';

/**
 * Anthropic ↔ OpenAI 格式双向转换器。
 *
 * 供需要走 OpenAI 兼容端点的上游 adapter 使用（如 DeepSeek，其 Anthropic 兼容端点
 * 不支持并发 tool_use，但 OpenAI 端点支持并发 tool_calls）。
 *
 * 导出：
 *   convertRequestToOpenAI(anthropicBody)     → { body, params }
 *   convertResponseToAnthropic(openaiBody, requestModel) → anthropicBody
 *   convertStreamToAnthropicEvents(openaiSseText, requestModel) → anthropicSseText
 *   stripCacheControl(node)                   递归剥离 cache_control
 *
 * 思考内容双向映射（DeepSeek-V4 thinking 模式的硬要求）：
 *   响应方向：reasoning_content → Anthropic thinking block（CC 收到后会在后续请求回传）
 *   请求方向：assistant 的 thinking block → reasoning_content 字段
 *   DeepSeek 规则（实测）：请求以 tool 消息结尾（tool 结果续接）时，带 tool_calls 的
 *   assistant 消息必须携带 reasoning_content，否则 400「The `reasoning_content` in the
 *   thinking mode must be passed back to the API.」。缺失时用占位符兜底（兼容修复前
 *   生成的无思考历史会话）。
 */

// ─── 请求转换：Anthropic → OpenAI ─────────────────────────────────────────

/**
 * Anthropic system 字段可能是字符串或 block 数组（[{type:'text',text:'...'}]）。
 * 提取纯文本返回。
 */
function extractSystemText(system) {
  if (!system) return null;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    const parts = system
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && b.text)
      .map((b) => b.text);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

/**
 * 把 Anthropic messages 数组转为 OpenAI messages 数组。
 *
 * 关键映射：
 *   · assistant 消息中多个 content block（text + tool_use）→ OpenAI 的
 *     content(string) + tool_calls(array) 分离结构
 *   · user 消息中 tool_result block → role:"tool" 独立消息
 */
function convertMessages(anthropicMessages) {
  const out = [];
  if (!Array.isArray(anthropicMessages)) return out;

  for (const msg of anthropicMessages) {
    if (!msg || !msg.role) continue;

    if (msg.role === 'assistant') {
      const textParts = [];
      const thinkingParts = [];
      const toolCalls = [];

      if (typeof msg.content === 'string') {
        textParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && block.text != null) {
            textParts.push(block.text);
          } else if (block.type === 'thinking' && block.thinking) {
            // 思考内容 → reasoning_content 字段（DeepSeek thinking 模式要求原样回传；
            // 并入正文文本会被视为普通输出，上游照样 400）。signature 是 Anthropic 专有，
            // DeepSeek 不读，丢弃。
            thinkingParts.push(block.thinking);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: typeof block.input === 'string'
                  ? block.input
                  : JSON.stringify(block.input || {}),
              },
            });
          }
          // redacted_thinking 无法还原文本，跳过（极端情况下由下方占位符兜底）
        }
      }

      const assistantMsg = { role: 'assistant' };
      const text = textParts.join('');
      if (text) assistantMsg.content = text;
      else if (toolCalls.length) assistantMsg.content = null;
      if (thinkingParts.length) assistantMsg.reasoning_content = thinkingParts.join('');
      if (toolCalls.length) {
        assistantMsg.tool_calls = toolCalls;
        // 兜底：tool_calls 回合缺 reasoning_content 时补占位符——DeepSeek thinking 模式下，
        // 「tool 结果续接」请求里该字段缺失会 400；占位符对 OpenAI 兼容端点无副作用
        // （不认识的字段被忽略），主要兼容本修复落地前生成的无思考历史会话。
        if (assistantMsg.reasoning_content == null) assistantMsg.reasoning_content = ' ';
      }
      out.push(assistantMsg);

    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // tool_result → role:"tool" 独立消息，且必须先于同 user 消息内的正文发出。
        // OpenAI / DeepSeek 硬性要求：带 tool_calls 的 assistant 消息之后必须紧接
        // 覆盖每个 tool_call_id 的 tool 消息，中间不能夹 user 消息；而 Anthropic
        // 允许 text 与 tool_result 混在同一 user 消息里，拆开时若正文在前会插到
        // assistant tool_calls 与 tool 响应之间 → 上游 400「insufficient tool
        // messages following tool_calls message」。故 tool 排前、正文排后。
        const toolResults = msg.content.filter(
          (b) => b && typeof b === 'object' && b.type === 'tool_result',
        );
        for (const tr of toolResults) {
          let content;
          if (typeof tr.content === 'string') {
            content = tr.content;
          } else if (Array.isArray(tr.content)) {
            const texts = tr.content
              .filter((b) => b && b.type === 'text' && b.text != null)
              .map((b) => b.text);
            content = texts.join('\n') || '';
          } else {
            content = '';
          }
          // 缺 tool_use_id 的 tool_result 无法对应任何 tool_call，丢弃以免产生
          // 孤立 tool 消息触发上游 400。
          if (tr.tool_use_id == null) continue;
          out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content });
        }

        // 非 tool_result 的 user 内容（text / image 等）
        const nonToolBlocks = msg.content.filter(
          (b) => b && typeof b === 'object' && b.type !== 'tool_result',
        );
        for (const block of nonToolBlocks) {
          if (block.type === 'text' && block.text != null) {
            out.push({ role: 'user', content: block.text });
          }
          // image / other types → 暂不转换（DeepSeek function calling 场景下极少出现）
        }
      }
    }
    // system 消息由 extractSystemText 单独处理，不进 messages
  }
  return out;
}

/**
 * 兜底修复转换后的 OpenAI messages，满足 OpenAI / DeepSeek 的 tool 序列硬性约束：
 * 带 tool_calls 的 assistant 消息之后必须紧接覆盖每个 tool_call_id 的 tool 消息。
 *
 * 触发场景：Claude Code 的上下文压缩（/compact、自动压缩）或历史截断会把某轮
 * assistant 的 tool_use 留下、却丢掉了其后的 tool_result——转换后便出现孤立的
 * tool_calls；或是压缩摘要本身把 tool 回合拦腰截断。这类请求发给 DeepSeek 会
 * 直接 400「An assistant message with 'tool_calls' must be followed by tool
 * messages responding to each 'tool_call_id'」。
 *
 * 修复策略（只动异常序列，正常历史原样保留）：
 *   · assistant 消息带 tool_calls，但其后没有覆盖全部 id 的 tool 消息 → 从该
 *     assistant 消息上剥离 tool_calls（保留正文与思考内容），使序列合法；
 *   · 孤立的 tool 消息（其 tool_call_id 无对应的 assistant tool_calls）→ 丢弃，
 *     避免「tool 消息没有前置 tool_calls」的对称错误。
 *
 * @param {Array<object>} msgs 转换后的 OpenAI messages
 * @returns {Array<object>} 修复后的 messages
 */
function repairToolSequences(msgs) {
  if (!Array.isArray(msgs) || msgs.length === 0) return msgs;
  const out = [];
  // 当前「待响应」的 tool 状态：{ ids: 未响应 id 集合, assistantIndex: 该 assistant
  // 在 out 中的下标 }。遇到 role=tool 且 id 命中即从未响应集合移除；遇到新的
  // assistant / user / system 消息或到达末尾时，若仍有未响应 id，说明该轮
  // tool_calls 是截断残留 → 剥离并清理。
  let pending = null;

  const stripPending = () => {
    if (!pending || pending.ids.size === 0) return;
    const a = out[pending.assistantIndex];
    if (a && a.role === 'assistant') {
      delete a.tool_calls;
      // 仅含 tool_calls 的 assistant 消息 content 为 null，剥离后补空串，
      // 避免「无正文且无 tool_calls 的 assistant 消息」触发其它校验。
      if (a.content == null) a.content = '';
      // reasoning_content 占位符（' '）仅为 tool_calls 回合兜底，随 tool_calls
      // 一起移除，避免无谓的思考占位污染上下文。
      if (a.reasoning_content === ' ') delete a.reasoning_content;
      // 已发出的、响应这批 tool_calls 的 tool 消息随之成为孤儿（其 tool_calls
      // 已被剥离），一并移除，避免「tool 消息没有前置 tool_calls」的对称 400。
      out.splice(pending.assistantIndex + 1, out.length - pending.assistantIndex - 1);
    }
    pending = null;
  };

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant') {
      stripPending();
      pending = Array.isArray(m.tool_calls) && m.tool_calls.length
        ? { ids: new Set(m.tool_calls.map((tc) => tc && tc.id).filter((id) => id != null)), assistantIndex: out.length }
        : null;
      out.push(m);
    } else if (m.role === 'tool') {
      if (pending && m.tool_call_id != null && pending.ids.has(m.tool_call_id)) {
        pending.ids.delete(m.tool_call_id);
        out.push(m);
      }
      // 孤立 tool 消息：无对应 assistant tool_calls（压缩把前置 assistant 整条
      // 丢掉了），或 id 不在当前待响应集合中。留着会触发「tool 消息没有前置
      // tool_calls」400，直接丢弃。
    } else {
      // user / system：新消息打断。若此时还有未响应的 tool_calls → 截断残留。
      stripPending();
      out.push(m);
    }
  }
  // 尾部：请求以「带 tool_calls 的 assistant」结束（无任何后续消息），同属截断残留。
  stripPending();

  return out;
}

/**
 * 把 Anthropic tools 定义转为 OpenAI function 定义。
 */
function convertTools(anthropicTools) {
  if (!Array.isArray(anthropicTools)) return undefined;
  const converted = anthropicTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.input_schema ? { parameters: t.input_schema } : {}),
    },
  }));
  return converted.length ? converted : undefined;
}

/**
 * 把 Anthropic tool_choice 转为 OpenAI tool_choice。
 *
 * Anthropic: { type: "auto"|"any"|"tool"|"none", name?: "..." }
 * OpenAI:    "auto" | "required" | "none" | { type:"function", function:{ name:"..." } }
 */
function convertToolChoice(anthropicTc) {
  if (!anthropicTc) return undefined;
  if (typeof anthropicTc === 'string') return anthropicTc;
  if (typeof anthropicTc !== 'object') return undefined;
  switch (anthropicTc.type) {
    case 'auto': return 'auto';
    case 'none': return 'none';
    case 'any': return 'required';
    case 'tool':
      if (anthropicTc.name) {
        return { type: 'function', function: { name: anthropicTc.name } };
      }
      return 'auto';
    default: return 'auto';
  }
}

/**
 * 主入口：把 Anthropic /v1/messages 请求体转为 OpenAI /chat/completions 请求体。
 *
 * @param {object} anthropicBody - Claude Code 发来的原始请求体
 * @returns {{ body: object }} 转换后的 OpenAI 请求体
 */
function convertRequestToOpenAI(anthropicBody) {
  const messages = [];

  // system → OpenAI system message
  const systemText = extractSystemText(anthropicBody.system);
  if (systemText) messages.push({ role: 'system', content: systemText });

  // messages
  // repairToolSequences：兜底修复上下文压缩 / 历史截断残留的 tool 序列（见函数注释），
  // 避免「assistant tool_calls 后无对应 tool 消息」被 DeepSeek 400 拒收。
  messages.push(...repairToolSequences(convertMessages(anthropicBody.messages)));

  // 构建 OpenAI 请求体
  const openaiBody = {
    model: anthropicBody.model, // 已被 server 改写为 target（如 deepseek-v4-pro）
    messages,
  };

  // max_tokens → max_completion_tokens
  if (anthropicBody.max_tokens != null) {
    openaiBody.max_completion_tokens = anthropicBody.max_tokens;
  }

  // stream
  if (anthropicBody.stream) {
    openaiBody.stream = true;
    // 请求 OpenAI 在流末尾发送 usage 统计（默认流式不发）。
    // DeepSeek 支持此参数；拿到 usage 后转为 Anthropic message_delta 的 usage 字段，
    // 让 cc-bridge stats 正确累计输出 token。
    openaiBody.stream_options = { include_usage: true };
  }

  // tools / tool_choice
  const tools = convertTools(anthropicBody.tools);
  if (tools) openaiBody.tools = tools;
  const tc = convertToolChoice(anthropicBody.tool_choice);
  if (tc !== undefined) openaiBody.tool_choice = tc;

  // temperature（透传）
  if (anthropicBody.temperature != null) openaiBody.temperature = anthropicBody.temperature;

  // 思考参数透传（adapter 已按模型钉死等级后写入 anthropicBody）：
  //   reasoning_effort = max/high → 开思考并定级；none → 关思考
  //   thinking.type = disabled   → 关思考（DeepSeek 两者都认，对称写入确保一致）
  // 实测：deepseek-v4 默认开思考；不传这两个字段时思考也是开的。
  if (anthropicBody.reasoning_effort != null) openaiBody.reasoning_effort = anthropicBody.reasoning_effort;
  if (anthropicBody.thinking && anthropicBody.thinking.type === 'disabled') {
    openaiBody.thinking = { type: 'disabled' };
  }

  return { body: openaiBody };
}

// ─── 响应转换：OpenAI → Anthropic ─────────────────────────────────────────

/**
 * 递归尝试解析 JSON 字符串；失败返回原值。
 */
function tryParseJSON(str) {
  if (typeof str !== 'string') return str;
  try { return JSON.parse(str); } catch { return str; }
}

/**
 * 把 OpenAI /chat/completions 非流式响应转为 Anthropic Messages API 响应格式。
 *
 * @param {object} openaiRes - OpenAI 响应体
 * @param {string} requestModel - 请求中的 model（用于填充 Anthropic 响应的 model 字段）
 * @returns {object} Anthropic 格式响应体
 */
function convertResponseToAnthropic(openaiRes, requestModel) {
  const choice = (openaiRes.choices && openaiRes.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];

  // reasoning_content → thinking block（必须在 text 之前，Anthropic 规范要求 thinking 居首；
  // CC 收到后会在后续请求回传，满足 DeepSeek thinking 模式的 reasoning_content 回传要求）
  if (msg.reasoning_content) {
    content.push({ type: 'thinking', thinking: msg.reasoning_content });
  }

  // text content
  if (msg.content != null && msg.content !== '') {
    content.push({ type: 'text', text: msg.content });
  }

  // tool_calls → tool_use content blocks
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!tc || !tc.function) continue;
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: tryParseJSON(tc.function.arguments),
      });
    }
  }

  const usage = openaiRes.usage || {};
  return {
    id: openaiRes.id || 'msg_openai_bridge',
    type: 'message',
    role: 'assistant',
    model: requestModel || openaiRes.model || 'unknown',
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

/**
 * OpenAI finish_reason → Anthropic stop_reason。
 */
function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return reason || 'end_turn';
  }
}

// ─── 流式响应转换：OpenAI SSE → Anthropic SSE ─────────────────────────────

/**
 * 把 OpenAI SSE 流式文本（多个 "data: {...}\n\n" 事件）转为 Anthropic SSE 事件序列。
 *
 * 策略：先缓冲所有 OpenAI chunk，收集完整响应后再一次性转为 Anthropic 格式。
 * 对于触发并发 tool_use 的场景（工具调用通常不长），延迟可接受。
 *
 * @param {string} openaiSseText - OpenAI 完整 SSE 文本
 * @param {string} requestModel - 请求中的 model
 * @returns {string} Anthropic SSE 事件文本
 */
function convertStreamToAnthropicEvents(openaiSseText, requestModel) {
  const lines = openaiSseText.split('\n');
  let role = 'assistant';
  let contentText = '';
  let reasoningText = '';
  const toolCalls = {}; // index → { id, name, arguments }
  let finishReason = null;

  let usage = null; // OpenAI 流末尾的 usage（stream_options.include_usage=true 时有）

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }

    // stream_options.include_usage=true 时，OpenAI 在流末尾发一个无 choices 的 chunk，
    // 仅含 usage 字段。提取它用于 Anthropic message_delta 的 usage。
    if (chunk.usage && (!chunk.choices || !chunk.choices.length)) {
      usage = chunk.usage;
      continue;
    }

    const delta = (chunk.choices && chunk.choices[0] && chunk.choices[0].delta) || {};
    if (delta.role) role = delta.role;
    if (delta.content) contentText += delta.content;
    if (delta.reasoning_content) reasoningText += delta.reasoning_content;

    // tool_calls delta 累积
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index != null ? tc.index : 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', arguments: '' };
        if (tc.id) toolCalls[idx].id += tc.id;
        if (tc.function) {
          if (tc.function.name) toolCalls[idx].name += tc.function.name;
          if (tc.function.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }
    }

    const fr = chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason;
    if (fr) finishReason = fr;
  }

  // 从累积数据构建 Anthropic 响应（thinking 必须居首）
  const content = [];
  if (reasoningText) content.push({ type: 'thinking', thinking: reasoningText });
  if (contentText) content.push({ type: 'text', text: contentText });

  const tcArray = Object.keys(toolCalls).sort().map((k) => toolCalls[k]);
  for (const tc of tcArray) {
    content.push({
      type: 'tool_use',
      id: tc.id || undefined,
      name: tc.name,
      input: tryParseJSON(tc.arguments || '{}'),
    });
  }

  const anthropicRes = {
    id: 'msg_openai_bridge_stream',
    type: 'message',
    role,
    model: requestModel || 'unknown',
    content,
    stop_reason: mapFinishReason(finishReason),
    usage: {
      input_tokens: (usage && usage.prompt_tokens) || 0,
      output_tokens: (usage && usage.completion_tokens) || 0,
    },
  };

  // 以 Anthropic streaming 格式输出事件序列
  const events = [];

  // message_start
  events.push('event: message_start');
  events.push(`data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: anthropicRes.id,
      type: 'message',
      role: anthropicRes.role,
      model: anthropicRes.model,
      content: [],
      usage: { input_tokens: anthropicRes.usage.input_tokens, output_tokens: 0 },
    },
  })}`);

  // content_block_start + content_block_delta + content_block_stop（逐 block）
  for (let i = 0; i < content.length; i++) {
    const block = content[i];

    events.push('event: content_block_start');
    if (block.type === 'thinking') {
      events.push(`data: ${JSON.stringify({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'thinking', thinking: '' },
      })}`);
      events.push('event: content_block_delta');
      events.push(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: i,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      })}`);
    } else if (block.type === 'text') {
      events.push(`data: ${JSON.stringify({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      })}`);
      events.push('event: content_block_delta');
      events.push(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: i,
        delta: { type: 'text_delta', text: block.text },
      })}`);
    } else if (block.type === 'tool_use') {
      events.push(`data: ${JSON.stringify({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: '' },
      })}`);
      events.push('event: content_block_delta');
      events.push(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      })}`);
    }

    events.push('event: content_block_stop');
    events.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: i })}`);
  }

  // message_delta（stop_reason + usage）
  events.push('event: message_delta');
  events.push(`data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: anthropicRes.stop_reason },
    usage: { output_tokens: anthropicRes.usage.output_tokens },
  })}`);

  // message_stop
  events.push('event: message_stop');
  events.push(`data: ${JSON.stringify({ type: 'message_stop' })}`);

  return events.join('\n') + '\n';
}

/**
 * 流式转换：OpenAI SSE 流 → Anthropic SSE 流（逐 chunk 实时转发）。
 *
 * 与 convertStreamToAnthropicEvents（缓冲全部 SSE 后一次性转换）不同，本函数
 * 边收边转：thinking / text 内容到达即实时转为 Anthropic 的 content_block 事件
 * 输出，Claude Code 能逐字看到思考与正文流式出现，而非等上游全部生成完才一次性
 * 闪出。工具调用（tool_calls）因 OpenAI 流式按 index 增量分段传输、需收齐后才能
 * 拼出完整 input，统一在流末尾批量输出（工具调用通常不长，延迟可接受）。
 *
 * @param {Readable} openaiStream - DeepSeek OpenAI 端点的 SSE 流（upRes）
 * @param {string} requestModel - 请求中的 model
 * @param {number} [estimatedInputTokens] - 预估值（来自请求体估算），用于在
 *   message_start 填充 input_tokens——OpenAI 流式 usage 只在流末尾返回，提前
 *   填入可让 Claude Code 界面在流一开始就显示输入 token 计数。
 * @returns {Readable} Anthropic SSE 文本流
 */
function streamOpenAIToAnthropic(openaiStream, requestModel, estimatedInputTokens) {
  const { Readable } = require('stream');
  const out = new Readable({ read() {} });

  let sseBuf = '';          // 跨 chunk 的 SSE 行缓冲
  let started = false;      // message_start 是否已发
  let openBlockType = null; // 当前打开的 block 类型：'thinking' | 'text' | null
  let openBlockIndex = -1;  // 当前打开 block 的 index（-1 = 无）
  let blockCount = 0;       // 已打开的 content_block 总数（下一个 index）
  let finishReason = null;  // OpenAI finish_reason
  let usage = null;         // 流末尾 usage chunk（include_usage）
  const toolCalls = {};     // OpenAI tool_call index → { id, name, args }
  let done = false;         // finish() 只执行一次

  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

  const closeBlock = () => {
    if (openBlockIndex < 0) return '';
    const s = ev('content_block_stop', { type: 'content_block_stop', index: openBlockIndex });
    openBlockType = null;
    openBlockIndex = -1;
    return s;
  };

  // 打开指定类型的 block（同类型复用当前 block；切换类型先关闭旧 block）。
  const startBlock = (type, contentBlock) => {
    if (openBlockType === type) return '';
    let s = closeBlock();
    const i = blockCount++;
    openBlockType = type;
    openBlockIndex = i;
    s += ev('content_block_start', {
      type: 'content_block_start',
      index: i,
      content_block: contentBlock,
    });
    return s;
  };

  // 流收尾：关闭当前 block → 批量输出 tool_use blocks → message_delta → message_stop。
  const finish = () => {
    if (done) return '';
    done = true;
    let s = closeBlock();
    const idxs = Object.keys(toolCalls).sort((a, b) => Number(a) - Number(b));
    for (const k of idxs) {
      const tc = toolCalls[k];
      const i = blockCount++;
      s += ev('content_block_start', {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: '' },
      });
      s += ev('content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: tc.args },
      });
      s += ev('content_block_stop', { type: 'content_block_stop', index: i });
    }
    // 流末尾的真实 usage（include_usage chunk）已到手：output_tokens 是精确值，
    // input_tokens 用真实 prompt_tokens 覆盖 message_start 里的估算值，让
    // Claude Code 在流结束时得到完整准确的 usage。
    s += ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinishReason(finishReason) },
      usage: {
        input_tokens: (usage && usage.prompt_tokens) || 0,
        output_tokens: (usage && usage.completion_tokens) || 0,
      },
    });
    s += ev('message_stop', { type: 'message_stop' });
    return s;
  };

  // 处理一行 "data: {...}"，返回要输出的 Anthropic SSE 文本（可能为空串）。
  function processData(data) {
    if (data === '[DONE]') return '';
    let chunk;
    try { chunk = JSON.parse(data); } catch { return ''; }

    // 流末尾的 usage-only chunk（stream_options.include_usage=true 时，无 choices）。
    if (chunk.usage && (!chunk.choices || !chunk.choices.length)) {
      usage = chunk.usage;
      return '';
    }

    const choice = (chunk.choices && chunk.choices[0]) || {};
    const delta = choice.delta || {};
    let s = '';

    if (!started) {
      started = true;
      // 流式响应中真实 usage 只在流末尾返回（include_usage chunk），message_start
      // 阶段拿不到——用请求侧估算值预填 input_tokens，让 CC 界面在流一开始就有
      // 接近真实的输入计数；流末尾 message_delta 再以真实 usage 为准。
      s += ev('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_openai_bridge_stream',
          type: 'message',
          role: delta.role || 'assistant',
          model: requestModel || 'unknown',
          content: [],
          usage: { input_tokens: estimatedInputTokens || 0, output_tokens: 0 },
        },
      });
    }

    // thinking：实时转为 thinking block + thinking_delta
    if (delta.reasoning_content) {
      s += startBlock('thinking', { type: 'thinking', thinking: '' });
      s += ev('content_block_delta', {
        type: 'content_block_delta',
        index: openBlockIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      });
    }

    // text：实时转为 text block + text_delta
    if (delta.content) {
      s += startBlock('text', { type: 'text', text: '' });
      s += ev('content_block_delta', {
        type: 'content_block_delta',
        index: openBlockIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    // tool_calls：增量累积，流末尾统一输出（见 finish()）
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index != null ? tc.index : 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', args: '' };
        if (tc.id) toolCalls[idx].id += tc.id;
        if (tc.function) {
          if (tc.function.name) toolCalls[idx].name += tc.function.name;
          if (tc.function.arguments) toolCalls[idx].args += tc.function.arguments;
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
    return s;
  }

  openaiStream.on('data', (chunk) => {
    sseBuf += chunk.toString('utf-8');
    let nl;
    while ((nl = sseBuf.indexOf('\n')) >= 0) {
      const line = sseBuf.slice(0, nl).trim();
      sseBuf = sseBuf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      const s = processData(data);
      if (s) out.push(s);
    }
  });
  openaiStream.on('end', () => {
    // 处理缓冲区可能残留的最后一行（无换行结尾）
    if (sseBuf.trim()) {
      const line = sseBuf.trim();
      if (line.startsWith('data:')) {
        const s = processData(line.slice(5).trim());
        if (s) out.push(s);
      }
    }
    out.push(finish());
    out.push(null);
  });
  openaiStream.on('error', (err) => { try { out.destroy(err); } catch {} });

  return out;
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 粗略估算一段文本的 token 数（用于在流式响应中提前注入 message_start 的
 * input_tokens，让 Claude Code 界面在流一开始就有接近真实的输入 token 计数）。
 *
 * 估算口径：CJK 字符按 1 字符 ≈ 1 token；其余（拉丁/数字/标点/空白）按
 * 4 字符 ≈ 1 token。这是通用近似，不追求精确——OpenAI 流式端点的 usage 只在
 * 流末尾返回（stream_options.include_usage），message_start 阶段拿不到真实值，
 * 只能先用估算让界面「有数」，流结束的 message_delta 再以真实 usage 为准。
 *
 * @param {*} v - 文本或任意 JSON 值（对象/数组会被序列化后估算）
 * @returns {number} 估算 token 数
 */
function estimateTokens(v) {
  let str;
  if (typeof v === 'string') str = v;
  else if (v == null) return 0;
  else str = JSON.stringify(v);
  let cjk = 0;
  let other = 0;
  for (const ch of str) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 估算 OpenAI 请求体的输入 token 数：messages 正文 + tools 定义 + system。
 * 用于流式响应 message_start 的 input_tokens 预填。
 *
 * @param {object} openaiBody - convertRequestToOpenAI 产出的 OpenAI 请求体
 * @returns {number} 估算的输入 token 数
 */
function estimateInputTokens(openaiBody) {
  if (!openaiBody || typeof openaiBody !== 'object') return 0;
  let total = 0;
  if (Array.isArray(openaiBody.messages)) {
    for (const m of openaiBody.messages) {
      if (!m || typeof m !== 'object') continue;
      if (typeof m.content === 'string') total += estimateTokens(m.content);
      else if (m.content != null) total += estimateTokens(m.content);
      // reasoning_content / tool_calls 由 JSON 序列化兜底覆盖
      if (m.reasoning_content) total += estimateTokens(m.reasoning_content);
      if (Array.isArray(m.tool_calls)) total += estimateTokens(m.tool_calls);
    }
  }
  if (openaiBody.system) total += estimateTokens(openaiBody.system);
  if (Array.isArray(openaiBody.tools)) total += estimateTokens(openaiBody.tools);
  return total;
}

/**
 * 递归剥离所有 cache_control 字段。DeepSeek 不识别该标记（有隐式缓存），留着只是膨胀。
 */
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
  convertRequestToOpenAI,
  convertResponseToAnthropic,
  convertStreamToAnthropicEvents,
  streamOpenAIToAnthropic,
  estimateTokens,
  estimateInputTokens,
  stripCacheControl,
};
