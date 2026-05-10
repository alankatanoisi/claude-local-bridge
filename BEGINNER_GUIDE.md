# Claude Local Bridge Beginner Guide

This guide is intentionally basic.

It assumes:

- you are on a Mac
- you are using VS Code
- this project folder is already open in VS Code
- the Claude Local Bridge extension is already installed or running from this folder

When this guide says **Terminal**, it means the Mac app named **Terminal**.

Do **not** paste commands into Spotlight, a browser address bar, or the VS Code search box.

---

## Tiny Dictionary

**Terminal** means the Mac app where you type commands.

**VS Code** means the code editor app.

**Output panel** means the log area inside VS Code where extensions print status messages.

**Port** means a local numbered doorway on your computer. This bridge usually uses `11437` for HTTP.

**Base URL** means the beginning of an API address, like `http://127.0.0.1:11437`.

**API key** means a password-like value. For this bridge, many tools require you to type one, but the bridge usually ignores the incoming value and uses its own saved credentials.

---

## Step 1: Open The Right VS Code Folder

1. Open **VS Code**.
2. Click **File** in the top menu.
3. Click **Open Folder...**
4. Choose this folder:

```text
/Users/alanman/Documents/GitHub/claude-local-bridge
```

5. Click **Open**.

You are in the right place if you can see files like:

- `README.md`
- `package.json`
- `src`
- `test`

---

## Step 2: Open The Bridge Logs In VS Code

1. In VS Code, click **View** in the top menu.
2. Click **Output**.
3. In the Output panel, look for a dropdown menu on the right side.
4. Choose:

```text
Claude Local Bridge
```

You want to see something like this:

```text
Extension activated. Starting server...
Server running on http://localhost:11437
```

If the port is not `11437`, write down the port number you see.

Example:

```text
Server running on http://localhost:11440
```

In that example, your port is `11440`, not `11437`.

---

## Step 3: Open Terminal

Use either method.

Method A:

1. Press `Command + Space`.
2. Type `Terminal`.
3. Press `Return`.

Method B:

1. Open **Finder**.
2. Click **Applications**.
3. Open **Utilities**.
4. Open **Terminal**.

You should see a window with a prompt that looks roughly like:

```text
alanman@Alans-Laptop ~ %
```

That is where you paste commands.

---

## Step 4: Test Whether The Bridge Is Alive

Copy this command into **Terminal**, then press `Return`:

```bash
curl http://127.0.0.1:11437/v1/debug
```

If your Output panel showed a different port, replace `11437` with that port.

Example if your bridge says port `11440`:

```bash
curl http://127.0.0.1:11440/v1/debug
```

Success looks like a big block of text that starts roughly like this:

```json
{"status":"running"
```

The most important things to look for are:

```json
"status":"running"
```

and:

```json
"authenticated":true
```

If you see both, the bridge is running and it found credentials.

---

## Step 5: Test The Model List

Copy this into **Terminal**:

```bash
curl http://127.0.0.1:11437/v1/models
```

Again, change `11437` if your bridge is using a different port.

Success looks like JSON with model names, for example:

```json
"claude-sonnet-4-6"
```

or:

```json
"claude-haiku-4-5"
```

---

## Step 6: Send A Tiny Test Message

Copy this into **Terminal**:

```bash
curl -X POST http://127.0.0.1:11437/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":20,"messages":[{"role":"user","content":"Reply with exactly: hello"}]}'
```

Success looks like a response containing:

```json
"text":"hello"
```

If you get a rate limit or usage message, that still means the bridge reached the upstream service. The bridge is working, but the account or provider rejected the request.

---

## Step 7: Use The New Debug Pages

These are read-only diagnostic pages. They do not send a model request.

### Provider profiles

Copy this into **Terminal**:

```bash
curl http://127.0.0.1:11437/v1/debug/profiles
```

This shows:

- which providers the bridge knows about
- whether Anthropic, OpenCode Go, OpenAI, or NVIDIA are configured
- which wire API each provider uses
- the last route the bridge used

### Claude IDE lockfiles

Copy this into **Terminal**:

```bash
curl http://127.0.0.1:11437/v1/debug/ide
```

