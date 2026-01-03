---
name: electron-playwright
description: Launch and interact with the Electron app using Playwright. Use when you need to see the app UI, take screenshots, click buttons, fill forms, or debug the app behavior. Supports persistent sessions for multi-step debugging.
allowed-tools: Bash, Read
---

# Electron Playwright Control

Control the Electron app via Playwright with persistent sessions for debugging.

## Session Workflow

**Start a session (runs in background):**
```bash
pnpm electron:run start &
```

**Interact with the running app:**
```bash
pnpm electron:run screenshot "step1"
pnpm electron:run run "await window.click('text=Open PDF')"
pnpm electron:run screenshot "step2"
pnpm electron:run run "return await window.locator('button').allTextContents()"
```

**Stop the session:**
```bash
pnpm electron:run stop
```

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start Electron app session (keeps running) |
| `stop` | Stop the running session |
| `status` | Check if session is running |
| `screenshot [name]` | Take screenshot of running app |
| `run <code>` | Run Playwright code against running app |

## The `run` Command

Execute any Playwright code with access to:
- `window` - Playwright Page object for the main window
- `app` - ElectronApplication for main process access
- `screenshot(name)` - Helper to save screenshots

### Examples

**Click a button:**
```bash
pnpm electron:run run "await window.click('text=Open PDF')"
```

**Get text content:**
```bash
pnpm electron:run run "return await window.textContent('h1')"
```

**Get all buttons:**
```bash
pnpm electron:run run "return await window.locator('button').allTextContents()"
```

**Fill an input:**
```bash
pnpm electron:run run "await window.fill('input[name=search]', 'hello')"
```

**Wait for element:**
```bash
pnpm electron:run run "await window.waitForSelector('.loaded')"
```

**Keyboard shortcut:**
```bash
pnpm electron:run run "await window.press('body', 'Control+o')"
```

**Take screenshot in code:**
```bash
pnpm electron:run run "await screenshot('before'); await window.click('button'); await screenshot('after')"
```

**Main process evaluation:**
```bash
pnpm electron:run run "return await app.evaluate(({app}) => app.getVersion())"
```

## Screenshots

Screenshots are saved to `.devkit/screenshots/<name>.png`.

To view a screenshot, use the Read tool on the PNG file path.

## Debugging Workflow

1. Start session: `pnpm electron:run start &`
2. Take initial screenshot: `pnpm electron:run screenshot "initial"`
3. View screenshot with Read tool
4. Run interactions: `pnpm electron:run run "..."`
5. Take more screenshots to verify
6. Repeat steps 3-5 as needed
7. Stop when done: `pnpm electron:run stop`

## Prerequisites

Build Electron code first:
```bash
pnpm run build:electron
```
