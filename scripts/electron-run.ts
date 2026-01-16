/**
 * Electron Puppeteer Control - Persistent Session Server
 *
 * Uses Puppeteer CDP connection (Playwright has compatibility issues with Electron 39)
 *
 * Usage:
 *   pnpm electron:run start    - Start session (foreground, Ctrl+C to stop)
 *   pnpm electron:run stop     - Stop running session
 *   pnpm electron:run status   - Check session status
 *   pnpm electron:run run <code>       - Execute Puppeteer code
 *   pnpm electron:run screenshot [name] - Take screenshot
 */

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { delay } from 'es-toolkit/promise';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const screenshotDir = join(projectRoot, '.devkit', 'screenshots');
const sessionFile = join(projectRoot, '.devkit', 'electron-session.json');
const SERVER_PORT = 9847;
const CDP_PORT = 9222;
const NUXT_PORT = 3235;

// ============ Session State ============

interface ISessionState {
    browser: Browser;
    page: Page;
    electronProcess: ChildProcess;
    nuxtProcess: ChildProcess | null;
    consoleMessages: Array<{ type: string; text: string; timestamp: number }>;
}

let sessionState: ISessionState | null = null;

// ============ Nuxt Server Management ============

async function isNuxtRunning(): Promise<boolean> {
    try {
        const res = await fetch(`http://localhost:${NUXT_PORT}`, { method: 'HEAD' });
        return res.ok;
    } catch {
        return false;
    }
}

async function killExistingNuxt(): Promise<void> {
    try {
        const { execSync } = await import('node:child_process');
        execSync(`lsof -ti :${NUXT_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
        await delay(500);
    } catch {}
}

async function startNuxtServer(forceClean = false): Promise<ChildProcess | null> {
    if (forceClean) {
        console.log('[Nuxt] Force clean start - killing existing server...');
        await killExistingNuxt();
    } else if (await isNuxtRunning()) {
        console.log('[Nuxt] Server already running on port', NUXT_PORT);
        return null;
    }

    console.log('[Nuxt] Starting dev server...');
    const nuxt = spawn('pnpm', ['run', 'dev:nuxt'], {
        cwd: projectRoot,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    nuxt.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (text.includes('Local:') || text.includes('Listening')) {
            console.log('[Nuxt] Server ready');
        }
    });

    // Wait for server
    const timeout = 120_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await isNuxtRunning()) {
            console.log('[Nuxt] Server ready at http://localhost:' + NUXT_PORT);
            return nuxt;
        }
        await delay(1000);
    }

    nuxt.kill();
    throw new Error('Nuxt server failed to start');
}

// ============ Electron Management ============

async function startElectron(): Promise<ChildProcess> {
    const mainJs = join(projectRoot, 'dist-electron', 'main.js');
    if (!existsSync(mainJs)) {
        throw new Error('dist-electron/main.js not found. Run `pnpm run build:electron` first.');
    }

    console.log('[Electron] Starting with CDP on port', CDP_PORT);

    const electronPath = join(projectRoot, 'node_modules/.bin/electron');
    const electron = spawn(electronPath, [
        `--remote-debugging-port=${CDP_PORT}`,
        mainJs,
    ], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    electron.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (text.includes('DevTools listening')) {
            console.log('[Electron] CDP ready');
        }
    });

    // Wait for CDP to be available
    const timeout = 30_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const res = await fetch(`http://localhost:${CDP_PORT}/json/version`);
            if (res.ok) {
                console.log('[Electron] App started');
                return electron;
            }
        } catch {}
        await delay(500);
    }

    electron.kill();
    throw new Error('Electron failed to start CDP');
}

async function connectToBrowser(): Promise<{ browser: Browser; page: Page }> {
    console.log('[Puppeteer] Connecting via CDP...');

    const browser = await puppeteer.connect({
        browserURL: `http://localhost:${CDP_PORT}`,
        defaultViewport: null, // Don't override Electron window's natural viewport
    });

    // Wait for the app page
    let page: Page | null = null;
    for (let i = 0; i < 30; i++) {
        const pages = await browser.pages();
        page = pages.find(p => p.url().includes(`localhost:${NUXT_PORT}`)) ?? null;
        if (page) break;
        await delay(500);
    }

    if (!page) {
        throw new Error('Could not find app page');
    }

    // Wait for page to fully load
    await page.waitForSelector('body', { timeout: 30000 });
    await delay(2000); // Let Vue hydrate

    console.log('[Puppeteer] Connected to app');
    return { browser, page };
}

