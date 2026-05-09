'use strict';

const vscode = require('vscode');
const { getCredentials } = require('./credentials');
const { getIdentitySettings } = require('./identity');

const WIRE_APIS = {
  ANTHROPIC_MESSAGES: 'anthropic-messages',
  OPENAI_CHAT: 'openai-chat',
  OPENAI_RESPONSES: 'openai-responses',
};

function getProviderProfiles(ctx) {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');
  const creds = ctx ? getCredentials(ctx) : { source: 'unknown' };
  const overrides = config.get('providerProfiles', {});

  const profiles = [
    {
      id: 'anthropic',
      name: 'Anthropic',
      enabled: Boolean(creds.apiKey || creds.accessToken),
      baseUrl: config.get('anthropicBaseUrl', 'https://api.anthropic.com'),
      credentialSource: creds.source,
      authConfigured: Boolean(creds.apiKey || creds.accessToken),
      wireApis: [WIRE_APIS.ANTHROPIC_MESSAGES],
      notes: ['Local Claude credential discovery is used for this profile.'],
    },
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      enabled: Boolean(process.env.CLAUDE_LOCAL_BRIDGE_OPENCODE_GO_API_KEY || config.get('opencodeGoApiKey', '')),
      baseUrl: config.get('opencodeGoBaseUrl', 'https://opencode.ai/zen/go'),
      credentialSource: process.env.CLAUDE_LOCAL_BRIDGE_OPENCODE_GO_API_KEY
        ? 'env:CLAUDE_LOCAL_BRIDGE_OPENCODE_GO_API_KEY'
        : 'vscode-setting:opencodeGoApiKey',
      authConfigured: Boolean(
        process.env.CLAUDE_LOCAL_BRIDGE_OPENCODE_GO_API_KEY || config.get('opencodeGoApiKey', ''),
      ),
      authScheme: config.get('opencodeGoAuthScheme', 'bearer'),
      wireApis: [WIRE_APIS.ANTHROPIC_MESSAGES, WIRE_APIS.OPENAI_CHAT, WIRE_APIS.OPENAI_RESPONSES],
      notes: ['OpenAI Responses is reserved plumbing; request handling is not implemented yet.'],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      enabled: Boolean(process.env.OPENAI_API_KEY || config.get('openaiApiKey', '')),
      baseUrl: config.get('openaiBaseUrl', 'https://api.openai.com/v1'),
      credentialSource: process.env.OPENAI_API_KEY ? 'env:OPENAI_API_KEY' : 'vscode-setting:openaiApiKey',
      authConfigured: Boolean(process.env.OPENAI_API_KEY || config.get('openaiApiKey', '')),
      authScheme: 'bearer',
      wireApis: [WIRE_APIS.OPENAI_CHAT, WIRE_APIS.OPENAI_RESPONSES],
      notes: ['Profile is visible for routing experiments; upstream adapter is earmarked for the next build.'],
    },
    {
      id: 'nvidia',
      name: 'NVIDIA NIM',
      enabled: Boolean(process.env.NVIDIA_API_KEY || config.get('nvidiaApiKey', '')),
      baseUrl: config.get('nvidiaBaseUrl', 'https://integrate.api.nvidia.com/v1'),
      credentialSource: process.env.NVIDIA_API_KEY ? 'env:NVIDIA_API_KEY' : 'vscode-setting:nvidiaApiKey',
      authConfigured: Boolean(process.env.NVIDIA_API_KEY || config.get('nvidiaApiKey', '')),
      authScheme: 'bearer',
      wireApis: [WIRE_APIS.OPENAI_CHAT],
      notes: ['Profile is visible for routing experiments; upstream adapter is earmarked for the next build.'],
    },
  ];

  return applyProviderProfileOverrides(profiles, overrides);
}

function applyProviderProfileOverrides(profiles, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return profiles;
  }

  return profiles.map((profile) => {
    const override = overrides[profile.id];
    if (!override || typeof override !== 'object' || Array.isArray(override)) {
      return profile;
    }

    const merged = {
      ...profile,
      ...pickProfileOverrideFields(override),
      id: profile.id,
    };

    if (override.wireApis && Array.isArray(override.wireApis)) {
      merged.wireApis = override.wireApis.filter((wireApi) => Object.values(WIRE_APIS).includes(wireApi));
    }

    if (override.notes && Array.isArray(override.notes)) {
      merged.notes = override.notes.map((note) => String(note));
    }

    return merged;
  });
}

function pickProfileOverrideFields(override) {
  const allowed = {};

  for (const key of ['name', 'enabled', 'baseUrl', 'credentialSource', 'authConfigured', 'authScheme']) {
    if (Object.prototype.hasOwnProperty.call(override, key)) {
      allowed[key] = override[key];
    }
  }

  return allowed;
}

function getProfilesDebug(ctx) {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');

  return {
    modelCatalog: config.get('modelCatalog', 'anthropic'),
    defaultWireApi: config.get('defaultWireApi', WIRE_APIS.ANTHROPIC_MESSAGES),
    identity: getIdentitySettings(),
    providers: getProviderProfiles(ctx),
    lastRoute: ctx.lastRoute || null,
  };
}

function recordRoute(ctx, route) {
  if (!ctx) return;
  ctx.lastRoute = {
    at: new Date().toISOString(),
    ...route,
    identityMode: getIdentitySettings().mode,
  };
}

module.exports = {
  WIRE_APIS,
  applyProviderProfileOverrides,
  getProviderProfiles,
  getProfilesDebug,
  recordRoute,
};
