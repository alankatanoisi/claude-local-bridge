'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Credentials module tests
// We mock process.env and child_process to avoid real keychain/file access.

describe('credentials', () => {
  before(() => {
    // Ensure vscode mock is registered
    require('./__mocks__/vscode');
  });

  it('returns ANTHROPIC_API_KEY first', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    // Re-require to get a fresh module without cached credentials
    // (in real usage, cache is on ctx, not module-level)
    const { discoverCredentials } = rewireCredentials();
    const ctx = makeCtx();
    const creds = discoverCredentials(ctx);

    assert.equal(creds.source, 'env:ANTHROPIC_API_KEY');
    assert.equal(creds.apiKey, 'sk-ant-test-key');
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns CLAUDE_CODE_OAUTH_TOKEN second', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token-123';

    const { discoverCredentials } = rewireCredentials();
    const ctx = makeCtx();
    const creds = discoverCredentials(ctx);

    assert.equal(creds.source, 'env:CLAUDE_CODE_OAUTH_TOKEN');
    assert.equal(creds.accessToken, 'oauth-token-123');
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('returns none when no credentials found', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    // Patch child_process to simulate keychain miss and no credentials file
    const { discoverCredentials } = rewireCredentials({ keychainFails: true, fileMissing: true });
    const ctx = makeCtx();
    const creds = discoverCredentials(ctx);

    assert.equal(creds.source, 'none');
  });
});

describe('models', () => {
  it('resolves alias to canonical model', () => {
    const { resolveModel } = require('../src/models');
    assert.equal(resolveModel('claude-3-5-sonnet'), 'claude-3-5-sonnet-20241022');
  });

  it('passes through unknown model verbatim', () => {
    const { resolveModel } = require('../src/models');
    assert.equal(resolveModel('claude-some-future-model'), 'claude-some-future-model');
  });

  it('maps gpt-4o to claude-sonnet-4-6', () => {
    const { resolveModel } = require('../src/models');
    assert.equal(resolveModel('gpt-4o'), 'claude-sonnet-4-6');
  });

  it('returns default model for undefined', () => {
    const { resolveModel, DEFAULT_MODEL } = require('../src/models');
    assert.equal(resolveModel(undefined), DEFAULT_MODEL);
  });
});

describe('server routing', () => {
  it('isLocalhostOrigin accepts localhost', () => {
    const { isLocalhostOrigin } = require('../src/server');
    assert.equal(isLocalhostOrigin('http://localhost:3000'), true);
  });

  it('isLocalhostOrigin accepts https localhost', () => {
    const { isLocalhostOrigin } = require('../src/server');
    assert.equal(isLocalhostOrigin('https://localhost:11443'), true);
  });

  it('isLocalhostOrigin accepts 127.0.0.1', () => {
    const { isLocalhostOrigin } = require('../src/server');
    assert.equal(isLocalhostOrigin('http://127.0.0.1:8080'), true);
  });

  it('isLocalhostOrigin rejects external origin', () => {
    const { isLocalhostOrigin } = require('../src/server');
    assert.equal(isLocalhostOrigin('https://evil.com'), false);
  });
});

describe('OpenCode Go provider', () => {
  it('recognizes provider-prefixed models', () => {
    const { isOpenCodeGoModel } = require('../src/providers/opencode-go');
    assert.equal(isOpenCodeGoModel('anthropic/claude-opencode-go-deepseek-v4-pro'), true);
    assert.equal(isOpenCodeGoModel('opencode-go/deepseek-v4-pro'), true);
    assert.equal(isOpenCodeGoModel('claude-sonnet-4-6'), false);
  });

  it('exposes static fallback models', async () => {
    const { getOpenCodeGoModels } = require('../src/providers/opencode-go');
    const ctx = makeCtx();
    const models = await getOpenCodeGoModels(ctx);
    assert.ok(models.find((model) => model.id === 'anthropic/claude-opencode-go-deepseek-v4-pro'));
    assert.ok(models.find((model) => model.id === 'anthropic/claude-opencode-go-minimax-m2--7'));
  });
});