// ============ Session Server ============

async function startSession(forceClean = false) {
    if (await isSessionRunning()) {
        console.log('Session already running. Use `pnpm electron:run stop` to stop it.');
        process.exit(0);
    }

    console.log('Starting Electron Puppeteer session...\n');

    // Ensure Nuxt is running (force clean if requested)
    const nuxtProcess = await startNuxtServer(forceClean);

    // Start Electron with CDP
    const electronProcess = await startElectron();

    // Connect via Puppeteer
    const { browser, page } = await connectToBrowser();

    // Setup console capture
    const consoleMessages: ISessionState['consoleMessages'] = [];
    page.on('console', (msg) => {
        const entry = {
            type: msg.type(),
            text: msg.text(),
            timestamp: Date.now(),
        };
        consoleMessages.push(entry);
        // Log immediately to console for visibility
        const timestamp = new Date(entry.timestamp).toISOString().split('T')[1];
        console.log(`[${entry.type.toUpperCase()}] ${entry.text}`);
        if (consoleMessages.length > 100) consoleMessages.shift();
    });

    // Capture page errors (uncaught exceptions, failed modules, etc)
    page.on('error', (err) => {
        const entry = {
            type: 'error',
            text: `[PAGE ERROR] ${err.message}`,
            timestamp: Date.now(),
        };
        consoleMessages.push(entry);
        console.log(`[ERROR] ${err.message}`);
        if (consoleMessages.length > 100) consoleMessages.shift();
    });

    // Capture page crashes
    page.on('pageerror', (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const entry = {
            type: 'error',
            text: `[PAGE CRASH] ${message}`,
            timestamp: Date.now(),
        };
        consoleMessages.push(entry);
        console.log(`[ERROR] ${message}`);
        if (consoleMessages.length > 100) consoleMessages.shift();
    });

    sessionState = { browser, page, electronProcess, nuxtProcess, consoleMessages };

    // Shutdown state
    let isShuttingDown = false;
    let httpServer: ReturnType<typeof createServer> | null = null;

    // Cleanup function - must be defined before event handlers
    const cleanupAndExit = async (exitCode: number) => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        console.log('\nShutting down...');
        try { unlinkSync(sessionFile); } catch {}
        httpServer?.close();

        // Disconnect Puppeteer (suppress errors since browser may already be gone)
        await sessionState?.browser.disconnect().catch(() => {});

        // Kill processes (they may already be dead)
        try { sessionState?.electronProcess.kill(); } catch {}
        try { sessionState?.nuxtProcess?.kill(); } catch {}

        process.exit(exitCode);
    };

    // Monitor Electron process exit
    electronProcess.on('exit', (code, signal) => {
        console.log(`\n[Electron] Process exited (code: ${code}, signal: ${signal})`);
        console.log('[Session] Electron died - shutting down session...');
        cleanupAndExit(1);
    });

    // Monitor Puppeteer disconnection
    browser.on('disconnected', () => {
        console.log('\n[Puppeteer] Browser disconnected');
        console.log('[Session] Lost connection to Electron - shutting down session...');
        cleanupAndExit(1);
    });

    // HTTP server for commands
    const server = createServer(async (req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end('Method not allowed');
            return;
        }

        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', async () => {
            try {
                const { command, args } = JSON.parse(body);
                const result = await handleCommand(command, args);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, result }));
            } catch (error) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                }));
            }
        });
    });

    httpServer = server;

    server.listen(SERVER_PORT, () => {
        mkdirSync(join(projectRoot, '.devkit'), { recursive: true });
        writeFileSync(sessionFile, JSON.stringify({ port: SERVER_PORT, pid: process.pid }));

        console.log(`\n✓ Session ready on port ${SERVER_PORT}`);
        console.log('  Press Ctrl+C to stop\n');
    });

    process.on('SIGINT', () => cleanupAndExit(0));
    process.on('SIGTERM', () => cleanupAndExit(0));

    await new Promise(() => {});
}

// ============ Command Handlers ============

