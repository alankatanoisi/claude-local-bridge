'use strict';

const https = require('https');
const { log } = require('../utils');
const { extractFingerprint, updateFingerprint } = require('../fingerprint');

const ANTHROPIC_HOSTNAMES = new Set(['api.anthropic.com', 'claude.ai', 'api.claude.ai']);

function extractAuthFromHeaders(headers) {
  if (!headers) return null;

  if (typeof headers?.entries === 'function') {
    const entries = Object.fromEntries(headers.entries());
    return extractAuthFromHeaders(entries);
  }

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

function captureAuth(ctx, url, headers) {
  try {
    let host, port, path;

    if (typeof url === 'string') {
      const u = new URL(url);
      host = u.hostname;
      port = u.port ? parseInt(u.port) : 443;
      path = u.pathname;
    } else if (url instanceof URL) {
      host = url.hostname;
      port = url.port ? parseInt(url.port) : 443;
      path = url.pathname;
    }

    if (host && ANTHROPIC_HOSTNAMES.has(host)) {
      const fingerprint = extractFingerprint(headers);
      if (fingerprint) {
        fingerprint.endpoint = { hostname: host, port };
        if (typeof url === 'string') {
          try {
            const u = new URL(url);
            fingerprint.messagesPath = u.pathname + u.search;
          } catch {
            // ignore URL parse failures
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
        ctx.interceptedHost = host;
        ctx.interceptedPort = port;
        ctx.cachedCredentials = null;
        ctx.credentialsCachedAt = 0;

        log(ctx, {
          event: wasEmpty ? 'interceptor.auth.captured' : 'interceptor.auth.rotated',
          path,
          credentialSource: cred.source,
          details: { host, port, headerType: cred.headerType, tokenPreview: cred.token },
        });

        log(ctx, {
          event: 'interceptor.fingerprint.captured',
          path,
          credentialSource: cred.source,
          details: { host, headerCount: Object.keys(fingerprint || {}).length },
        });
      }
    }
  } catch {
    /* never break the original call */
  }
}

function createInterceptedFetch(ctx) {
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

    captureAuth(ctx, url, headers);

    return ctx._originalFetch.call(globalThis, input, init);
  };
}

function createInterceptedRequest(ctx) {
  return function interceptedRequest(optionsOrUrl, optionsOrCb, ...rest) {
    try {
      let host, port, rawHeaders, path;

      if (typeof optionsOrUrl === 'string' || optionsOrUrl instanceof URL) {
        const u = new URL(optionsOrUrl.toString());
        host = u.hostname;
        port = u.port ? parseInt(u.port) : 443;
        path = u.pathname;
        rawHeaders = optionsOrCb && typeof optionsOrCb === 'object' ? optionsOrCb.headers : null;
      } else if (optionsOrUrl && typeof optionsOrUrl === 'object') {
        host = optionsOrUrl.hostname || optionsOrUrl.host || '';
        port = parseInt(optionsOrUrl.port) || 443;
        path = optionsOrUrl.path;
        rawHeaders = optionsOrUrl.headers;
      }

      if (host && ANTHROPIC_HOSTNAMES.has(host)) {
        const cred = extractAuthFromHeaders(rawHeaders);
        if (cred && cred.token !== ctx.interceptedToken) {
          const wasEmpty = !ctx.interceptedToken;
          ctx.interceptedToken = cred.token;
          ctx.interceptedHeaderType = cred.headerType;
          ctx.interceptedSource = cred.source;
          ctx.interceptedHost = host;
          ctx.interceptedPort = port;
          ctx.cachedCredentials = null;
          ctx.credentialsCachedAt = 0;

          log(ctx, {
            event: wasEmpty ? 'interceptor.auth.captured' : 'interceptor.auth.rotated',
            path,
            credentialSource: cred.source,
            details: { host, port, headerType: cred.headerType, tokenPreview: cred.token },
          });
        }
      }
    } catch {
      /* never break the original call */
    }

    return ctx._originalHttpsRequest.call(this, optionsOrUrl, optionsOrCb, ...rest);
  };
}

function install(ctx) {
  ctx._originalHttpsRequest = https.request;
  ctx._interceptedRequest = createInterceptedRequest(ctx);
  https.request = ctx._interceptedRequest;
  log(ctx, { event: 'interceptor.https.installed' });

  if (typeof globalThis.fetch === 'function') {
    ctx._originalFetch = globalThis.fetch;
    ctx._interceptedFetch = createInterceptedFetch(ctx);
    globalThis.fetch = ctx._interceptedFetch;
    log(ctx, { event: 'interceptor.fetch.installed' });
  }
}

function uninstall(ctx) {
  if (ctx._originalHttpsRequest && https.request === ctx._interceptedRequest) {
    https.request = ctx._originalHttpsRequest;
  }
  ctx._originalHttpsRequest = null;
  ctx._interceptedRequest = null;

  if (ctx._originalFetch && globalThis.fetch === ctx._interceptedFetch) {
    globalThis.fetch = ctx._originalFetch;
  }
  ctx._originalFetch = null;
  ctx._interceptedFetch = null;

  log(ctx, { event: 'interceptor.uninstalled' });
}

module.exports = { install, uninstall };
