'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const MAX_FILE_BYTES = 128 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_SEARCH_MATCHES = 50;
const MAX_SEARCH_BYTES = 64 * 1024;
const MAX_BASH_BYTES = 128 * 1024;
const MAX_PATCH_BYTES = 256 * 1024;
const DEFAULT_BASH_TIMEOUT_MS = 10_000;
const MAX_BASH_TIMEOUT_MS = 30_000;

const TOOL_SCHEMAS = [
  {
    name: 'list_files',
    description: 'List direct children of a directory under the run working directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the run working directory.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a bounded UTF-8 text file under the run working directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the run working directory.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_text',
    description: 'Search for text under the run working directory and return bounded matches.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text or ripgrep-compatible pattern to search for.' },
        path: { type: 'string', description: 'Optional directory or file path relative to the run working directory.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'git_status',
    description: 'Return concise git status for the run working directory.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'bash',
    description: 'Run a bounded shell command in the run working directory.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run from the run working directory.' },
        timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds, capped at 30000.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace text in a bounded file under the run working directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the run working directory.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring one match.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a bounded UTF-8 text file under the run working directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the run working directory.' },
        content: { type: 'string', description: 'Text content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply a bounded unified diff patch under the run working directory.',
    input_schema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Unified diff patch to apply with git apply.' },
      },
      required: ['patch'],
    },
  },
];

const TOOL_METADATA = {
  list_files: { readOnly: true, concurrent: true },
  read_file: { readOnly: true, concurrent: true },
  search_text: { readOnly: true, concurrent: true },
  git_status: { readOnly: true, concurrent: true },
  bash: { readOnly: false, concurrent: false, shell: true },
  edit_file: { readOnly: false, concurrent: false, writes: true },
  write_file: { readOnly: false, concurrent: false, writes: true },
  apply_patch: { readOnly: false, concurrent: false, writes: true },
};

async function executeTool(run, toolUse) {
  const input = toolUse.input || {};
  if (toolUse.name === 'list_files') return listFiles(run.cwd, input.path || '.');
  if (toolUse.name === 'read_file') return readFile(run.cwd, input.path);
  if (toolUse.name === 'search_text') return searchText(run.cwd, input.query, input.path || '.');
  if (toolUse.name === 'git_status') return gitStatus(run.cwd);
  if (toolUse.name === 'bash') return bash(run.cwd, input.command, input.timeout_ms);
  if (toolUse.name === 'edit_file') return editFile(run.cwd, input);
  if (toolUse.name === 'write_file') return writeFile(run.cwd, input.path, input.content);
  if (toolUse.name === 'apply_patch') return applyPatch(run.cwd, input.patch);
  throw new Error(`Unknown tool: ${toolUse.name}`);
}

function toolMetadata(name) {
  return TOOL_METADATA[name] || { readOnly: false, concurrent: false };
}

