'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const { log } = require('./utils');

// ─────────────────────────────────────────────
// Auth Capture Proxy
//
// A lightweight HTTP proxy that Claude Code routes through via
// HTTPS_PROXY=http://localhost:<port>. When Claude Code makes requests,
// we capture the auth token and endpoint, then forward the request.
//
// This works because Claude Code respects HTTPS_PROXY and sends its
// requests through it. We intercept, capture, and forward.
// ─────────────────────────────────────────────

const ANTHROPIC_HOSTNAMES = new Set(['api.anthropic.com', 'claude.ai', 'api.claude.ai']);

function captureAuthFromHeaders(ctx, headers, host, port) {
  if (!headers) return;

  const apiKey = headers['x-api-key'] || headers['X-Api-Key'];
  if (apiKey && apiKey !== ctx.interceptedToken) {
    const wasEmpty = !ctx.interceptedToken;
    ctx.interceptedToken = apiKey;
    ctx.interceptedHeaderType = 'api-key';
    ctx.interceptedSource = 'proxy:x-api-key';
    ctx.interceptedHost = host;
    ctx.interceptedPort = port || 443;
    ctx.cachedCredentials = null;
    ctx.credentialsCachedAt = 0;
    const preview = apiKey.slice(0, 8) + '...' + apiKey.slice(-4);
    log(ctx, wasEmpty ? `🔑 [PROXY] Captured API key from ${host}: ${preview}` : `🔑 [PROXY] Auth rotated from ${host}: ${preview}`);
    return;
  }

  const auth = headers['authorization'] || headers['Authorization'];
  if (auth && auth.startsWith('Bearer ') && auth.slice(7) !== ctx.interceptedToken) {
    const token = auth.slice(7);
    const wasEmpty = !ctx.interceptedToken;
    ctx.interceptedToken = token;
    ctx.interceptedHeaderType = 'bearer';
    ctx.interceptedSource = 'proxy:bearer';
    ctx.interceptedHost = host;
    ctx.interceptedPort = port || 443;
    ctx.cachedCredentials = null;
    ctx.credentialsCachedAt = 0;
    const preview = token.slice(0, 8) + '...' + token.slice(-4);
    log(ctx, wasEmpty ? `🔑 [PROXY] Captured Bearer token from ${host}: ${preview}` : `🔑 [PROXY] Auth rotated from ${host}: ${preview}`);
  }
}

function startCaptureProxy(ctx) {
  const proxyPort = 11439;

  if (ctx.captureProxy) stopCaptureProxy(ctx);

  ctx.captureProxy = http.createServer((req, res) => {
    // Regular HTTP proxy for non-CONNECT requests
    handleProxyRequest(ctx, req, res);
  });

  ctx.captureProxy.on('connect', (req, clientSocket, head) => {
    // CONNECT tunnel for HTTPS
    handleConnect(ctx, req, clientSocket, head);
  });

  ctx.captureProxy.listen(proxyPort, '127.0.0.1', () => {
    log(ctx, `🔌 Auth capture proxy running on http://localhost:${proxyPort}`);
    log(ctx, `   Set HTTPS_PROXY=http://localhost:${proxyPort} in Claude Code's environment`);
  });

  ctx.captureProxy.on('error', (err) => {
    log(ctx, `⚠️ Capture proxy error: ${err.message}`, true);
  });
}

function stopCaptureProxy(ctx) {
  if (ctx.captureProxy) {
    ctx.captureProxy.close(() => {
      ctx.captureProxy = null;
    });
  }
}

function handleProxyRequest(ctx, req, res) {
  // Extract target from the request URL (absolute URL in proxy mode)
  let targetUrl;
  try {
    targetUrl = new URL(req.url);
  } catch {
    // Fall back to Host header
    const host = req.headers['host'];
    if (host) {
      targetUrl = new URL(`https://${host}${req.url}`);
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing target URL' }));
      return;
    }
  }

  const host = targetUrl.hostname;

  // Capture auth if targeting Anthropic
  if (ANTHROPIC_HOSTNAMES.has(host)) {
    captureAuthFromHeaders(ctx, req.headers, host, targetUrl.port);
  }

  // Forward the request
  const options = {
    hostname: host,
    port: targetUrl.port || 443,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: { ...req.headers, host },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    log(ctx, `Proxy forward error: ${err.message}`, true);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  req.pipe(proxyReq);
}

function handleConnect(ctx, req, clientSocket, head) {
  const { hostname, port } = parseHost(req.url);

  // `CONNECT` is how an HTTP proxy carries HTTPS traffic.
  // After the tunnel is established, the bytes are TLS-encrypted end-to-end.
  // That means we can tunnel the traffic, but we cannot reliably read auth
  // headers out of the encrypted stream unless we switch to a real MITM proxy.
  // So for CONNECT we focus on making the tunnel work correctly and log what
  // target was used for debugging.
  if (ANTHROPIC_HOSTNAMES.has(hostname)) {
    log(ctx, `🔌 [PROXY] CONNECT tunnel to ${hostname}:${port}`);
  }

  // Use a plain TCP socket here.
  // `https.connect()` does not exist in Node, and even if it did, wrapping the
  // upstream side in TLS would be the wrong thing for an HTTP CONNECT tunnel.
  // The client and the upstream server must perform the TLS handshake directly
  // through this raw socket.
  const upstreamSocket = net.connect({
    host: hostname,
    port: port || 443,
  });

  upstreamSocket.on('connect', () => {
    // Tell the proxy client that the tunnel is ready.
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // If Node gave us any already-read bytes after the CONNECT line, forward
    // them first so the TLS handshake can continue without losing data.
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }

    // From this point on, this is just a byte tunnel in both directions.
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);

    upstreamSocket.on('error', (err) => {
      log(ctx, `Proxy socket error: ${err.message}`, true);
      clientSocket.end();
    });

    clientSocket.on('error', (err) => {
      log(ctx, `Client socket error: ${err.message}`, true);
      upstreamSocket.end();
    });
  });

  upstreamSocket.on('error', (err) => {
    log(ctx, `CONNECT error: ${err.message}`, true);
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
  });
}

function parseHost(hostStr) {
  const [hostname, port] = hostStr.split(':');
  return { hostname, port: port ? parseInt(port) : 443 };
}

module.exports = { startCaptureProxy, stopCaptureProxy };
