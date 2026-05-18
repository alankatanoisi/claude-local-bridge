# Headless Agent Runner Beginner Guide

This guide explains the new local agent runner in very plain language.

The short version:

- the **bridge** is the local server running on your Mac
- the **agent runner** is a new part of the bridge that can think, ask for tools, run approved tools, and continue
- you talk to it with `curl`, which is a Terminal command for sending a web request

When this guide says **Terminal**, it means the Mac app named **Terminal**.

Do not paste these commands into Spotlight, a browser address bar, or the VS Code search box.

---

## Tiny Dictionary

**Bridge** means the local server from this repo. It usually listens at:

```text
http://127.0.0.1:11437
```

**Endpoint** means a specific address inside the bridge, like:

```text
/v1/agent/runs
```

**Run** means one agent job. A run starts with your prompt and ends when the model gives a final answer, asks for approval, or hits an error.

**Tool** means an action the model can ask the runner to do, like reading a file or running `git status`.

**Approval** means the runner pauses and waits for you before it executes a tool.

**JSON** means structured text that computers can read. It uses `{}`, `[]`, and lots of quotes.

**NDJSON** means "newline-delimited JSON." It is one JSON object per line, useful for streaming progress.

---

## What This Runner Can Do Now

The new runner can:

- list files
- read files
- search text
- check git status
- run bounded shell commands
- edit files by replacing exact text
- write files
- apply a patch
- pause for approval
- resume after approval
- stream progress as JSON lines
- save run transcripts locally

It is not full Claude Code yet. It is a headless runner that is moving toward `claude -p` style behavior.

---

## Step 1: Open Terminal

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

You should see a prompt that looks roughly like:

```text
alanman@Alans-Laptop ~ %
```

That is where you paste commands.

---

## Step 2: Check That The Bridge Is Running

Paste this into **Terminal**, then press `Return`:

```bash
# Ask the bridge for its debug/status page.
curl http://127.0.0.1:11437/v1/debug
```

Success looks like a block of JSON that includes:

```json
"status":"running"
```

If you see `Failed to connect`, the bridge is not running or it is on a different port.

Common fix:

1. Open VS Code.
2. Open this repo folder.
3. Open **View -> Output**.
4. Pick **Claude Local Bridge** from the Output dropdown.
5. Look for the actual port number.

If the bridge says it is running on `11440`, replace `11437` with `11440` in the commands below.

---

## Step 3: Start A Simple Agent Run

This starts a run that does not need tools.

Paste this into **Terminal**:

```bash
# -X POST means "send data to this endpoint."
# -H means "send this header." Here it says our data is JSON.
# -d means "this is the data we are sending."
curl -s -X POST http://127.0.0.1:11437/v1/agent/runs \
  -H "content-type: application/json" \
  -d '{"prompt":"Reply with exactly: hello from the runner"}'
```

Success looks like JSON with:

```json
"status":"completed"
```

and:

```json
"final_text":"hello from the runner"
```

The exact wording may vary unless your prompt says exactly what to reply with.

---

## Step 4: Ask The Runner To Use A Tool

By default, the runner is cautious. If the model asks to use a tool, the runner pauses.

Paste this into **Terminal**:

```bash
# This asks the model to inspect the current project.
# The cwd field means "working directory", which is the folder tools are allowed to use.
curl -s -X POST http://127.0.0.1:11437/v1/agent/runs \
  -H "content-type: application/json" \
  -d '{"prompt":"List the top-level files in this project.","cwd":"/Users/alanman/Library/Mobile Documents/com~apple~CloudDocs/Documents/GitHub/claude-local-bridge"}'
```

If the model asks for a tool, success looks like:

```json
"status":"awaiting_approval"
```

You will also see something like:

```json
"run_id":"..."
```

and:

```json
"pending_tool":{"tool_use_id":"...","name":"list_files"}
```

You need both IDs for the approval step:

- `run_id`
- `tool_use_id`

---

## Step 5: Approve A Tool

Use this command shape:

```bash
# Replace RUN_ID_HERE with the run_id from the previous response.
# Replace TOOL_USE_ID_HERE with the tool_use_id from the pending_tool.
curl -s -X POST http://127.0.0.1:11437/v1/agent/runs/RUN_ID_HERE/approve \
  -H "content-type: application/json" \
  -d '{"tool_use_id":"TOOL_USE_ID_HERE","decision":"allow"}'
```

Example with fake IDs:

```bash
curl -s -X POST http://127.0.0.1:11437/v1/agent/runs/abc-123/approve \
  -H "content-type: application/json" \
  -d '{"tool_use_id":"toolu_123","decision":"allow"}'
```

Do not use the fake IDs above. Use the real IDs from your own response.

After approval, the runner executes the tool, sends the result back to the model, and continues.

---

## Step 6: Deny A Tool

If a tool request looks wrong, deny it.

Use the same endpoint but change `"allow"` to `"deny"`:

```bash
curl -s -X POST http://127.0.0.1:11437/v1/agent/runs/RUN_ID_HERE/approve \
  -H "content-type: application/json" \
  -d '{"tool_use_id":"TOOL_USE_ID_HERE","decision":"deny"}'
```

The model receives a tool result saying the tool was denied. It can then answer without that tool or ask for a different one.

---

## Step 7: Let Safe Tools Run Automatically

If you already trust a specific tool, list it in `allowed_tools`.

This example lets the runner list files and read files without stopping to ask you:

