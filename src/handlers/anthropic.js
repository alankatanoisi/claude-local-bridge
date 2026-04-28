'use strict';

const { readBody, sendJson, verboseLog, log } = require('../utils');
const { resolveModel } = require('../models');
const { proxyToAnthropic } = require('../proxy');
const { getCredentials, prependClaudeCodeSystem, messagesPathFor } = require('../credentials');
const { redactHeaders, redactAny } = require('../logging');

const vscode = require('vscode');

function dumpCapture(ctx, req, raw) {
  const cfg = vscode.workspace.getConfiguration('claudeLocalBridge');
  if (!cfg.get('logRequests', false)) return;

  let parsedBody = raw;
  try {
    parsedBody = redactAny(JSON.parse(raw), { redactionPolicy: 'strict' });
  } catch {
    parsedBody = redactAny({ body: raw }, { redactionPolicy: 'strict' });
  }

  log(ctx, {
    event: 'anthropic.capture',
    path: '/v1/messages',
    details: {
      headers: redactHeaders(req.headers, { redactionPolicy: 'strict' }),
      body: parsedBody,
    },
  });
}

async function handleAnthropicMessages(ctx, req, res) {
  const raw = await readBody(req);
  dumpCapture(ctx, req, raw);
  verboseLog(ctx, 'anthropic.request.received', {
    path: '/v1/messages',
    requestId: req.headers['x-request-id'] || null,
  });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
    return;
  }

  body.model = resolveModel(body.model, vscode);

  if (!body.max_tokens) body.max_tokens = 4096;

  const creds = getCredentials(ctx);
  prependClaudeCodeSystem(ctx, body, creds);

  await proxyToAnthropic(ctx, res, messagesPathFor(ctx, creds), JSON.stringify(body));
}

function handleCountTokens(_ctx, _req, res) {
  sendJson(res, 200, { input_tokens: 0 });
}

module.exports = { handleAnthropicMessages, handleCountTokens };
