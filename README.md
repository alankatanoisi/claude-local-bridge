# Claude Local Bridge

A VS Code extension that exposes a local LLM gateway on your Mac.

For the very granular copy/paste walkthrough, use [BEGINNER_GUIDE.md](./BEGINNER_GUIDE.md).

For the new local agent runner and `curl` examples, use
[HEADLESS_AGENT_RUNNER_BEGINNER_GUIDE.md](./HEADLESS_AGENT_RUNNER_BEGINNER_GUIDE.md).

Today it supports two main jobs:

1. Read your **Claude Code** credentials and expose them as a local HTTP API.
2. Act as a **Claude Cowork-compatible Anthropic Messages gateway** for provider-backed models such as **OpenCode Go**.

Point tools at the bridge instead of talking to the upstream directly.

---

## How it works

```
Client
  → local bridge
    → either:
      - Claude credentials discovered on this Mac
      - a configured upstream provider such as OpenCode Go
```

The bridge can now do more than plain pass-through:

- proxy directly to Anthropic using local Claude credentials
- translate **Anthropic Messages** ↔ **OpenAI Chat Completions**
- advertise a provider-backed model catalog
- optionally serve the gateway over **HTTPS** for Claude Cowork third-party mode

---

## Credential Discovery (Priority Order)

| #   | Source                                       | Notes                                                      |
| --- | -------------------------------------------- | ---------------------------------------------------------- |
| 1   | `ANTHROPIC_API_KEY` env var                  | Standard Anthropic API key                                 |
| 2   | `CLAUDE_CODE_OAUTH_TOKEN` env var            | Long-lived token from `claude setup-token`                 |
| 3   | **macOS Keychain** `Claude Code-credentials` | Automatically set when you log in via `claude /login`      |
| 4   | `~/.claude/.credentials.json`                | Linux / Windows fallback; also macOS if keychain is locked |
| 5   | VS Code setting `claudeLocalBridge.apiKey`   | Manual fallback — set in VS Code settings                  |

On macOS with Claude Code installed, **Priority 3 is used automatically** — no configuration needed.

---

## Supported Endpoints

| Endpoint                         | Format           | Notes                                                   |
| -------------------------------- | ---------------- | ------------------------------------------------------- |
| `GET /v1/models`                 | OpenAI           | Lists the currently advertised model catalog            |
| `POST /v1/messages`              | Anthropic native | Native Anthropic endpoint; can proxy or translate       |
| `POST /v1/messages/count_tokens` | Anthropic        | Mock response (returns 0) for Claude CLI preflight      |
| `POST /v1/chat/completions`      | OpenAI           | OpenAI-compatible endpoint; can proxy or translate      |
| `GET /v1/debug`                  | JSON             | Status, credential source, authenticated flag           |
| `GET /v1/debug/ide`              | JSON             | Redacted Claude Code IDE MCP lockfile inspection        |
| `GET /v1/debug/profiles`         | JSON             | Provider profiles, wire APIs, identity mode, last route |
| `GET /v1/debug/security`         | JSON             | Local Claude config/MCP security posture checks         |

---

## Configuration

Open **VS Code Settings** and search for `Claude Local Bridge`:

