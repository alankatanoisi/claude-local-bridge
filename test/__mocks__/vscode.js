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
  port: 11436,
  anthropicBaseUrl: 'https://api.anthropic.com',
  apiKey: '',
  defaultModel: 'claude-sonnet-4-5',
  logRequests: false,
  logFormat: 'text',
  redactionPolicy: 'balanced',
  redactedFields: [
    'authorization',
    'x-api-key',
    'api-key',
    'token',
    'access_token',
    'refresh_token',
    'sessionid',
    'session-id',
    'session_id',
    'cookie',
    'set-cookie',
    'x-anthropic-billing-header',
    'billing',
  ],
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
};

// Intercept require('vscode') at the Module._load level.
// This works even though vscode isn't an installed npm package.
const _originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return _originalLoad.call(this, request, parent, isMain);
};

vscode.__setConfig = (updates) => Object.assign(config, updates);
vscode.__resetConfig = () => {
  config.port = 11436;
  config.anthropicBaseUrl = 'https://api.anthropic.com';
  config.apiKey = '';
  config.defaultModel = 'claude-sonnet-4-5';
  config.logRequests = false;
  config.logFormat = 'text';
  config.redactionPolicy = 'balanced';
};

module.exports = vscode;
