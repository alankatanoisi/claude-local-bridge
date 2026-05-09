'use strict';

// Shared translation helpers between the Anthropic Messages API and
// OpenAI-style Chat Completions.
//
// Why this file exists:
// - Claude Cowork talks in Anthropic Messages format.
// - OpenCode Go exposes a mixed catalog:
//   - some models live behind /v1/chat/completions
//   - some models live behind /v1/messages
// - The local bridge already supports OpenAI-style clients too.
//
// So instead of burying conversion logic inside one handler, we keep the
// translation rules in one place and let different routes reuse them.

const { randomUUID } = require('crypto');

/**
 * Convert an OpenAI Chat Completions request body to an Anthropic Messages body.
 *
 * This is the same conceptual transform the bridge already uses for
 * `/v1/chat/completions`, but moved here so provider adapters can reuse it.
 *
 * @param {object} oai OpenAI Chat Completions request body
 * @param {(model: string|undefined) => string} resolveModelName callback so the caller can decide
 *        how model aliases should be resolved for the current upstream.
 * @returns {object}
 */
function openAIToAnthropic(oai, resolveModelName) {
  const messages = [];
  let systemPrompt;

  for (const msg of oai.messages || []) {
    if (msg.role === 'system') {
      // Anthropic uses one top-level `system` field instead of system messages.
      systemPrompt = systemPrompt ? systemPrompt + '\n\n' + msg.content : msg.content;
      continue;
    }

    if (msg.role === 'tool') {
      // OpenAI tool results become Anthropic `tool_result` content blocks.
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          },
        ],
      });
      continue;
    }

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const content = [];

      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }

      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeJsonParse(tc.function.arguments, {}),
        });
      }

      messages.push({ role: 'assistant', content });
      continue;
    }

    // Ordinary user/assistant messages are mostly pass-through.
    // The only tricky case is multi-part content with images.
    let content = msg.content;
    if (Array.isArray(content)) {
      content = content.map((part) => {
        if (part.type === 'text') return { type: 'text', text: part.text };

        if (part.type === 'image_url') {
          const url = part.image_url?.url || '';

          // OpenAI-compatible clients often send images as data URLs.
          // Anthropic expects a structured image source object instead.
          if (url.startsWith('data:')) {
            const [header, data] = url.split(',');
            const mediaType = header.replace('data:', '').replace(';base64', '');
            return {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data },
            };
          }

          return { type: 'image', source: { type: 'url', url } };
        }

        return part;
      });
    }

    messages.push({ role: msg.role, content });
  }

  const body = {
    model: resolveModelName(oai.model),
    messages,
    max_tokens: oai.max_tokens || 4096,
    stream: oai.stream === true,
  };

  if (systemPrompt) body.system = systemPrompt;
  if (oai.temperature !== undefined) body.temperature = oai.temperature;
  if (oai.top_p !== undefined) body.top_p = oai.top_p;
  if (oai.stop) body.stop_sequences = Array.isArray(oai.stop) ? oai.stop : [oai.stop];

  if (Array.isArray(oai.tools) && oai.tools.length > 0) {
    body.tools = oai.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters || { type: 'object', properties: {} },
    }));
  }

  if (oai.tool_choice) {
    if (oai.tool_choice === 'auto') body.tool_choice = { type: 'auto' };
    else if (oai.tool_choice === 'none') body.tool_choice = { type: 'none' };
    else if (oai.tool_choice === 'required') body.tool_choice = { type: 'any' };
    else if (typeof oai.tool_choice === 'object' && oai.tool_choice.function) {
      body.tool_choice = { type: 'tool', name: oai.tool_choice.function.name };
    }
  }

  return body;
}

/**
 * Convert an Anthropic Messages request body to an OpenAI Chat Completions body.
 *
 * This is the important Phase 1 bridge for Claude Cowork:
 * Cowork sends Anthropic Messages requests, while many OpenCode Go models
 * expect `/v1/chat/completions`.
 *
 * @param {object} ant Anthropic Messages request body
 * @param {(model: string|undefined) => string} resolveModelName callback so the caller can strip
 *        provider prefixes or apply other upstream-specific logic.
 * @returns {object}
 */