async function handleCommand(command: string, args: unknown[]): Promise<unknown> {
    if (!sessionState) throw new Error('Session not initialized');

    const { page, consoleMessages } = sessionState;

    switch (command) {
        case 'ping':
            return { status: 'ok', uptime: process.uptime() };

        case 'screenshot': {
            const name = (args[0] as string) ?? `screenshot-${Date.now()}`;
            mkdirSync(screenshotDir, { recursive: true });
            const filepath = join(screenshotDir, `${name}.png`);
            await page.screenshot({ path: filepath });
            return { screenshot: filepath };
        }

        case 'console': {
            const level = (args[0] as string) ?? 'all';
            const filtered = level === 'all'
                ? consoleMessages
                : consoleMessages.filter((m) => m.type === level);
            return { messages: filtered.slice(-50) };
        }

        case 'run': {
            const code = args[0] as string;
            if (!code) throw new Error('No code provided');

            const screenshotFn = async (name: string) => {
                mkdirSync(screenshotDir, { recursive: true });
                const filepath = join(screenshotDir, `${name}.png`);
                await page.screenshot({ path: filepath });
                return filepath;
            };

            const asyncFn = new Function(
                'page', 'screenshot',
                `return (async () => { ${code} })()`,
            );

            return await asyncFn(page, screenshotFn);
        }

        case 'eval': {
            const code = args[0] as string;
            if (!code) throw new Error('No code provided');
            return await page.evaluate(code);
        }

        case 'click': {
            const selector = args[0] as string;
            if (!selector) throw new Error('No selector provided');
            await page.click(selector);
            return { clicked: selector };
        }

        case 'type': {
            const [selector, text] = args as [string, string];
            if (!selector || !text) throw new Error('Selector and text required');
            await page.type(selector, text);
            return { typed: text, into: selector };
        }

        case 'content': {
            const selector = args[0] as string;
            if (!selector) throw new Error('No selector provided');
            const el = await page.$(selector);
            if (!el) return null;
            return await el.evaluate((e) => e.textContent);
        }

        case 'resize': {
            const [width, height] = args as [number, number];
            if (!width || !height) throw new Error('Width and height required');
            await page.setViewport({ width, height });
            return { resized: { width, height } };
        }

        case 'viewport': {
            const viewport = page.viewport();
            return { viewport };
        }

        case 'openPdf': {
            const pdfPath = args[0] as string;
            if (!pdfPath) throw new Error('PDF path required');
            await page.evaluate((path: string) => {
                return (window as any).__openFileDirect(path);
            }, pdfPath);
            // Wait for PDF to load (check for pdf-viewer element and no loading state)
            await page.waitForSelector('[id="pdf-viewer"]', { timeout: 30000 });
            // Give it a moment to finish rendering
            await new Promise(r => setTimeout(r, 500));
            return { opened: pdfPath };
        }

        case 'health': {
            const health = await page.evaluate(() => {
                return {
                    bodyExists: document.body !== null,
                    openFileDirect: typeof (window as any).__openFileDirect,
                    electronAPI: typeof (window as any).electronAPI,
                    title: document.title,
                    url: window.location.href,
                };
            });
            return { health, consoleCount: consoleMessages.length };
        }

        default:
            throw new Error(`Unknown command: ${command}`);
    }
}

// ============ Client Commands ============

interface ISessionInfo {
    port: number;
    pid: number;
}

function getSessionInfo(): ISessionInfo | null {
    try {
        return JSON.parse(readFileSync(sessionFile, 'utf8'));
    } catch {
        return null;
    }
}

async function isSessionRunning(): Promise<boolean> {
    const info = getSessionInfo();
    if (!info) return false;

    try {
        const res = await fetch(`http://localhost:${info.port}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'ping', args: [] }),
        });
        return res.ok;
    } catch {
        try { unlinkSync(sessionFile); } catch {}
        return false;
    }
}

async function sendCommand(command: string, args: unknown[] = []): Promise<unknown> {
    const info = getSessionInfo();
    if (!info) {
        throw new Error('No session running. Start with: pnpm electron:run start');
    }

    const res = await fetch(`http://localhost:${info.port}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, args }),
    });

    const data = (await res.json()) as { success: boolean; result?: unknown; error?: string };
    if (!data.success) throw new Error(data.error ?? 'Unknown error');
    return data.result;
}