This checks Claude Code IDE connection files.

Important: tokens are redacted. You should not see full secret tokens.

### Claude/MCP security posture

Copy this into **Terminal**:

```bash
curl http://127.0.0.1:11437/v1/debug/security
```

This checks local Claude config files for things worth reviewing, like:

- suspicious proxy settings
- insecure remote MCP URLs
- sensitive-looking headers stored in config files

This is a warning system, not a perfect security scanner.

---

## Step 8: If A Command Fails

### Problem: `Connection refused`

Example:

```text
curl: (7) Failed to connect to 127.0.0.1 port 11437
```

What it means:

The bridge is not running on that port.

Fix:

1. Go back to VS Code.
2. Open **View → Output**.
3. Pick **Claude Local Bridge**.
4. Look for the actual port.
5. Try the command again with the actual port.

### Problem: `authenticated:false`

What it means:

The bridge is running, but it did not find usable credentials.

Fix:

1. Open Claude Code normally.
2. Make sure you are signed in.
3. Restart VS Code.
4. Try:

```bash
curl http://127.0.0.1:11437/v1/debug
```

### Problem: `EADDRINUSE`

Example:

```text
address already in use
```

What it means:

Another process is already using that port.

Usually this is okay because the bridge automatically tries the next port.

Fix:

Look at the Output panel and use the port it actually chose.

### Problem: You pasted into the wrong place

If nothing happens, you may have pasted into:

- Spotlight
- a browser address bar
- VS Code search
- the editor text area

Fix:

Open **Terminal** and paste there.

---

## Step 9: Connect OpenCode To The Claude Local Bridge

This means OpenCode talks to your local bridge at:

```text
http://127.0.0.1:11437/v1
```

### 9A: Open the OpenCode config folder

In **Terminal**, paste:

```bash
mkdir -p ~/.config/opencode
open ~/.config/opencode
```

This opens a Finder window.

### 9B: Create or edit `opencode.json`

In that Finder window:

1. Look for a file named `opencode.json`.
2. If it exists, open it in VS Code.
3. If it does not exist, create a new file named exactly:

```text
opencode.json
```

Put this inside the file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "claude-local-bridge": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Claude Local Bridge",
      "options": {
        "baseURL": "http://127.0.0.1:11437/v1"
      },
      "models": {
        "claude-sonnet-4-6": {
          "name": "Claude Sonnet 4.6"
        },
        "claude-haiku-4-5": {
          "name": "Claude Haiku 4.5"
        },
        "claude-opus-4-5": {
          "name": "Claude Opus 4.5"
        }
      }
    }
  }
}
```

If your bridge is using a different port, change this line:

```json
"baseURL": "http://127.0.0.1:11437/v1"
```

Example for port `11440`:

```json
"baseURL": "http://127.0.0.1:11440/v1"
```

### 9C: Open OpenCode

In **Terminal**, paste:

```bash
opencode
```

Inside OpenCode:

1. Type `/connect`.
2. Pick **Claude Local Bridge** if it appears.
3. If it asks for an API key, type:

```text
local
```

4. Type `/models`.
5. Pick one of the Claude Local Bridge models.

The word `local` is just a placeholder. The bridge does not use it as your real upstream key.

---

## Step 10: Optional OpenCode Go Provider Models

Use this only if you want the bridge to show OpenCode Go provider-backed models too.

### 10A: Add your OpenCode Go API key in VS Code

1. Open VS Code.
2. Press `Command + Shift + P`.
3. Type:

```text
Preferences: Open User Settings (JSON)
```

4. Press `Return`.
5. Add these settings inside the big JSON object:

```json
"claudeLocalBridge.modelCatalog": "hybrid",
"claudeLocalBridge.opencodeGoApiKey": "PASTE_YOUR_OPENCODE_GO_KEY_HERE"
```

Important:

- Keep the quotes.
- Keep the comma if there are settings before or after it.
- Do not share this file publicly after adding a real key.

### 10B: Restart the bridge

In VS Code:

1. Press `Command + Shift + P`.
2. Type:

```text
Developer: Reload Window
```

3. Press `Return`.

### 10C: Confirm the models appear

In **Terminal**, paste:

```bash
curl http://127.0.0.1:11437/v1/models
```

Look for model IDs like:

```text
anthropic/claude-opencode-go-deepseek-v4-pro
```

or:

```text
anthropic/claude-opencode-go-kimi-k2--6
```

---

## Step 11: Optional HTTPS For Claude Cowork

Claude Cowork third-party gateway mode wants an `https://` URL.

