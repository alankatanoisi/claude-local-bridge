'use strict';

const vscode = require('vscode');
const { emitLog, sanitizeForResponse } = require('./logging');

function log(ctx, msg, isError = false) {
  const level = isError ? 'error' : 'info';
  if (typeof msg === 'object' && msg && msg.event) {
    emitLog(ctx, level, msg.event, msg);
    return;
  }

  emitLog(ctx, level, 'message', {
    details: {
      message: typeof msg === 'string' ? msg : JSON.stringify(msg),
    },
  });
}

function verboseLog(ctx, event, details = {}) {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');
  if (!config.get('logRequests', false)) return;

  if (typeof event === 'string' && Object.keys(details).length === 0) {
    emitLog(ctx, 'debug', 'verbose', { details: { message: event } });
    return;
  }

  emitLog(ctx, 'debug', event, details);
}

function updateStatusBar(ctx, running, port, credSource) {
  if (!ctx.statusBarItem) return;
  if (running) {
    const icon = '$(radio-tower)';
    const src = credSource ? ` [${credSource}]` : '';
    ctx.statusBarItem.text = `${icon} Claude Bridge :${port}${src}`;
    ctx.statusBarItem.backgroundColor = undefined;
  } else {
    ctx.statusBarItem.text = '$(warning) Claude Bridge OFF';
    ctx.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  ctx.statusBarItem.show();
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(code);
  res.end(body);
}

function sendSafeJson(res, code, payload) {
  const safePayload = sanitizeForResponse(payload);
  sendJson(res, code, safePayload);
}

function readBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (c) => {
      totalBytes += c.length;
      if (totalBytes > maxBytes) {
        req.destroy(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function buildStreamChunk(id, model, content, finishReason = null) {
  const delta = content !== null ? { role: 'assistant', content } : {};
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function buildCompletion(id, model, content) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

module.exports = {
  log,
  verboseLog,
  updateStatusBar,
  sendJson,
  sendSafeJson,
  readBody,
  buildStreamChunk,
  buildCompletion,
};