| Setting                                           | Default                               | Description                                                         |
| ------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `claudeLocalBridge.port`                          | `11437`                               | HTTP server port                                                    |
| `claudeLocalBridge.httpsEnabled`                  | `false`                               | Also serve the bridge over HTTPS                                    |
| `claudeLocalBridge.httpsPort`                     | `11443`                               | HTTPS server port                                                   |
| `claudeLocalBridge.httpsKeyFile`                  | `""`                                  | Absolute path to TLS private key                                    |
| `claudeLocalBridge.httpsCertFile`                 | `""`                                  | Absolute path to TLS certificate                                    |
| `claudeLocalBridge.anthropicBaseUrl`              | `https://api.anthropic.com`           | Override for Anthropic pass-through mode                            |
| `claudeLocalBridge.apiKey`                        | `""`                                  | Manual Anthropic API key fallback                                   |
| `claudeLocalBridge.defaultModel`                  | `claude-sonnet-4-6`                   | Default model when none is specified                                |
| `claudeLocalBridge.modelCatalog`                  | `anthropic`                           | Advertised catalog: `anthropic`, `opencode-go`, `hybrid`            |
| `claudeLocalBridge.defaultWireApi`                | `anthropic-messages`                  | Debug/profile label for the default wire protocol                   |
| `claudeLocalBridge.providerProfiles`              | `{}`                                  | Advanced per-provider profile overrides                             |
| `claudeLocalBridge.identityMode`                  | `compatibility`                       | Identity mode: `compatibility`, `plain-api`, `observed-official`    |
| `claudeLocalBridge.replayFingerprintHeaders`      | `true`                                | Whether OAuth requests replay captured/fallback fingerprint headers |
| `claudeLocalBridge.prependClaudeCodeSystemBlocks` | `true`                                | Whether OAuth requests prepend Claude-Code-like system blocks       |
| `claudeLocalBridge.opencodeGoApiKey`              | `""`                                  | OpenCode Go API key                                                 |
| `claudeLocalBridge.opencodeGoBaseUrl`             | `https://opencode.ai/zen/go`          | OpenCode Go base URL                                                |
| `claudeLocalBridge.opencodeGoAuthScheme`          | `bearer`                              | How the OpenCode Go key is sent upstream                            |
| `claudeLocalBridge.openaiApiKey`                  | `""`                                  | OpenAI key for provider-profile experiments                         |
| `claudeLocalBridge.openaiBaseUrl`                 | `https://api.openai.com/v1`           | OpenAI-compatible base URL                                          |
| `claudeLocalBridge.nvidiaApiKey`                  | `""`                                  | NVIDIA key for provider-profile experiments                         |
| `claudeLocalBridge.nvidiaBaseUrl`                 | `https://integrate.api.nvidia.com/v1` | NVIDIA NIM OpenAI-compatible base URL                               |
| `claudeLocalBridge.logRequests`                   | `false`                               | Verbose request logging to Output channel                           |

### Identity modes

`compatibility` keeps the bridge's existing Claude-Code-compatible behavior. It can replay captured fingerprint headers and, if no live capture exists, fall back to the bridge's hardcoded compatibility headers.

`plain-api` sends only the minimal API/auth headers. This is useful as a clean baseline when you want to see what breaks without client identity replay.

`observed-official` replays only headers observed from a real local Claude Code request. It does not use the hardcoded fallback fingerprint.

### Claude Code wrapper tracer

The repo includes `scripts/claude-wrapper-trace.sh` for observing the official Claude Code VS Code launch path. It logs redacted launch context to:

```text
~/.claude-local-bridge/claude-wrapper-trace.log
```

To use it, set VS Code's **Claude Code: Claude Process Wrapper** setting to:

```text
/Users/alanman/Documents/GitHub/claude-local-bridge/scripts/claude-wrapper-trace.sh
```

Then restart the Claude Code extension or reload VS Code. The wrapper receives the real bundled Claude binary as its first argument, sets `HTTPS_PROXY=http://localhost:11439` when no proxy is already set, and then launches the real binary.

---

## Using with Claude Code CLI

Set `ANTHROPIC_BASE_URL` to point Claude Code at your local bridge:

```bash
export ANTHROPIC_BASE_URL=http://localhost:11437
export ANTHROPIC_API_KEY=local  # required by the CLI, value is ignored

claude
```

The Claude Code CLI will route its requests through the bridge, which injects your real credentials.

## Using with Continue.dev / Cursor / other tools

Point the provider at:

- **Base URL**: `http://localhost:11437`
- **API Key**: anything (e.g. `local`) — the bridge ignores the incoming key and uses its own credentials
- **Model**: any Claude model name (e.g. `claude-sonnet-4-6`)

---

## Phase 1: OpenCode Go Gateway For Claude Cowork

This bridge can now expose **OpenCode Go** models behind an Anthropic Messages-compatible gateway.

That is specifically useful for **Claude Cowork on third-party (3P)** because Cowork expects:

- `POST /v1/messages`
- streaming
- tool use
- and an `https://` gateway base URL

### 1. Add your OpenCode Go API key

Use either:

- VS Code setting: `claudeLocalBridge.opencodeGoApiKey`
- or environment variable: `CLAUDE_LOCAL_BRIDGE_OPENCODE_GO_API_KEY`

### 2. Switch the advertised model catalog

Set:

- `claudeLocalBridge.modelCatalog = opencode-go`

If you want to expose both the original Claude-backed bridge models and the new
OpenCode Go models together, use:

