#!/usr/bin/env bash

# This wrapper is an observation tool for Claude Code's official VS Code launch path.
# VS Code passes the real bundled Claude binary as the first argument when
# `claudeCode.claudeProcessWrapper` is configured.

set -euo pipefail

# Put logs in a predictable user-owned folder, away from the repo.
LOG_DIR="${CLAUDE_LOCAL_BRIDGE_TRACE_DIR:-$HOME/.claude-local-bridge}"
LOG_FILE="$LOG_DIR/claude-wrapper-trace.log"

mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR" 2>/dev/null || true

redact_value() {
  # Keep short values fully hidden. For long values, keep only enough shape to
  # recognize whether a setting changed between launches.
  local value="${1:-}"
  if [ "${#value}" -le 8 ]; then
    printf '[REDACTED]'
  else
    printf '%s...%s' "${value:0:4}" "${value: -4}"
  fi
}

is_sensitive_name() {
  local name
  name="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  case "$name" in
    *TOKEN*|*SECRET*|*PASSWORD*|*CREDENTIAL*|*API_KEY*|*AUTHORIZATION*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

log_line() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE"
}

if [ "$#" -gt 0 ] && [ -x "$1" ]; then
  REAL_CLAUDE="$1"
  shift
else
  # Fallback for manual tests where the wrapper is launched directly.
  REAL_CLAUDE="$(command -v claude)"
fi

# If the caller did not provide a proxy, point Claude at the bridge's capture
# proxy. This is the same proxy the bridge announces as HTTPS_PROXY=localhost:11439.
export HTTPS_PROXY="${HTTPS_PROXY:-http://localhost:11439}"

log_line '--- launch ---'
log_line "cwd=$PWD"
log_line "real_claude=$REAL_CLAUDE"
log_line "argc=$#"
log_line "https_proxy=$HTTPS_PROXY"

# Log a small allowlist of environment variables that explain routing/context.
# This avoids dumping the full environment, which can contain unrelated secrets.
for name in \
  CLAUDE_CODE_SSE_PORT \
  CLAUDE_CONFIG_DIR \
  ANTHROPIC_BASE_URL \
  HTTPS_PROXY \
  HTTP_PROXY \
  NO_PROXY \
  CLAUDE_CODE_ATTRIBUTION_HEADER \
  DISABLE_TELEMETRY \
  DISABLE_ERROR_REPORTING \
  DISABLE_AUTOUPDATER \
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS \
  CLAUDE_CODE_HIDE_ACCOUNT_INFO
do
  if [ "${!name+x}" = x ]; then
    value="${!name}"
    if is_sensitive_name "$name"; then
      value="$(redact_value "$value")"
    fi
    log_line "env.$name=$value"
  fi
done

exec "$REAL_CLAUDE" "$@"
