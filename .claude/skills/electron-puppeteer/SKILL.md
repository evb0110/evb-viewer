---
name: electron-puppeteer
description: Launch and interact with the Electron app using Puppeteer CDP. Use when you need to see the app UI, take screenshots, click buttons, fill forms, read console, or debug the app. Supports persistent sessions for multi-step debugging workflows. Multiple named sessions can run concurrently. Triggers: 'launch the app', 'open the app', 'start the app', 'run the app', 'show me the app', 'take a screenshot', 'screenshot the app', 'what does the app look like', 'check the UI', 'test the app', 'debug the app', 'open a PDF', 'click the button', 'verify the UI', 'see what happened', 'look at the app', 'inspect the app'.
allowed-tools: Bash, Read
---

# Electron Puppeteer Control

Control the Electron app via Puppeteer CDP with persistent sessions.

> **Note**: Uses Puppeteer instead of Playwright due to compatibility issues with Electron 39.
>
> Client commands like `health` and `screenshot` will wait briefly for the session to become ready (instead of immediately erroring) when `start` is still spinning up.
>
> For non-interactive/automation usage, prefer `startd` (detached background start).

## Quick Start

```bash
# 1. Start session in background
pnpm electron:run startd

# 2. Wait for "Session ready" message, then interact
pnpm electron:run screenshot "initial"
pnpm electron:run health  # Verify openFileDirect: "function"

# 3. Stop when done
pnpm electron:run stop
```

## Multi-Session Support

Multiple sessions can run concurrently using `--session <name>` (or `-s <name>`). Each session gets its own Electron instance, CDP port, and HTTP command server. The Nuxt dev server is shared.

```bash
# Session A (e.g., agent 1)
pnpm electron:run -s a startd
pnpm electron:run -s a screenshot "test1"
pnpm electron:run -s a openPdf "/path/to/doc.pdf"

# Session B (e.g., agent 2) — runs in parallel, no conflicts
pnpm electron:run -s b startd
pnpm electron:run -s b screenshot "test2"
pnpm electron:run -s b openPdf "/path/to/other.pdf"

# List all sessions
pnpm electron:run list

# Stop individual or all
pnpm electron:run -s a stop
pnpm electron:run stop --all
```

Without `--session`, the default session name is `"default"`.

The `start` command automatically:
- Starts the shared Nuxt dev server if not already running (skips restart if other sessions are active)
- Uses a fresh Electron profile per session
- Allocates free ports dynamically (no fixed ports to conflict)
- Waits for Vue to hydrate (auto-reloads if needed)

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start session (clears cache, fresh Nuxt, waits for hydration) |
| `startd` | Start session in background and return when ready |
| `cleanstart` | Alias for `start` |
| `stop` | Stop running session (add `--all` to stop every session) |
| `restart` | Stop and cleanstart (for recovery) |
| `status` | Check session health (shows connection status) |
| `list` | List all sessions and their status |
| `health` | Check app health (verify `openFileDirect: "function"`) |
| `screenshot [name]` | Take screenshot → `.devkit/sessions/<session>/screenshots/<name>.png` |
| `console [level]` | Get console messages (all\|log\|warn\|error) |
| `run <code>` | Run Puppeteer code (supports `sleep(ms)`/`wait(ms)`) |
| `run-file <path>` | Run Puppeteer code from a JS file |
| `eval <code>` | Evaluate JS in renderer process |
| `click <selector>` | Click element |
| `type <sel> <text>` | Type into element |
| `content <selector>` | Get text content |
| `openPdf <path>` | Open PDF by absolute path (waits for load) |

## What `start` Does Automatically

1. **Checks for other sessions** - If other sessions are running, skips Nuxt restart
2. **Starts Nuxt if needed** - Kills and rebuilds only when safe to do so
3. **Clears Vite cache** - Removes `node_modules/.vite` and `.nuxt` (only when no other sessions running)
4. **Allocates free ports** - Each session gets unique CDP and HTTP ports
5. **Starts Electron with a clean profile** - Per-session `.devkit/sessions/<name>/electron-user-data`
6. **Waits for Vue hydration** - Checks for `#__nuxt` children
7. **Auto-reloads if needed** - Fixes timing issues on cold starts

