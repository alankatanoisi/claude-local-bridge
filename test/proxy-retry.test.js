'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { EventEmitter } = require('events');

require('./__mocks__/vscode');

const { proxyToAnthropic } = require('../src/proxy');

// ─────────────────────────────────────────────
// Test helpers — fake upstream and ServerResponse
// ─────────────────────────────────────────────

function makeRes() {
  const writes = [];
  const headers = {};
  let statusCode = null;
  let writableEnded = false;
  let headersSent = false;
  return {
    writes,
    get statusCode() {
      return statusCode;
    },
    get writableEnded() {
      return writableEnded;
    },
    get headersSent() {
      return headersSent;
    },
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    writeHead(code, h) {
      statusCode = code;
      headersSent = true;
      if (h) {
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
      }
    },
    write(chunk) {
      writes.push(chunk.toString('utf8'));
    },
    end(chunk) {
      if (chunk) writes.push(chunk.toString('utf8'));
      writableEnded = true;
    },
    headers,
  };
}

/**
 * Replace https.request with a stub that returns a fake upstream response
 * for each call. `responses` is an array of { status, body } objects;
 * one is consumed per call.
 */
function stubHttpsRequest(responses) {
  const original = https.request;
  const calls = [];
  https.request = function (options, cb) {
    const idx = calls.length;
    calls.push({ options, headers: { ...options.headers } });

    const upRes = new EventEmitter();
    upRes.statusCode = responses[idx]?.status ?? 500;
    upRes.headers = {};
    upRes.resume = () => {};

    const upReq = new EventEmitter();
    upReq.write = () => {};
    upReq.end = () => {
      // Simulate upstream returning after end()
      process.nextTick(() => {
        cb(upRes);
        process.nextTick(() => {
          if (responses[idx]?.body) upRes.emit('data', Buffer.from(responses[idx].body));
          upRes.emit('end');
        });
      });
    };
    upReq.destroy = () => {};
    return upReq;
  };
  return {
    calls,
    restore() {
      https.request = original;
    },
  };
}

function makeCtx() {
  return {
    outputChannel: { appendLine: () => {} },
    cachedCredentials: null,
    credentialsCachedAt: 0,
    CREDS_CACHE_TTL: 300_000,
    interceptedToken: null,
    interceptedHost: null,
    interceptedPort: null,
    liveFingerprint: null,
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('proxyToAnthropic — 401 retry behavior', () => {
  let stub;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    if (stub) stub.restore();
    stub = null;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('clears credential cache and retries once on 401', async () => {
    stub = stubHttpsRequest([
      { status: 401, body: '{"error":"unauthorized"}' },
      { status: 200, body: '{"id":"msg_1"}' },
    ]);
    const ctx = makeCtx();
    // Pre-populate cache to verify it gets cleared.
    ctx.cachedCredentials = { apiKey: 'sk-test-key', source: 'env:ANTHROPIC_API_KEY' };
    ctx.credentialsCachedAt = Date.now();
    const cachedAtBefore = ctx.credentialsCachedAt;

    const res = makeRes();
    await proxyToAnthropic(ctx, res, '/v1/messages', '{}');

    assert.equal(stub.calls.length, 2, 'exactly two upstream calls (one retry)');
    assert.equal(res.statusCode, 200, 'final response uses retry result');
    assert.ok(
      ctx.credentialsCachedAt > cachedAtBefore || ctx.credentialsCachedAt === cachedAtBefore,
      'cache repopulated via getCredentials',
    );
    // After clearCredentialsCache + getCredentials, cache should now hold the
    // freshly discovered creds (not the original cached object).
    assert.equal(ctx.cachedCredentials.apiKey, 'sk-test-key');
  });

  it('does not retry more than once on persistent 401', async () => {
    stub = stubHttpsRequest([
      { status: 401, body: '{"error":"unauthorized"}' },
      { status: 401, body: '{"error":"still unauthorized"}' },
    ]);
    const ctx = makeCtx();
    const res = makeRes();
    await proxyToAnthropic(ctx, res, '/v1/messages', '{}');

    assert.equal(stub.calls.length, 2, 'caps at one retry');
    assert.equal(res.statusCode, 401, 'forwards final 401 to client');
  });

  it('does not retry on non-401 errors', async () => {
    stub = stubHttpsRequest([{ status: 500, body: '{"error":"server"}' }]);
    const ctx = makeCtx();
    const res = makeRes();
    await proxyToAnthropic(ctx, res, '/v1/messages', '{}');

    assert.equal(stub.calls.length, 1, 'no retry on 500');
    assert.equal(res.statusCode, 500);
  });

  it('forwards 200 responses without retrying', async () => {
    stub = stubHttpsRequest([{ status: 200, body: '{"id":"msg_ok"}' }]);
    const ctx = makeCtx();
    const res = makeRes();
    await proxyToAnthropic(ctx, res, '/v1/messages', '{}');

    assert.equal(stub.calls.length, 1, 'single call on success');
    assert.equal(res.statusCode, 200);
    assert.ok(res.writes.join('').includes('msg_ok'));
  });
});
