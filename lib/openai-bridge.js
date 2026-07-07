'use strict';

// Anthropic ↔ OpenAI format bridge.
//
// Used when an upstream pair speaks OpenAI's `/v1/chat/completions` format
// instead of Anthropic's native `/v1/messages`. This module:
//   1. Converts an Anthropic request body → OpenAI request body.
//   2. Converts an OpenAI non-streaming response → Anthropic response.
//   3. Converts an OpenAI streaming SSE response → Anthropic SSE event stream.
//
// Tool calls, tool results, system prompts, and stop reasons are handled.
// `reasoning_content` (OpenAI thinking extension) is converted into an
// Anthropic `thinking` content block so the reasoning process is visible in
// Claude Code. Claude Code does not validate the thinking `signature` (native
// GLM returns short fake signatures like "zqevnedtfg"), so a random
// placeholder signature suffices.

// ---------------------------------------------------------------------------
// Request: Anthropic → OpenAI
// ---------------------------------------------------------------------------

function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => b.text || '').join('\n');
  return '';
}

// Convert an Anthropic messages array (+system) into OpenAI messages.
// One Anthropic user turn may expand into multiple OpenAI messages
// (tool_result blocks become standalone `role: tool` messages).
function convertMessages(anthropicMessages, system) {
  const out = [];
  const sys = systemToText(system);
  if (sys) out.push({ role: 'system', content: sys });

  for (const m of anthropicMessages || []) {
    const role = m.role;
    const content = m.content;

    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      out.push({ role, content: '' });
      continue;
    }

    if (role === 'assistant') {
      let text = '';
      const toolCalls = [];
      for (const b of content) {
        if (b.type === 'text') text += b.text || '';
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: {
              name: b.name,
              arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input || {}),
            },
          });
        }
      }
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // user: text / image / tool_result
      const textParts = [];
      const toolResults = [];
      for (const b of content) {
        if (b.type === 'text') textParts.push(b.text || '');
        else if (b.type === 'tool_result') toolResults.push(b);
        else if (b.type === 'image') textParts.push('[image omitted]');
      }
      for (const tr of toolResults) {
        let c = tr.content;
        if (Array.isArray(c)) c = c.map((b) => b.text || '').join('\n');
        else if (typeof c !== 'string') c = c == null ? '' : JSON.stringify(c);
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: c });
      }
      if (textParts.length) out.push({ role: 'user', content: textParts.join('\n') });
    }
  }
  return out;
}

function convertTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool') return { type: 'function', function: { name: tc.name } };
  return undefined;
}

// Build an OpenAI /v1/chat/completions request body from an Anthropic body.
function buildOpenAIRequest(anthropicBody) {
  const out = {
    model: anthropicBody.model,
    messages: convertMessages(anthropicBody.messages, anthropicBody.system),
    stream: !!anthropicBody.stream,
  };
  if (anthropicBody.max_tokens != null) out.max_tokens = anthropicBody.max_tokens;
  if (anthropicBody.temperature != null) out.temperature = anthropicBody.temperature;
  if (anthropicBody.top_p != null) out.top_p = anthropicBody.top_p;
  // #1: 把 rewriteBody 计算出的 reasoning_effort 透传给 OpenAI 格式上游。
  // rewriteBody 已根据 output_config.effort 映射出 GLM 的 reasoning_effort 值。
  if (anthropicBody.reasoning_effort) {
    out.reasoning_effort = anthropicBody.reasoning_effort;
  }
  // thinking 也透传（OpenAI 兼容上游可能认这个字段）
  if (anthropicBody.thinking && anthropicBody.thinking.type) {
    out.thinking = { type: anthropicBody.thinking.type };
  }
  const tools = convertTools(anthropicBody.tools);
  if (tools) out.tools = tools;
  const tc = convertToolChoice(anthropicBody.tool_choice);
  if (tc !== undefined) out.tool_choice = tc;
  if (Array.isArray(anthropicBody.stop_sequences) && anthropicBody.stop_sequences.length) {
    out.stop = anthropicBody.stop_sequences;
  }
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

// ---------------------------------------------------------------------------
// Response (non-streaming): OpenAI → Anthropic
// ---------------------------------------------------------------------------

const FINISH_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
};