function anthropicToOpenAI(ant, resolveModelName) {
  const messages = [];

  // Anthropic has a top-level `system` field.
  // OpenAI-style chat expects that as one or more leading system messages.
  const systemBlocks = normalizeAnthropicSystemBlocks(ant.system);
  for (const block of systemBlocks) {
    if (block.type === 'text' && block.text) {
      messages.push({
        role: 'system',
        content: [
          {
            type: 'text',
            text: block.text,
          },
        ],
      });
    }
  }

  for (const msg of ant.messages || []) {
    if (msg.role === 'assistant') {
      messages.push(convertAnthropicAssistantMessageToOpenAI(msg));
      continue;
    }

    if (msg.role === 'user') {
      messages.push(...convertAnthropicUserMessageToOpenAI(msg));
      continue;
    }
  }

  const body = {
    model: resolveModelName(ant.model),
    messages,
    max_tokens: ant.max_tokens || 4096,
    stream: ant.stream === true,
  };

  if (ant.temperature !== undefined) body.temperature = ant.temperature;
  if (ant.top_p !== undefined) body.top_p = ant.top_p;
  if (Array.isArray(ant.stop_sequences) && ant.stop_sequences.length > 0) {
    body.stop = ant.stop_sequences;
  }

  if (Array.isArray(ant.tools) && ant.tools.length > 0) {
    body.tools = ant.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  if (ant.tool_choice) {
    if (ant.tool_choice.type === 'auto') body.tool_choice = 'auto';
    else if (ant.tool_choice.type === 'none') body.tool_choice = 'none';
    else if (ant.tool_choice.type === 'any') body.tool_choice = 'required';
    else if (ant.tool_choice.type === 'tool') {
      body.tool_choice = {
        type: 'function',
        function: { name: ant.tool_choice.name },
      };
    }
  }

  return body;
}

/**
 * Convert a buffered Anthropic response to a buffered OpenAI response.
 *
 * @param {object} antResp Parsed Anthropic response body
 * @param {string} completionId OpenAI response id to use
 * @returns {object}
 */
function anthropicResponseToOpenAI(antResp, completionId) {
  const model = antResp.model || 'unknown';
  const stopReason = antResp.stop_reason;
  const finishReason = anthropicStopReasonToOpenAIFinishReason(stopReason);

  let textContent = '';
  let reasoningContent = '';
  const toolCalls = [];

  for (const block of antResp.content || []) {
    if (block.type === 'text') {
      textContent += block.text;
      continue;
    }

    if (block.type === 'thinking') {
      reasoningContent += block.thinking || '';
      continue;
    }

    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const message = { role: 'assistant', content: textContent || null };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: antResp.usage?.input_tokens || 0,
      completion_tokens: antResp.usage?.output_tokens || 0,
      total_tokens: (antResp.usage?.input_tokens || 0) + (antResp.usage?.output_tokens || 0),
    },
  };
}

/**
 * Convert a buffered OpenAI Chat Completions response to a buffered
 * Anthropic Messages response.
 *
 * @param {object} oaiResp Parsed OpenAI response body
 * @param {string} advertisedModel The model id this bridge should expose back to the client
 * @returns {object}
 */
function openAIResponseToAnthropic(oaiResp, advertisedModel) {
  const choice = oaiResp.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
    content.push({
      type: 'thinking',
      thinking: message.reasoning_content,
    });
  }

  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content });
  }

  for (const toolCall of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id || `toolu_${randomUUID()}`,
      name: toolCall.function?.name || 'unknown_tool',
      input: safeJsonParse(toolCall.function?.arguments, {}),
    });
  }

  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: advertisedModel,
    content,
    stop_reason: openAIFinishReasonToAnthropicStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Convert Anthropic SSE events to OpenAI SSE chunks on the fly.
 *
 * @param {import('http').ServerResponse} res
 * @param {string} completionId
 * @param {string} modelName
 * @returns {{ write(chunk: Buffer): void, end(): void }}
 */
function createAnthropicToOpenAIStreamConverter(res, completionId, modelName) {
  let buffer = '';

  return {
    write(chunk) {
      buffer += chunk.toString('utf8');
      const frames = splitSseFrames(buffer);
      buffer = frames.remainder;

      for (const frame of frames.complete) {
        const data = extractSseData(frame);
        if (!data || data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          handleAnthropicEventForOpenAI(res, event, completionId, modelName);
        } catch {
          // Ignore malformed partial frames.
        }
      }
    },
    end() {
      if (buffer.trim()) {
        const data = extractSseData(buffer);
        if (data && data !== '[DONE]') {
          try {
            const event = JSON.parse(data);
            handleAnthropicEventForOpenAI(res, event, completionId, modelName);
          } catch {
            // Ignore trailing partial frame.
          }
        }
      }

      res.write('data: [DONE]\n\n');
      res.end();
    },
  };
}

