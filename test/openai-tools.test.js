'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

require('./__mocks__/vscode');

const { openAIToAnthropic, anthropicToOpenAI } = require('../src/handlers/openai');

// ─────────────────────────────────────────────
// openAIToAnthropic
// ─────────────────────────────────────────────

describe('openAIToAnthropic — tool conversion', () => {
  it('converts an assistant tool_calls message into Anthropic tool_use blocks', () => {
    const out = openAIToAnthropic({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: 'whats the weather' },
        {
          role: 'assistant',
          content: 'let me check',
          tool_calls: [
            {
              id: 'call_abc',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
      ],
    });

    const assistant = out.messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content.length, 2);
    assert.deepEqual(assistant.content[0], { type: 'text', text: 'let me check' });
    assert.deepEqual(assistant.content[1], {
      type: 'tool_use',
      id: 'call_abc',
      name: 'get_weather',
      input: { city: 'NYC' },
    });
  });

  it('falls back to empty input when tool_call arguments are not valid JSON', () => {
    const out = openAIToAnthropic({
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_x',
              type: 'function',
              function: { name: 'noop', arguments: 'not json' },
            },
          ],
        },
      ],
    });
    assert.deepEqual(out.messages[0].content[0].input, {});
  });

  it('converts a tool-role message into a user-role tool_result block', () => {
    const out = openAIToAnthropic({
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_abc',
          content: 'sunny, 72F',
        },
      ],
    });

    assert.equal(out.messages[0].role, 'user');
    assert.deepEqual(out.messages[0].content[0], {
      type: 'tool_result',
      tool_use_id: 'call_abc',
      content: 'sunny, 72F',
    });
  });

  it('serializes object tool_result content as JSON', () => {
    const out = openAIToAnthropic({
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_xyz',
          content: { temp: 72, condition: 'sunny' },
        },
      ],
    });
    assert.equal(out.messages[0].content[0].content, '{"temp":72,"condition":"sunny"}');
  });

  it('extracts system prompt to top-level system field', () => {
    const out = openAIToAnthropic({
      messages: [
        { role: 'system', content: 'you are helpful' },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.equal(out.system, 'you are helpful');
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, 'user');
  });

  it('concatenates multiple system messages with double-newline', () => {
    const out = openAIToAnthropic({
      messages: [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'hi' },
      ],
    });
    assert.equal(out.system, 'A\n\nB');
  });

  it('converts OpenAI tool definitions to Anthropic tool definitions', () => {
    const out = openAIToAnthropic({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Look up weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
    });

    assert.equal(out.tools.length, 1);
    assert.equal(out.tools[0].name, 'get_weather');
    assert.equal(out.tools[0].description, 'Look up weather');
    assert.deepEqual(out.tools[0].input_schema, {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    });
  });

  it('translates tool_choice values', () => {
    assert.deepEqual(openAIToAnthropic({ messages: [], tool_choice: 'auto' }).tool_choice, { type: 'auto' });
    assert.deepEqual(openAIToAnthropic({ messages: [], tool_choice: 'none' }).tool_choice, { type: 'none' });
    assert.deepEqual(
      openAIToAnthropic({
        messages: [],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
      }).tool_choice,
      { type: 'tool', name: 'get_weather' },
    );
  });

  it('passes through a multi-turn tool conversation in order', () => {
    const out = openAIToAnthropic({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '72F sunny' },
        { role: 'assistant', content: "It's 72F and sunny." },
      ],
    });

    assert.equal(out.messages.length, 4);
    assert.equal(out.messages[0].role, 'user');
    assert.equal(out.messages[1].role, 'assistant');
    assert.equal(out.messages[1].content[0].type, 'tool_use');
    assert.equal(out.messages[2].role, 'user');
    assert.equal(out.messages[2].content[0].type, 'tool_result');
    assert.equal(out.messages[2].content[0].tool_use_id, 'call_1');
    assert.equal(out.messages[3].role, 'assistant');
  });
});

// ─────────────────────────────────────────────
// anthropicToOpenAI
// ─────────────────────────────────────────────

describe('anthropicToOpenAI — tool conversion', () => {
  it('converts tool_use blocks back into OpenAI tool_calls', () => {
    const out = anthropicToOpenAI(
      {
        model: 'claude-sonnet-4-5',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'checking...' },
          {
            type: 'tool_use',
            id: 'toolu_xyz',
            name: 'get_weather',
            input: { city: 'NYC' },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      'cmpl-123',
    );

    assert.equal(out.id, 'cmpl-123');
    assert.equal(out.choices[0].finish_reason, 'tool_calls');
    const msg = out.choices[0].message;
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.content, 'checking...');
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].id, 'toolu_xyz');
    assert.equal(msg.tool_calls[0].function.name, 'get_weather');
    assert.equal(msg.tool_calls[0].function.arguments, '{"city":"NYC"}');
    assert.equal(out.usage.total_tokens, 15);
  });

  it('maps stop_reason values to OpenAI finish_reason', () => {
    const cases = [
      ['end_turn', 'stop'],
      ['max_tokens', 'length'],
      ['tool_use', 'tool_calls'],
      ['something_else', 'stop'],
    ];
    for (const [stop, expected] of cases) {
      const out = anthropicToOpenAI(
        { model: 'm', stop_reason: stop, content: [{ type: 'text', text: 'x' }] },
        'cmpl-x',
      );
      assert.equal(out.choices[0].finish_reason, expected, `stop_reason=${stop}`);
    }
  });

  it('returns null content when there are no text blocks', () => {
    const out = anthropicToOpenAI(
      { model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }] },
      'cmpl-y',
    );
    assert.equal(out.choices[0].message.content, null);
  });
});
