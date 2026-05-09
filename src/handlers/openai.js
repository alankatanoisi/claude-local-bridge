'use strict';

/**
 * POST /v1/chat/completions — OpenAI Chat Completions format
 *
 * Converts OpenAI request → Anthropic request → proxies → converts response back.
 * Supports both streaming (stream: true) and non-streaming responses.
 */

const { readBody, sendJson, log, verboseLog } = require('../utils');
const { resolveModel } = require('../models');
const {
  getCredentials,
  buildAuthHeaders,
  clearCredentialsCache,
  prependClaudeCodeSystem,
  messagesPathFor,
} = require('../credentials');
const https = require('https');
const { URL } = require('url');
const { randomUUID } = require('crypto');
const vscode = require('vscode');
const {
  openAIToAnthropic,
  anthropicResponseToOpenAI,
  createAnthropicToOpenAIStreamConverter,
} = require('../translators/anthropic-openai');
const { isOpenCodeGoModel, handleOpenAIChatToOpenCodeGo } = require('../providers/opencode-go');
const { WIRE_APIS, recordRoute } = require('../profiles');

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

async function handleChatCompletions(ctx, req, res) {
  const raw = await readBody(req);
  verboseLog(ctx, `→ /v1/chat/completions body: ${raw.slice(0, 300)}`);

  let oaiBody;
  try {
    oaiBody = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
    return;
  }

  // If the requested model belongs to a provider-backed catalog like
  // `opencode-go/...`, hand off to that adapter immediately.
  if (isOpenCodeGoModel(oaiBody.model)) {
    recordRoute(ctx, {
      endpoint: '/v1/chat/completions',
      providerId: 'opencode-go',
      incomingWireApi: WIRE_APIS.OPENAI_CHAT,
      upstreamWireApi: 'model-specific',
      requestedModel: oaiBody.model,
    });
    return handleOpenAIChatToOpenCodeGo(ctx, req, res, oaiBody);
  }

  const antBody = openAIToAnthropic(oaiBody, (model) => resolveModel(model, vscode));
  recordRoute(ctx, {
    endpoint: '/v1/chat/completions',
    providerId: 'anthropic',
    incomingWireApi: WIRE_APIS.OPENAI_CHAT,
    upstreamWireApi: WIRE_APIS.ANTHROPIC_MESSAGES,
    requestedModel: oaiBody.model || null,
    upstreamModel: antBody.model,
  });
  // Reshape system field to match Claude Code's wire format when using OAuth.
  prependClaudeCodeSystem(ctx, antBody, getCredentials(ctx));
  const antBodyStr = JSON.stringify(antBody);
  const completionId = `chatcmpl-${randomUUID()}`;
  const isStream = oaiBody.stream === true;

  if (!isStream) {
    return handleChatCompletionsBuffered(ctx, res, antBodyStr, completionId);
  }

  // For streaming: we can't use proxyToAnthropic directly because we need to
  // intercept and convert the SSE events.
  return handleChatCompletionsStreaming(ctx, req, res, antBodyStr, antBody.model, completionId);
}

/**
 * Non-streaming: fetch full Anthropic response, convert to OpenAI format.
 */
