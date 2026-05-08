'use strict';

const vscode = require('vscode');
const { LISTED_MODELS } = require('./models');
const { shouldAdvertiseOpenCodeGo, getOpenCodeGoModels } = require('./providers/opencode-go');

async function getAdvertisedModels(ctx) {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');
  const catalogMode = config.get('modelCatalog', 'anthropic');

  if (catalogMode === 'opencode-go') {
    return getOpenCodeGoModels(ctx);
  }

  if (catalogMode === 'hybrid') {
    const openCodeGoModels = shouldAdvertiseOpenCodeGo(ctx) ? await getOpenCodeGoModels(ctx) : [];
    return [...LISTED_MODELS, ...openCodeGoModels];
  }

  return LISTED_MODELS;
}

module.exports = { getAdvertisedModels };