async function stopSession() {
    const info = getSessionInfo();
    if (!info) {
        console.log('No session running.');
        return;
    }

    try {
        process.kill(info.pid, 'SIGTERM');
        console.log('Session stopped.');
    } catch {
        console.log('Session was not running.');
    }
    try { unlinkSync(sessionFile); } catch {}
}

// ============ Utilities ============

// ============ CLI ============

async function main() {
    const [, , command, ...args] = process.argv;

    if (!command) {
        console.log(`
Electron Puppeteer Control - Persistent Session

Usage:
  pnpm electron:run <command> [args...]

Session:
  start               Start session (foreground, Ctrl+C to stop)
  cleanstart          Start with fresh Nuxt server (clears stale cache)
  stop                Stop running session
  status              Check session status and Electron connection health
  restart             Stop and restart the session (useful for recovery)

Commands (require running session):
  health              Check app health status (loaded, API availability)
  screenshot [name]   Take screenshot → .devkit/screenshots/<name>.png
  console [level]     Get console messages (all|log|warn|error)
  run <code>          Run Puppeteer code (access: page, screenshot)
  eval <code>         Evaluate JS in page
  click <selector>    Click element
  type <sel> <text>   Type into element
  content <selector>  Get text content
  openPdf <path>      Open PDF file by absolute path

Examples:
  pnpm electron:run start
  pnpm electron:run screenshot "home"
  pnpm electron:run openPdf "/path/to/document.pdf"
  pnpm electron:run click "text=Open PDF"
  pnpm electron:run run "await page.click('button'); return await page.title()"
  pnpm electron:run console error
  pnpm electron:run stop
`);
        process.exit(0);
    }

    try {
        switch (command) {
            case 'start':
                await startSession();
                break;

            case 'cleanstart':
                console.log('Starting fresh session (killing existing Nuxt)...');
                await startSession(true);
                break;

            case 'stop':
                await stopSession();
                break;

            case 'status': {
                const info = getSessionInfo();
                if (!info) {
                    console.log('No session running.');
                    break;
                }
                try {
                    // Try ping first to see if server is up
                    const pingResult = await sendCommand('ping') as { uptime: number };
                    // Then verify Electron connection is alive with health check
                    try {
                        await sendCommand('health');
                        console.log(`Session running (uptime: ${Math.round(pingResult.uptime)}s) - Electron connected ✓`);
                    } catch {
                        console.log(`Session running (uptime: ${Math.round(pingResult.uptime)}s) - ⚠️  Electron DISCONNECTED`);
                        console.log('  Use `pnpm electron:run restart` to recover.');
                    }
                } catch {
                    console.log('Session file exists but server not responding.');
                    console.log('  Cleaning up stale session file...');
                    try { unlinkSync(sessionFile); } catch {}
                }
                break;
            }

            case 'restart': {
                console.log('Restarting session (with fresh Nuxt)...');
                await stopSession();
                await delay(1000);
                await startSession(true);  // Force clean to avoid stale cache
                break;
            }

            case 'screenshot': {
                const result = await sendCommand('screenshot', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'console': {
                const result = await sendCommand('console', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'click': {
                const result = await sendCommand('click', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'type': {
                const result = await sendCommand('type', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'content': {
                const result = await sendCommand('content', args);
                console.log(result);
                break;
            }

            case 'run': {
                const code = args.join(' ');
                if (!code) {
                    console.error('No code provided');
                    process.exit(1);
                }
                const result = await sendCommand('run', [code]);
                if (result !== undefined) {
                    console.log(JSON.stringify(result, null, 2));
                }
                break;
            }

            case 'eval': {
                const code = args.join(' ');
                if (!code) {
                    console.error('No code provided');
                    process.exit(1);
                }
                const result = await sendCommand('eval', [code]);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'openPdf': {
                const pdfPath = args[0];
                if (!pdfPath) {
                    console.error('PDF path required');
                    process.exit(1);
                }
                const result = await sendCommand('openPdf', [pdfPath]);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'health': {
                const result = await sendCommand('health');
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            default:
                console.error(`Unknown command: ${command}`);
                process.exit(1);
        }
    } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

main();
