'use strict';

const http = require('http');
const https = require('https');
const { log } = require('./utils');

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
    log(ctx, {
      event: wasEmpty ? 'capture_proxy.auth.captured' : 'capture_proxy.auth.rotated',
      credentialSource: ctx.interceptedSource,
      details: { host, port: ctx.interceptedPort, headerType: 'api-key', tokenPreview: apiKey },
    });
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
    log(ctx, {
      event: wasEmpty ? 'capture_proxy.auth.captured' : 'capture_proxy.auth.rotated',
      credentialSource: ctx.interceptedSource,
      details: { host, port: ctx.interceptedPort, headerType: 'bearer', tokenPreview: token },
    });
  }
}

function startCaptureProxy(ctx) {
  const proxyPort = 11439;

  if (ctx.captureProxy) stopCaptureProxy(ctx);

  ctx.captureProxy = http.createServer((req, res) => {
    handleProxyRequest(ctx, req, res);
  });

  ctx.captureProxy.on('connect', (req, clientSocket, head) => {
    handleConnect(ctx, req, clientSocket, head);
  });

  ctx.captureProxy.listen(proxyPort, '127.0.0.1', () => {
    log(ctx, { event: 'capture_proxy.started', details: { url: `http://localhost:${proxyPort}` } });
  });

  ctx.captureProxy.on('error', (err) => {
    log(ctx, { event: 'capture_proxy.error', details: { message: err.message } }, true);
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
  let targetUrl;
  try {
    targetUrl = new URL(req.url);
  } catch {
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

  if (ANTHROPIC_HOSTNAMES.has(host)) {
    captureAuthFromHeaders(ctx, req.headers, host, targetUrl.port);
  }

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
    log(ctx, { event: 'capture_proxy.forward_error', path: targetUrl.pathname, details: { message: err.message } }, true);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream proxy failure' }));
    }
  });

  req.pipe(proxyReq);
}

function handleConnect(ctx, req, clientSocket, head) {
  const { hostname, port } = parseHost(req.url);

  if (ANTHROPIC_HOSTNAMES.has(hostname)) {
    log(ctx, { event: 'capture_proxy.connect', details: { hostname, port } });
  }

  const proxyReq = https.connect({
    host: hostname,
    port: port || 443,
  });

  proxyReq.on('connect', (_proxyRes, proxySocket) => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    proxySocket.on('data', (data) => clientSocket.write(data));
    clientSocket.on('data', (data) => {
      if (ANTHROPIC_HOSTNAMES.has(hostname) && !ctx.interceptedToken) {
        const text = data.toString('utf8', 0, Math.min(data.length, 8192));
        const authMatch = text.match(/authorization:\s*bearer\s*([^\r\n]+)/i);
        const keyMatch = text.match(/x-api-key:\s*([^\r\n]+)/i);
        if (authMatch) {
          captureAuthFromHeaders(ctx, { authorization: `Bearer ${authMatch[1].trim()}` }, hostname, port);
        } else if (keyMatch) {
          captureAuthFromHeaders(ctx, { 'x-api-key': keyMatch[1].trim() }, hostname, port);
        }
      }
      proxySocket.write(data);
    });

    proxySocket.on('error', (err) => {
      log(ctx, { event: 'capture_proxy.proxy_socket_error', details: { message: err.message } }, true);
      clientSocket.end();
    });

    clientSocket.on('error', (err) => {
      log(ctx, { event: 'capture_proxy.client_socket_error', details: { message: err.message } }, true);
      proxySocket.end();
    });
  });

  proxyReq.on('error', (err) => {
    log(ctx, { event: 'capture_proxy.connect_error', details: { message: err.message } }, true);
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
  });

  if (head && head.length > 0) {
    proxyReq.write(head);
  }
}

function parseHost(hostStr) {
  const [hostname, port] = hostStr.split(':');
  return { hostname, port: port ? parseInt(port) : 443 };
}

module.exports = { startCaptureProxy, stopCaptureProxy };