async function handleChatCompletionsBuffered(ctx, res, antBodyStr, completionId, retry = false) {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');
  const configuredBaseUrl = config.get('anthropicBaseUrl', 'https://api.anthropic.com');

  // Prefer the host we observed Claude Code actually calling
  const baseUrl = ctx.interceptedHost
    ? `https://${ctx.interceptedHost}${ctx.interceptedPort && ctx.interceptedPort !== 443 ? `:${ctx.interceptedPort}` : ''}`
    : configuredBaseUrl;
  const creds = getCredentials(ctx);
  const apiPath = messagesPathFor(ctx, creds);
  const url = new URL(apiPath, baseUrl);
  const authHeaders = buildAuthHeaders(ctx, creds);
  const bodyBuf = Buffer.from(antBodyStr, 'utf8');

  return new Promise((resolve, reject) => {
    const upReq = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { ...authHeaders, 'content-length': bodyBuf.length },
        timeout: 300_000,
      },
      (upRes) => {
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');

          // On 401: clear cache and retry once
          if (upRes.statusCode === 401 && !retry) {
            log(ctx, '⚠️ Received 401 (OpenAI path) — clearing credential cache and retrying');
            clearCredentialsCache(ctx);
            handleChatCompletionsBuffered(ctx, res, antBodyStr, completionId, true).then(resolve).catch(reject);
            return;
          }

          if (upRes.statusCode !== 200) {
            let errPayload;
            try {
              errPayload = JSON.parse(body);
            } catch {
              errPayload = { error: { type: 'upstream_error', message: body } };
            }
            sendJson(res, upRes.statusCode, errPayload);
            resolve();
            return;
          }

          try {
            const antResp = JSON.parse(body);
            const oaiResp = anthropicResponseToOpenAI(antResp, completionId);
            sendJson(res, 200, oaiResp);
          } catch (err) {
            sendJson(res, 500, { error: { type: 'internal_error', message: err.message } });
          }
          resolve();
        });
        upRes.on('error', reject);
      },
    );
    upReq.on('error', reject);
    upReq.write(bodyBuf);
    upReq.end();
  });
}

/**
 * Streaming: convert Anthropic SSE events to OpenAI SSE events on-the-fly.
 */
async function handleChatCompletionsStreaming(ctx, _req, res, antBodyStr, modelName, completionId, retry = false) {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');
  const configuredBaseUrl = config.get('anthropicBaseUrl', 'https://api.anthropic.com');

  // Prefer the host we observed Claude Code actually calling
  const baseUrl = ctx.interceptedHost
    ? `https://${ctx.interceptedHost}${ctx.interceptedPort && ctx.interceptedPort !== 443 ? `:${ctx.interceptedPort}` : ''}`
    : configuredBaseUrl;
  const creds = getCredentials(ctx);
  const apiPath = messagesPathFor(ctx, creds);
  const url = new URL(apiPath, baseUrl);
  const authHeaders = buildAuthHeaders(ctx, creds);
  const bodyBuf = Buffer.from(antBodyStr, 'utf8');

  // Set up OpenAI SSE response headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.writeHead(200);
  if (res.flushHeaders) res.flushHeaders();
  if (res.socket?.setNoDelay) res.socket.setNoDelay(true);

  const converter = createAnthropicToOpenAIStreamConverter(res, completionId, modelName);

  return new Promise((resolve, reject) => {
    const upReq = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { ...authHeaders, 'content-length': bodyBuf.length },
        timeout: 300_000,
      },
      (upRes) => {
        // On 401: clear cache and retry once
        if (upRes.statusCode === 401 && !retry) {
          log(ctx, '⚠️ Received 401 (streaming) — clearing credential cache and retrying');
          clearCredentialsCache(ctx);
          upRes.resume(); // drain upstream
          handleChatCompletionsStreaming(ctx, _req, res, antBodyStr, modelName, completionId, true)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (upRes.statusCode !== 200) {
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            const errBody = Buffer.concat(chunks).toString('utf8');
            res.write(`data: ${errBody}\n\ndata: [DONE]\n\n`);
            res.end();
            resolve();
          });
          return;
        }

        upRes.on('data', (chunk) => converter.write(chunk));
        upRes.on('end', () => {
          converter.end();
          resolve();
        });
        upRes.on('error', (err) => {
          log(ctx, `Streaming upstream error: ${err.message}`, true);
          if (!res.writableEnded) res.end();
          resolve();
        });
      },
    );
    upReq.on('error', reject);
    upReq.write(bodyBuf);
    upReq.end();
  });
}

module.exports = { handleChatCompletions };
