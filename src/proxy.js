'use strict';

const https = require('https');
const { URL } = require('url');
const vscode = require('vscode');
const { getCredentials, clearCredentialsCache, buildAuthHeaders } = require('./credentials');
const { log, verboseLog } = require('./utils');

async function proxyToAnthropic(ctx, res, apiPath, bodyStr, retry = false) {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');
  const configuredBaseUrl = config.get('anthropicBaseUrl', 'https://api.anthropic.com');

  const baseUrl = ctx.interceptedHost
    ? `https://${ctx.interceptedHost}${ctx.interceptedPort && ctx.interceptedPort !== 443 ? `:${ctx.interceptedPort}` : ''}`
    : configuredBaseUrl;

  const url = new URL(apiPath, baseUrl);
  const creds = getCredentials(ctx);
  const authHeaders = buildAuthHeaders(ctx, creds);

  verboseLog(ctx, 'proxy.request', {
    path: url.pathname,
    credentialSource: creds.source,
    details: { hostname: url.hostname, model: tryExtractModel(bodyStr), retry },
  });

  const bodyBuf = Buffer.from(bodyStr, 'utf8');

  const reqOptions = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      ...authHeaders,
      'content-length': bodyBuf.length,
    },
    timeout: 300_000,
  };

  return new Promise((resolve, reject) => {
    const upReq = https.request(reqOptions, (upRes) => {
      const requestId = upRes.headers['x-request-id'] || null;
      verboseLog(ctx, 'proxy.response', {
        path: url.pathname,
        status: upRes.statusCode,
        requestId,
        credentialSource: creds.source,
      });

      if (upRes.statusCode === 401 && !retry) {
        log(ctx, {
          event: 'proxy.auth.retry',
          path: url.pathname,
          status: 401,
          requestId,
          credentialSource: creds.source,
          details: { reason: 'upstream_401' },
        });
        clearCredentialsCache(ctx);
        upRes.resume();
        proxyToAnthropic(ctx, res, apiPath, bodyStr, true).then(resolve).catch(reject);
        return;
      }

      const forwardHeaders = {};
      const passthroughHeaders = [
        'content-type',
        'x-request-id',
        'anthropic-ratelimit-requests-limit',
        'anthropic-ratelimit-requests-remaining',
        'anthropic-ratelimit-requests-reset',
        'anthropic-ratelimit-tokens-limit',
        'anthropic-ratelimit-tokens-remaining',
        'anthropic-ratelimit-tokens-reset',
      ];
      for (const h of passthroughHeaders) {
        if (upRes.headers[h]) forwardHeaders[h] = upRes.headers[h];
      }

      if (!res.headersSent) {
        res.writeHead(upRes.statusCode, forwardHeaders);
      }

      upRes.on('data', (chunk) => {
        if (!res.writableEnded) res.write(chunk);
      });
      upRes.on('end', () => {
        if (!res.writableEnded) res.end();
        resolve();
      });
      upRes.on('error', (err) => {
        log(ctx, {
          event: 'proxy.upstream.response_error',
          path: url.pathname,
          status: upRes.statusCode,
          requestId,
          credentialSource: creds.source,
          details: { message: err.message },
        }, true);
        if (!res.writableEnded) res.end();
        resolve();
      });
    });

    upReq.on('error', (err) => {
      log(ctx, {
        event: 'proxy.upstream.request_error',
        path: url.pathname,
        credentialSource: creds.source,
        details: { message: err.message },
      }, true);
      reject(err);
    });

    upReq.on('timeout', () => {
      log(ctx, {
        event: 'proxy.upstream.timeout',
        path: url.pathname,
        credentialSource: creds.source,
      }, true);
      upReq.destroy(new Error('Upstream request timed out'));
    });

    upReq.write(bodyBuf);
    upReq.end();
  });
}

function tryExtractModel(bodyStr) {
  try {
    return JSON.parse(bodyStr).model || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { proxyToAnthropic };
