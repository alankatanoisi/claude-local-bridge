'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const vscode = require('vscode');
const { randomUUID } = require('crypto');
const { log, sendJson, verboseLog } = require('../utils');
const {
  openAIToAnthropic,
  anthropicToOpenAI,
  anthropicResponseToOpenAI,
  openAIResponseToAnthropic,
  createAnthropicToOpenAIStreamConverter,
  createOpenAIToAnthropicStreamConverter,
} = require('../translators/anthropic-openai');

// OpenCode Go model ids and endpoint families, based on the official docs:
// https://opencode.ai/docs/zh-cn/go/
//
// We keep a static fallback list so the bridge can still advertise models when:
// - the Go `/v1/models` endpoint is temporarily unavailable
// - the API key has not been configured yet
// - the user wants deterministic model ids during setup
//
// The `wire_api` field is the important Phase 1 abstraction:
// - `openai-chat-completions` means the upstream expects `/v1/chat/completions`
// - `anthropic-messages` means the upstream expects `/v1/messages`
// - `openai-responses` is reserved for a later Phase 2/3 adapter
const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
const OPENCODE_GO_CACHE_TTL = 5 * 60 * 1000;

const STATIC_OPENCODE_GO_MODELS = [
  modelSeed('glm-5', 'GLM-5', 'openai-chat-completions'),
  modelSeed('glm-5.1', 'GLM-5.1', 'openai-chat-completions'),
  modelSeed('kimi-k2.5', 'Kimi K2.5', 'openai-chat-completions'),
  modelSeed('kimi-k2.6', 'Kimi K2.6', 'openai-chat-completions'),
  modelSeed('deepseek-v4-pro', 'DeepSeek V4 Pro', 'openai-chat-completions'),
  modelSeed('deepseek-v4-flash', 'DeepSeek V4 Flash', 'openai-chat-completions'),
  modelSeed('mimo-v2.5', 'MiMo-V2.5', 'openai-chat-completions'),
  modelSeed('mimo-v2.5-pro', 'MiMo-V2.5-Pro', 'openai-chat-completions'),
  modelSeed('qwen3.5-plus', 'Qwen3.5 Plus', 'openai-chat-completions'),
  modelSeed('qwen3.6-plus', 'Qwen3.6 Plus', 'openai-chat-completions'),
  modelSeed('minimax-m2.5', 'MiniMax M2.5', 'anthropic-messages'),
  modelSeed('minimax-m2.7', 'MiniMax M2.7', 'anthropic-messages'),
];

function modelSeed(upstreamId, displayName, wireApi) {
  return {
    id: `${OPENCODE_GO_PROVIDER_ID}/${upstreamId}`,
    upstream_model: upstreamId,
    name: `OpenCode Go ${displayName}`,
    owned_by: 'opencode',
    provider: OPENCODE_GO_PROVIDER_ID,
    wire_api: wireApi,
    context_length: 200000,
    output_length: 64000,
  };
}

function isOpenCodeGoModel(modelId) {
  return typeof modelId === 'string' && modelId.startsWith(`${OPENCODE_GO_PROVIDER_ID}/`);
}

function getOpenCodeGoSettings() {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');

  // We allow an environment variable as an easy escape hatch because many
  // people already think in terms of `export SOME_KEY=...` when testing APIs.
  const apiKey = process.env.CLAUDE_LOCAL_BRIDGE_OPENCODE_GO_API_KEY || config.get('opencodeGoApiKey', '');

  return {
    baseUrl: config.get('opencodeGoBaseUrl', 'https://opencode.ai/zen/go'),
    apiKey: apiKey.trim(),
    authScheme: config.get('opencodeGoAuthScheme', 'bearer'),
    catalogMode: config.get('modelCatalog', 'anthropic'),
  };
}

function shouldAdvertiseOpenCodeGo() {
  const settings = getOpenCodeGoSettings();

  // `hybrid` means "show both the local Claude bridge models and provider-backed ones".
  // `opencode-go` means "pretend this gateway is basically an OpenCode Go adapter".
  if (settings.catalogMode === 'hybrid' || settings.catalogMode === 'opencode-go') {
    return true;
  }

  // Even in `anthropic` mode, if the user explicitly configured a key they
  // probably want access to these models somewhere.
  return Boolean(settings.apiKey);
}

