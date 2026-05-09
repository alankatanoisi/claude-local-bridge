'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SENSITIVE_KEY_RE = /(token|secret|password|authorization|api[_-]?key|credential)/i;
const PROXY_KEY_RE = /(^|_)(http|https)_proxy$/i;

function inspectClaudeSecurity({ homeDir = os.homedir(), paths = defaultClaudePaths(homeDir) } = {}) {
  const files = paths.map((filePath) => inspectConfigFile(filePath)).filter(Boolean);
  const findings = [];

  for (const file of files) {
    findings.push(...file.findings);
  }

  return {
    checkedAt: new Date().toISOString(),
    files,
    summary: summarizeFindings(findings),
    findings,
  };
}

function defaultClaudePaths(homeDir) {
  return [
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.claude', 'settings.json'),
    path.join(homeDir, '.claude', 'settings.local.json'),
  ];
}

function inspectConfigFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const report = {
    path: filePath,
    exists: true,
    mode: modeString(stat.mode),
    mtime: new Date(stat.mtimeMs).toISOString(),
    parseOk: false,
    contentHash: null,
    mcpServerCount: 0,
    findings: [],
  };

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
    report.contentHash = `sha256:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
    const parsed = JSON.parse(raw);
    report.parseOk = true;
    inspectJsonTree(parsed, report, [path.basename(filePath)]);
  } catch (err) {
    report.findings.push({
      severity: 'warn',
      kind: 'parse_error',
      path: filePath,
      message: `Could not parse JSON: ${err.message}`,
    });
  }

  if (report.mode && !['600', '644'].includes(report.mode)) {
    report.findings.push({
      severity: 'warn',
      kind: 'file_permissions',
      path: filePath,
      message: `File mode is ${report.mode}; review whether this config should be more restrictive.`,
    });
  }

  return report;
}

function inspectJsonTree(value, report, trail) {
  if (!value || typeof value !== 'object') return;

  if (
    Object.prototype.hasOwnProperty.call(value, 'mcpServers') &&
    value.mcpServers &&
    typeof value.mcpServers === 'object'
  ) {
    inspectMcpServers(value.mcpServers, report, [...trail, 'mcpServers']);
  }

  for (const [key, child] of Object.entries(value)) {
    const childTrail = [...trail, key];

    if (SENSITIVE_KEY_RE.test(key) && typeof child === 'string' && child.length > 0) {
      report.findings.push({
        severity: 'info',
        kind: 'sensitive_field_present',
        path: childTrail.join('.'),
        message: 'Sensitive-looking field is present; value redacted.',
        valuePreview: redactSecret(child),
      });
    }

    if (PROXY_KEY_RE.test(key) && typeof child === 'string' && child.length > 0) {
      inspectProxyValue(child, report, childTrail);
    }

    inspectJsonTree(child, report, childTrail);
  }
}

function inspectMcpServers(mcpServers, report, trail) {
  for (const [name, server] of Object.entries(mcpServers)) {
    report.mcpServerCount += 1;
    const serverTrail = [...trail, name];
    const url = typeof server?.url === 'string' ? server.url : null;

    if (url) inspectMcpUrl(url, report, serverTrail);

    if (server?.headers && typeof server.headers === 'object') {
      for (const [headerName, headerValue] of Object.entries(server.headers)) {
        if (SENSITIVE_KEY_RE.test(headerName) && typeof headerValue === 'string') {
          report.findings.push({
            severity: 'warn',
            kind: 'mcp_sensitive_header',
            path: [...serverTrail, 'headers', headerName].join('.'),
            message: 'MCP server stores a sensitive-looking header in config.',
            valuePreview: redactSecret(headerValue),
          });
        }
      }
    }

    if (server?.env && typeof server.env === 'object') {
      for (const [envName, envValue] of Object.entries(server.env)) {
        if (PROXY_KEY_RE.test(envName) && typeof envValue === 'string') {
          inspectProxyValue(envValue, report, [...serverTrail, 'env', envName]);
        }
      }
    }
  }
}

function inspectMcpUrl(url, report, trail) {
  try {
    const parsed = new URL(url);
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !isLocal) {
      report.findings.push({
        severity: 'warn',
        kind: 'mcp_insecure_url',
        path: [...trail, 'url'].join('.'),
        message: `MCP server uses ${parsed.protocol} for a non-local URL.`,
        valuePreview: redactUrl(url),
      });
    }
  } catch {
    report.findings.push({
      severity: 'warn',
      kind: 'mcp_invalid_url',
      path: [...trail, 'url'].join('.'),
      message: 'MCP server URL could not be parsed.',
      valuePreview: redactUrl(url),
    });
  }
}

function inspectProxyValue(value, report, trail) {
  try {
    const parsed = new URL(value);
    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    report.findings.push({
      severity: isLocal ? 'info' : 'warn',
      kind: isLocal ? 'local_proxy_configured' : 'external_proxy_configured',
      path: trail.join('.'),
      message: isLocal
        ? 'Proxy points at a local endpoint.'
        : 'Proxy points at a non-local endpoint; review for MCP hijacking risk.',
      valuePreview: redactUrl(value),
    });
  } catch {
    report.findings.push({
      severity: 'warn',
      kind: 'invalid_proxy_url',
      path: trail.join('.'),
      message: 'Proxy value could not be parsed as a URL.',
      valuePreview: redactSecret(value),
    });
  }
}

function summarizeFindings(findings) {
  return findings.reduce(
    (summary, finding) => {
      summary.total += 1;
      summary[finding.severity] = (summary[finding.severity] || 0) + 1;
      return summary;
    },
    { total: 0, info: 0, warn: 0, error: 0 },
  );
}

function redactSecret(value) {
  const text = String(value);
  if (text.length <= 8) return '[REDACTED]';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function redactUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = 'REDACTED';
    if (parsed.password) parsed.password = 'REDACTED';
    return parsed.toString();
  } catch {
    return redactSecret(value);
  }
}

function modeString(mode) {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

module.exports = {
  inspectClaudeSecurity,
  inspectConfigFile,
  defaultClaudePaths,
  redactSecret,
  redactUrl,
};
