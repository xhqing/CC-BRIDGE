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
      const toolCalls = [];

      if (typeof msg.content === 'string') {
        textParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && block.text != null) {
            textParts.push(block.text);
          } else if (block.type === 'thinking' && block.thinking != null) {
            // DeepSeek-V4 thinking 通过 reasoning_effort 开启，不走 thinking block；
            // 但为通用性保留转换（某些上游可能读取）。
            textParts.push(block.thinking);
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
        }
      }

      const assistantMsg = { role: 'assistant' };
      const text = textParts.join('');
      if (text) assistantMsg.content = text;
      else if (toolCalls.length) assistantMsg.content = null;
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);

    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // 先发非 tool_result 的 user 内容（text / image 等）
        const nonToolBlocks = msg.content.filter(
          (b) => b && typeof b === 'object' && b.type !== 'tool_result',
        );
        for (const block of nonToolBlocks) {
          if (block.type === 'text' && block.text != null) {
            out.push({ role: 'user', content: block.text });
          }
          // image / other types → 暂不转换（DeepSeek function calling 场景下极少出现）
        }

        // tool_result → role:"tool" 独立消息
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
          out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content });
        }
      }
    }
    // system 消息由 extractSystemText 单独处理，不进 messages
  }
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
  messages.push(...convertMessages(anthropicBody.messages));

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

  // 从累积数据构建 Anthropic 响应
  const content = [];
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
    if (block.type === 'text') {
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

// ─── 工具函数 ──────────────────────────────────────────────────────────────

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
  stripCacheControl,
};