## Reliability Features

The session automatically handles:

- **Electron crash** → Session auto-cleans up, status shows "No session running"
- **CDP disconnection** → Session detects and shuts down cleanly
- **504 Outdated Dep errors** → Fixed by clearing Vite cache (cleanstart)
- **Vue not hydrating** → Auto-reloads page if needed
- **Hung client commands** → Per-command request timeout with clear timeout error
- **`openPdf` hangs** → Non-blocking trigger + readiness polling with explicit failure reason
- **`openPdf` false-positive success** → Command now validates the loaded file name matches the requested path
- **Long `run`/`eval` snippets** → Extended command execution timeout to reduce false failures
- **Multi-session safety** → Stopping one session leaves others (and shared Nuxt) intact

## Verifying the Session is Working

After `cleanstart`, check that the app loaded properly:

```bash
pnpm electron:run health
# Or for a named session:
pnpm electron:run -s mytest health
```

**Good output** (app ready):
```json
{
  "health": {
    "openFileDirect": "function",
    "electronAPI": "object"
  }
}
```

**Bad output** (app not loaded):
```json
{
  "health": {
    "openFileDirect": "undefined",
  }
}
```

If you see `"undefined"`, run:
```bash
pnpm electron:run restart
```

## The `run` Command

Execute Puppeteer code with access to:
- `page` - Puppeteer Page object
- `screenshot(name)` - Take named screenshot
- `sleep(ms)` / `wait(ms)` - delay helper

### Examples

```bash
# Click elements
pnpm electron:run run "await page.click('button')"

# Get content
pnpm electron:run run "return await page.evaluate(() => document.title)"

# Fill inputs
pnpm electron:run run "await page.type('input', 'hello')"

# Wait for elements
pnpm electron:run run "await page.waitForSelector('.loaded')"

# Delay safely (do not rely on page.waitForTimeout)
pnpm electron:run run "await sleep(500); return 'ok'"

# Screenshots in code
pnpm electron:run run "await screenshot('before'); await page.click('button'); await screenshot('after')"

# Use a file for long scripts to avoid shell escaping issues
pnpm electron:run run-file "/tmp/flow.js"
```

`run-file` expects plain JavaScript code (same as `run` snippet body).

## Opening PDFs

```bash
pnpm electron:run openPdf "/absolute/path/to/document.pdf"
```

## Screenshots

Screenshots saved to `.devkit/sessions/<session>/screenshots/<name>.png`

View with the Read tool:
```bash
Read .devkit/sessions/default/screenshots/initial.png
```

## Session Files

Each session stores its state under `.devkit/sessions/<name>/`:
- `session.json` — port, PID, and connection info
- `session.log` — log output for detached sessions
- `electron-user-data/` — isolated Electron profile
- `screenshots/` — screenshots for this session

## Troubleshooting

| Problem | Solution |
|---------|----------|
| White/blank screen | Use `cleanstart` (not `start`) |
| 504 Outdated Optimize Dep | Use `cleanstart` to clear cache |
| `openFileDirect: "undefined"` | Run `restart` |
| Session says running but fails | Run `restart` |
| Status shows "DISCONNECTED" | Run `restart` |
| `openPdf` says timeout with `(loaded: <path>)` | Current doc likely wasn't switched (often unsaved changes); save/close current doc first, then retry |
| Complex `run` snippet fails from shell escaping | Put code in a file and use `run-file` |
| Port conflict | Sessions auto-allocate free ports, so this shouldn't happen. Use `list` to check |

**Nuclear option** (if all else fails):
```bash
pnpm electron:run stop --all
pkill -f "node.*nuxt"
pkill -f "Electron"
rm -rf .nuxt node_modules/.vite .devkit/sessions
pnpm electron:run cleanstart &
```

## Prerequisites

Build Electron code first:
```bash
pnpm run build:electron
```
