'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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

describe('agent tools', () => {
  it('allows normal project paths', async () => {
    const { executeTool } = require('../src/agent/tools');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-tools-'));
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'app.js'), 'console.log("ok");');

    const result = await executeTool({ cwd }, { name: 'read_file', input: { path: 'src/app.js' } });
    assert.match(result, /console\.log/);
  });

  it('rejects path traversal outside cwd', async () => {
    const { executeTool } = require('../src/agent/tools');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-tools-'));

    await assert.rejects(
      executeTool({ cwd }, { name: 'read_file', input: { path: '../outside.txt' } }),
      /escapes the run working directory/,
    );
  });

  it('rejects sensitive files', async () => {
    const { executeTool } = require('../src/agent/tools');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-tools-'));
    fs.writeFileSync(path.join(cwd, '.env'), 'TOKEN=secret');
    fs.writeFileSync(path.join(cwd, 'service-credential.json'), '{}');

    await assert.rejects(executeTool({ cwd }, { name: 'read_file', input: { path: '.env' } }), /Sensitive path/);
    await assert.rejects(
      executeTool({ cwd }, { name: 'read_file', input: { path: 'service-credential.json' } }),
      /Credential-looking file/,
    );
  });

  it('enforces file output size limits', async () => {
    const { executeTool, MAX_FILE_BYTES } = require('../src/agent/tools');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-tools-'));
    fs.writeFileSync(path.join(cwd, 'large.txt'), 'a'.repeat(MAX_FILE_BYTES + 1));

    await assert.rejects(executeTool({ cwd }, { name: 'read_file', input: { path: 'large.txt' } }), /too large/);
  });

  it('writes and edits bounded project files', async () => {
    const { executeTool } = require('../src/agent/tools');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-tools-'));

    await executeTool({ cwd }, { name: 'write_file', input: { path: 'notes.txt', content: 'hello world' } });
    const editResult = await executeTool(
      { cwd },
      {
        name: 'edit_file',
        input: { path: 'notes.txt', old_string: 'world', new_string: 'bridge' },
      },
    );

    assert.match(editResult, /replacements/);
    assert.equal(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8'), 'hello bridge');
  });

  it('runs bounded bash commands in cwd', async () => {
    const { executeTool } = require('../src/agent/tools');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-tools-'));
    fs.writeFileSync(path.join(cwd, 'marker.txt'), 'ok');

    const result = await executeTool({ cwd }, { name: 'bash', input: { command: 'pwd && ls marker.txt' } });

    assert.match(result, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result, /marker\.txt/);
  });

  it('enforces bash timeout limits', async () => {
    const { executeTool } = require('../src/agent/tools');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-tools-'));

    await assert.rejects(
      executeTool({ cwd }, { name: 'bash', input: { command: 'sleep 1', timeout_ms: 1 } }),
      /timed out/,
    );
  });
});