/**
 * Convert OpenAI SSE chunks to Anthropic SSE events on the fly.
 *
 * This is the Cowork-facing stream bridge for OpenCode Go models that expose
 * `/v1/chat/completions`.
 *
 * @param {import('http').ServerResponse} res
 * @param {string} advertisedModel
 * @returns {{ write(chunk: Buffer): void, end(): void }}
 */
function createOpenAIToAnthropicStreamConverter(res, advertisedModel) {
  let buffer = '';
  let messageStarted = false;
  let thinkingBlockState = null;
  let textBlockOpen = false;
  let textBlockIndex = null;
  let nextBlockIndex = -1;
  const toolStates = new Map();
  const messageId = `msg_${randomUUID().replace(/-/g, '')}`;

  function ensureMessageStart() {
    if (messageStarted) return;
    messageStarted = true;

    writeAnthropicSseEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: advertisedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    });
  }

  function ensureThinkingBlock() {
    ensureMessageStart();
    if (thinkingBlockState) return thinkingBlockState.blockIndex;

    const blockIndex = ++nextBlockIndex;
    thinkingBlockState = { blockIndex, closed: false };
    writeAnthropicSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'thinking',
        thinking: '',
      },
    });

    return blockIndex;
  }

  function ensureTextBlock() {
    ensureMessageStart();
    if (textBlockOpen) return textBlockIndex;

    textBlockOpen = true;
    textBlockIndex = ++nextBlockIndex;
    writeAnthropicSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: textBlockIndex,
      content_block: {
        type: 'text',
        text: '',
      },
    });

    return textBlockIndex;
  }

  function closeThinkingBlockIfOpen() {
    if (!thinkingBlockState || thinkingBlockState.closed) return;
    writeAnthropicSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: thinkingBlockState.blockIndex,
    });
    thinkingBlockState.closed = true;
  }

  function closeTextBlockIfOpen() {
    if (!textBlockOpen) return;
    writeAnthropicSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index: textBlockIndex,
    });
    textBlockOpen = false;
    textBlockIndex = null;
  }

  function ensureToolBlock(toolDelta) {
    ensureMessageStart();
    closeThinkingBlockIfOpen();
    closeTextBlockIfOpen();

    const existing = toolStates.get(toolDelta.index);
    if (existing) return existing;

    const blockIndex = ++nextBlockIndex;
    const state = {
      blockIndex,
      id: toolDelta.id || `toolu_${randomUUID()}`,
      name: toolDelta.function?.name || 'unknown_tool',
      closed: false,
    };

    toolStates.set(toolDelta.index, state);
    writeAnthropicSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: state.id,
        name: state.name,
        input: {},
      },
    });

    return state;
  }

  function closeOpenBlocks() {
    closeThinkingBlockIfOpen();
    closeTextBlockIfOpen();

    for (const state of toolStates.values()) {
      if (state.closed) continue;
      writeAnthropicSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: state.blockIndex,
      });
      state.closed = true;
    }
  }

  return {
    write(chunk) {
      buffer += chunk.toString('utf8');
      const frames = splitSseFrames(buffer);
      buffer = frames.remainder;

      for (const frame of frames.complete) {
        const data = extractSseData(frame);
        if (!data) continue;
        if (data === '[DONE]') continue;

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        // Anthropic SSE streams always begin with `message_start`.
        // Some OpenAI-compatible upstreams emit only a terminal chunk with a
        // finish reason and no text delta. If we waited for content before
        // sending `message_start`, Cowork would see an incomplete stream shape.
        ensureMessageStart();

        const choice = parsed.choices?.[0];
        const delta = choice?.delta || {};

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          const blockIndex = ensureThinkingBlock();
          writeAnthropicSseEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'thinking_delta',
              thinking: delta.reasoning_content,
            },
          });
        }

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          const blockIndex = ensureTextBlock();
          writeAnthropicSseEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'text_delta',
              text: delta.content,
            },
          });
        }

        for (const toolDelta of delta.tool_calls || []) {
          const state = ensureToolBlock(toolDelta);

          if (toolDelta.function?.arguments) {
            writeAnthropicSseEvent(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: state.blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: toolDelta.function.arguments,
              },
            });
          }
        }

        if (choice?.finish_reason) {
          closeOpenBlocks();
          writeAnthropicSseEvent(res, 'message_delta', {
            type: 'message_delta',
            delta: {
              stop_reason: openAIFinishReasonToAnthropicStopReason(choice.finish_reason),
              stop_sequence: null,
            },
            usage: {
              output_tokens: parsed.usage?.completion_tokens || 0,
            },
          });
          writeAnthropicSseEvent(res, 'message_stop', { type: 'message_stop' });
        }
      }
    },
    end() {
      if (buffer.trim()) {
        const data = extractSseData(buffer);
        if (data && data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (choice?.finish_reason) {
              closeOpenBlocks();
              writeAnthropicSseEvent(res, 'message_delta', {
                type: 'message_delta',
                delta: {
                  stop_reason: openAIFinishReasonToAnthropicStopReason(choice.finish_reason),
                  stop_sequence: null,
                },
                usage: {
                  output_tokens: parsed.usage?.completion_tokens || 0,
                },
              });
              writeAnthropicSseEvent(res, 'message_stop', { type: 'message_stop' });
            }
          } catch {
            // Ignore trailing partial frame.
          }
        }
      }

      res.end();
    },
  };
}

