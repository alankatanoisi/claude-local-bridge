'use strict';

const http = require('http');

async function sendMessageViaBridge(ctx, body) {
  const port = currentHttpPort(ctx);
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': 'local',
          'content-length': Buffer.byteLength(payload),
        },
        timeout: 300_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            reject(new Error(`Bridge returned non-JSON response (${res.statusCode}): ${text.slice(0, 300)}`));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(json.error?.message || `Bridge returned ${res.statusCode}`));
            return;
          }
          resolve(json);
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Bridge request timed out')));
    req.write(payload);
    req.end();
  });
}

function currentHttpPort(ctx) {
  const address = ctx.server && ctx.server.address && ctx.server.address();
  if (address && typeof address === 'object' && address.port) return address.port;
  return 11437;
}

module.exports = { sendMessageViaBridge };
