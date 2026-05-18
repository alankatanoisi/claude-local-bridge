'use strict';

const { randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_MODEL } = require('../models');

const DEFAULT_MAX_TURNS = 10;
const HARD_MAX_TURNS = 25;
const OUTPUT_FORMATS = new Set(['json', 'stream-json']);
const PERMISSION_MODES = new Set(['ask', 'dontAsk', 'acceptEdits']);

function getRunStore(ctx) {
  if (!ctx.agentRuns) ctx.agentRuns = new Map();
  return ctx.agentRuns;
}

function createRun(ctx, params, options = {}) {
  const cwd = path.resolve(params.cwd || process.cwd());
  const maxTurns = normalizeMaxTurns(params.max_turns);
  const run = {
    id: randomUUID(),
    status: 'running',
    prompt: params.prompt,
    cwd,
    model: params.model || DEFAULT_MODEL,
    maxTurns,
    outputFormat: normalizeOutputFormat(params.output_format),
    allowedTools: normalizeAllowedTools(params.allowed_tools),
    permissionMode: normalizePermissionMode(params.permission_mode),
    turns: 0,
    messages: [{ role: 'user', content: params.prompt }],
    pendingTool: null,
    pendingTools: [],
    pendingResults: {},
    currentToolBatch: [],
    finalText: '',
    error: null,
    transcript: [],
    onEvent: options.onEvent || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    transcriptPath: transcriptPath(ctx, null),
  };
  run.transcriptPath = transcriptPath(ctx, run.id);
  getRunStore(ctx).set(run.id, run);
  record(run, 'run_started', {
    prompt: params.prompt,
    cwd,
    model: run.model,
    max_turns: maxTurns,
    output_format: run.outputFormat,
    allowed_tools: run.allowedTools,
    permission_mode: run.permissionMode,
  });
  return run;
}

function getRun(ctx, id) {
  const store = getRunStore(ctx);
  const existing = store.get(id);
  if (existing) return existing;

  const loaded = loadRun(ctx, id);
  if (loaded) store.set(id, loaded);
  return loaded;
}

function touch(run) {
  run.updatedAt = new Date().toISOString();
}

function record(run, type, payload) {
  const event = { type, at: new Date().toISOString(), ...payload };
  run.transcript.push(event);
  touch(run);
  persistEvent(run, event);
  persistSnapshot(run);
  if (typeof run.onEvent === 'function') run.onEvent(publicEvent(event));
}

function publicRun(run) {
  return {
    run_id: run.id,
    status: run.status,
    cwd: run.cwd,
    model: run.model,
    turns: run.turns,
    max_turns: run.maxTurns,
    output_format: run.outputFormat,
    allowed_tools: run.allowedTools,
    permission_mode: run.permissionMode,
    pending_tool: publicPendingTool(run.pendingTool),
    pending_tools: (run.pendingTools || []).map(publicPendingTool),
    final_text: run.finalText,
    error: run.error,
    transcript: run.transcript,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

function publicPendingTool(pending) {
  if (!pending) return null;
  return {
    tool_use_id: pending.tool_use_id,
    name: pending.name,
    input: pending.input,
    decision_required: pending.decision_required,
  };
}

function normalizeMaxTurns(value) {
  const numeric = Number.isInteger(value) ? value : DEFAULT_MAX_TURNS;
  return Math.max(1, Math.min(HARD_MAX_TURNS, numeric));
}

function normalizeOutputFormat(value) {
  if (value === undefined) return 'json';
  if (!OUTPUT_FORMATS.has(value)) throwBadRequest('output_format must be "json" or "stream-json"');
  return value;
}

function normalizeAllowedTools(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throwBadRequest('allowed_tools must be an array of tool names');
  }
  return [...new Set(value)];
}

function normalizePermissionMode(value) {
  if (value === undefined) return 'ask';
  if (!PERMISSION_MODES.has(value)) {
    throwBadRequest('permission_mode must be "ask", "dontAsk", or "acceptEdits"');
  }
  return value;
}

function throwBadRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  throw err;
}

function publicEvent(event) {
  if (event.type === 'state_snapshot') return null;
  return event;
}

function transcriptPath(ctx, id) {
  const dir = agentStorageDir(ctx);
  return id ? path.join(dir, `${id}.jsonl`) : dir;
}

function agentStorageDir(ctx) {
  const storageRoot =
    ctx.extensionContext && ctx.extensionContext.globalStorageUri && ctx.extensionContext.globalStorageUri.fsPath
      ? ctx.extensionContext.globalStorageUri.fsPath
      : path.join(os.tmpdir(), 'claude-local-bridge');
  const dir = path.join(storageRoot, 'agent-runs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function persistEvent(run, event) {
  if (!run.transcriptPath) return;
  fs.appendFileSync(run.transcriptPath, `${JSON.stringify({ kind: 'event', event })}\n`, { mode: 0o600 });
}

function persistSnapshot(run) {
  if (!run.transcriptPath) return;
  fs.appendFileSync(run.transcriptPath, `${JSON.stringify({ kind: 'state_snapshot', run: serializeRun(run) })}\n`, {
    mode: 0o600,
  });
}

function serializeRun(run) {
  return {
    ...run,
    onEvent: null,
  };
}

function loadRun(ctx, id) {
  const file = transcriptPath(ctx, id);
  if (!fs.existsSync(file)) return null;

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.kind === 'state_snapshot' && entry.run && entry.run.id === id) {
        return {
          ...entry.run,
          onEvent: null,
          transcriptPath: file,
          pendingTools: entry.run.pendingTools || (entry.run.pendingTool ? [entry.run.pendingTool] : []),
          pendingResults: entry.run.pendingResults || {},
          currentToolBatch: entry.run.currentToolBatch || [],
        };
      }
    } catch {
      // A partially written final line should not make the whole run unreadable.
    }
  }
  return null;
}

module.exports = {
  createRun,
  getRun,
  publicRun,
  record,
  touch,
  normalizeAllowedTools,
  normalizeOutputFormat,
  normalizePermissionMode,
  DEFAULT_MAX_TURNS,
  HARD_MAX_TURNS,
};
