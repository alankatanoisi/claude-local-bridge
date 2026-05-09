'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('./__mocks__/vscode');

const { createAnthropicToOpenAIStreamConverter } = require('../src/handlers/openai');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeRes() {
  const writes = [];
  let ended = false;
  return {
    writes,
    isEnded: () => ended,
    write(chunk) {
      writes.push(chunk.toString('utf8'));
    },
    end() {
      ended = true;
    },
  };
}

/** Parse the captured SSE writes back into a list of chunk objects (skipping [DONE]). */
function parseChunks(writes) {
  const out = [];
  for (const raw of writes) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      out.push(JSON.parse(payload));
    }
  }
  return out;
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('createAnthropicToOpenAIStreamConverter', () => {
  it('translates text_delta events into OpenAI content chunks', () => {
    const res = makeRes();
    const conv = createAnthropicToOpenAIStreamConverter(res, 'cmpl-1', 'claude-test');

    conv.write(sse({ type: 'message_start' }));
    conv.write(sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }));
    conv.write(sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } }));
    conv.write(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
    conv.end();

    const chunks = parseChunks(res.writes);

    const contents = chunks.map((c) => c.choices[0].delta.content).filter((x) => typeof x === 'string');
    assert.deepEqual(contents, ['Hello', ' world']);

    const finishChunk = chunks.find((c) => c.choices[0].finish_reason);
    assert.equal(finishChunk.choices[0].finish_reason, 'stop');

    assert.ok(res.isEnded(), 'response was ended');
    const lastWrite = res.writes[res.writes.length - 1];
    assert.ok(lastWrite.includes('data: [DONE]\n\n'), 'final write contains [DONE]');
  });

  it('emits a tool_calls delta on content_block_start of type tool_use', () => {
    const res = makeRes();
    const conv = createAnthropicToOpenAIStreamConverter(res, 'cmpl-2', 'claude-test');

    conv.write(
      sse({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_abc', name: 'get_weather' },
      }),
    );
    conv.write(
      sse({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"city":"' },
      }),
    );
    conv.write(
      sse({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: 'NYC"}' },
      }),
    );
    conv.write(sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
    conv.end();

    const chunks = parseChunks(res.writes);

    const startChunk = chunks.find((c) => c.choices[0].delta?.tool_calls);
    assert.ok(startChunk, 'tool_calls start chunk emitted');
    const toolCall = startChunk.choices[0].delta.tool_calls[0];
    assert.equal(toolCall.id, 'toolu_abc');
    assert.equal(toolCall.type, 'function');
    assert.equal(toolCall.function.name, 'get_weather');

    const argFragments = chunks.map((c) => c.choices[0].delta.content).filter((x) => typeof x === 'string');
    assert.deepEqual(argFragments, ['{"city":"', 'NYC"}']);

    const finishChunk = chunks.find((c) => c.choices[0].finish_reason);
    assert.equal(finishChunk.choices[0].finish_reason, 'tool_calls');
  });

  it('maps stop_reason max_tokens to length', () => {
    const res = makeRes();
    const conv = createAnthropicToOpenAIStreamConverter(res, 'cmpl-3', 'claude-test');

    conv.write(sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }));
    conv.end();

    const chunks = parseChunks(res.writes);
    const finishChunk = chunks.find((c) => c.choices[0].finish_reason);
    assert.equal(finishChunk.choices[0].finish_reason, 'length');
  });

  it('handles split-across-write SSE lines without dropping events', () => {
    const res = makeRes();
    const conv = createAnthropicToOpenAIStreamConverter(res, 'cmpl-4', 'claude-test');

    const full = sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'AB' } });
    // Split mid-line so the converter must buffer the partial.
    const split = Math.floor(full.length / 2);
    conv.write(full.slice(0, split));
    conv.write(full.slice(split));
    conv.write(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
    conv.end();

    const chunks = parseChunks(res.writes);
    const contents = chunks.map((c) => c.choices[0].delta.content).filter((x) => typeof x === 'string');
    assert.deepEqual(contents, ['AB']);
  });

  it('always terminates with [DONE] and ends the response', () => {
    const res = makeRes();
    const conv = createAnthropicToOpenAIStreamConverter(res, 'cmpl-5', 'claude-test');
    conv.end();
    assert.ok(res.isEnded());
    assert.ok(res.writes.some((w) => w.includes('data: [DONE]\n\n')));
  });
});