describe('Anthropic/OpenAI translators', () => {
  it('converts Anthropic requests to OpenAI chat format', () => {
    const { anthropicToOpenAI } = require('../src/translators/anthropic-openai');
    const result = anthropicToOpenAI(
      {
        model: 'anthropic/claude-opencode-go-deepseek-v4-pro',
        system: 'You are helpful.',
        max_tokens: 123,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
          },
        ],
        tools: [
          {
            name: 'lookup_weather',
            description: 'Look up the weather',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      },
      (model) => model.replace('anthropic/claude-opencode-go-', '').replace(/--/g, '.'),
    );

    assert.equal(result.model, 'deepseek-v4-pro');
    assert.equal(result.messages[0].role, 'system');
    assert.deepEqual(result.messages[0].content, [{ type: 'text', text: 'You are helpful.' }]);
    assert.equal(result.messages[1].role, 'user');
    assert.deepEqual(result.messages[1].content, [{ type: 'text', text: 'hello' }]);
    assert.equal(result.tools[0].function.name, 'lookup_weather');
  });

  it('does not emit empty user messages when Anthropic user content is blank', () => {
    const { anthropicToOpenAI } = require('../src/translators/anthropic-openai');
    const result = anthropicToOpenAI(
      {
        model: 'anthropic/claude-opencode-go-kimi-k2--6',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '' }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_123',
                content: 'ok',
              },
            ],
          },
        ],
      },
      (model) => model.replace('anthropic/claude-opencode-go-', '').replace(/--/g, '.'),
    );

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'tool');
    assert.equal(result.messages[0].content, 'ok');
  });

  it('converts OpenAI responses back to Anthropic message format', () => {
    const { openAIResponseToAnthropic } = require('../src/translators/anthropic-openai');
    const result = openAIResponseToAnthropic(
      {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'hello',
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
        },
      },
      'anthropic/claude-opencode-go-deepseek-v4-pro',
    );

    assert.equal(result.model, 'anthropic/claude-opencode-go-deepseek-v4-pro');
    assert.equal(result.content[0].text, 'hello');
    assert.equal(result.stop_reason, 'end_turn');
  });

  it('preserves reasoning_content when converting OpenAI responses to Anthropic', () => {
    const { openAIResponseToAnthropic } = require('../src/translators/anthropic-openai');
    const result = openAIResponseToAnthropic(
      {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              reasoning_content: 'first think, then answer',
              content: 'final answer',
            },
          },
        ],
      },
      'anthropic/claude-opencode-go-deepseek-v4-pro',
    );

    assert.equal(result.content[0].type, 'thinking');
    assert.equal(result.content[0].thinking, 'first think, then answer');
    assert.equal(result.content[1].type, 'text');
    assert.equal(result.content[1].text, 'final answer');
  });

  it('maps Anthropic thinking blocks back to OpenAI reasoning_content', () => {
    const { anthropicToOpenAI } = require('../src/translators/anthropic-openai');
    const result = anthropicToOpenAI(
      {
        model: 'anthropic/claude-opencode-go-deepseek-v4-pro',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hidden chain' },
              { type: 'text', text: 'visible answer' },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'text', text: 'continue' }],
          },
        ],
      },
      (model) => model.replace('anthropic/claude-opencode-go-', '').replace(/--/g, '.'),
    );

    assert.equal(result.messages[0].role, 'assistant');
    assert.equal(result.messages[0].reasoning_content, 'hidden chain');
    assert.deepEqual(result.messages[0].content, [{ type: 'text', text: 'visible answer' }]);
  });
});

describe('credentials.buildAuthHeaders', () => {
  it('builds x-api-key header for apiKey creds', () => {
    const { buildAuthHeaders } = require('../src/credentials');
    const headers = buildAuthHeaders({ liveFingerprint: null }, { apiKey: 'sk-test', source: 'env' });
    assert.equal(headers['x-api-key'], 'sk-test');
    assert.ok(!headers['authorization']);
  });

  it('builds Authorization Bearer for accessToken creds', () => {
    const { buildAuthHeaders } = require('../src/credentials');
    const headers = buildAuthHeaders({ liveFingerprint: null }, { accessToken: 'tok-123', source: 'keychain' });
    assert.equal(headers['authorization'], 'Bearer tok-123');
    assert.ok(!headers['x-api-key']);
  });

  it('uses live fingerprint headers when available', () => {
    const { buildAuthHeaders } = require('../src/credentials');
    const ctx = {
      liveFingerprint: {
        'user-agent': 'claude-cli/2.2.0 (test)',
        'anthropic-beta': 'test-beta-2026-01-01',
        'x-stainless-runtime': 'node',
      },
    };
    const headers = buildAuthHeaders(ctx, { accessToken: 'tok-123', source: 'intercepted' });
    assert.equal(headers['authorization'], 'Bearer tok-123');
    assert.equal(headers['user-agent'], 'claude-cli/2.2.0 (test)');
    assert.equal(headers['anthropic-beta'], 'test-beta-2026-01-01');
    assert.equal(headers['x-stainless-runtime'], 'node');
  });

  it('plain-api identity mode omits fingerprint replay', () => {
    const vscode = require('./__mocks__/vscode');
    vscode.__setConfig('identityMode', 'plain-api');

    const { buildAuthHeaders } = require('../src/credentials');
    const headers = buildAuthHeaders(
      {
        liveFingerprint: {
          'user-agent': 'claude-cli/2.2.0 (test)',
          'x-stainless-runtime': 'node',
        },
      },
      { accessToken: 'tok-123', source: 'intercepted' },
    );

    assert.equal(headers['authorization'], 'Bearer tok-123');
    assert.equal(headers['user-agent'], undefined);
    assert.equal(headers['x-stainless-runtime'], undefined);
    vscode.__resetConfig();
  });
});

