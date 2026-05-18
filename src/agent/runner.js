'use strict';

const { TOOL_SCHEMAS, toolMetadata } = require('./tools');
const { sendMessageViaBridge } = require('./model-client');
const { decideToolPermission, makePendingTool, resolveToolDecision } = require('./permissions');
const { createRun, getRun, publicRun, record } = require('./state');

const SYSTEM_PROMPT = [
  'You are running inside a local bridge headless agent runner.',
  'Use tools only when they materially help answer or complete the user request.',
  'The runner may allow, deny, or pause tool calls according to allowed_tools and permission_mode.',
  'When a tool is denied, continue from the denial instead of claiming the tool succeeded.',
  'When enough information is available, answer directly and concisely.',
].join('\n');

async function startRun(ctx, params, options = {}) {
  validateStartParams(params);
  const run = createRun(ctx, params, { onEvent: options.onEvent });
  await continueRun(ctx, run, options);
  return publicRun(run);
}

async function approveTool(ctx, runId, payload, options = {}) {
  const run = getRun(ctx, runId);
  if (!run) return null;
  if (options.onEvent) run.onEvent = options.onEvent;
  const decisions = normalizeApprovalDecisions(payload);
  run.pendingTools = run.pendingTools || (run.pendingTool ? [run.pendingTool] : []);

  if (run.status !== 'awaiting_approval' || !run.pendingTools || run.pendingTools.length === 0) {
    const err = new Error('Run is not awaiting approval');
    err.statusCode = 409;
    throw err;
  }

  assertPendingDecisions(run, decisions);
  run.status = 'running';

  for (const decision of decisions) {
    const pending = run.pendingTools.find((item) => item.tool_use_id === decision.tool_use_id);
    record(run, 'tool_decision', { tool_use_id: decision.tool_use_id, decision: decision.decision });
    const result = await resolveToolDecision(run, pending.raw, decision.decision);
    run.pendingResults[pending.tool_use_id] = result;
    recordToolResult(run, result);
  }

  run.pendingTools = run.pendingTools.filter(
    (pending) => !decisions.some((decision) => decision.tool_use_id === pending.tool_use_id),
  );
  run.pendingTool = run.pendingTools[0] || null;

  if (run.pendingTools.length > 0) {
    run.status = 'awaiting_approval';
    record(run, 'approval_required', { pending_tools: run.pendingTools.map(publicPendingTool) });
    return publicRun(run);
  }

  appendCurrentToolResults(run);
  await continueRun(ctx, run, options);
  return publicRun(run);
}

async function continueRun(ctx, run, options = {}) {
  const modelClient = options.modelClient || ctx.agentModelClient || sendMessageViaBridge;

  while (run.turns < run.maxTurns) {
    run.turns += 1;
    record(run, 'model_request', { turn: run.turns });

    const response = await modelClient(ctx, {
      model: run.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: run.messages,
      tools: TOOL_SCHEMAS,
      tool_choice: { type: 'auto' },
    });

    const assistantMessage = {
      role: 'assistant',
      content: Array.isArray(response.content) ? response.content : [],
    };
    run.messages.push(assistantMessage);
    record(run, 'model_response', {
      turn: run.turns,
      stop_reason: response.stop_reason,
      content: assistantMessage.content,
    });

    const toolUses = assistantMessage.content.filter((block) => block && block.type === 'tool_use');
    if (toolUses.length > 0) {
      await handleToolUses(run, toolUses);
      if (run.status === 'awaiting_approval') return;
      appendCurrentToolResults(run);
      continue;
    }

    const text = extractText(assistantMessage.content);
    if (text || response.stop_reason !== 'tool_use') {
      run.finalText = text;
      run.status = 'completed';
      record(run, 'completed', { final_text: run.finalText });
      return;
    }
  }

  run.status = 'error';
  run.error = `Max turns exceeded (${run.maxTurns})`;
  record(run, 'error', { message: run.error });
}

function getRunStatus(ctx, id) {
  const run = getRun(ctx, id);
  return run ? publicRun(run) : null;
}

function validateStartParams(params) {
  if (!params || typeof params !== 'object') throwBadRequest('Request body must be a JSON object');
  if (!params.prompt || typeof params.prompt !== 'string') throwBadRequest('prompt is required');
  if (params.cwd !== undefined && typeof params.cwd !== 'string') throwBadRequest('cwd must be a string');
  if (params.model !== undefined && typeof params.model !== 'string') throwBadRequest('model must be a string');
  if (params.max_turns !== undefined && !Number.isInteger(params.max_turns))
    throwBadRequest('max_turns must be an integer');
  if (params.allowed_tools !== undefined && !Array.isArray(params.allowed_tools))
    throwBadRequest('allowed_tools must be an array');
  if (params.permission_mode !== undefined && typeof params.permission_mode !== 'string')
    throwBadRequest('permission_mode must be a string');
  if (params.output_format !== undefined && typeof params.output_format !== 'string')
    throwBadRequest('output_format must be a string');
}

