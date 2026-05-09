'use strict';

/**
 * Minimal VS Code API mock for tests.
 * Only stubs methods that are actually used by claude-local-bridge.
 *
 * Bootstrap: patches Module._load so that any require('vscode') call in src/
 * returns this mock object instead of trying to resolve the real vscode package.
 */

const Module = require('module');

const config = {
  port: 11437,
  httpsEnabled: false,
  httpsPort: 11443,
  httpsKeyFile: '',
  httpsCertFile: '',
  anthropicBaseUrl: 'https://api.anthropic.com',
  apiKey: '',
  defaultModel: 'claude-sonnet-4-6',
  modelCatalog: 'anthropic',
  defaultWireApi: 'anthropic-messages',
  providerProfiles: {},
  identityMode: 'compatibility',
  replayFingerprintHeaders: true,
  prependClaudeCodeSystemBlocks: true,
  opencodeGoApiKey: '',
  opencodeGoBaseUrl: 'https://opencode.ai/zen/go',
  opencodeGoAuthScheme: 'bearer',
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  nvidiaApiKey: '',
  nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1',
  logRequests: false,
};

const vscode = {
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    }),
    createStatusBarItem: () => ({
      text: '',
      tooltip: '',
      command: '',
      backgroundColor: undefined,
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    showInformationMessage: () => {},
    showErrorMessage: () => {},
  },
  workspace: {
    getConfiguration: (_section) => ({
      get: (key, defaultVal) => {
        if (key in config) return config[key];
        return defaultVal;
      },
    }),
  },
  commands: {
    registerCommand: (_id, _fn) => ({ dispose: () => {} }),
  },
  StatusBarAlignment: { Right: 1, Left: 2 },
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
  __setConfig: (key, value) => {
    config[key] = value;
  },
  __resetConfig: () => {
    config.identityMode = 'compatibility';
    config.replayFingerprintHeaders = true;
    config.prependClaudeCodeSystemBlocks = true;
    config.modelCatalog = 'anthropic';
    config.providerProfiles = {};
    config.openaiApiKey = '';
    config.nvidiaApiKey = '';
  },
};

// Intercept require('vscode') at the Module._load level.
// This works even though vscode isn't an installed npm package.
const _originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return _originalLoad.call(this, request, parent, isMain);
};

module.exports = vscode;
