---
name: electron-playwright
description: Launch and interact with the Electron app using Puppeteer CDP. Use when you need to see the app UI, take screenshots, click buttons, fill forms, read console, or debug the app. Supports persistent sessions for multi-step debugging workflows.
allowed-tools: Bash, Read
---

# Electron Puppeteer Control

Control the Electron app via Puppeteer CDP with persistent sessions - like Playwright MCP but for Electron.

> **Note**: Uses Puppeteer instead of Playwright due to compatibility issues with Electron 39.

## Quick Start

**1. Start session (in background):**
```bash
pnpm electron:run start &
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
| `start` | Start session (foreground, Ctrl+C to stop) |
| `stop` | Stop running session |
| `status` | Check session status and uptime |
| `screenshot [name]` | Take screenshot → `.devkit/screenshots/<name>.png` |
| `console [level]` | Get console messages (all\|log\|warn\|error) |
| `run <code>` | Run Puppeteer code |
| `eval <code>` | Evaluate JS in renderer process |
| `click <selector>` | Click element |
| `type <sel> <text>` | Type into element |
| `content <selector>` | Get text content |
| `openPdf <path>` | Open PDF by absolute path (waits for load) |

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
# Start session
pnpm electron:run start &
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

Read browser console output:
```bash
pnpm electron:run console          # All messages
pnpm electron:run console error    # Only errors
pnpm electron:run console warn     # Only warnings
```

## Screenshots

Screenshots saved to `.devkit/screenshots/<name>.png` (gitignored).

View with the Read tool:
```bash
# After taking screenshot
Read .devkit/screenshots/initial.png
```

## Debugging Workflow

1. Start session: `pnpm electron:run start &`
2. Wait for "Session ready" message
3. Take screenshot: `pnpm electron:run screenshot "step1"`
4. View screenshot with Read tool
5. Interact: `pnpm electron:run run "await page.click('...')"`
6. Take more screenshots to verify
7. Check console: `pnpm electron:run console error`
8. Repeat as needed
9. Stop: `pnpm electron:run stop`

## Prerequisites

Build Electron code first:
```bash
pnpm run build:electron
```

The session will auto-start Nuxt dev server if not running.