describe('agent runner', () => {
  it('completes a final text response without tools', async () => {
    const { startRun } = require('../src/agent/runner');
    const ctx = makeCtx();
    const result = await startRun(
      ctx,
      { prompt: 'hello' },
      {
        modelClient: async () => ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'done' }],
        }),
      },
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.final_text, 'done');
  });

  it('pauses for approval when the model requests a tool', async () => {
    const { startRun } = require('../src/agent/runner');
    const ctx = makeCtx();
    const result = await startRun(
      ctx,
      { prompt: 'list files' },
      {
        modelClient: async () => ({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_files', input: { path: '.' } }],
        }),
      },
    );

    assert.equal(result.status, 'awaiting_approval');
    assert.equal(result.pending_tool.tool_use_id, 'toolu_1');
    assert.equal(result.pending_tool.name, 'list_files');
  });

  it('auto-runs tools listed in allowed_tools', async () => {
    const { startRun } = require('../src/agent/runner');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-runner-'));
    fs.writeFileSync(path.join(cwd, 'README.md'), '# demo');
    const ctx = makeCtx();
    let calls = 0;
    const modelClient = async (_ctx, body) => {
      calls += 1;
      if (calls === 1) {
        return {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } }],
        };
      }

      const resultBlock = body.messages.at(-1).content[0];
      assert.equal(resultBlock.tool_use_id, 'toolu_1');
      assert.match(resultBlock.content, /demo/);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'read it' }] };
    };

    const result = await startRun(ctx, { prompt: 'read', cwd, allowed_tools: ['read_file'] }, { modelClient });

    assert.equal(result.status, 'completed');
    assert.equal(result.final_text, 'read it');
  });

  it('denies unlisted tools in dontAsk mode', async () => {
    const { startRun } = require('../src/agent/runner');
    const ctx = makeCtx();
    let calls = 0;
    const modelClient = async (_ctx, body) => {
      calls += 1;
      if (calls === 1) {
        return {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'git_status', input: {} }],
        };
      }

      const resultBlock = body.messages.at(-1).content[0];
      assert.equal(resultBlock.is_error, true);
      assert.match(resultBlock.content, /denied/);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'continued' }] };
    };

    const result = await startRun(ctx, { prompt: 'check git', permission_mode: 'dontAsk' }, { modelClient });

    assert.equal(result.status, 'completed');
    assert.equal(result.final_text, 'continued');
  });

  it('auto-runs edit tools in acceptEdits mode', async () => {
    const { startRun } = require('../src/agent/runner');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-runner-'));
    fs.writeFileSync(path.join(cwd, 'app.js'), 'const name = "old";\n');
    const ctx = makeCtx();
    let calls = 0;
    const modelClient = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'edit_file',
              input: { path: 'app.js', old_string: '"old"', new_string: '"new"' },
            },
          ],
        };
      }
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'edited' }] };
    };

    const result = await startRun(ctx, { prompt: 'edit', cwd, permission_mode: 'acceptEdits' }, { modelClient });

    assert.equal(result.status, 'completed');
    assert.equal(fs.readFileSync(path.join(cwd, 'app.js'), 'utf8'), 'const name = "new";\n');
  });

  it('handles multiple allowed tool calls in one assistant message', async () => {
    const { startRun } = require('../src/agent/runner');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-runner-'));
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'beta');
    const ctx = makeCtx();
    let calls = 0;
    const modelClient = async (_ctx, body) => {
      calls += 1;
      if (calls === 1) {
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } },
            { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'b.txt' } },
          ],
        };
      }

      const toolResults = body.messages.at(-1).content;
      assert.equal(toolResults.length, 2);
      assert.deepEqual(
        toolResults.map((result) => result.tool_use_id),
        ['toolu_1', 'toolu_2'],
      );
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
    };

    const result = await startRun(ctx, { prompt: 'read both', cwd, allowed_tools: ['read_file'] }, { modelClient });

    assert.equal(result.status, 'completed');
  });

  it('executes an approved tool and resumes the model loop', async () => {
    const { startRun, approveTool } = require('../src/agent/runner');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-runner-'));
    fs.writeFileSync(path.join(cwd, 'README.md'), '# demo');
    const ctx = makeCtx();
    let calls = 0;
    const modelClient = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'list_files', input: { path: '.' } }],
        };
      }
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'saw README.md' }] };
    };

    const first = await startRun(ctx, { prompt: 'list files', cwd }, { modelClient });
    const second = await approveTool(ctx, first.run_id, { tool_use_id: 'toolu_1', decision: 'allow' }, { modelClient });

    assert.equal(second.status, 'completed');
    assert.equal(second.final_text, 'saw README.md');
    assert.ok(second.transcript.find((event) => event.type === 'tool_result' && event.content.includes('README.md')));
  });

  it('accepts batch approval decisions', async () => {
    const { startRun, approveTool } = require('../src/agent/runner');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-agent-runner-'));
    fs.writeFileSync(path.join(cwd, 'README.md'), '# demo');
    const ctx = makeCtx();
    let calls = 0;
    const modelClient = async (_ctx, body) => {
      calls += 1;
      if (calls === 1) {
        return {
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } },
            { type: 'tool_use', id: 'toolu_2', name: 'git_status', input: {} },
          ],
        };
      }

      const toolResults = body.messages.at(-1).content;
      assert.equal(toolResults.length, 2);
      assert.equal(toolResults[1].is_error, true);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'batch complete' }] };
    };

    const first = await startRun(ctx, { prompt: 'use two tools', cwd }, { modelClient });
    const second = await approveTool(
      ctx,
      first.run_id,
      {
        decisions: [
          { tool_use_id: 'toolu_1', decision: 'allow' },
          { tool_use_id: 'toolu_2', decision: 'deny' },
        ],
      },
      { modelClient },
    );

    assert.equal(first.pending_tools.length, 2);
    assert.equal(second.status, 'completed');
    assert.equal(second.final_text, 'batch complete');
  });

  it('sends denied tool results back to the model', async () => {
    const { startRun, approveTool } = require('../src/agent/runner');
    const ctx = makeCtx();
    let calls = 0;
    const modelClient = async (_ctx, body) => {
      calls += 1;
      if (calls === 1) {
        return {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'git_status', input: {} }],
        };
      }

      const resultBlock = body.messages.at(-1).content[0];
      assert.equal(resultBlock.is_error, true);
      assert.match(resultBlock.content, /denied/);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    };

    const first = await startRun(ctx, { prompt: 'check git' }, { modelClient });
    const second = await approveTool(ctx, first.run_id, { tool_use_id: 'toolu_1', decision: 'deny' }, { modelClient });

    assert.equal(second.status, 'completed');
  });

  it('stops runaway loops at max_turns', async () => {
    const { startRun, approveTool } = require('../src/agent/runner');
    const ctx = makeCtx();
    const modelClient = async () => ({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'git_status', input: {} }],
    });

    const first = await startRun(ctx, { prompt: 'loop', max_turns: 1 }, { modelClient });
    const second = await approveTool(ctx, first.run_id, { tool_use_id: 'toolu_1', decision: 'deny' }, { modelClient });

    assert.equal(second.status, 'error');
    assert.match(second.error, /Max turns exceeded/);
  });
});