function normalizeApprovalDecisions(payload) {
  if (!payload || typeof payload !== 'object') throwBadRequest('Request body must be a JSON object');
  const decisions = Array.isArray(payload.decisions)
    ? payload.decisions
    : [{ tool_use_id: payload.tool_use_id, decision: payload.decision }];
  if (decisions.length === 0) throwBadRequest('decisions must not be empty');

  const seen = new Set();
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object') throwBadRequest('each decision must be an object');
    if (!decision.tool_use_id || typeof decision.tool_use_id !== 'string') throwBadRequest('tool_use_id is required');
    if (decision.decision !== 'allow' && decision.decision !== 'deny') {
      throwBadRequest('decision must be "allow" or "deny"');
    }
    if (seen.has(decision.tool_use_id)) throwBadRequest(`duplicate decision for ${decision.tool_use_id}`);
    seen.add(decision.tool_use_id);
  }

  return decisions;
}

function throwBadRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  throw err;
}

function extractText(content) {
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

async function handleToolUses(run, toolUses) {
  run.currentToolBatch = toolUses.map((toolUse) => toolUse.id);
  run.pendingResults = {};
  run.pendingTools = [];
  run.pendingTool = null;

  for (const toolUse of toolUses) {
    record(run, 'tool_use', { tool_use_id: toolUse.id, name: toolUse.name, input: toolUse.input || {} });
  }

  const allowed = [];
  for (const toolUse of toolUses) {
    const decision = decideToolPermission(run, toolUse);
    if (decision === 'ask') {
      const pending = makePendingTool(toolUse);
      pending.raw = toolUse;
      run.pendingTools.push(pending);
      continue;
    }
    if (decision === 'deny') {
      const result = await resolveToolDecision(run, toolUse, 'deny');
      run.pendingResults[toolUse.id] = result;
      recordToolResult(run, result);
      continue;
    }
    allowed.push(toolUse);
  }

  await executeAllowedTools(run, allowed);

  if (run.pendingTools.length > 0) {
    run.pendingTool = run.pendingTools[0];
    run.status = 'awaiting_approval';
    record(run, 'approval_required', { pending_tools: run.pendingTools.map(publicPendingTool) });
  }
}

async function executeAllowedTools(run, toolUses) {
  const concurrent = toolUses.filter((toolUse) => toolMetadata(toolUse.name).concurrent);
  const serial = toolUses.filter((toolUse) => !toolMetadata(toolUse.name).concurrent);

  await Promise.all(concurrent.map((toolUse) => executeAllowedTool(run, toolUse)));
  for (const toolUse of serial) await executeAllowedTool(run, toolUse);
}

async function executeAllowedTool(run, toolUse) {
  record(run, 'tool_decision', { tool_use_id: toolUse.id, decision: 'allow' });
  const result = await resolveToolDecision(run, toolUse, 'allow');
  run.pendingResults[toolUse.id] = result;
  recordToolResult(run, result);
}

function appendCurrentToolResults(run) {
  const results = run.currentToolBatch.map((id) => run.pendingResults[id]).filter(Boolean);
  if (results.length > 0) run.messages.push({ role: 'user', content: results });
  run.currentToolBatch = [];
  run.pendingResults = {};
}

function recordToolResult(run, toolResult) {
  record(run, 'tool_result', {
    tool_use_id: toolResult.tool_use_id,
    is_error: toolResult.is_error === true,
    content: toolResult.content,
  });
}

function assertPendingDecisions(run, decisions) {
  for (const decision of decisions) {
    const pending = run.pendingTools.find((item) => item.tool_use_id === decision.tool_use_id);
    if (!pending) {
      const err = new Error('tool_use_id does not match a pending tool');
      err.statusCode = 400;
      throw err;
    }
  }
}

function publicPendingTool(pending) {
  return {
    tool_use_id: pending.tool_use_id,
    name: pending.name,
    input: pending.input,
    decision_required: pending.decision_required,
  };
}

module.exports = {
  startRun,
  approveTool,
  getRunStatus,
  continueRun,
  SYSTEM_PROMPT,
  normalizeApprovalDecisions,
};
