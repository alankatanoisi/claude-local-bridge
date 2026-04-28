'use strict';

const vscode = require('vscode');

const DEFAULT_REDACTED_FIELDS = [
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
];

const SENSITIVE_TEXT_PATTERNS = [
  /(authorization\s*:\s*bearer\s+)([^\s,;]+)/gi,
  /(x-api-key\s*:\s*)([^\s,;]+)/gi,
  /(token\s*[=:]\s*)([^\s,;]+)/gi,
  /(session[_-]?id\s*[=:]\s*)([^\s,;]+)/gi,
  /(cookie\s*:\s*)([^\r\n]+)/gi,
];

function getLoggingConfig() {
  const config = vscode.workspace.getConfiguration('claudeLocalBridge');
  return {
    logRequests: config.get('logRequests', false),
    logFormat: config.get('logFormat', 'text'),
    redactionPolicy: config.get('redactionPolicy', 'balanced'),
    redactedFields: config.get('redactedFields', DEFAULT_REDACTED_FIELDS),
  };
}

function asObjectEntries(value) {
  if (!value) return [];
  if (typeof value.entries === 'function') {
    try {
      return Array.from(value.entries());
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.entries(value);
  return [];
}

function isRedactedKey(key, redactedSet) {
  const normalized = String(key).toLowerCase();
  if (redactedSet.has(normalized)) return true;
  return (
    normalized.includes('authorization') ||
    normalized.includes('api-key') ||
    normalized.includes('token') ||
    normalized.includes('session') ||
    normalized.includes('cookie') ||
    normalized.includes('billing')
  );
}

function maskString(value, policy = 'balanced') {
  const input = String(value);
  let out = input;

  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    out = out.replace(pattern, (_match, prefix) => `${prefix}[REDACTED]`);
  }

  if (policy === 'strict') return out === input ? '[REDACTED]' : out;
  if (out !== input) return out;

  if (input.length <= 10) return '***';
  return `${input.slice(0, 4)}...${input.slice(-4)}`;
}

function redactValue(key, value, options = {}) {
  const { redactionPolicy = 'balanced', redactedSet = new Set(DEFAULT_REDACTED_FIELDS.map((k) => k.toLowerCase())) } =
    options;

  if (value === null || value === undefined) return value;

  if (isRedactedKey(key, redactedSet)) {
    if (Array.isArray(value)) return value.map((v) => redactValue(key, v, options));
    if (typeof value === 'object') return '[REDACTED]';
    return maskString(value, redactionPolicy);
  }

  if (Array.isArray(value)) return value.map((v) => redactAny(v, options));
  if (typeof value === 'object') return redactObject(value, options);
  if (typeof value === 'string' && redactionPolicy === 'strict') {
    return SENSITIVE_TEXT_PATTERNS.some((p) => p.test(value)) ? maskString(value, redactionPolicy) : value;
  }
  return value;
}

function redactObject(obj, options = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = redactValue(key, value, options);
  }
  return out;
}

function redactAny(value, options = {}) {
  if (Array.isArray(value)) return value.map((v) => redactAny(v, options));
  if (value && typeof value === 'object') return redactObject(value, options);
  if (typeof value === 'string' && options.redactionPolicy === 'strict') {
    return SENSITIVE_TEXT_PATTERNS.some((p) => p.test(value)) ? maskString(value, options.redactionPolicy) : value;
  }
  return value;
}

function redactHeaders(headers, options = {}) {
  const result = {};
  for (const [k, v] of asObjectEntries(headers)) {
    result[k] = redactValue(k, v, options);
  }
  return result;
}

function createRecord(ctx, level, event, details = {}) {
  const cfg = getLoggingConfig();
  const redactedSet = new Set((cfg.redactedFields || DEFAULT_REDACTED_FIELDS).map((k) => String(k).toLowerCase()));
  const redactOptions = { redactionPolicy: cfg.redactionPolicy, redactedSet };

  return {
    timestamp: new Date().toISOString(),
    level,
    event,
    requestId: details.requestId || null,
    path: details.path || null,
    status: details.status ?? null,
    credentialSource: details.credentialSource || null,
    details: redactAny(details.details || {}, redactOptions),
  };
}

function emitLog(ctx, level, event, details = {}) {
  const record = createRecord(ctx, level, event, details);
  const cfg = getLoggingConfig();

  if (cfg.logFormat === 'json') {
    ctx.outputChannel?.appendLine(JSON.stringify(record));
  } else {
    const ts = record.timestamp.slice(11, 23);
    const summary = `${record.event} path=${record.path || '-'} status=${record.status ?? '-'} requestId=${record.requestId || '-'}`;
    const extra = Object.keys(record.details || {}).length ? ` details=${JSON.stringify(record.details)}` : '';
    ctx.outputChannel?.appendLine(`[${ts}] [${record.level}] ${summary}${extra}`);
  }

  if (level === 'error') {
    console.error(`[claude-bridge] ${JSON.stringify(record)}`);
  }

  return record;
}

function sanitizeForResponse(payload) {
  const cfg = getLoggingConfig();
  const redactedSet = new Set((cfg.redactedFields || DEFAULT_REDACTED_FIELDS).map((k) => String(k).toLowerCase()));
  return redactAny(payload, { redactionPolicy: cfg.redactionPolicy, redactedSet });
}

module.exports = {
  DEFAULT_REDACTED_FIELDS,
  redactHeaders,
  redactObject,
  redactAny,
  sanitizeForResponse,
  emitLog,
};