async function getOpenCodeGoModels(ctx) {
  const settings = getOpenCodeGoSettings();
  const cached = ctx.providerModelCache?.opencodeGo;
  const now = Date.now();

  if (cached && now - cached.cachedAt < OPENCODE_GO_CACHE_TTL) {
    return cached.models;
  }

  let models = STATIC_OPENCODE_GO_MODELS;

  if (settings.apiKey) {
    try {
      const discovered = await fetchOpenCodeGoModels(ctx, settings);
      models = mergeDiscoveredModels(discovered);
    } catch (err) {
      log(ctx, `⚠️ OpenCode Go model discovery failed, falling back to static catalog: ${err.message}`, true);
    }
  }

  ctx.providerModelCache = ctx.providerModelCache || {};
  ctx.providerModelCache.opencodeGo = { cachedAt: now, models };
  return models;
}

function findOpenCodeGoModel(modelId, models = STATIC_OPENCODE_GO_MODELS) {
  return models.find((model) => model.id === modelId) || null;
}

async function handleAnthropicMessagesToOpenCodeGo(ctx, req, res, antBody) {
  const models = await getOpenCodeGoModels(ctx);
  const model = findOpenCodeGoModel(antBody.model, models);

  if (!model) {
    sendJson(res, 404, {
      error: {
        type: 'not_found_error',
        message: `Unknown OpenCode Go model: ${antBody.model}`,
      },
    });
    return;
  }

  if (model.wire_api === 'anthropic-messages') {
    return proxyAnthropicBodyToAnthropicUpstream(ctx, res, antBody, model);
  }

  if (model.wire_api === 'openai-chat-completions') {
    return proxyAnthropicBodyToOpenAIUpstream(ctx, res, antBody, model);
  }

  if (model.wire_api === 'openai-responses') {
    sendJson(res, 501, {
      error: {
        type: 'not_implemented_error',
        message: `Model ${model.id} is earmarked for a future OpenAI Responses adapter, but that path is not implemented yet.`,
      },
    });
    return;
  }

  sendJson(res, 500, {
    error: {
      type: 'internal_error',
      message: `Unsupported OpenCode Go wire API: ${model.wire_api}`,
    },
  });
}

async function handleOpenAIChatToOpenCodeGo(ctx, req, res, oaiBody) {
  const models = await getOpenCodeGoModels(ctx);
  const model = findOpenCodeGoModel(oaiBody.model, models);

  if (!model) {
    sendJson(res, 404, {
      error: {
        type: 'not_found_error',
        message: `Unknown OpenCode Go model: ${oaiBody.model}`,
      },
    });
    return;
  }

  if (model.wire_api === 'openai-chat-completions') {
    return proxyOpenAIBodyToOpenAIUpstream(ctx, res, oaiBody, model);
  }

  if (model.wire_api === 'anthropic-messages') {
    return proxyOpenAIBodyToAnthropicUpstream(ctx, res, oaiBody, model);
  }

  if (model.wire_api === 'openai-responses') {
    sendJson(res, 501, {
      error: {
        type: 'not_implemented_error',
        message: `Model ${model.id} is earmarked for a future OpenAI Responses adapter, but that path is not implemented yet.`,
      },
    });
    return;
  }

  sendJson(res, 500, {
    error: {
      type: 'internal_error',
      message: `Unsupported OpenCode Go wire API: ${model.wire_api}`,
    },
  });
}

async function proxyAnthropicBodyToAnthropicUpstream(ctx, res, antBody, model) {
  const upstreamBody = {
    ...antBody,
    model: model.upstream_model,
  };

  if (upstreamBody.stream === true) {
    return streamAnthropicToAnthropic(ctx, res, upstreamBody, model);
  }

  const response = await requestJson(ctx, buildOpenCodeGoUrl('/v1/messages'), {
    method: 'POST',
    headers: buildOpenCodeGoHeaders(getOpenCodeGoSettings()),
    body: JSON.stringify(upstreamBody),
  });

  return forwardBufferedAnthropicResponse(res, response, model.id);
}

