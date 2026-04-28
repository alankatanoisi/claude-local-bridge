'use strict';

const https = require('https');
const { log } = require('../utils');
const { extractFingerprint, updateFingerprint } = require('../fingerprint');

// ─────────────────────────────────────────────
// HTTPS + Fetch Interceptor — Auth + Endpoint + Fingerprint Sniffer
//
// Patches both https.request() and globalThis.fetch to observe every
// outgoing HTTPS call made by any VS Code extension in this process.
// When Claude Code makes a request to an Anthropic endpoint, we capture:
//   • The auth header (Bearer token or x-api-key)
//   • The exact target hostname Claude Code is actually calling
//   • The full request fingerprint (user-agent, stainless headers, etc.)
//
// WHY capture the endpoint too:
//   Claude Code may not call api.anthropic.com directly — it might route
//   through claude.ai/api or another internal gateway. By capturing the
//   actual URL, we proxy requests to wherever Claude Code really goes,
//   just like ag-local-bridge routes through Antigravity's sidecar rather
//   than directly to Google AI.
//
// WHY capture the fingerprint:
//   Claude Code's request headers (user-agent, billing header, beta flags)
//   change with each version. By capturing them live, the bridge becomes
//   self-adapting instead of relying on hardcoded values that rot.
//
// NOTE: The Anthropic SDK uses fetch() by default, not https.request,
// so both interceptors are needed.
// ─────────────────────────────────────────────

const ANTHROPIC_HOSTNAMES = new Set(['api.anthropic.com', 'claude.ai', 'api.claude.ai']);
const HTTPS_REQUEST_WRAPPER_SYMBOL = Symbol.for('claudeLocalBridge.httpsRequestWrapper');
const FETCH_WRAPPER_SYMBOL = Symbol.for('claudeLocalBridge.fetchWrapper');
const MODES = {
  OBSERVE_ONLY: 'observe-only',
  CAPTURE_AUTH: 'capture-auth',
};

function normalizeSettings(settings = {}) {
  const mode = settings.interceptorMode === MODES.OBSERVE_ONLY ? MODES.OBSERVE_ONLY : MODES.CAPTURE_AUTH;
  const sourceHosts = Array.isArray(settings.interceptorHostAllowlist)
    ? settings.interceptorHostAllowlist
    : Array.from(ANTHROPIC_HOSTNAMES);
  const hosts = sourceHosts
    .map((host) => (typeof host === 'string' ? host.trim().toLowerCase() : ''))
    .filter(Boolean);
  return {
    interceptorMode: mode,
    hostAllowlist: new Set(hosts.length > 0 ? hosts : Array.from(ANTHROPIC_HOSTNAMES)),
  };
}

function parseTargetFromInput(input, options) {
  try {
    if (typeof input === 'string') {
      const u = new URL(input);
      if (u.protocol !== 'https:') return { valid: false };
      return { valid: true, host: u.hostname.toLowerCase(), port: u.port ? parseInt(u.port, 10) : 443, url: u };
    }
    if (input instanceof URL) {
      if (input.protocol !== 'https:') return { valid: false };
      return {
        valid: true,
        host: input.hostname.toLowerCase(),
        port: input.port ? parseInt(input.port, 10) : 443,
        url: input,
      };
    }
    if (input && typeof input === 'object') {
      const protocol = (input.protocol || options?.protocol || 'https:').toLowerCase();
      if (!protocol.startsWith('https')) return { valid: false };
      const host = (input.hostname || input.host || '').toString().split(':')[0].trim().toLowerCase();
      if (!host) return { valid: false };
      const rawPort = input.port || options?.port;
      return { valid: true, host, port: rawPort ? parseInt(rawPort, 10) : 443 };
    }
  } catch {
    return { valid: false };
  }
  return { valid: false };
}

