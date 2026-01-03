/**
 * Electron Playwright Control Script - Persistent Session
 *
 * Usage:
 *   pnpm electron:run <command> [args...]
 *
 * Commands:
 *   start               - Start Electron app session (keeps running)
 *   stop                - Stop the running session
 *   status              - Check if session is running
 *   screenshot [name]   - Take screenshot of running app
 *   run <code>          - Run Playwright code against running app
 */

import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const screenshotDir = join(projectRoot, '.devkit', 'screenshots');
const sessionFile = join(projectRoot, '.devkit', 'electron-session.json');
const DEFAULT_PORT = 9847;
const NUXT_PORT = 3235;

async function isNuxtServerRunning(): Promise<boolean> {
    try {
        const response = await fetch(`http://localhost:${NUXT_PORT}`, { method: 'HEAD' });
        return response.ok;
    } catch {
        return false;
    }
}

async function waitForNuxtServer(timeoutMs = 120_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isNuxtServerRunning()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Nuxt server not ready after ${timeoutMs / 1000}s`);
}

interface ISessionInfo {
    port: number;
    pid: number;
}

// ============ Server Mode (runs the Electron app) ============

async function startServer() {
    const mainJs = join(projectRoot, 'dist-electron', 'main.js');
    if (!existsSync(mainJs)) {
        console.error('Error: dist-electron/main.js not found. Run `pnpm run build:electron` first.');
        process.exit(1);
    }

    console.log('Starting Electron app...');

    const app = await electron.launch({
        args: [mainJs],
        cwd: projectRoot,
        timeout: 60_000,
    });

    // Wait for main window (not DevTools)
    let window: Page | null = null;
    for (let i = 0; i < 30; i++) {
        const windows = app.windows();
        for (const w of windows) {
            const title = await w.title();
            if (!title.includes('DevTools')) {
                window = w;
                break;
            }
        }
        if (window) break;
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!window) {
        window = await app.firstWindow();
    }

    await window.waitForLoadState('domcontentloaded');
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('Electron app ready.');

    // Create HTTP server to handle commands
    const server = createServer(async (req, res) => {
        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end('Method not allowed');
            return;
        }

        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { command, args } = JSON.parse(body);
                const result = await handleCommand(app, window!, command, args);
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

    server.listen(DEFAULT_PORT, () => {
        console.log(`Server listening on port ${DEFAULT_PORT}`);

        // Save session info
        mkdirSync(join(projectRoot, '.devkit'), { recursive: true });
        writeFileSync(sessionFile, JSON.stringify({
            port: DEFAULT_PORT,
            pid: process.pid,
        }));
    });

    // Handle shutdown
    const shutdown = async () => {
        console.log('\nShutting down...');
        try { unlinkSync(sessionFile); } catch {}
        server.close();
        await app.close().catch(() => {});
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process running
    await new Promise(() => {});
}

async function handleCommand(
    app: ElectronApplication,
    window: Page,
    command: string,
    args: unknown[],
): Promise<unknown> {
    switch (command) {
        case 'screenshot': {
            const name = (args[0] as string) ?? `screenshot-${Date.now()}`;
            mkdirSync(screenshotDir, { recursive: true });
            const filepath = join(screenshotDir, `${name}.png`);
            await window.screenshot({ path: filepath, fullPage: false });
            return { screenshot: filepath };
        }

        case 'run': {
            const code = args[0] as string;
            if (!code) throw new Error('No code provided');

            const asyncFn = new Function(
                'window',
                'app',
                'screenshot',
                `return (async () => { ${code} })()`,
            );

            const screenshotFn = async (name: string) => {
                mkdirSync(screenshotDir, { recursive: true });
                const filepath = join(screenshotDir, `${name}.png`);
                await window.screenshot({ path: filepath, fullPage: false });
                return filepath;
            };

            return await asyncFn(window, app, screenshotFn);
        }

        case 'ping':
            return 'pong';

        default:
            throw new Error(`Unknown command: ${command}`);
    }
}

// ============ Client Mode (sends commands to server) ============

function getSession(): ISessionInfo | null {
    try {
        return JSON.parse(readFileSync(sessionFile, 'utf8'));
    } catch {
        return null;
    }
}

async function sendCommand(command: string, args: unknown[] = []): Promise<unknown> {
    const session = getSession();
    if (!session) {
        throw new Error('No session running. Start one with: pnpm electron:run start');
    }

    const response = await fetch(`http://localhost:${session.port}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, args }),
    });

    const data = await response.json() as { success: boolean; result?: unknown; error?: string };

    if (!data.success) {
        throw new Error(data.error ?? 'Unknown error');
    }

    return data.result;
}

async function checkStatus(): Promise<boolean> {
    const session = getSession();
    if (!session) return false;

    try {
        await sendCommand('ping');
        return true;
    } catch {
        // Clean up stale session file
        try { unlinkSync(sessionFile); } catch {}
        return false;
    }
}

async function stopSession() {
    const session = getSession();
    if (!session) {
        console.log('No session running.');
        return;
    }

    try {
        process.kill(session.pid, 'SIGTERM');
        console.log('Session stopped.');
    } catch {
        console.log('Session was not running.');
    }

    try { unlinkSync(sessionFile); } catch {}
}

// ============ CLI ============

async function main() {
    const [, , command, ...args] = process.argv;

    if (!command) {
        console.log(`
Electron Playwright Control - Persistent Session

Usage:
  pnpm electron:run <command> [args...]

Session Commands:
  start               Start Electron app session (keeps running)
  stop                Stop the running session
  status              Check if session is running

Interaction Commands (require running session):
  screenshot [name]   Take screenshot
  run <code>          Run Playwright code (access: window, app, screenshot)

Examples:
  pnpm electron:run start
  pnpm electron:run screenshot "initial"
  pnpm electron:run run "await window.click('text=Open PDF')"
  pnpm electron:run run "return await window.locator('button').allTextContents()"
  pnpm electron:run stop

The 'run' command has access to:
  - window     : Playwright Page object
  - app        : ElectronApplication for main process
  - screenshot : async (name) => filepath - take named screenshot
`);
        process.exit(0);
    }

    try {
        switch (command) {
            case 'start': {
                if (await checkStatus()) {
                    console.log('Session already running.');
                    process.exit(0);
                }
                await startServer();
                break;
            }

            case 'stop':
                await stopSession();
                break;

            case 'status': {
                const running = await checkStatus();
                console.log(running ? 'Session is running.' : 'No session running.');
                break;
            }

            case 'screenshot': {
                const result = await sendCommand('screenshot', args);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'run': {
                const code = args.join(' ');
                if (!code) {
                    console.error('Error: No code provided');
                    process.exit(1);
                }
                const result = await sendCommand('run', [code]);
                if (result !== undefined) {
                    console.log(JSON.stringify(result, null, 2));
                }
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