async function proxyAnthropicBodyToOpenAIUpstream(ctx, res, antBody, model) {
  const upstreamBody = anthropicToOpenAI(antBody, () => model.upstream_model);

  if (upstreamBody.stream === true) {
    return streamOpenAIBackAsAnthropic(ctx, res, upstreamBody, model);
  }

  const response = await requestJson(ctx, buildOpenCodeGoUrl('/v1/chat/completions'), {
    method: 'POST',
    headers: buildOpenCodeGoHeaders(getOpenCodeGoSettings()),
    body: JSON.stringify(upstreamBody),
  });

  if (response.statusCode !== 200) {
    return forwardErrorJson(res, response);
  }

  const anthropicBody = openAIResponseToAnthropic(response.json, model.id);
  sendJson(res, 200, anthropicBody);
}

async function proxyOpenAIBodyToOpenAIUpstream(ctx, res, oaiBody, model) {
  const upstreamBody = {
    ...oaiBody,
    model: model.upstream_model,
  };

  if (upstreamBody.stream === true) {
    return streamOpenAIToOpenAI(ctx, res, upstreamBody);
  }

  const response = await requestJson(ctx, buildOpenCodeGoUrl('/v1/chat/completions'), {
    method: 'POST',
    headers: buildOpenCodeGoHeaders(getOpenCodeGoSettings()),
    body: JSON.stringify(upstreamBody),
  });

  if (response.statusCode !== 200) {
    return forwardErrorJson(res, response);
  }

  // Replace the upstream model id with the advertised bridge id so clients see
  // stable local ids rather than provider-internal ones.
  response.json.model = model.id;
  sendJson(res, 200, response.json);
}

async function proxyOpenAIBodyToAnthropicUpstream(ctx, res, oaiBody, model) {
  const upstreamBody = openAIToAnthropic(oaiBody, () => model.upstream_model);

  if (upstreamBody.stream === true) {
    return streamAnthropicBackAsOpenAI(ctx, res, upstreamBody, model);
  }

  const response = await requestJson(ctx, buildOpenCodeGoUrl('/v1/messages'), {
    method: 'POST',
    headers: buildOpenCodeGoHeaders(getOpenCodeGoSettings()),
    body: JSON.stringify(upstreamBody),
  });

  if (response.statusCode !== 200) {
    return forwardErrorJson(res, response);
  }

  const completionId = `chatcmpl-${randomUUID()}`;
  const oaiResponse = anthropicResponseToOpenAI(
    { ...response.json, model: model.id },
    completionId,
  );
  sendJson(res, 200, oaiResponse);
}

async function streamAnthropicToAnthropic(ctx, res, upstreamBody, model) {
  prepareSseResponse(res);

  return requestStream(
    ctx,
    buildOpenCodeGoUrl('/v1/messages'),
    {
      method: 'POST',
      headers: buildOpenCodeGoHeaders(getOpenCodeGoSettings()),
      body: JSON.stringify(upstreamBody),
    },
    (upRes) => {
      if (upRes.statusCode !== 200) {
        bufferStreamErrorIntoAnthropicSse(upRes, res);
        return;
      }

      let buffer = '';
      upRes.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const frames = buffer.split(/\n\n/);
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const rewritten = rewriteAnthropicSseFrameModel(frame, model.id);
          if (rewritten) res.write(rewritten + '\n\n');
        }
      });
      upRes.on('end', () => {
        if (buffer.trim()) {
          const rewritten = rewriteAnthropicSseFrameModel(buffer, model.id);
          if (rewritten) res.write(rewritten + '\n\n');
        }
        res.end();
      });
    },
  );
}