function extractAuthFromHeaders(headers) {
  if (!headers) return null;

  // Handle Headers object (fetch API)
  if (typeof headers?.entries === 'function') {
    const entries = Object.fromEntries(headers.entries());
    return extractAuthFromHeaders(entries);
  }

  // Handle array of [key, value] pairs (fetch API internal)
  if (Array.isArray(headers)) {
    return extractAuthFromHeaders(Object.fromEntries(headers));
  }

  const apiKey = headers['x-api-key'] || headers['X-Api-Key'];
  if (apiKey) return { token: apiKey, headerType: 'api-key', source: 'intercepted:x-api-key' };

  const auth = headers['authorization'] || headers['Authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    return { token: auth.slice(7), headerType: 'bearer', source: 'intercepted:bearer' };
  }

  return null;
}

function captureAuth(ctx, url, headers, settings) {
  try {
    const target = parseTargetFromInput(url);
    if (!target.valid || !target.host || !settings.hostAllowlist.has(target.host)) return;
    const host = target.host;
    const port = target.port;

    if (host && ANTHROPIC_HOSTNAMES.has(host)) {
      // Capture full fingerprint
      const fingerprint = extractFingerprint(headers);
      if (fingerprint) {
        fingerprint.endpoint = { hostname: host, port };
        // Extract path from URL for messages path discovery
        if (typeof url === 'string') {
          try {
            const u = new URL(url);
            fingerprint.messagesPath = u.pathname + u.search;
          } catch {
            // URL parsing failed — skip messages path capture
          }
        }
        updateFingerprint(ctx, fingerprint);
      }

      const cred = extractAuthFromHeaders(headers);
      if (cred && cred.token !== ctx.interceptedToken) {
        const wasEmpty = !ctx.interceptedToken;
        ctx.interceptedToken = cred.token;
        ctx.interceptedHeaderType = cred.headerType;
        ctx.interceptedSource = cred.source;

        // Store the exact host Claude Code is calling so proxy.js mirrors it
        ctx.interceptedHost = host;
        ctx.interceptedPort = port;

        // Clear credential cache so next bridge request picks up the fresh token
        ctx.cachedCredentials = null;
        ctx.credentialsCachedAt = 0;

        const preview = cred.token.slice(0, 8) + '...' + cred.token.slice(-4);
        log(
          ctx,
          wasEmpty
            ? `🔑 [INTERCEPT] Captured Claude Code auth from ${host} (${cred.source}): ${preview}`
            : `🔑 [INTERCEPT] Auth rotated from ${host} (${cred.source}): ${preview}`,
        );
        log(ctx, `🔍 [FINGERPRINT] Captured ${Object.keys(fingerprint || {}).length} header values from ${host}`);
      }
    }
  } catch {
    /* never break the original call */
  }
}

function createInterceptedFetch(ctx) {
  const settings = normalizeSettings(ctx.interceptorSettings);
  return async function interceptedFetch(input, init) {
    let url = input;
    let headers = init?.headers;

    if (input instanceof Request) {
      url = input.url;
      headers = input.headers;
    } else if (typeof input === 'object' && input !== null && 'url' in input) {
      url = input.url;
      headers = input.headers;
    }

    captureAuth(ctx, url, headers, settings);

    return ctx._originalFetch.call(globalThis, input, init);
  };
}

function createInterceptedRequest(ctx) {
  const settings = normalizeSettings(ctx.interceptorSettings);
  return function interceptedRequest(optionsOrUrl, optionsOrCb, ...rest) {
    try {
      let rawHeaders = null;
      if (optionsOrUrl && typeof optionsOrUrl === 'object' && !(optionsOrUrl instanceof URL)) {
        rawHeaders = optionsOrUrl.headers;
      } else if (optionsOrCb && typeof optionsOrCb === 'object') {
        rawHeaders = optionsOrCb.headers;
      }

      const target = parseTargetFromInput(optionsOrUrl, optionsOrCb);
      if (!target.valid || !target.host || !settings.hostAllowlist.has(target.host)) {
        return ctx._wrappedHttpsRequest.call(this, optionsOrUrl, optionsOrCb, ...rest);
      }

      if (target.host && ANTHROPIC_HOSTNAMES.has(target.host)) {
        const cred = extractAuthFromHeaders(rawHeaders);
        if (cred && cred.token !== ctx.interceptedToken) {
          const wasEmpty = !ctx.interceptedToken;
          ctx.interceptedToken = cred.token;
          ctx.interceptedHeaderType = cred.headerType;
          ctx.interceptedSource = cred.source;

          // Store the exact host Claude Code is calling so proxy.js mirrors it
          ctx.interceptedHost = target.host;
          ctx.interceptedPort = target.port;

          // Clear credential cache so next bridge request picks up the fresh token
          ctx.cachedCredentials = null;
          ctx.credentialsCachedAt = 0;

          const preview = cred.token.slice(0, 8) + '...' + cred.token.slice(-4);
          log(
            ctx,
            wasEmpty
              ? `🔑 [INTERCEPT] Captured Claude Code auth from ${target.host} (${cred.source}): ${preview}`
              : `🔑 [INTERCEPT] Auth rotated from ${target.host} (${cred.source}): ${preview}`,
          );
        }
      }
    } catch {
      /* never break the original call */
    }

    return ctx._wrappedHttpsRequest.call(this, optionsOrUrl, optionsOrCb, ...rest);
  };
}

