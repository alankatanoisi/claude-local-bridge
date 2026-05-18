'use strict';

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { log, sendJson, updateStatusBar } = require('./utils');
const { handleModels } = require('./handlers/models');
const { handleAnthropicMessages, handleCountTokens } = require('./handlers/anthropic');
const { handleChatCompletions } = require('./handlers/openai');
const { handleDebug, handleDebugProfiles, handleDebugIde, handleDebugSecurity } = require('./handlers/debug');
const { handleAgentRuns, handleAgentRunStatus, handleAgentApproval } = require('./handlers/agent');
const { getCredentials } = require('./credentials');

// ─────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────

async function startServer(ctx) {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');
  const basePort = config.get('port', 11437);
  const httpsEnabled = config.get('httpsEnabled', false);
  const httpsBasePort = config.get('httpsPort', 11443);

  if (ctx.server || ctx.httpsServer) await stopServer(ctx);

  const maxRetries = 10;
  const requestHandler = createRequestHandler(ctx);

  // Start the normal HTTP listener first.
  const httpServer = await bindSequentialPorts(() => http.createServer(requestHandler), basePort, maxRetries);
  ctx.server = httpServer.server;

  const creds = getCredentials(ctx);
  log(ctx, `✅ Server running on http://localhost:${httpServer.port}  [${creds.source}]`);
  updateStatusBar(ctx, true, httpServer.port, creds.source);
  ctx.server.on('error', (err) => {
    log(ctx, `❌ Server runtime error: ${err.message}`, true);
    updateStatusBar(ctx, false);
  });

  if (!httpsEnabled) return;

  const tlsOptions = loadHttpsOptions(config);
  const httpsServer = await bindSequentialPorts(
    () => https.createServer(tlsOptions, requestHandler),
    httpsBasePort,
    maxRetries,
  );
  ctx.httpsServer = httpsServer.server;
  ctx.httpsServer.on('error', (err) => {
    log(ctx, `❌ HTTPS server runtime error: ${err.message}`, true);
  });

  log(ctx, `🔐 HTTPS server running on https://localhost:${httpsServer.port}`);
}

function stopServer(ctx) {
  return new Promise((resolve) => {
    let remaining = 0;

    function done() {
      remaining -= 1;
      if (remaining <= 0) {
        ctx.server = null;
        ctx.httpsServer = null;
        updateStatusBar(ctx, false);
        resolve();
      }
    }

    if (!ctx.server && !ctx.httpsServer) {
      resolve();
      return;
    }

    if (ctx.server) {
      remaining += 1;
      ctx.server.close(done);
    }

    if (ctx.httpsServer) {
      remaining += 1;
      ctx.httpsServer.close(done);
    }
  });
}

// ─────────────────────────────────────────────
// Request Router
// ─────────────────────────────────────────────

function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

function createRequestHandler(ctx) {
  return (req, res) => {
    handleRequest(ctx, req, res).catch((err) => {
      log(ctx, `Request error: ${err.message}`, true);
      if (!res.headersSent) {
        const statusCode = err.statusCode || 500;
        const type = statusCode >= 500 ? 'internal_error' : 'invalid_request_error';
        sendJson(res, statusCode, { error: { message: err.message, type } });
      } else if (!res.writableEnded) {
        res.write(`data: {"error": "${err.message.replace(/"/g, '\\"')}"}\n\ndata: [DONE]\n\n`);
        res.end();
      }
    });
  };
}

async function bindSequentialPorts(serverFactory, basePort, maxRetries) {
  for (let offset = 0; offset <= maxRetries; offset++) {
    const port = basePort + offset;
    const server = serverFactory();
    server.timeout = 0;
    server.keepAliveTimeout = 0;

    const didBind = await new Promise((resolve, reject) => {
      function onError(err) {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          resolve(false);
          return;
        }
        reject(err);
      }

      function onListening() {
        server.removeListener('error', onError);
        resolve(true);
      }

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

    if (didBind) {
      return { server, port };
    }
  }

  throw new Error(`listen EADDRINUSE: Exhausted ${maxRetries} sequential ports starting at ${basePort}`);
}

function loadHttpsOptions(config) {
  const keyFile = config.get('httpsKeyFile', '');
  const certFile = config.get('httpsCertFile', '');

  if (!keyFile || !certFile) {
    throw new Error('HTTPS is enabled but claudeLocalBridge.httpsKeyFile or httpsCertFile is missing');
  }

  return {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
  };
}

async function handleRequest(ctx, req, res) {
  const origin = req.headers['origin'];
  if (origin) {
    if (!isLocalhostOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Forbidden: Invalid Origin', type: 'forbidden' } }));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-goog-api-key',
    );
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(origin ? 204 : 403);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  // ── Model listing ──
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    return handleModels(ctx, req, res);
  }

  // ── OpenAI Chat Completions ──
  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    return handleChatCompletions(ctx, req, res);
  }

  // ── Anthropic Messages ──
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    return handleAnthropicMessages(ctx, req, res);
  }

  // ── Anthropic count_tokens preflight ──
  if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
    return handleCountTokens(ctx, req, res);
  }

  // ── Local agent runner ──
  if (req.method === 'POST' && url.pathname === '/v1/agent/runs') {
    return handleAgentRuns(ctx, req, res);
  }

  const agentRunMatch = url.pathname.match(/^\/v1\/agent\/runs\/([^/]+)$/);
  if (req.method === 'GET' && agentRunMatch) {
    return handleAgentRunStatus(ctx, req, res, agentRunMatch[1]);
  }

  const agentApprovalMatch = url.pathname.match(/^\/v1\/agent\/runs\/([^/]+)\/approve$/);
  if (req.method === 'POST' && agentApprovalMatch) {
    return handleAgentApproval(ctx, req, res, agentApprovalMatch[1]);
  }

  // ── Debug ──
  if (req.method === 'GET' && url.pathname === '/v1/debug') {
    return handleDebug(ctx, req, res);
  }

  if (req.method === 'GET' && url.pathname === '/v1/debug/profiles') {
    return handleDebugProfiles(ctx, req, res);
  }

  if (req.method === 'GET' && url.pathname === '/v1/debug/ide') {
    return handleDebugIde(ctx, req, res);
  }

  if (req.method === 'GET' && url.pathname === '/v1/debug/security') {
    return handleDebugSecurity(ctx, req, res);
  }

  sendJson(res, 404, {
    error: { message: `Unknown: ${req.method} ${url.pathname}`, type: 'not_found' },
  });
}

module.exports = { startServer, stopServer, isLocalhostOrigin };