async function streamOpenAIBackAsAnthropic(ctx, res, upstreamBody, model) {
  prepareSseResponse(res);
  const converter = createOpenAIToAnthropicStreamConverter(res, model.id);

  return requestStream(
    ctx,
    buildOpenCodeGoUrl('/v1/chat/completions'),
    {
      method: 'POST',
      headers: buildOpenCodeGoHeaders(getOpenCodeGoSettings()),
      body: JSON.stringify(upstreamBody),
    },
    (upRes) => {
      if (upRes.statusCode !== 200) {
        bufferStreamErrorIntoAnthropicSse(upRes, res);
        return;
      }

      upRes.on('data', (chunk) => converter.write(chunk));
      upRes.on('end', () => converter.end());
    },
  );
}

async function streamOpenAIToOpenAI(ctx, res, upstreamBody) {
  prepareSseResponse(res);

  return requestStream(
    ctx,
    buildOpenCodeGoUrl('/v1/chat/completions'),
    {
      method: 'POST',
      headers: buildOpenCodeGoHeaders(getOpenCodeGoSettings()),
      body: JSON.stringify(upstreamBody),
    },
    (upRes) => {
      if (upRes.statusCode !== 200) {
        bufferStreamErrorIntoOpenAISse(upRes, res);
        return;
      }

      upRes.pipe(res);
    },
  );
}

async function streamAnthropicBackAsOpenAI(ctx, res, upstreamBody, model) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.writeHead(200);
  if (res.flushHeaders) res.flushHeaders();
  if (res.socket?.setNoDelay) res.socket.setNoDelay(true);

  const completionId = `chatcmpl-${randomUUID()}`;
  const converter = createAnthropicToOpenAIStreamConverter(res, completionId, model.id);

  return requestStream(
    ctx,
    buildOpenCodeGoUrl('/v1/messages'),
    {
      method: 'POST',
      headers: buildOpenCodeGoHeaders(getOpenCodeGoSettings()),
      body: JSON.stringify(upstreamBody),
    },
    (upRes) => {
      if (upRes.statusCode !== 200) {
        bufferStreamErrorIntoOpenAISse(upRes, res);
        return;
      }

      upRes.on('data', (chunk) => converter.write(chunk));
      upRes.on('end', () => converter.end());
    },
  );
}

async function fetchOpenCodeGoModels(ctx, settings) {
  const response = await requestJson(ctx, buildOpenCodeGoUrl('/v1/models', settings), {
    method: 'GET',
    headers: buildOpenCodeGoHeaders(settings),
  });

  if (response.statusCode !== 200) {
    throw new Error(`OpenCode Go /v1/models returned ${response.statusCode}`);
  }

  const rawModels = Array.isArray(response.json?.data)
    ? response.json.data
    : Array.isArray(response.json)
      ? response.json
      : [];

  return rawModels.map((item) => normalizeDiscoveredModel(item));
}

function normalizeDiscoveredModel(item) {
  const upstreamId = stripOpenCodeGoPrefix(item.id || item.model || '');
  const seed = STATIC_OPENCODE_GO_MODELS.find((model) => model.upstream_model === upstreamId);

  return {
    id: `${OPENCODE_GO_PROVIDER_ID}/${upstreamId}`,
    upstream_model: upstreamId,
    name: seed?.name || item.name || `OpenCode Go ${upstreamId}`,
    owned_by: item.owned_by || 'opencode',
    provider: OPENCODE_GO_PROVIDER_ID,
    wire_api: seed?.wire_api || inferWireApiFromStaticFallback(upstreamId),
    context_length: item.context_length || item.context_window || seed?.context_length || 200000,
    output_length: item.output_length || item.max_output_tokens || seed?.output_length || 64000,
  };
}

function mergeDiscoveredModels(discovered) {
  const byId = new Map(STATIC_OPENCODE_GO_MODELS.map((model) => [model.id, model]));
  for (const model of discovered) {
    byId.set(model.id, { ...byId.get(model.id), ...model });
  }
  return Array.from(byId.values());
}

function inferWireApiFromStaticFallback(upstreamId) {
  const seed = STATIC_OPENCODE_GO_MODELS.find((model) => model.upstream_model === upstreamId);
  return seed?.wire_api || 'openai-chat-completions';
}