function markWrapper(fn, owner, previous, symbol) {
  Object.defineProperty(fn, symbol, {
    value: { owner, previous },
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

function install(ctx, settings = {}) {
  ctx.interceptorSettings = settings;
  const normalized = normalizeSettings(settings);

  // Patch https.request
  const currentRequest = https.request;
  const existingWrapper = currentRequest?.[HTTPS_REQUEST_WRAPPER_SYMBOL];
  if (existingWrapper && existingWrapper.owner !== 'claude-local-bridge') {
    log(ctx, `⚠️ HTTPS request already wrapped by ${existingWrapper.owner}`, true);
    if (normalized.interceptorMode === MODES.OBSERVE_ONLY) {
      log(ctx, '⚠️ observe-only mode aborts install on wrapper conflict');
      return;
    }
  }

  ctx._originalHttpsRequest = currentRequest;
  ctx._wrappedHttpsRequest = currentRequest;
  ctx._interceptedRequest = createInterceptedRequest(ctx);
  markWrapper(ctx._interceptedRequest, 'claude-local-bridge', currentRequest, HTTPS_REQUEST_WRAPPER_SYMBOL);
  https.request = ctx._interceptedRequest;
  log(ctx, '🔌 HTTPS interceptor installed (watching Anthropic endpoints)');

  // Patch globalThis.fetch (used by Anthropic SDK)
  if (typeof globalThis.fetch === 'function') {
    const currentFetch = globalThis.fetch;
    const existingFetchWrapper = currentFetch?.[FETCH_WRAPPER_SYMBOL];
    if (existingFetchWrapper && existingFetchWrapper.owner !== 'claude-local-bridge') {
      log(ctx, `⚠️ fetch already wrapped by ${existingFetchWrapper.owner}`, true);
      if (normalized.interceptorMode === MODES.OBSERVE_ONLY) {
        log(ctx, '⚠️ observe-only mode aborts fetch install on wrapper conflict');
        return;
      }
    }
    ctx._originalFetch = currentFetch;
    ctx._interceptedFetch = createInterceptedFetch(ctx);
    markWrapper(ctx._interceptedFetch, 'claude-local-bridge', currentFetch, FETCH_WRAPPER_SYMBOL);
    globalThis.fetch = ctx._interceptedFetch;
    log(ctx, '🔌 Fetch interceptor installed (watching Anthropic endpoints)');
  }
}

function uninstall(ctx) {
  // Idempotent and safe unwind: restore only when we're still top-most.
  if (ctx._originalHttpsRequest && https.request === ctx._interceptedRequest) {
    https.request = ctx._originalHttpsRequest;
  }
  ctx._originalHttpsRequest = null;
  ctx._wrappedHttpsRequest = null;
  ctx._interceptedRequest = null;

  if (ctx._originalFetch && globalThis.fetch === ctx._interceptedFetch) {
    globalThis.fetch = ctx._originalFetch;
  }
  ctx._originalFetch = null;
  ctx._interceptedFetch = null;

  log(ctx, '🔌 Interceptors removed');
}

module.exports = { install, uninstall };
