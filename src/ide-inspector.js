'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function inspectIdeLockfiles({ homeDir = os.homedir() } = {}) {
  const ideDir = path.join(homeDir, '.claude', 'ide');
  const result = {
    ideDir,
    exists: false,
    directoryMode: null,
    lockfiles: [],
    warnings: [],
  };

  let entries;
  try {
    const stat = fs.statSync(ideDir);
    result.exists = stat.isDirectory();
    result.directoryMode = modeString(stat.mode);
    entries = fs.readdirSync(ideDir).filter((name) => name.endsWith('.lock'));
  } catch (err) {
    result.warnings.push(`Could not read IDE lockfile directory: ${err.code || err.message}`);
    return result;
  }

  if (result.directoryMode && result.directoryMode !== '700') {
    result.warnings.push(`IDE lockfile directory mode is ${result.directoryMode}; expected 700.`);
  }

  for (const entry of entries) {
    result.lockfiles.push(readLockfile(path.join(ideDir, entry), entry));
  }

  result.activeCount = result.lockfiles.filter((lock) => lock.parseOk).length;
  return result;
}

function readLockfile(filePath, fileName) {
  const lock = {
    file: fileName,
    path: filePath,
    port: parseInt(fileName.replace(/\.lock$/, ''), 10) || null,
    mode: null,
    mtime: null,
    parseOk: false,
    data: null,
    warnings: [],
  };

  try {
    const stat = fs.statSync(filePath);
    lock.mode = modeString(stat.mode);
    lock.mtime = new Date(stat.mtimeMs).toISOString();
    if (lock.mode !== '600') lock.warnings.push(`Lockfile mode is ${lock.mode}; expected 600.`);

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    lock.parseOk = true;
    lock.data = redactLockData(parsed);
  } catch (err) {
    lock.warnings.push(`Could not parse lockfile: ${err.code || err.message}`);
  }

  return lock;
}

function redactLockData(data) {
  return {
    pid: data.pid ?? null,
    workspaceFolders: Array.isArray(data.workspaceFolders) ? data.workspaceFolders : [],
    ideName: data.ideName ?? null,
    transport: data.transport ?? null,
    runningInWindows: Boolean(data.runningInWindows),
    authToken: data.authToken
      ? {
          present: true,
          fingerprint: `sha256:${crypto.createHash('sha256').update(String(data.authToken)).digest('hex').slice(0, 12)}`,
        }
      : { present: false },
  };
}

function modeString(mode) {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

module.exports = {
  inspectIdeLockfiles,
  redactLockData,
};