- `claudeLocalBridge.modelCatalog = hybrid`

### 3. Create a trusted local HTTPS certificate on macOS

Claude Cowork third-party gateway mode requires an `https://` URL.

The easiest local setup on macOS is `mkcert`, because it creates a certificate
your Mac actually trusts.

Type this in **Terminal**:

```bash
brew install mkcert
mkcert -install
mkdir -p ~/.claude-local-bridge
mkcert -key-file ~/.claude-local-bridge/dev.key -cert-file ~/.claude-local-bridge/dev.crt localhost 127.0.0.1 ::1
```

### 4. Point the bridge at those certificate files

Set these VS Code settings:

- `claudeLocalBridge.httpsEnabled = true`
- `claudeLocalBridge.httpsPort = 11443`
- `claudeLocalBridge.httpsKeyFile = /Users/<you>/.claude-local-bridge/dev.key`
- `claudeLocalBridge.httpsCertFile = /Users/<you>/.claude-local-bridge/dev.crt`

### 5. Restart the extension and verify the gateway

Open the Output panel for `Claude Local Bridge`.

You should see something like:

```text
✅ Server running on http://localhost:11437
🔐 HTTPS server running on https://localhost:11443
```

Then verify in **Terminal**:

```bash
curl https://127.0.0.1:11443/v1/debug
```

If `curl` complains about trust during early setup, try:

```bash
curl --cacert ~/.claude-local-bridge/dev.crt https://127.0.0.1:11443/v1/debug
```

The debug payload should show:

- an `httpsBaseUrl`
- `modelCatalog: "opencode-go"` or `hybrid`
- `providerSummary.openCodeGoConfigured: true`

### 6. Point Claude Cowork at the local HTTPS gateway

In Claude Desktop:

1. Enable Developer Mode if you have not already.
2. Open `Developer -> Configure third-party inference`.
3. Choose `gateway`.
4. Use:
   - Base URL: `https://127.0.0.1:11443`
   - API key: `local`
   - Auth scheme: `bearer` or `x-api-key`
     - `bearer` is fine for the bridge because the value is only used locally

If your Cowork build does not auto-discover models from `/v1/models`, set
`inferenceModels` manually to ids such as:

- `anthropic/claude-opencode-go-deepseek-v4-pro`
- `anthropic/claude-opencode-go-deepseek-v4-flash`
- `anthropic/claude-opencode-go-kimi-k2--6`
- `anthropic/claude-opencode-go-glm-5--1`

Claude Cowork validates gateway model ids and expects them to look Anthropic-shaped.
The bridge therefore advertises Anthropic-style route ids while preserving the
real OpenCode Go upstream model names internally.

### OpenCode Go models currently wired in Phase 1

The bridge understands these OpenCode Go upstream shapes today:

- `/v1/chat/completions`
  - `glm-5`
  - `glm-5.1`
  - `kimi-k2.5`
  - `kimi-k2.6`
  - `deepseek-v4-pro`
  - `deepseek-v4-flash`
  - `mimo-v2.5`
  - `mimo-v2.5-pro`
  - `qwen3.5-plus`
  - `qwen3.6-plus`
- `/v1/messages`
  - `minimax-m2.5`
  - `minimax-m2.7`

The bridge chooses the correct upstream endpoint per model.

### Reserved for later: OpenAI Responses

The provider adapter now has a wire-api slot for `openai-responses`, but that
translation path is intentionally not implemented yet.

That is the earmark for the later Responses-based adapter work.

---

## OAuth Token Expiry

Claude Code OAuth tokens expire periodically. The bridge will:

1. Return a `401` to the caller if the token has expired
2. Clear its credential cache automatically
3. Retry once with freshly discovered credentials

If the retry also fails, run `claude /login` (or simply open Claude Code) — the CLI will refresh the token, which the bridge will pick up on the next request.

---

## Status Bar

The extension shows a status bar item: `📡 Claude Bridge :11437 [keychain]`

Click it to see the current credential source and server status.

---

## Commands

- `Claude Local Bridge: Start Server`
- `Claude Local Bridge: Stop Server`
- `Claude Local Bridge: Show Status`
- `Claude Local Bridge: Show Credential Source`

---

## Development

```bash
npm install
npm run format   # Prettier
npm run lint     # ESLint
npm test         # node:test suite
```

Press `F5` in VS Code to launch an Extension Development Host.