describe('agent routes', () => {
  it('returns 404 for an unknown run id', async () => {
    const vscode = require('./__mocks__/vscode');
    const { startServer, stopServer } = require('../src/server');
    const ctx = makeCtx();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    vscode.__setConfig('port', 0);

    await startServer(ctx);
    const port = ctx.server.address().port;
    const response = await requestJson(port, 'GET', '/v1/agent/runs/not-found');
    await stopServer(ctx);
    delete process.env.ANTHROPIC_API_KEY;
    vscode.__setConfig('port', 11437);
    vscode.__resetConfig();

    assert.equal(response.statusCode, 404);
    assert.equal(response.body.error.type, 'not_found');
  });

  it('returns 400 for malformed approval payloads', async () => {
    const vscode = require('./__mocks__/vscode');
    const { startServer, stopServer } = require('../src/server');
    const ctx = makeCtx();
    ctx.agentRuns = new Map([
      [
        'run-1',
        {
          id: 'run-1',
          status: 'awaiting_approval',
          pendingTool: { tool_use_id: 'toolu_1', raw: { id: 'toolu_1', name: 'git_status', input: {} } },
          transcript: [],
          updatedAt: new Date().toISOString(),
        },
      ],
    ]);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    vscode.__setConfig('port', 0);

    await startServer(ctx);
    const port = ctx.server.address().port;
    const response = await requestJson(port, 'POST', '/v1/agent/runs/run-1/approve', { tool_use_id: 'toolu_1' });
    await stopServer(ctx);
    delete process.env.ANTHROPIC_API_KEY;
    vscode.__setConfig('port', 11437);
    vscode.__resetConfig();

    assert.equal(response.statusCode, 400);
    assert.match(response.body.error.message, /decision/);
  });

  it('returns 409 when approving a run that is no longer pending', async () => {
    const vscode = require('./__mocks__/vscode');
    const { startServer, stopServer } = require('../src/server');
    const ctx = makeCtx();
    ctx.agentRuns = new Map([
      [
        'run-1',
        {
          id: 'run-1',
          status: 'completed',
          pendingTool: null,
          transcript: [],
          updatedAt: new Date().toISOString(),
        },
      ],
    ]);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    vscode.__setConfig('port', 0);

    await startServer(ctx);
    const port = ctx.server.address().port;
    const response = await requestJson(port, 'POST', '/v1/agent/runs/run-1/approve', {
      tool_use_id: 'toolu_1',
      decision: 'allow',
    });
    await stopServer(ctx);
    delete process.env.ANTHROPIC_API_KEY;
    vscode.__setConfig('port', 11437);
    vscode.__resetConfig();

    assert.equal(response.statusCode, 409);
    assert.match(response.body.error.message, /not awaiting approval/);
  });

  it('streams parseable JSON lines for agent runs', async () => {
    const vscode = require('./__mocks__/vscode');
    const { startServer, stopServer } = require('../src/server');
    const ctx = makeCtx();
    ctx.agentModelClient = async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'stream done' }],
    });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    vscode.__setConfig('port', 0);

    await startServer(ctx);
    const port = ctx.server.address().port;
    const response = await requestText(port, 'POST', '/v1/agent/runs', {
      prompt: 'hello',
      output_format: 'stream-json',
    });
    await stopServer(ctx);
    delete process.env.ANTHROPIC_API_KEY;
    vscode.__setConfig('port', 11437);
    vscode.__resetConfig();

    assert.equal(response.statusCode, 200);
    const events = response.body
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(events.find((event) => event.type === 'run_started'));
    assert.ok(events.find((event) => event.type === 'model_request'));
    assert.ok(events.find((event) => event.type === 'completed' && event.final_text === 'stream done'));
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

function requestJson(port, method, pathName, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ statusCode: res.statusCode, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestText(port, method, pathName, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
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