function listFiles(cwd, requestedPath) {
  const target = resolveSafePath(cwd, requestedPath);
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${requestedPath}`);

  const entries = fs
    .readdirSync(target, { withFileTypes: true })
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return JSON.stringify({ path: path.relative(cwd, target) || '.', entries }, null, 2);
}

function readFile(cwd, requestedPath) {
  if (!requestedPath) throw new Error('path is required');
  const target = resolveSafePath(cwd, requestedPath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`Not a file: ${requestedPath}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to read safely (${stat.size} bytes, limit ${MAX_FILE_BYTES})`);
  }

  const content = fs.readFileSync(target, 'utf8');
  return JSON.stringify(
    {
      path: path.relative(cwd, target),
      bytes: Buffer.byteLength(content, 'utf8'),
      content,
    },
    null,
    2,
  );
}

function writeFile(cwd, requestedPath, content) {
  if (!requestedPath) throw new Error('path is required');
  if (typeof content !== 'string') throw new Error('content must be a string');
  assertByteLimit(content, MAX_WRITE_BYTES, 'content');

  const target = resolveSafePath(cwd, requestedPath);
  const parent = path.dirname(target);
  resolveSafePath(cwd, path.relative(cwd, parent) || '.');
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(target, content, 'utf8');

  return JSON.stringify(
    {
      path: path.relative(cwd, target),
      bytes: Buffer.byteLength(content, 'utf8'),
      written: true,
    },
    null,
    2,
  );
}

function editFile(cwd, input) {
  const requestedPath = input.path;
  if (!requestedPath) throw new Error('path is required');
  if (typeof input.old_string !== 'string') throw new Error('old_string must be a string');
  if (typeof input.new_string !== 'string') throw new Error('new_string must be a string');

  const target = resolveSafePath(cwd, requestedPath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`Not a file: ${requestedPath}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to edit safely (${stat.size} bytes, limit ${MAX_FILE_BYTES})`);
  }

  const before = fs.readFileSync(target, 'utf8');
  if (!before.includes(input.old_string)) throw new Error('old_string was not found');

  const count = before.split(input.old_string).length - 1;
  if (!input.replace_all && count !== 1) {
    throw new Error(`old_string matched ${count} times; set replace_all to true or make it unique`);
  }

  const after = input.replace_all
    ? before.split(input.old_string).join(input.new_string)
    : before.replace(input.old_string, input.new_string);
  assertByteLimit(after, MAX_WRITE_BYTES, 'edited file');
  fs.writeFileSync(target, after, 'utf8');

  return JSON.stringify(
    {
      path: path.relative(cwd, target),
      replacements: input.replace_all ? count : 1,
      bytes: Buffer.byteLength(after, 'utf8'),
    },
    null,
    2,
  );
}

function searchText(cwd, query, requestedPath) {
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const target = resolveSafePath(cwd, requestedPath || '.');

  return new Promise((resolve, reject) => {
    const args = [
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--max-count',
      String(MAX_SEARCH_MATCHES),
      query,
      target,
    ];
    execFile('rg', args, { cwd, maxBuffer: MAX_SEARCH_BYTES }, (err, stdout, stderr) => {
      if (err && err.code !== 1) {
        reject(new Error((stderr || err.message).trim()));
        return;
      }
      resolve(
        JSON.stringify(
          {
            query,
            path: path.relative(cwd, target) || '.',
            matches: stdout.trim() ? stdout.trim().split('\n').slice(0, MAX_SEARCH_MATCHES) : [],
          },
          null,
          2,
        ),
      );
    });
  });
}

function gitStatus(cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', ['status', '--short'], { cwd, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message).trim()));
        return;
      }
      resolve(JSON.stringify({ status: stdout.trim() ? stdout.trim().split('\n') : [] }, null, 2));
    });
  });
}

function bash(cwd, command, timeoutMs) {
  if (!command || typeof command !== 'string') throw new Error('command is required');
  if (command.length > 4000) throw new Error('command is too long');

  const timeout = normalizeTimeout(timeoutMs);
  return new Promise((resolve, reject) => {
    // The shell runs from cwd and is still permission-gated by the runner.
    // This is not a full OS sandbox; it is the local automation escape hatch.
    execFile('/bin/zsh', ['-lc', command], { cwd, timeout, maxBuffer: MAX_BASH_BYTES }, (err, stdout, stderr) => {
      if (err && err.killed) {
        reject(new Error(`Command timed out after ${timeout}ms`));
        return;
      }
      resolve(
        JSON.stringify(
          {
            command,
            exit_code: err && Number.isInteger(err.code) ? err.code : 0,
            stdout,
            stderr,
          },
          null,
          2,
        ),
      );
    });
  });
}

async function applyPatch(cwd, patch) {
  if (!patch || typeof patch !== 'string') throw new Error('patch is required');
  assertByteLimit(patch, MAX_PATCH_BYTES, 'patch');
  assertPatchPathsSafe(cwd, patch);

  await runWithStdin('git', ['apply', '--check', '-'], patch, cwd);
  await runWithStdin('git', ['apply', '-'], patch, cwd);
  return JSON.stringify({ applied: true }, null, 2);
}

function assertPatchPathsSafe(cwd, patch) {
  const paths = new Set();
  for (const line of patch.split('\n')) {
    const gitMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (gitMatch) {
      paths.add(gitMatch[1]);
      paths.add(gitMatch[2]);
    }

    const fileMatch = line.match(/^(?:---|\+\+\+) (?:a\/|b\/)?(.+)$/);
    if (fileMatch && fileMatch[1] !== '/dev/null') paths.add(fileMatch[1]);
  }

  if (paths.size === 0) throw new Error('patch does not include any file paths');
  for (const patchPath of paths) {
    if (path.isAbsolute(patchPath)) throw new Error(`Patch path must be relative: ${patchPath}`);
    resolveSafePath(cwd, patchPath);
  }
}

function runWithStdin(command, args, stdin, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let total = 0;

    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total <= MAX_BASH_BYTES) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      total += chunk.length;
      if (total <= MAX_BASH_BYTES) stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${command} exited with ${code}`));
    });
    child.stdin.end(stdin);
  });
}

function normalizeTimeout(timeoutMs) {
  if (timeoutMs === undefined) return DEFAULT_BASH_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeout_ms must be a positive integer');
  return Math.min(timeoutMs, MAX_BASH_TIMEOUT_MS);
}

function assertByteLimit(value, limit, label) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > limit) throw new Error(`${label} is too large (${bytes} bytes, limit ${limit})`);
}

function resolveSafePath(cwd, requestedPath, options = {}) {
  const base = path.resolve(cwd);
  const target = path.resolve(base, requestedPath || '.');
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Path escapes the run working directory: ${requestedPath}`);
  }
  if (!options.allowSensitiveLeaf) assertNotSensitive(target, base);
  return target;
}

function assertNotSensitive(target, base) {
  const relative = path.relative(base, target);
  const parts = relative.split(path.sep).filter(Boolean);
  for (const part of parts) {
    if (part === '.env' || part.startsWith('.env.')) throw new Error(`Sensitive path is blocked: ${relative}`);
    if (part === '.ssh' || part === '.aws' || part === '.config' || part === '.claude') {
      throw new Error(`Sensitive directory is blocked: ${relative}`);
    }
    if (/key|secret|credential|token/i.test(part) && /\.(json|pem|key|env|txt|ya?ml)$/i.test(part)) {
      throw new Error(`Credential-looking file is blocked: ${relative}`);
    }
    if (/\.(pem|key|p12|pfx)$/i.test(part)) throw new Error(`Private key file is blocked: ${relative}`);
  }
}

module.exports = {
  TOOL_SCHEMAS,
  TOOL_METADATA,
  executeTool,
  toolMetadata,
  resolveSafePath,
  assertNotSensitive,
  MAX_FILE_BYTES,
  MAX_WRITE_BYTES,
  MAX_BASH_BYTES,
};
