'use strict';

const vscode = require('vscode');

const IDENTITY_MODES = new Set(['compatibility', 'plain-api', 'observed-official']);

function getIdentitySettings() {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');
  const mode = config.get('identityMode', 'compatibility');

  return {
    // compatibility: current behavior, including fallback Claude-Code-like headers.
    // plain-api: only send the minimum API auth headers.
    // observed-official: replay only headers observed from a real local Claude Code request.
    mode: IDENTITY_MODES.has(mode) ? mode : 'compatibility',
    replayFingerprintHeaders: config.get('replayFingerprintHeaders', true),
    prependClaudeCodeSystemBlocks: config.get('prependClaudeCodeSystemBlocks', true),
  };
}

function shouldReplayFingerprintHeaders(settings = getIdentitySettings()) {
  return settings.mode !== 'plain-api' && settings.replayFingerprintHeaders !== false;
}

function shouldUseHardcodedCompatibilityFingerprint(settings = getIdentitySettings()) {
  return settings.mode === 'compatibility' && shouldReplayFingerprintHeaders(settings);
}

function shouldPrependClaudeCodeSystemBlocks(settings = getIdentitySettings()) {
  return settings.mode !== 'plain-api' && settings.prependClaudeCodeSystemBlocks !== false;
}

module.exports = {
  getIdentitySettings,
  shouldReplayFingerprintHeaders,
  shouldUseHardcodedCompatibilityFingerprint,
  shouldPrependClaudeCodeSystemBlocks,
};
