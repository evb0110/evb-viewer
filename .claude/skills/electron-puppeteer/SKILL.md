---
name: electron-puppeteer
description: Launch and interact with the Electron app using Puppeteer CDP. Use when you need to see the app UI, take screenshots, click buttons, fill forms, read console, or debug the app. Supports persistent sessions for multi-step debugging workflows. Triggers: 'launch the app', 'open the app', 'start the app', 'run the app', 'show me the app', 'take a screenshot', 'screenshot the app', 'what does the app look like', 'check the UI', 'test the app', 'debug the app', 'open a PDF', 'click the button', 'verify the UI', 'see what happened', 'look at the app', 'inspect the app', 'check in the app'.
allowed-tools: Bash, Read
---

# Electron Puppeteer Control

Control the Electron app via Puppeteer CDP with persistent sessions.

> **Note**: Uses Puppeteer instead of Playwright due to compatibility issues with Electron 39.
>
> Client commands like `health` and `screenshot` will wait briefly for the session to become ready (instead of immediately erroring) when `start` is still spinning up.

## Quick Start

```bash
# 1. Start session
pnpm electron:run start &

# 2. Wait for "Session ready" message, then interact
pnpm electron:run screenshot "initial"
pnpm electron:run health  # Verify openFileDirect: "function"

# 3. Stop when done
pnpm electron:run stop
```

The `start` command automatically:
- Kills any existing Nuxt server
- Clears Vite cache (fixes 504 Outdated Optimize Dep errors)
- Uses a fresh Electron profile (disables HTTP cache)
- Waits for Vue to hydrate (auto-reloads if needed)

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start session (clears cache, fresh Nuxt, waits for hydration) |
| `cleanstart` | Alias for `start` |
| `stop` | Stop running session |
| `restart` | Stop and cleanstart (for recovery) |
| `status` | Check session health (shows connection status) |
| `health` | Check app health (verify `openFileDirect: "function"`) |
| `screenshot [name]` | Take screenshot → `.devkit/screenshots/<name>.png` |
| `console [level]` | Get console messages (all\|log\|warn\|error) |
| `run <code>` | Run Puppeteer code |
| `eval <code>` | Evaluate JS in renderer process |
| `click <selector>` | Click element |
| `type <sel> <text>` | Type into element |
| `content <selector>` | Get text content |
| `openPdf <path>` | Open PDF by absolute path (waits for load) |

## What `start` Does Automatically

1. **Kills existing Nuxt** - Prevents stale server reuse
2. **Clears Vite cache** - Removes `node_modules/.vite` and `.nuxt`
   - Also clears `node_modules/.cache/vite` (Vite 7+ default)
3. **Starts fresh Nuxt** - Rebuilds all dependencies
4. **Starts Electron with a clean profile** - Clears `.devkit/electron-user-data`
5. **Waits for Vue hydration** - Checks for `#__nuxt` children
6. **Auto-reloads if needed** - Fixes timing issues on cold starts

## Reliability Features

The session automatically handles:

- **Electron crash** → Session auto-cleans up, status shows "No session running"
- **CDP disconnection** → Session detects and shuts down cleanly
- **504 Outdated Dep errors** → Fixed by clearing Vite cache (cleanstart)
- **Vue not hydrating** → Auto-reloads page if needed
- **Hung client commands** → Per-command request timeout with clear timeout error
- **`openPdf` hangs** → Non-blocking trigger + readiness polling with explicit failure reason
- **Long `run`/`eval` snippets** → Extended command execution timeout to reduce false failures

## Verifying the Session is Working

After `cleanstart`, check that the app loaded properly:

```bash
pnpm electron:run health
```

**Good output** (app ready):
```json
{
  "health": {
    "openFileDirect": "function",  // ✓ Must be "function"
    "electronAPI": "object"
  }
}
```

**Bad output** (app not loaded):
```json
{
  "health": {
    "openFileDirect": "undefined",  // ✗ Problem - use restart
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

# Screenshots in code
pnpm electron:run run "await screenshot('before'); await page.click('button'); await screenshot('after')"
```

## Opening PDFs

```bash
pnpm electron:run openPdf "/absolute/path/to/document.pdf"
```

## Screenshots

Screenshots saved to `.devkit/screenshots/<name>.png`

View with the Read tool:
```bash
Read .devkit/screenshots/initial.png
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| White/blank screen | Use `cleanstart` (not `start`) |
| 504 Outdated Optimize Dep | Use `cleanstart` to clear cache |
| `openFileDirect: "undefined"` | Run `restart` |
| Session says running but fails | Run `restart` |
| Status shows "DISCONNECTED" | Run `restart` |

**Nuclear option** (if all else fails):
```bash
pnpm electron:run stop
pkill -f "node.*nuxt"
pkill -f "Electron"
rm -rf .nuxt node_modules/.vite
pnpm electron:run cleanstart &
```

## Prerequisites

Build Electron code first:
```bash
pnpm run build:electron
```
