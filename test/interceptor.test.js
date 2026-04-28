'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

require('./__mocks__/vscode');
const vscode = require('vscode');

const https = require('https');
const interceptor = require('../src/interceptors/https');

const ORIGINAL_HTTPS_REQUEST = https.request;
const ORIGINAL_FETCH = globalThis.fetch;

function makeCtx() {
  const lines = [];
  return {
    outputChannel: { appendLine: (line) => lines.push(line) },
    interceptedToken: null,
    interceptedHeaderType: null,
    interceptedSource: null,
    interceptedHost: null,
    interceptedPort: null,
    cachedCredentials: null,
    credentialsCachedAt: 0,
    _originalHttpsRequest: null,
    _wrappedHttpsRequest: null,
    _interceptedRequest: null,
    _originalFetch: null,
    _interceptedFetch: null,
    interceptorSettings: null,
    _logs: lines,
  };
}

function resetGlobals() {
  https.request = ORIGINAL_HTTPS_REQUEST;
  globalThis.fetch = ORIGINAL_FETCH;
}

describe('https interceptor', () => {
  beforeEach(() => {
    resetGlobals();
  });

  afterEach(() => {
    resetGlobals();
  });

  it('captures auth only for allowlisted hosts', () => {
    const ctx = makeCtx();
    const calls = [];
    https.request = function fakeRequest(...args) {
      calls.push(args);
      return { on: () => {}, end: () => {} };
    };

    interceptor.install(ctx, {
      interceptorMode: 'capture-auth',
      interceptorHostAllowlist: ['api.anthropic.com'],
    });

    https.request(
      'https://api.anthropic.com/v1/messages',
      { headers: { authorization: 'Bearer token-123' } },
      () => {},
    );
    assert.equal(ctx.interceptedToken, 'token-123');

    ctx.interceptedToken = null;
    https.request(
      'https://claude.ai/api/messages',
      { headers: { authorization: 'Bearer token-456' } },
      () => {},
    );
    assert.equal(ctx.interceptedToken, null);
    assert.equal(calls.length, 2);
  });

  it('detects existing wrapper conflict and aborts in observe-only mode', () => {
    const ctx = makeCtx();
    const original = https.request;

    function wrappedByOther(...args) {
      return original(...args);
    }
    Object.defineProperty(wrappedByOther, Symbol.for('claudeLocalBridge.httpsRequestWrapper'), {
      value: { owner: 'other-wrapper', previous: original },
      configurable: true,
    });

    https.request = wrappedByOther;

    interceptor.install(ctx, {
      interceptorMode: 'observe-only',
      interceptorHostAllowlist: ['api.anthropic.com'],
    });

    assert.equal(https.request, wrappedByOther);
    assert.equal(ctx._interceptedRequest, null);
    assert.ok(ctx._logs.some((line) => line.includes('already wrapped')));
  });

  it('aborts atomically when fetch conflict is present in observe-only mode', () => {
    const ctx = makeCtx();
    const originalRequest = https.request;
    const originalFetch = globalThis.fetch;

    function wrappedFetchByOther(...args) {
      return originalFetch(...args);
    }
    Object.defineProperty(wrappedFetchByOther, Symbol.for('claudeLocalBridge.fetchWrapper'), {
      value: { owner: 'other-fetch-wrapper', previous: originalFetch },
      configurable: true,
    });
    globalThis.fetch = wrappedFetchByOther;

    interceptor.install(ctx, {
      interceptorMode: 'observe-only',
      interceptorHostAllowlist: ['api.anthropic.com'],
    });

    // No partial install of https.request should happen.
    assert.equal(https.request, originalRequest);
    assert.equal(globalThis.fetch, wrappedFetchByOther);
    assert.equal(ctx._interceptedRequest, null);
    assert.equal(ctx._interceptedFetch, null);
  });

  it('chains safely in capture-auth mode and uninstall is idempotent', () => {
    const ctx = makeCtx();

    const base = function baseRequest() {
      return { on: () => {}, end: () => {} };
    };

    function wrappedByOther(...args) {
      return base(...args);
    }
    Object.defineProperty(wrappedByOther, Symbol.for('claudeLocalBridge.httpsRequestWrapper'), {
      value: { owner: 'other-wrapper', previous: base },
      configurable: true,
    });
    https.request = wrappedByOther;

    interceptor.install(ctx, {
      interceptorMode: 'capture-auth',
      interceptorHostAllowlist: ['api.anthropic.com'],
    });

    const ours = https.request;
    assert.notEqual(ours, wrappedByOther);

    // Another wrapper is installed above ours.
    function wrappedAfter(...args) {
      return ours(...args);
    }
    https.request = wrappedAfter;

    interceptor.uninstall(ctx);
    // Must not clobber the newest wrapper.
    assert.equal(https.request, wrappedAfter);

    // Idempotent second call.
    interceptor.uninstall(ctx);
    assert.equal(https.request, wrappedAfter);
  });
});

describe('extension settings wiring', () => {
  afterEach(() => {
    vscode.__resetConfig();
    for (const mod of ['../src/extension', '../src/capture-proxy', '../src/interceptors/https', '../src/server']) {
      delete require.cache[require.resolve(mod)];
    }
  });

  it('skips interceptor/proxy when disabled', async () => {
    const extPath = require.resolve('../src/extension');
    const serverPath = require.resolve('../src/server');
    const proxyPath = require.resolve('../src/capture-proxy');
    const interceptorPath = require.resolve('../src/interceptors/https');

    const calls = { install: 0, proxy: 0, startServer: 0 };

    require.cache[interceptorPath] = {
      id: interceptorPath,
      filename: interceptorPath,
      loaded: true,
      exports: {
        install: () => {
          calls.install += 1;
        },
        uninstall: () => {},
      },
    };

    require.cache[proxyPath] = {
      id: proxyPath,
      filename: proxyPath,
      loaded: true,
      exports: {
        startCaptureProxy: () => {
          calls.proxy += 1;
        },
        stopCaptureProxy: () => {},
      },
    };

    require.cache[serverPath] = {
      id: serverPath,
      filename: serverPath,
      loaded: true,
      exports: {
        startServer: async () => {
          calls.startServer += 1;
        },
        stopServer: () => {},
      },
    };

    vscode.__setConfig({
      enableHttpsInterceptor: false,
      enableCaptureProxy: false,
    });

    const extension = require(extPath);
    const fakeContext = { subscriptions: [] };
    extension.activate(fakeContext);

    // allow async startServer() to run
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.install, 0);
    assert.equal(calls.proxy, 0);
    assert.equal(calls.startServer, 1);

  });
});