// Random placeholder for the thinking signature. Claude Code does not verify
// it (native GLM emits short fake ones), so any opaque string works.
function randSig() {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

function convertOpenAIResponseToAnthropic(oai, clientModel) {
  const choice = (oai.choices && oai.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];

  // Reasoning content → Anthropic thinking block (must precede text/tool_use).
  if (msg.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: msg.reasoning_content,
      signature: randSig(),
    });
  }
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input;
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const usage = oai.usage || {};
  return {
    id: oai.id || ('msg_' + Date.now()),
    type: 'message',
    role: 'assistant',
    model: clientModel,
    content,
    stop_reason: FINISH_MAP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

// Convert an OpenAI error body into an Anthropic-shaped error.
function convertOpenAIErrorToAnthropic(body, status) {
  let message = 'upstream error';
  let type = 'api_error';
  try {
    const obj = typeof body === 'string' ? JSON.parse(body) : body;
    if (obj && obj.error) {
      message = obj.error.message || message;
      type = obj.error.type || type;
    }
  } catch { /* keep defaults */ }
  return {
    type: 'error',
    error: {
      type: status === 429 ? 'rate_limit_error' : 'api_error',
      message: `upstream (${status}): ${message}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming: OpenAI SSE → Anthropic SSE
// ---------------------------------------------------------------------------

// Returns an object with feed(chunkBuf) and end() that write Anthropic SSE
// events to clientRes. clientModel is the spoof model the client expects.
// modelUsage (optional) is injected into the final message_delta event.
function createStreamConverter(clientRes, clientModel, modelUsage) {
  const msgId = 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let started = false;
  let thinkingOpen = false;
  let thinkingIndex = -1;
  let textOpen = false;
  let textIndex = -1;
  let nextIndex = 0;
  const toolBlocks = new Map(); // oai index → { blockIndex, id, name, opened, closed }
  let stopReason = 'end_turn';
  let outTokens = 0;
  let finished = false;
  let buffer = '';
  // TextDecoder stream 模式处理跨 chunk UTF-8 多字节字符（中文 3 字节/字），避免 chunk 边界切断 → U+FFFD。
  const decoder = new TextDecoder('utf-8');

  function emit(event, data) {
    clientRes.write(`event: ${event}\n`);
    clientRes.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function startMessage(inputTokens) {
    if (started) return;
    started = true;
    emit('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: clientModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens || 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
  }

  function openThinking() {
    if (thinkingOpen) return;
    thinkingOpen = true;
    thinkingIndex = nextIndex++;
    emit('content_block_start', {
      type: 'content_block_start',
      index: thinkingIndex,
      content_block: { type: 'thinking', thinking: '' },
    });
  }
  function closeThinking() {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    // Anthropic sends the signature via a signature_delta before block stop.
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: thinkingIndex,
      delta: { type: 'signature_delta', signature: randSig() },
    });
    emit('content_block_stop', { type: 'content_block_stop', index: thinkingIndex });
  }

  function openText() {
    if (textOpen) return;
    textOpen = true;
    textIndex = nextIndex++;
    emit('content_block_start', {
      type: 'content_block_start',
      index: textIndex,
      content_block: { type: 'text', text: '' },
    });
  }
  function closeText() {
    if (!textOpen) return;
    textOpen = false;
    emit('content_block_stop', { type: 'content_block_stop', index: textIndex });
  }

  function handleChunk(obj) {
    if (obj.usage) {
      if (obj.usage.prompt_tokens != null) { /* message_start already sent; ignore */ }
      if (obj.usage.completion_tokens != null) outTokens = obj.usage.completion_tokens;
    }
    const choice = obj.choices && obj.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (delta.role && !started) startMessage(0);

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      if (!started) startMessage(0);
      openThinking();
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      });
    }

    if (typeof delta.content === 'string' && delta.content) {
      if (!started) startMessage(0);
      closeThinking();
      openText();
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      if (!started) startMessage(0);
      closeThinking();
      closeText();
      for (const tc of delta.tool_calls) {
        const idx = tc.index != null ? tc.index : 0;
        let block = toolBlocks.get(idx);
        if (!block) {
          block = {
            blockIndex: nextIndex++,
            id: tc.id || ('toolu_' + Date.now().toString(36) + idx),
            name: (tc.function && tc.function.name) || '',
            opened: false,
            closed: false,
          };
          toolBlocks.set(idx, block);
        } else {
          if (!block.name && tc.function && tc.function.name) block.name = tc.function.name;
          if (tc.id && block.id.startsWith('toolu_')) block.id = tc.id;
        }
        if (!block.opened) {
          block.opened = true;
          emit('content_block_start', {
            type: 'content_block_start',
            index: block.blockIndex,
            content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
          });
        }
        const argDelta = (tc.function && tc.function.arguments) || '';
        if (argDelta) {
          emit('content_block_delta', {
            type: 'content_block_delta',
            index: block.blockIndex,
            delta: { type: 'input_json_delta', partial_json: argDelta },
          });
        }
      }
    }

    if (choice.finish_reason) {
      stopReason = FINISH_MAP[choice.finish_reason] || 'end_turn';
    }
  }

  function finalize() {
    if (finished) return;
    finished = true;
    closeThinking();
    closeText();
    for (const block of toolBlocks.values()) {
      if (block.opened && !block.closed) {
        block.closed = true;
        emit('content_block_stop', { type: 'content_block_stop', index: block.blockIndex });
      }
    }
    if (!started) startMessage(0);
    const deltaEvent = {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outTokens },
    };
    if (modelUsage) {
      deltaEvent.modelUsage = modelUsage;
      deltaEvent.total_cost_usd = 0;  // ensure webview reads modelUsage
    }
    emit('message_delta', deltaEvent);
    emit('message_stop', { type: 'message_stop' });
    clientRes.end();
  }

  function processLine(line) {
    const s = line.trim();
    if (!s || !s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (data === '[DONE]') { finalize(); return; }
    try { handleChunk(JSON.parse(data)); } catch { /* ignore malformed */ }
  }

  function feed(chunk) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      processLine(line);
    }
  }

  function end() {
    buffer += decoder.decode();  // flush 剩余字节（正常为空）
    if (buffer.trim()) processLine(buffer);
    buffer = '';
    finalize();
  }

  return { feed, end };
}

module.exports = {
  buildOpenAIRequest,
  convertOpenAIResponseToAnthropic,
  convertOpenAIErrorToAnthropic,
  createStreamConverter,
};
