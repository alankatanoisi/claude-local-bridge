'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');

require('./__mocks__/vscode');

const interceptor = require('../src/interceptors/https');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeCtx() {
  return {
    outputChannel: { appendLine: () => {} },
    cachedCredentials: { apiKey: 'cached', source: 'test' },
    credentialsCachedAt: Date.now(),
    CREDS_CACHE_TTL: 300_000,
    interceptedToken: null,
    interceptedHeaderType: null,
    interceptedSource: null,
    interceptedHost: null,
    interceptedPort: null,
    liveFingerprint: null,
    liveFingerprintCapturedAt: 0,
  };
}

/**
 * Replace https.request and globalThis.fetch with no-op stubs that record
 * call args. Returns the recording arrays plus a restore() to put back the
 * real originals (whatever they were before this stub).
 */
function stubGlobals() {
  const realRequest = https.request;
  const realFetch = globalThis.fetch;
  const requestCalls = [];
  const fetchCalls = [];

  https.request = function (...args) {
    requestCalls.push(args);
    return {
      on: () => {},
      write: () => {},
      end: () => {},
      destroy: () => {},
    };
  };
  const stubRequest = https.request;

  globalThis.fetch = async function (...args) {
    fetchCalls.push(args);
    return new Response('{}', { status: 200 });
  };
  const stubFetch = globalThis.fetch;

  return {
    requestCalls,
    fetchCalls,
    stubRequest,
    stubFetch,
    restore() {
      https.request = realRequest;
      globalThis.fetch = realFetch;
    },
  };
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('https interceptor — install/uninstall lifecycle', () => {
  let stub;

  beforeEach(() => {
    stub = stubGlobals();
  });

  afterEach(() => {
    stub.restore();
  });

  it('install replaces https.request and saves the original', () => {
    const ctx = makeCtx();
    interceptor.install(ctx);

    assert.notEqual(https.request, stub.stubRequest, 'https.request was replaced');
    assert.equal(ctx._originalHttpsRequest, stub.stubRequest, 'original is saved');
    assert.equal(typeof https.request, 'function');

    interceptor.uninstall(ctx);
  });

  it('install replaces globalThis.fetch and saves the original', () => {
    const ctx = makeCtx();
    interceptor.install(ctx);

    assert.notEqual(globalThis.fetch, stub.stubFetch, 'fetch was replaced');
    assert.equal(ctx._originalFetch, stub.stubFetch, 'original fetch saved');

    interceptor.uninstall(ctx);
  });

  it('uninstall restores original https.request when patch is still in place', () => {
    const ctx = makeCtx();
    interceptor.install(ctx);
    interceptor.uninstall(ctx);

    assert.equal(https.request, stub.stubRequest, 'restored to pre-install value');
    assert.equal(ctx._originalHttpsRequest, null);
    assert.equal(ctx._interceptedRequest, null);
  });

  it('uninstall is a no-op when something else has further patched https.request', () => {
    const ctx = makeCtx();
    interceptor.install(ctx);

    // Some other extension patches on top of ours.
    const outerWrapper = function () {};
    https.request = outerWrapper;

    interceptor.uninstall(ctx);

    // Uninstall should NOT clobber the outer wrapper since it isn't ours anymore.
    assert.equal(https.request, outerWrapper, 'leaves outer patch alone');

    // Manually restore so afterEach() sees a clean slate.
    https.request = stub.stubRequest;
  });
});

describe('https interceptor — capture behavior', () => {
  let stub;

  beforeEach(() => {
    stub = stubGlobals();
  });

  afterEach(() => {
    stub.restore();
  });

  it('captures Bearer token from request to api.anthropic.com', () => {
    const ctx = makeCtx();
    interceptor.install(ctx);

    https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      headers: { authorization: 'Bearer sk-ant-oat01-abc123def' },
    });

    assert.equal(ctx.interceptedToken, 'sk-ant-oat01-abc123def');
    assert.equal(ctx.interceptedHeaderType, 'bearer');
    assert.equal(ctx.interceptedHost, 'api.anthropic.com');
    assert.equal(ctx.interceptedPort, 443);
    assert.equal(stub.requestCalls.length, 1, 'request was passed through to original');

    interceptor.uninstall(ctx);
  });

  it('captures x-api-key from request to claude.ai', () => {
    const ctx = makeCtx();
    interceptor.install(ctx);

    https.request({
      hostname: 'claude.ai',
      headers: { 'x-api-key': 'sk-test-apikey' },
    });

    assert.equal(ctx.interceptedToken, 'sk-test-apikey');
    assert.equal(ctx.interceptedHeaderType, 'api-key');
    assert.equal(ctx.interceptedHost, 'claude.ai');

    interceptor.uninstall(ctx);
  });

  it('does not capture from non-allowlisted hosts', () => {
    const ctx = makeCtx();
    interceptor.install(ctx);

    https.request({
      hostname: 'evil.example.com',
      headers: { authorization: 'Bearer leaked-token-do-not-capture' },
    });

    assert.equal(ctx.interceptedToken, null);
    assert.equal(ctx.interceptedHost, null);
    assert.equal(stub.requestCalls.length, 1, 'still passed through');

    interceptor.uninstall(ctx);
  });

  it('clears credential cache on token rotation', () => {
    const ctx = makeCtx();
    interceptor.install(ctx);

    https.request({
      hostname: 'api.anthropic.com',
      headers: { authorization: 'Bearer token-1' },
    });
    assert.equal(ctx.cachedCredentials, null, 'cache cleared on first capture');

    // Re-populate cache, then rotate token.
    ctx.cachedCredentials = { apiKey: 'restamped', source: 'test' };
    ctx.credentialsCachedAt = Date.now();

    https.request({
      hostname: 'api.anthropic.com',
      headers: { authorization: 'Bearer token-2' },
    });

    assert.equal(ctx.interceptedToken, 'token-2', 'token rotated');
    assert.equal(ctx.cachedCredentials, null, 'cache cleared again on rotation');

    interceptor.uninstall(ctx);
  });

  it('does not re-fire when the same token is observed twice', () => {
    const ctx = makeCtx();
    interceptor.install(ctx);

    https.request({
      hostname: 'api.anthropic.com',
      headers: { authorization: 'Bearer same-token' },
    });
    // Re-populate the cache. If captureAuth re-fires, it would clear again.
    ctx.cachedCredentials = { apiKey: 'still-here', source: 'test' };

    https.request({
      hostname: 'api.anthropic.com',
      headers: { authorization: 'Bearer same-token' },
    });

    assert.deepEqual(
      ctx.cachedCredentials,
      { apiKey: 'still-here', source: 'test' },
      'cache survives duplicate-token capture',
    );

    interceptor.uninstall(ctx);
  });

  it('passes through requests with no auth headers without recording', () => {
    const ctx = makeCtx();
    interceptor.install(ctx);

    https.request({ hostname: 'api.anthropic.com', headers: {} });

    assert.equal(ctx.interceptedToken, null);
    assert.equal(stub.requestCalls.length, 1);

    interceptor.uninstall(ctx);
  });
});