This bridge can serve HTTPS locally.

### 11A: Install `mkcert`

In **Terminal**, paste:

```bash
brew install mkcert
mkcert -install
```

If you see `brew: command not found`, Homebrew is missing. Stop here and install Homebrew first.

### 11B: Create local certificate files

In **Terminal**, paste:

```bash
mkdir -p ~/.claude-local-bridge
mkcert -key-file ~/.claude-local-bridge/dev.key -cert-file ~/.claude-local-bridge/dev.crt localhost 127.0.0.1 ::1
```

Success means you now have:

```text
/Users/alanman/.claude-local-bridge/dev.key
/Users/alanman/.claude-local-bridge/dev.crt
```

### 11C: Turn on HTTPS in VS Code settings

1. Open VS Code.
2. Press `Command + Shift + P`.
3. Type:

```text
Preferences: Open User Settings (JSON)
```

4. Press `Return`.
5. Add these settings:

```json
"claudeLocalBridge.httpsEnabled": true,
"claudeLocalBridge.httpsPort": 11443,
"claudeLocalBridge.httpsKeyFile": "/Users/alanman/.claude-local-bridge/dev.key",
"claudeLocalBridge.httpsCertFile": "/Users/alanman/.claude-local-bridge/dev.crt"
```

### 11D: Reload VS Code

1. Press `Command + Shift + P`.
2. Type:

```text
Developer: Reload Window
```

3. Press `Return`.

### 11E: Test HTTPS

In **Terminal**, paste:

```bash
curl https://127.0.0.1:11443/v1/debug
```

Success looks like:

```json
"httpsBaseUrl":"https://127.0.0.1:11443"
```

If you see a certificate warning, try:

```bash
curl --cacert ~/.claude-local-bridge/dev.crt https://127.0.0.1:11443/v1/debug
```

---

## Step 12: Optional Claude Wrapper Trace

This is for observing how the official Claude Code VS Code extension launches Claude.

You do not need this for normal bridge use.

### 12A: Set the wrapper path

In VS Code:

1. Press `Command + Shift + P`.
2. Type:

```text
Preferences: Open User Settings (JSON)
```

3. Press `Return`.
4. Add this setting:

```json
"claudeCode.claudeProcessWrapper": "/Users/alanman/Documents/GitHub/claude-local-bridge/scripts/claude-wrapper-trace.sh"
```

### 12B: Reload VS Code

1. Press `Command + Shift + P`.
2. Type:

```text
Developer: Reload Window
```

3. Press `Return`.

### 12C: Check the trace log

In **Terminal**, paste:

```bash
cat ~/.claude-local-bridge/claude-wrapper-trace.log
```

Success means you see lines like:

```text
--- launch ---
real_claude=...
https_proxy=http://localhost:11439
```

The trace log is designed to redact sensitive values.

---

## Safe Defaults I Recommend

For normal bridge testing:

```json
"claudeLocalBridge.modelCatalog": "anthropic",
"claudeLocalBridge.identityMode": "compatibility"
```

For cleaner experiments:

```json
"claudeLocalBridge.identityMode": "plain-api"
```

For provider-mixed experiments:

```json
"claudeLocalBridge.modelCatalog": "hybrid"
```

---

## Quick Copy/Paste Checklist

Use this when you just want the shortest possible sanity check.

Open **Terminal** and paste:

```bash
curl http://127.0.0.1:11437/v1/debug
```

Then paste:

```bash
curl http://127.0.0.1:11437/v1/models
```

Then paste:

```bash
curl -X POST http://127.0.0.1:11437/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":20,"messages":[{"role":"user","content":"Reply with exactly: hello"}]}'
```

If those work, the bridge is alive.
