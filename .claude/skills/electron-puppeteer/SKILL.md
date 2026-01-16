---
name: electron-playwright
description: Launch and interact with the Electron app using Puppeteer CDP. Use when you need to see the app UI, take screenshots, click buttons, fill forms, read console, or debug the app. Supports persistent sessions for multi-step debugging workflows.
allowed-tools: Bash, Read
---

# Electron Puppeteer Control

Control the Electron app via Puppeteer CDP with persistent sessions - like Playwright MCP but for Electron.

> **Note**: Uses Puppeteer instead of Playwright due to compatibility issues with Electron 39.

## Quick Start

**1. Start session (recommended: use cleanstart for reliability):**
```bash
pnpm electron:run cleanstart &
```
Wait for "Session ready" message, then interact.

**2. Interact with the app:**
```bash
pnpm electron:run screenshot "initial"
pnpm electron:run run "await page.click('button')"
pnpm electron:run run "return await page.evaluate(() => document.title)"
```

**3. Stop when done:**
```bash
pnpm electron:run stop
```

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start session (reuses existing Nuxt if running) |
| `cleanstart` | Start with fresh Nuxt server (recommended - avoids stale cache) |
| `stop` | Stop running session |
| `restart` | Stop and restart with fresh Nuxt (for recovery) |
| `status` | Check session status and Electron connection health |
| `health` | Check app health (loaded, API availability, console logs) |
| `screenshot [name]` | Take screenshot -> `.devkit/screenshots/<name>.png` |
| `console [level]` | Get console messages (all\|log\|warn\|error) |
| `run <code>` | Run Puppeteer code |
| `eval <code>` | Evaluate JS in renderer process |
| `click <selector>` | Click element |
| `type <sel> <text>` | Type into element |
| `content <selector>` | Get text content |
| `openPdf <path>` | Open PDF by absolute path (waits for load) |

## Reliability Features

The session automatically handles common failure scenarios:

1. **Electron crash detection** - If Electron dies, the session auto-cleans up
2. **Puppeteer disconnection** - If CDP connection is lost, session shuts down
3. **Status health check** - The `status` command verifies Electron is actually connected
4. **Clean restart** - Use `restart` or `cleanstart` to recover from any broken state

### Troubleshooting

**White/blank screen or 504 errors?**
- Use `pnpm electron:run cleanstart` instead of `start`
- This kills any stale Nuxt server and starts fresh

**Session says "running" but commands fail?**
- Use `pnpm electron:run restart` to recover
- Or stop and cleanstart: `pnpm electron:run stop && pnpm electron:run cleanstart &`

**Status shows "Electron DISCONNECTED"?**
- The session detected a broken connection
- Use `pnpm electron:run restart` to recover

## The `run` Command

Execute any Puppeteer code with access to:
- `page` - Puppeteer Page object (the app window)
- `screenshot(name)` - Take named screenshot, returns filepath

### Examples

**Click elements:**
```bash
pnpm electron:run run "await page.click('button')"
pnpm electron:run run "await page.click('[data-testid=\"open-pdf\"]')"
```

**Get content:**
```bash
pnpm electron:run run "return await page.evaluate(() => document.querySelector('h1')?.textContent)"
pnpm electron:run run "return await page.evaluate(() => [...document.querySelectorAll('button')].map(b => b.textContent))"
```

**Fill inputs:**
```bash
pnpm electron:run run "await page.type('input[name=search]', 'hello')"
pnpm electron:run run "await page.type('#email', 'test@example.com')"
```

**Keyboard:**
```bash
pnpm electron:run run "await page.keyboard.press('Control+o')"
pnpm electron:run run "await page.keyboard.type('Hello world')"
```

**Wait for elements:**
```bash
pnpm electron:run run "await page.waitForSelector('.loaded')"
pnpm electron:run run "await new Promise(r => setTimeout(r, 1000))"
```

**Screenshots in code:**
```bash
pnpm electron:run run "await screenshot('before'); await page.click('button'); await screenshot('after')"
```

**Evaluate in page context:**
```bash
pnpm electron:run eval "document.querySelector('button').click()"
pnpm electron:run eval "window.electronAPI"
```

## Opening PDFs Programmatically

Use the `openPdf` command to load a PDF file by absolute path:

```bash
pnpm electron:run openPdf "/absolute/path/to/document.pdf"
```

The command:
1. Validates the file exists and is a PDF
2. Calls `window.__openFileDirect()` to load it
3. Waits for the PDF viewer to render (30s timeout)
4. Returns when the PDF is fully loaded

**Complete example workflow:**
```bash
# Start session (use cleanstart for reliability)
pnpm electron:run cleanstart &
sleep 2

# Open a PDF
pnpm electron:run openPdf "/Users/evb/WebstormProjects/electron-nuxt/.devkit/test-pdfs/dictionary.pdf"

# Take screenshot to verify
pnpm electron:run screenshot "pdf-loaded"

# You can now interact with the loaded PDF
pnpm electron:run run "return await page.evaluate(() => document.querySelector('[id=\"pdf-viewer\"]') ? 'PDF loaded' : 'PDF not found')"

# Stop when done
pnpm electron:run stop
```

## Console Messages

Console logs are captured automatically and printed in real-time when the session starts. Health check messages (prefixed with `[HEALTH CHECK]`) appear immediately after app hydration.

Read stored browser console output:
```bash
pnpm electron:run console          # All messages
pnpm electron:run console error    # Only errors
pnpm electron:run console warn     # Only warnings
```

Check app health and console status:
```bash
pnpm electron:run health           # Returns app state and console message count
```

This returns:
- `bodyExists` - Document body loaded
- `openFileDirect` - PDF opening function availability (should be "function")
- `electronAPI` - Electron bridge availability
- `title` - Page title
- `url` - Current page URL
- `consoleCount` - Total messages captured

## Screenshots

Screenshots saved to `.devkit/screenshots/<name>.png` (gitignored).

View with the Read tool:
```bash
# After taking screenshot
Read .devkit/screenshots/initial.png
```

## Recommended Workflow

1. **Start fresh session**: `pnpm electron:run cleanstart &`
2. Wait for "Session ready" and health check messages
3. Verify health: `pnpm electron:run health` (check `openFileDirect: "function"`)
4. Take screenshot: `pnpm electron:run screenshot "step1"`
5. View screenshot with Read tool
6. Interact: `pnpm electron:run run "await page.click('...')"`
7. Take more screenshots to verify
8. Check console: `pnpm electron:run console error`
9. Repeat as needed
10. Stop: `pnpm electron:run stop`

## Prerequisites

Build Electron code first:
```bash
pnpm run build:electron
```

The session will auto-start Nuxt dev server if not running.

## When Things Go Wrong

If you encounter issues:

1. **First try**: `pnpm electron:run restart`
2. **If that fails**: Stop and cleanstart
   ```bash
   pnpm electron:run stop
   pnpm run clean:cache  # Clear Vite cache if needed
   pnpm electron:run cleanstart &
   ```
3. **Check status**: `pnpm electron:run status` - shows connection health
4. **Check health**: `pnpm electron:run health` - verify app loaded properly