```bash
curl -s -X POST http://127.0.0.1:11437/v1/agent/runs \
  -H "content-type: application/json" \
  -d '{"prompt":"Read README.md and summarize it in one sentence.","cwd":"/Users/alanman/Library/Mobile Documents/com~apple~CloudDocs/Documents/GitHub/claude-local-bridge","allowed_tools":["list_files","read_file"]}'
```

Important: `allowed_tools` is a power setting.

Start with read-only tools:

```json
["list_files", "read_file", "search_text", "git_status"]
```

Be more careful with tools that can change files:

```json
["edit_file", "write_file", "apply_patch", "bash"]
```

---

## Step 8: Understand Permission Modes

The runner supports three permission modes.

### `ask`

This is the default.

The runner pauses for any tool that is not in `allowed_tools`.

```json
"permission_mode":"ask"
```

### `dontAsk`

This means "only run tools listed in `allowed_tools`; deny everything else."

```json
"permission_mode":"dontAsk"
```

This is useful for scripts where you do not want the process to pause.

### `acceptEdits`

This means the runner may auto-run file inspection and file editing tools.

```json
"permission_mode":"acceptEdits"
```

Raw shell commands through `bash` still require explicit allowlisting.

That is intentional because shell commands are powerful.

---

## Step 9: Stream Progress Like `claude -p --output-format stream-json`

Use:

```json
"output_format":"stream-json"
```

Example:

```bash
# This prints one JSON event per line as the run progresses.
curl -N -X POST http://127.0.0.1:11437/v1/agent/runs \
  -H "content-type: application/json" \
  -d '{"prompt":"Say hello, then explain what a local bridge is in one sentence.","output_format":"stream-json"}'
```

You may see event types like:

```text
run_started
model_request
model_response
tool_use
approval_required
tool_result
completed
error
```

This is useful because scripts can read progress line by line.

---

## Step 10: Use Batch Approval

Sometimes the model asks for more than one tool at the same time.

The response may include:

```json
"pending_tools":[
  {"tool_use_id":"toolu_1","name":"read_file"},
  {"tool_use_id":"toolu_2","name":"git_status"}
]
```

You can approve or deny them together:

```bash
curl -s -X POST http://127.0.0.1:11437/v1/agent/runs/RUN_ID_HERE/approve \
  -H "content-type: application/json" \
  -d '{"decisions":[{"tool_use_id":"toolu_1","decision":"allow"},{"tool_use_id":"toolu_2","decision":"deny"}]}'
```

Each item needs:

- `tool_use_id`
- `decision`

The decision must be:

- `"allow"`
- or `"deny"`

---

## Safe Starter Recipes

### Read-only project summary

```bash
curl -s -X POST http://127.0.0.1:11437/v1/agent/runs \
  -H "content-type: application/json" \
  -d '{"prompt":"Summarize this project from README.md and package.json.","cwd":"/Users/alanman/Library/Mobile Documents/com~apple~CloudDocs/Documents/GitHub/claude-local-bridge","allowed_tools":["list_files","read_file","search_text","git_status"],"permission_mode":"dontAsk"}'
```

### Streaming read-only run

```bash
curl -N -X POST http://127.0.0.1:11437/v1/agent/runs \
  -H "content-type: application/json" \
  -d '{"prompt":"Find the agent runner files and explain what each one does.","cwd":"/Users/alanman/Library/Mobile Documents/com~apple~CloudDocs/Documents/GitHub/claude-local-bridge","allowed_tools":["list_files","read_file","search_text"],"permission_mode":"dontAsk","output_format":"stream-json"}'
```

### Controlled edit run

```bash
# This lets the model edit files, but only with the structured edit_file tool.
# It does not allow arbitrary shell commands.
curl -N -X POST http://127.0.0.1:11437/v1/agent/runs \
  -H "content-type: application/json" \
  -d '{"prompt":"Fix one typo in README.md if you find one. Otherwise explain that no typo was found.","cwd":"/Users/alanman/Library/Mobile Documents/com~apple~CloudDocs/Documents/GitHub/claude-local-bridge","allowed_tools":["read_file","search_text","edit_file"],"permission_mode":"ask","output_format":"stream-json"}'
```

---

## What To Do When Something Goes Wrong

### `Failed to connect`

The bridge is probably not running or the port is different.

Check VS Code:

1. Open **View -> Output**.
2. Pick **Claude Local Bridge**.
3. Look for the port number.

### `Unknown agent run`

The `run_id` is wrong or the bridge restarted and lost the in-memory active run.

Try starting a new run.

### `tool_use_id does not match a pending tool`

The approval command used the wrong `tool_use_id`.

Look at the previous response again and copy the exact `tool_use_id`.

### `Sensitive path is blocked`

The runner refused to read or write something like:

- `.env`
- private keys
- credential-looking JSON files
- `.ssh`
- `.aws`
- `.claude`

This is a safety feature.

### `Command timed out`

The `bash` tool ran too long.

Use a smaller command or increase `timeout_ms` up to the limit:

```json
"timeout_ms":30000
```

---

## Mental Model

Think of the runner like this:

```text
You send a prompt
  -> model thinks
    -> model may ask for tools
      -> runner checks permissions
        -> runner runs allowed tools
        -> runner pauses for unapproved tools
          -> you approve or deny
            -> model gets the tool result
              -> model continues
                -> final answer
```

The bridge still handles the hard authentication part. The runner handles the local agent loop.