function stripOpenCodeGoPrefix(value) {
  if (value.startsWith(`${OPENCODE_GO_PROVIDER_ID}/`)) {
    return value.slice(OPENCODE_GO_PROVIDER_ID.length + 1);
  }
  return value;
}

function buildOpenCodeGoHeaders(settings) {
  const headers = {
    'content-type': 'application/json',
  };

  if (!settings.apiKey) {
    return headers;
  }

  if (settings.authScheme === 'x-api-key') {
    headers['x-api-key'] = settings.apiKey;
    return headers;
  }

  headers.authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

function buildOpenCodeGoUrl(pathname, settings = getOpenCodeGoSettings()) {
  return new URL(pathname, settings.baseUrl.endsWith('/') ? settings.baseUrl : settings.baseUrl + '/');
}

function prepareSseResponse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.writeHead(200);
  if (res.flushHeaders) res.flushHeaders();
  if (res.socket?.setNoDelay) res.socket.setNoDelay(true);
}

function forwardBufferedAnthropicResponse(res, response, advertisedModel) {
  if (response.statusCode !== 200) {
    return forwardErrorJson(res, response);
  }

  // Keep the client-facing model id stable.
  response.json.model = advertisedModel;
  sendJson(res, 200, response.json);
}

function forwardErrorJson(res, response) {
  if (response.json) {
    sendJson(res, response.statusCode, response.json);
    return;
  }

  sendJson(res, response.statusCode, {
    error: {
      type: 'upstream_error',
      message: response.text || `Upstream returned ${response.statusCode}`,
    },
  });
}

function rewriteAnthropicSseFrameModel(frame, advertisedModel) {
  const lines = frame.split('\n');
  const dataLines = [];
  const passthrough = [];

  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    else passthrough.push(line);
  }

  if (dataLines.length === 0) return frame;

  try {
    const payload = JSON.parse(dataLines.join('\n'));
    if (payload.message?.model) payload.message.model = advertisedModel;
    if (payload.model) payload.model = advertisedModel;

    const rebuilt = [];
    for (const line of passthrough) {
      if (line.length > 0) rebuilt.push(line);
    }
    rebuilt.push(`data: ${JSON.stringify(payload)}`);
    return rebuilt.join('\n');
  } catch {
    return frame;
  }
}

function bufferStreamErrorIntoAnthropicSse(upRes, res) {
  const chunks = [];
  upRes.on('data', (chunk) => chunks.push(chunk));
  upRes.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    res.write(`event: error\n`);
    res.write(`data: ${body}\n\n`);
    res.end();
  });
}

function bufferStreamErrorIntoOpenAISse(upRes, res) {
  const chunks = [];
  upRes.on('data', (chunk) => chunks.push(chunk));
  upRes.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    res.write(`data: ${body}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

function requestJson(ctx, url, { method, headers, body }) {
  verboseLog(ctx, `→ OpenCode Go ${method} ${url.pathname}`);
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          ...headers,
          ...(body ? { 'content-length': Buffer.byteLength(body, 'utf8') } : {}),
        },
        timeout: 300_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode || 500, headers: res.headers, text, json });
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('OpenCode Go request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

function requestStream(ctx, url, { method, headers, body }, onResponse) {
  verboseLog(ctx, `→ OpenCode Go stream ${method} ${url.pathname}`);
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          ...headers,
          ...(body ? { 'content-length': Buffer.byteLength(body, 'utf8') } : {}),
        },
        timeout: 300_000,
      },
      (res) => {
        onResponse(res);
        res.on('end', resolve);
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('OpenCode Go stream timed out')));
    if (body) req.write(body);
    req.end();
  });
}

module.exports = {
  OPENCODE_GO_PROVIDER_ID,
  STATIC_OPENCODE_GO_MODELS,
  shouldAdvertiseOpenCodeGo,
  isOpenCodeGoModel,
  getOpenCodeGoModels,
  handleAnthropicMessagesToOpenCodeGo,
  handleOpenAIChatToOpenCodeGo,
};