function convertAnthropicAssistantMessageToOpenAI(msg) {
  const blocks = normalizeAnthropicContent(msg.content);
  const textParts = [];
  const thinkingParts = [];
  const toolCalls = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) {
        textParts.push({
          type: 'text',
          text: block.text,
        });
      }
      continue;
    }

    if (block.type === 'thinking') {
      if (block.thinking) {
        thinkingParts.push(block.thinking);
      }
      continue;
    }

    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  const result = { role: 'assistant', content: textParts.length > 0 ? textParts : null };
  if (thinkingParts.length > 0) result.reasoning_content = thinkingParts.join('\n\n');
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  return result;
}

function convertAnthropicUserMessageToOpenAI(msg) {
  const blocks = normalizeAnthropicContent(msg.content);
  const messages = [];
  let currentContentParts = [];

  function flushUserContent() {
    if (currentContentParts.length === 0) return;
    messages.push({
      role: 'user',
      content: currentContentParts,
    });
    currentContentParts = [];
  }

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text) {
        currentContentParts.push({
          type: 'text',
          text: block.text,
        });
      }
      continue;
    }

    if (block.type === 'image') {
      const imageUrl = anthropicImageBlockToOpenAIImageUrl(block);
      if (imageUrl) {
        currentContentParts.push({
          type: 'image_url',
          image_url: { url: imageUrl },
        });
      }
      continue;
    }

    if (block.type === 'tool_result') {
      flushUserContent();
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: typeof block.content === 'string' ? block.content : stringifyAnthropicToolContent(block.content),
      });
    }
  }

  flushUserContent();

  return messages;
}

function normalizeAnthropicSystemBlocks(system) {
  if (!system) return [];
  if (typeof system === 'string') return [{ type: 'text', text: system }];
  if (Array.isArray(system)) return system;
  return [];
}

function normalizeAnthropicContent(content) {
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function anthropicImageBlockToOpenAIImageUrl(block) {
  const source = block.source || {};

  if (source.type === 'url') {
    return source.url || null;
  }

  if (source.type === 'base64' && source.media_type && source.data) {
    return `data:${source.media_type};base64,${source.data}`;
  }

  return null;
}

function stringifyAnthropicToolContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text') return item.text || '';
        return JSON.stringify(item);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

function handleAnthropicEventForOpenAI(res, event, completionId, modelName) {
  const type = event.type;

  if (type === 'content_block_delta') {
    const delta = event.delta;

    if (delta?.type === 'text_delta') {
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{ index: 0, delta: { role: 'assistant', content: delta.text }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      return;
    }

    if (delta?.type === 'input_json_delta') {
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{ index: 0, delta: { content: delta.partial_json || '' }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    return;
  }

  if (type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    const toolChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: event.index,
                id: event.content_block.id,
                type: 'function',
                function: { name: event.content_block.name, arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
    return;
  }

  if (type === 'message_delta') {
    const finalChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: anthropicStopReasonToOpenAIFinishReason(event.delta?.stop_reason),
        },
      ],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  }
}

function anthropicStopReasonToOpenAIFinishReason(stopReason) {
  if (stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  return 'stop';
}

function openAIFinishReasonToAnthropicStopReason(finishReason) {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function splitSseFrames(buffer) {
  const frames = buffer.split(/\n\n/);
  const remainder = frames.pop() ?? '';
  return { complete: frames, remainder };
}

function extractSseData(frame) {
  const lines = frame.split('\n');
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

function writeAnthropicSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

module.exports = {
  openAIToAnthropic,
  anthropicToOpenAI,
  anthropicResponseToOpenAI,
  openAIResponseToAnthropic,
  createAnthropicToOpenAIStreamConverter,
  createOpenAIToAnthropicStreamConverter,
  openAIFinishReasonToAnthropicStopReason,
};
