'use strict';

const { executeTool, toolMetadata } = require('./tools');

function makePendingTool(toolUse) {
  return {
    tool_use_id: toolUse.id,
    name: toolUse.name,
    input: toolUse.input || {},
    decision_required: true,
  };
}

function decideToolPermission(run, toolUse) {
  const metadata = toolMetadata(toolUse.name);
  const explicitlyAllowed = run.allowedTools.includes(toolUse.name);

  if (explicitlyAllowed) return 'allow';
  if (run.permissionMode === 'dontAsk') return 'deny';

  // acceptEdits means "let the agent inspect and edit files", but it still
  // leaves raw shell commands behind an explicit allowed_tools choice.
  if (run.permissionMode === 'acceptEdits' && !metadata.shell) return 'allow';

  return 'ask';
}

async function resolveToolDecision(run, toolUse, decision) {
  if (decision === 'deny') {
    return makeToolResult(toolUse, 'The user denied this tool call.', true);
  }

  try {
    const content = await executeTool(run, toolUse);
    return makeToolResult(toolUse, content, false);
  } catch (err) {
    return makeToolResult(toolUse, err.message, true);
  }
}

function makeToolResult(toolUse, content, isError) {
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    is_error: isError === true,
    content,
  };
}

module.exports = { makePendingTool, decideToolPermission, resolveToolDecision, makeToolResult };
