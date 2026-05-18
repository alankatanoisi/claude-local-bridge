'use strict';

const { readBody, sendJson } = require('../utils');
const { startRun, approveTool, getRunStatus } = require('../agent/runner');

async function handleAgentRuns(ctx, req, res) {
  const body = await readJson(req);
  if (body.output_format === 'stream-json') {
    await streamRun(res, (onEvent) => startRun(ctx, body, { onEvent }));
    return;
  }

  const result = await startRun(ctx, body);
  sendJson(res, statusCodeFor(result), stripRawPendingTool(result));
}

function handleAgentRunStatus(ctx, _req, res, runId) {
  const result = getRunStatus(ctx, runId);
  if (!result) {
    sendJson(res, 404, { error: { type: 'not_found', message: 'Unknown agent run' } });
    return;
  }
  sendJson(res, 200, stripRawPendingTool(result));
}

async function handleAgentApproval(ctx, req, res, runId) {
  const body = await readJson(req);
  if (body.output_format === 'stream-json') {
    await streamRun(res, (onEvent) => approveTool(ctx, runId, body, { onEvent }));
    return;
  }

  const result = await approveTool(ctx, runId, body);
  if (!result) {
    sendJson(res, 404, { error: { type: 'not_found', message: 'Unknown agent run' } });
    return;
  }
  sendJson(res, statusCodeFor(result), stripRawPendingTool(result));
}

async function streamRun(res, fn) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    const result = await fn((event) => {
      if (event) res.write(`${JSON.stringify(stripRawEvent(event))}\n`);
    });
    if (!result) {
      res.write(`${JSON.stringify({ type: 'error', error: 'Unknown agent run' })}\n`);
    }
  } catch (err) {
    res.write(`${JSON.stringify({ type: 'error', error: err.message })}\n`);
  } finally {
    res.end();
  }
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const err = new Error('Invalid JSON body');
    err.statusCode = 400;
    throw err;
  }
}

function statusCodeFor(result) {
  if (result.status === 'awaiting_approval') return 202;
  if (result.status === 'error') return 500;
  return 200;
}

function stripRawPendingTool(result) {
  return {
    ...result,
    pending_tool: stripOnePendingTool(result.pending_tool),
    pending_tools: Array.isArray(result.pending_tools)
      ? result.pending_tools.map(stripOnePendingTool)
      : result.pending_tools,
  };
}

function stripRawEvent(event) {
  if (!event.pending_tools) return event;
  return {
    ...event,
    pending_tools: event.pending_tools.map(stripOnePendingTool),
  };
}

function stripOnePendingTool(tool) {
  if (!tool) return tool;
  return {
    tool_use_id: tool.tool_use_id,
    name: tool.name,
    input: tool.input,
    decision_required: tool.decision_required,
  };
}

module.exports = {
  handleAgentRuns,
  handleAgentRunStatus,
  handleAgentApproval,
};