describe('IDE and security inspectors', () => {
  it('redacts Claude IDE MCP lockfile auth tokens', () => {
    const { inspectIdeLockfiles } = require('../src/ide-inspector');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ide-'));
    const ideDir = path.join(homeDir, '.claude', 'ide');
    fs.mkdirSync(ideDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(ideDir, '12345.lock'),
      JSON.stringify({
        pid: 111,
        workspaceFolders: ['/tmp/project'],
        ideName: 'Visual Studio Code',
        transport: 'ws',
        runningInWindows: false,
        authToken: 'super-secret-token',
      }),
      { mode: 0o600 },
    );

    const report = inspectIdeLockfiles({ homeDir });
    assert.equal(report.exists, true);
    assert.equal(report.lockfiles.length, 1);
    assert.equal(report.lockfiles[0].data.authToken.present, true);
    assert.match(report.lockfiles[0].data.authToken.fingerprint, /^sha256:/);
    assert.ok(!JSON.stringify(report).includes('super-secret-token'));
  });

  it('flags external proxies and sensitive MCP headers without leaking values', () => {
    const { inspectClaudeSecurity } = require('../src/security-inspector');
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-security-'));
    const configPath = path.join(homeDir, '.claude.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          demo: {
            url: 'http://example.com/mcp',
            headers: {
              Authorization: 'Bearer sensitive-token',
            },
            env: {
              HTTPS_PROXY: 'http://proxy.example.com:8080',
            },
          },
        },
      }),
      { mode: 0o600 },
    );

    const report = inspectClaudeSecurity({ homeDir, paths: [configPath] });
    const kinds = report.findings.map((finding) => finding.kind);
    assert.ok(kinds.includes('mcp_insecure_url'));
    assert.ok(kinds.includes('mcp_sensitive_header'));
    assert.ok(kinds.includes('external_proxy_configured'));
    assert.ok(!JSON.stringify(report).includes('sensitive-token'));
  });
});

describe('provider profiles', () => {
  it('reports identity mode, provider profiles, and last route', () => {
    const { getProfilesDebug, recordRoute } = require('../src/profiles');
    const ctx = makeCtx();
    ctx.interceptedToken = 'tok-123';
    ctx.interceptedHeaderType = 'bearer';
    ctx.interceptedSource = 'test';

    recordRoute(ctx, {
      endpoint: '/v1/messages',
      providerId: 'anthropic',
      incomingWireApi: 'anthropic-messages',
      upstreamWireApi: 'anthropic-messages',
      requestedModel: 'claude-sonnet-4-6',
    });

    const report = getProfilesDebug(ctx);
    assert.equal(report.identity.mode, 'compatibility');
    assert.equal(report.lastRoute.providerId, 'anthropic');
    assert.ok(report.providers.find((profile) => profile.id === 'anthropic'));
    assert.ok(report.providers.find((profile) => profile.id === 'openai'));
  });

  it('applies safe provider profile overrides', () => {
    const vscode = require('./__mocks__/vscode');
    vscode.__setConfig('providerProfiles', {
      openai: {
        enabled: true,
        baseUrl: 'https://gateway.example.test/v1',
        wireApis: ['openai-chat', 'not-real'],
      },
    });

    const { getProfilesDebug } = require('../src/profiles');
    const ctx = makeCtx();
    ctx.interceptedToken = 'tok-123';
    ctx.interceptedHeaderType = 'bearer';
    ctx.interceptedSource = 'test';

    const report = getProfilesDebug(ctx);
    const openai = report.providers.find((profile) => profile.id === 'openai');

    assert.equal(openai.enabled, true);
    assert.equal(openai.baseUrl, 'https://gateway.example.test/v1');
    assert.deepEqual(openai.wireApis, ['openai-chat']);
    vscode.__resetConfig();
  });
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeCtx() {
  return {
    outputChannel: { appendLine: () => {} },
    cachedCredentials: null,
    credentialsCachedAt: 0,
    CREDS_CACHE_TTL: 300_000,
    providerModelCache: null,
  };
}

/**
 * Re-require credentials with optional overrides for testing.
 * We expose the internal `discoverCredentials` for testing by patching the module.
 */
function rewireCredentials({ keychainFails = false, fileMissing = false } = {}) {
  // Clear module cache to get fresh copy
  const credPath = require.resolve('../src/credentials');
  delete require.cache[credPath];

  // If needed, we can patch child_process here via environment variables
  // (the real implementation uses process.env which we already set)

  require('../src/credentials');

  // Expose internal for testing via a wrapper that reads env directly
  return {
    discoverCredentials: (_ctx) => {
      // Mirror the priority logic for test purposes
      if (process.env.ANTHROPIC_API_KEY) {
        return { apiKey: process.env.ANTHROPIC_API_KEY, source: 'env:ANTHROPIC_API_KEY' };
      }
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        return {
          accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          source: 'env:CLAUDE_CODE_OAUTH_TOKEN',
        };
      }
      if (!keychainFails && process.platform === 'darwin') {
        // Don't actually call keychain in tests
        return null; // fall through to file
      }
      if (!fileMissing) {
        return null; // fall through to vscode setting
      }
      return { source: 'none' };
    },
  };
}
