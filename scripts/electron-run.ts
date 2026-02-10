/**
 * Electron Puppeteer Control - Persistent Session Server
 *
 * Supports multiple concurrent sessions via --session=<name> (default: "default").
 * Each session gets its own Electron instance, CDP port, and HTTP command server.
 * Nuxt dev server is shared across sessions on a fixed port.
 *
 * Usage:
 *   pnpm electron:run start                     - Start default session
 *   pnpm electron:run --session=a startd         - Start named session in background
 *   pnpm electron:run --session=a screenshot x   - Take screenshot in session "a"
 *   pnpm electron:run list                       - List all sessions
 *   pnpm electron:run stop --all                 - Stop every session
 */

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { delay } from 'es-toolkit/promise';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');

// Fixed port for the shared Nuxt dev server (configured in nuxt.config.ts)
const NUXT_PORT = 3235;

// Timeouts
const SESSION_WAIT_TIMEOUT_MS = 60_000;
const COMMAND_REQUEST_TIMEOUT_MS = 120_000;
const OPEN_PDF_READY_TIMEOUT_MS = 120_000;
const OPEN_PDF_TRIGGER_TIMEOUT_MS = 12_000;
const COMMAND_EXECUTION_TIMEOUT_MS = 180_000;

// ============ Session Configuration ============

let currentSessionName = 'default';

const sessionsBaseDir = join(projectRoot, '.devkit', 'sessions');

function sessionDir(name = currentSessionName) {
    return join(sessionsBaseDir, name);
}
function sessionFilePath(name = currentSessionName) {
    return join(sessionDir(name), 'session.json');
}
function sessionStartingFilePath(name = currentSessionName) {
    return join(sessionDir(name), 'session-starting.json');
}
function sessionLogFilePath(name = currentSessionName) {
    return join(sessionDir(name), 'session.log');
}
function electronUserDataPath(name = currentSessionName) {
    return join(sessionDir(name), 'electron-user-data');
}
function screenshotDirPath(name = currentSessionName) {
    return join(sessionDir(name), 'screenshots');
}

// ============ Port Allocation ============

async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createNetServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                server.close();
                reject(new Error('Failed to allocate free port'));
                return;
            }
            const { port } = addr;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

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
        const pids = await getPidsOnPort(NUXT_PORT);
        await killPids(pids);
        await delay(500);
    } catch {}
}

async function getPidsOnPort(port: number): Promise<number[]> {
    try {
        const { execSync } = await import('node:child_process');
        const output = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf8' }) as string;
        return output
            .split('\n')
            .map(entry => Number(entry.trim()))
            .filter(pid => Number.isFinite(pid) && pid > 0);
    } catch {
        return [];
    }
}

async function killPids(
    pids: number[],
    options: {
        signal?: NodeJS.Signals | number;
        exclude?: Set<number>;
    } = {},
): Promise<void> {
    if (!Array.isArray(pids) || pids.length === 0) {
        return;
    }
    const signal = options.signal ?? 'SIGKILL';
    const exclude = options.exclude ?? new Set<number>();
    exclude.add(process.pid);
    if (typeof process.ppid === 'number' && process.ppid > 0) {
        exclude.add(process.ppid);
    }

    const uniquePids = Array.from(new Set(pids));
    for (const pid of uniquePids) {
        if (exclude.has(pid)) {
            continue;
        }
        try {
            process.kill(pid, signal);
        } catch {}
    }
}

async function clearViteCache(): Promise<void> {
    const { rmSync } = await import('node:fs');
    const cachePaths = [
        join(projectRoot, 'node_modules', '.vite'),
        join(projectRoot, 'node_modules', '.cache', 'vite'),
        join(projectRoot, '.nuxt'),
    ];

    for (const cachePath of cachePaths) {
        try {
            rmSync(cachePath, { recursive: true, force: true });
            console.log(`[Cache] Cleared ${cachePath.replace(projectRoot + '/', '')}`);
        } catch {}
    }
}

async function startNuxtServer(forceClean = false): Promise<ChildProcess | null> {
    if (forceClean) {
        console.log('[Nuxt] Force clean start...');
        await killExistingNuxt();
        await clearViteCache();
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

    let viteClientBuilt = false;
    let viteServerBuilt = false;
    let nitroBuilt = false;
    let viteClientWarmed = false;

    const checkOutput = (text: string) => {
        if (text.includes('Vite client built')) {
            console.log('[Nuxt] Vite client built');
            viteClientBuilt = true;
        }
        if (text.includes('Vite server built')) {
            console.log('[Nuxt] Vite server built');
            viteServerBuilt = true;
        }
        if (text.includes('Nitro server built') || text.includes('Nitro') && text.includes('built')) {
            console.log('[Nuxt] Nitro server built');
            nitroBuilt = true;
        }
        if (text.includes('Vite client warmed up')) {
            console.log('[Nuxt] Vite client warmed up');
            viteClientWarmed = true;
        }
    };

    nuxt.stdout?.on('data', (data: Buffer) => checkOutput(data.toString()));
    nuxt.stderr?.on('data', (data: Buffer) => checkOutput(data.toString()));

    const timeout = 120_000;
    const start = Date.now();
    let lastLog = 0;
    const WARMUP_GRACE_MS = 5_000;

    while (Date.now() - start < timeout) {
        const serverUp = await isNuxtRunning();
        const buildsComplete = viteClientBuilt && viteServerBuilt && nitroBuilt;
        const warmupComplete = viteClientWarmed || (Date.now() - start > WARMUP_GRACE_MS);

        if (serverUp && buildsComplete && warmupComplete) {
            console.log('[Nuxt] Server ready at http://localhost:' + NUXT_PORT);

            console.log('[Nuxt] Warming up dependencies...');
            try {
                await fetch(`http://localhost:${NUXT_PORT}/`, { method: 'GET' });
                await delay(2000);
            } catch {}

            return nuxt;
        }

        const now = Date.now();
        if (serverUp && !buildsComplete && now - lastLog > 5000) {
            const missing = [];
            if (!viteClientBuilt) missing.push('Vite client');
            if (!viteServerBuilt) missing.push('Vite server');
            if (!nitroBuilt) missing.push('Nitro');
            if (!viteClientWarmed) missing.push('Vite warmup');
            console.log(`[Nuxt] Waiting for builds: ${missing.join(', ')}`);
            lastLog = now;
        }

        await delay(500);
    }

    nuxt.kill();
    throw new Error('Nuxt server failed to start');
}

// ============ Electron Management ============

async function startElectron(cdpPort: number): Promise<ChildProcess> {
    const mainJs = join(projectRoot, 'dist-electron', 'main.js');
    if (!existsSync(mainJs)) {
        throw new Error('dist-electron/main.js not found. Run `pnpm run build:electron` first.');
    }

    console.log('[Electron] Starting with CDP on port', cdpPort);
    mkdirSync(sessionDir(), { recursive: true });

    const electronPath = join(projectRoot, 'node_modules/.bin/electron');
    const electron = spawn(electronPath, [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${electronUserDataPath()}`,
        '--disable-http-cache',
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

    const timeout = 30_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
        try {
            const res = await fetch(`http://localhost:${cdpPort}/json/version`);
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

async function checkHydration(page: Page): Promise<boolean> {
    try {
        return await page.evaluate(() => {
            const nuxtEl = document.querySelector('#__nuxt');
            return !!(
                (window as any).__appReady ||
                (nuxtEl && nuxtEl.children.length > 0)
            );
        });
    } catch {
        return false;
    }
}

async function findAppPage(browser: Browser): Promise<Page | null> {
    const pages = await browser.pages();
    return pages.find(p => p.url().includes(`localhost:${NUXT_PORT}`)) ?? null;
}

async function connectToBrowser(cdpPort: number): Promise<{ browser: Browser; page: Page }> {
    console.log('[Puppeteer] Connecting via CDP...');
    let browser: Browser | null = null;

    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            browser = await Promise.race([
                puppeteer.connect({
                    browserURL: `http://localhost:${cdpPort}`,
                    defaultViewport: null,
                }),
                delay(3500).then(() => {
                    throw new Error('CDP connect timeout');
                }),
            ]);
            break;
        } catch (error) {
            if (attempt === 0 || attempt === 9 || attempt === 19) {
                const message = error instanceof Error ? error.message : String(error);
                console.log(`[Puppeteer] CDP connect retry ${attempt + 1}/20: ${message}`);
            }
            await delay(350);
        }
    }

    if (!browser) {
        throw new Error('Could not connect to Electron CDP');
    }

    let page: Page | null = null;
    for (let i = 0; i < 30; i++) {
        page = await findAppPage(browser);
        if (page) break;
        await delay(500);
    }

    if (!page) {
        const pages = await browser.pages();
        page = pages.find(candidate => !candidate.isClosed()) ?? await browser.newPage();
        if (!page.url().includes(`localhost:${NUXT_PORT}`)) {
            await page.goto(`http://localhost:${NUXT_PORT}/`, {
                waitUntil: 'domcontentloaded',
                timeout: 30_000,
            });
        }
    }

    let sawOutdatedOptimizeDep = false;
    page.on('response', (res) => {
        if (res.status() === 504 && res.url().includes(`localhost:${NUXT_PORT}`)) {
            sawOutdatedOptimizeDep = true;
        }
    });

    try {
        await page.waitForSelector('body', { timeout: 30000 });
    } catch {
        console.log('[Puppeteer] Page navigated during initial load, re-finding...');
        await delay(2000);
        page = await findAppPage(browser);
        if (!page) {
            throw new Error('Lost app page after navigation');
        }
        await page.waitForSelector('body', { timeout: 15000 });
    }

    console.log('[Puppeteer] Waiting for Vue to hydrate...');
    let hydrated = false;
    let navigationCount = 0;
    const MAX_NAVIGATIONS = 3;

    for (let attempt = 0; attempt < 30; attempt++) {
        if (sawOutdatedOptimizeDep) {
            console.log('[Puppeteer] Detected Vite 504 (Outdated Optimize Dep), reloading...');
            break;
        }

        const isReady = await checkHydration(page);

        if (isReady) {
            hydrated = true;
            break;
        }

        if (attempt > 0 && attempt % 5 === 0) {
            const freshPage = await findAppPage(browser);
            if (freshPage && freshPage !== page) {
                navigationCount++;
                console.log(`[Puppeteer] Page navigated (${navigationCount}/${MAX_NAVIGATIONS}), re-attaching...`);
                if (navigationCount > MAX_NAVIGATIONS) {
                    console.log('[Puppeteer] Too many navigations, proceeding with current page');
                    break;
                }
                page = freshPage;
            }
        }

        await delay(500);
    }

    if (!hydrated) {
        console.log('[Puppeteer] Vue not ready, reloading page...');
        sawOutdatedOptimizeDep = false;
        try {
            await page.reload({ waitUntil: 'networkidle2' });
        } catch {
            await delay(2000);
            page = await findAppPage(browser) ?? page;
        }
        await delay(3000);

        const isReadyAfterReload = await checkHydration(page);

        if (!isReadyAfterReload) {
            console.log('[Puppeteer] Warning: Vue may not be fully hydrated');
        }
    }

    console.log('[Puppeteer] Connected to app');
    return { browser, page };
}

// ============ Session Server ============

async function startSession(forceClean = false) {
    await cleanupStaleSessionArtifacts();

    if (await isSessionRunning()) {
        console.log(`Session '${currentSessionName}' already running. Use \`pnpm electron:run stop --session=${currentSessionName}\` to stop it.`);
        return;
    }
    if (isSessionStarting()) {
        console.log(`Session '${currentSessionName}' startup already in progress. Waiting for readiness...`);
        const ready = await waitForSessionReady(90_000);
        if (!ready) {
            throw new Error(`Session '${currentSessionName}' startup is stuck. Run stop and retry.`);
        }
        return;
    }
    markSessionStarting(process.pid);

    console.log(`Starting Electron Puppeteer session '${currentSessionName}'...\n`);

    try {
        // If other sessions are already running, don't force-restart the shared Nuxt server
        const otherRunning = (await listRunningSessions()).filter(s => s !== currentSessionName);
        if (forceClean && otherRunning.length > 0) {
            console.log(`[Nuxt] ${otherRunning.length} other session(s) running (${otherRunning.join(', ')}), skipping Nuxt restart`);
            forceClean = false;
        }

        const nuxtProcess = await startNuxtServer(forceClean);

        // Clean Electron profile for this session
        try {
            rmSync(electronUserDataPath(), { recursive: true, force: true });
            console.log(`[Cache] Cleared ${electronUserDataPath().replace(projectRoot + '/', '')}`);
        } catch {}

        // Kill stale Electron from a previous run of THIS session (by PID if known)
        const staleInfo = getSessionInfo();
        if (staleInfo?.electronPid && isProcessAlive(staleInfo.electronPid)) {
            try { process.kill(staleInfo.electronPid, 'SIGKILL'); } catch {}
            await delay(500);
        }

        // Allocate dynamic ports for this session
        const cdpPort = await findFreePort();
        const serverPort = await findFreePort();
        console.log(`[Ports] CDP: ${cdpPort}, HTTP server: ${serverPort}`);

        const electronProcess = await startElectron(cdpPort);

        let browser: Browser;
        let page: Page;
        try {
            ({ browser, page } = await connectToBrowser(cdpPort));
        } catch (err) {
            console.error('[Session] Failed to connect to browser, cleaning up...');
            try { electronProcess.kill(); } catch {}
            try { nuxtProcess?.kill(); } catch {}
            throw err;
        }

    const consoleMessages: ISessionState['consoleMessages'] = [];
    page.on('console', (msg) => {
        const entry = {
            type: msg.type(),
            text: msg.text(),
            timestamp: Date.now(),
        };
        consoleMessages.push(entry);
        const timestamp = new Date(entry.timestamp).toISOString().split('T')[1];
        console.log(`[${entry.type.toUpperCase()}] ${entry.text}`);
        if (consoleMessages.length > 100) consoleMessages.shift();
    });

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

        let isShuttingDown = false;
        let httpServer: ReturnType<typeof createServer> | null = null;

        const cleanupAndExit = async (exitCode: number) => {
            if (isShuttingDown) return;
            isShuttingDown = true;

            console.log('\nShutting down...');
            try { unlinkSync(sessionFilePath()); } catch {}
            clearSessionStarting();
            httpServer?.close();

            await sessionState?.browser.disconnect().catch(() => {});
            try { sessionState?.electronProcess.kill(); } catch {}

            // Only kill Nuxt if this session started it and no other sessions are running
            if (sessionState?.nuxtProcess) {
                const otherNames = listAllSessionNames().filter(s => s !== currentSessionName);
                const othersAlive = otherNames.some(s => {
                    const info = getSessionInfo(s);
                    return info && isProcessAlive(info.pid);
                });
                if (!othersAlive) {
                    try { sessionState.nuxtProcess.kill(); } catch {}
                } else {
                    console.log('[Nuxt] Left running (other sessions active)');
                }
            }

            process.exit(exitCode);
        };

        electronProcess.on('exit', (code, signal) => {
            if (isShuttingDown) {
                return;
            }
            console.log(`\n[Electron] Process exited (code: ${code}, signal: ${signal})`);
            console.log('[Session] Electron died - shutting down session...');
            cleanupAndExit(1);
        });

        browser.on('disconnected', () => {
            if (isShuttingDown) {
                return;
            }
            console.log('\n[Puppeteer] Browser disconnected');
            console.log('[Session] Lost connection to Electron - shutting down session...');
            cleanupAndExit(1);
        });

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

        server.listen(serverPort, () => {
            mkdirSync(sessionDir(), { recursive: true });
            writeFileSync(sessionFilePath(), JSON.stringify({
                port: serverPort,
                pid: process.pid,
                cdpPort,
                electronPid: electronProcess.pid ?? null,
                nuxtPid: nuxtProcess?.pid ?? null,
            }));
            clearSessionStarting();

            console.log(`\n✓ Session '${currentSessionName}' ready on port ${serverPort}`);
            console.log('  Press Ctrl+C to stop\n');
        });

        process.on('SIGINT', () => cleanupAndExit(0));
        process.on('SIGTERM', () => cleanupAndExit(0));

        await new Promise(() => {});
    } catch (error) {
        clearSessionStarting();
        throw error;
    }
}

// ============ Command Handlers ============

async function handleCommand(command: string, args: unknown[]): Promise<unknown> {
    if (!sessionState) throw new Error('Session not initialized');

    const { page, consoleMessages } = sessionState;
    const ssDirPath = screenshotDirPath();

    switch (command) {
        case 'ping':
            return { status: 'ok', uptime: process.uptime() };

        case 'screenshot': {
            const name = (args[0] as string) ?? `screenshot-${Date.now()}`;
            mkdirSync(ssDirPath, { recursive: true });
            const filepath = join(ssDirPath, `${name}.png`);
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
                mkdirSync(ssDirPath, { recursive: true });
                const filepath = join(ssDirPath, `${name}.png`);
                await page.screenshot({ path: filepath });
                return filepath;
            };
            const sleepFn = async (ms: number) => {
                const duration = Number.isFinite(ms) ? Math.max(0, ms) : 0;
                await delay(duration);
            };

            const asyncFn = new Function(
                'page', 'screenshot', 'sleep', 'wait',
                `return (async () => { ${code} })()`,
            );

            return await Promise.race([
                asyncFn(page, screenshotFn, sleepFn, sleepFn),
                delay(COMMAND_EXECUTION_TIMEOUT_MS).then(() => {
                    throw new Error(`run command timed out after ${Math.round(COMMAND_EXECUTION_TIMEOUT_MS / 1000)}s`);
                }),
            ]);
        }

        case 'eval': {
            const code = args[0] as string;
            if (!code) throw new Error('No code provided');
            return await Promise.race([
                page.evaluate(code),
                delay(COMMAND_EXECUTION_TIMEOUT_MS).then(() => {
                    throw new Error(`eval command timed out after ${Math.round(COMMAND_EXECUTION_TIMEOUT_MS / 1000)}s`);
                }),
            ]);
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
            const requestedBasename = basename(pdfPath).toLowerCase();
            type TOpenPdfState = {
                numPages: number | null;
                currentPage: number | null;
                isLoading: boolean | null;
                workingCopyPath: string | null;
                renderedPageContainers: number;
                renderedCanvasCount: number;
                renderedTextSpanCount: number;
                visibleSkeletonCount: number;
                hasViewer: boolean;
                hasEmptyState: boolean;
                openTrigger?: {
                    token: string;
                    status: 'pending' | 'resolved' | 'rejected';
                    error: string | null;
                } | null;
            };

            const isRequestedDocumentLoaded = (workingCopyPath: string | null | undefined) => {
                if (!workingCopyPath) {
                    return false;
                }
                return basename(workingCopyPath).toLowerCase() === requestedBasename;
            };

            const readViewerState = async (token?: string) => await page.evaluate((requestedToken?: string) => {
                const host = document.querySelector('#pdf-viewer') as (HTMLElement & {
                    __vueParentComponent?: {
                        setupState?: {
                            numPages?: number;
                            currentPage?: number;
                            isLoading?: boolean;
                            workingCopyPath?: string | null;
                        };
                    };
                }) | null;
                const setupState = host?.__vueParentComponent?.setupState;
                const trigger = (window as any).__electronRunOpenPdfTrigger as {
                    token?: string;
                    status?: 'pending' | 'resolved' | 'rejected';
                    error?: string | null;
                } | undefined;
                const openTrigger = (
                    requestedToken
                    && trigger
                    && trigger.token === requestedToken
                )
                    ? {
                        token: trigger.token ?? '',
                        status: trigger.status ?? 'pending',
                        error: trigger.error ?? null,
                    }
                    : null;

                return {
                    numPages: setupState?.numPages ?? null,
                    currentPage: setupState?.currentPage ?? null,
                    isLoading: setupState?.isLoading ?? null,
                    workingCopyPath: setupState?.workingCopyPath ?? null,
                    renderedPageContainers: document.querySelectorAll('.page_container').length,
                    renderedCanvasCount: document.querySelectorAll('.page_container .page_canvas canvas').length,
                    renderedTextSpanCount: document.querySelectorAll('.page_container .text-layer span, .page_container .textLayer span').length,
                    visibleSkeletonCount: Array.from(document.querySelectorAll('.page_container .pdf-page-skeleton'))
                        .filter((node) => {
                            const element = node as HTMLElement;
                            if (!element.isConnected) {
                                return false;
                            }
                            const style = window.getComputedStyle(element);
                            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                                return false;
                            }
                            const rect = element.getBoundingClientRect();
                            return rect.width > 0 && rect.height > 0;
                        })
                        .length,
                    hasViewer: Boolean(host),
                    hasEmptyState: Boolean(document.querySelector('.empty-state')),
                    openTrigger,
                } satisfies TOpenPdfState;
            }, token);

            const beforeState = await readViewerState();
            const triggerToken = await page.evaluate((path: string, triggerTimeoutMs: number) => {
                const token = `open-${Date.now()}-${Math.random().toString(16).slice(2)}`;
                (window as any).__electronRunOpenPdfTrigger = {
                    token,
                    status: 'pending',
                    error: null,
                };

                const openFileDirect = (window as any).__openFileDirect;
                if (typeof openFileDirect !== 'function') {
                    (window as any).__electronRunOpenPdfTrigger = {
                        token,
                        status: 'rejected',
                        error: 'window.__openFileDirect is not available',
                    };
                    return token;
                }

                Promise.resolve()
                    .then(async () => {
                        await Promise.race([
                            openFileDirect(path),
                            new Promise((_, reject) => {
                                setTimeout(() => reject(new Error('openFileDirect trigger timeout')), triggerTimeoutMs);
                            }),
                        ]);
                        (window as any).__electronRunOpenPdfTrigger = {
                            token,
                            status: 'resolved',
                            error: null,
                        };
                    })
                    .catch((error: unknown) => {
                        const message = error instanceof Error ? error.message : String(error);
                        (window as any).__electronRunOpenPdfTrigger = {
                            token,
                            status: 'rejected',
                            error: message,
                        };
                    });

                return token;
            }, pdfPath, OPEN_PDF_TRIGGER_TIMEOUT_MS);

            const start = Date.now();
            let lastState: TOpenPdfState = beforeState;
            while (Date.now() - start < OPEN_PDF_READY_TIMEOUT_MS) {
                lastState = await readViewerState(triggerToken as string);

                if (lastState.openTrigger?.status === 'rejected') {
                    throw new Error(lastState.openTrigger.error || 'openPdf failed');
                }

                const hasPages = (lastState.numPages ?? 0) > 0 || lastState.renderedPageContainers > 0;
                const notLoading = lastState.isLoading === false || lastState.isLoading === null;
                const hasDocumentUi = lastState.hasViewer && !lastState.hasEmptyState;
                const hasRenderedContent = lastState.renderedCanvasCount > 0 || lastState.renderedTextSpanCount > 0;
                const requestedDocLoaded = isRequestedDocumentLoaded(lastState.workingCopyPath);

                if (hasPages && hasDocumentUi && notLoading && hasRenderedContent && requestedDocLoaded) {
                    await delay(250);
                    break;
                }

                await delay(250);
            }

            const state = await readViewerState();
            if (
                !state.hasViewer
                || state.hasEmptyState
                || state.renderedPageContainers <= 0
                || (state.renderedCanvasCount <= 0 && state.renderedTextSpanCount <= 0)
                || !isRequestedDocumentLoaded(state.workingCopyPath)
            ) {
                const loadedPath = state.workingCopyPath ?? '<none>';
                throw new Error(`openPdf readiness timeout for ${pdfPath} (loaded: ${loadedPath})`);
            }

            return {
                opened: pdfPath,
                state,
            };
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

// ============ Session Info Helpers ============

interface ISessionInfo {
    port: number;
    pid: number;
    cdpPort: number;
    electronPid: number | null;
    nuxtPid: number | null;
}

function getSessionInfo(name = currentSessionName): ISessionInfo | null {
    try {
        return JSON.parse(readFileSync(sessionFilePath(name), 'utf8'));
    } catch {
        return null;
    }
}

interface ISessionStartingInfo {
    pid: number;
    startedAt: number;
}

function getSessionStartingInfo(name = currentSessionName): ISessionStartingInfo | null {
    try {
        return JSON.parse(readFileSync(sessionStartingFilePath(name), 'utf8')) as ISessionStartingInfo;
    } catch {
        return null;
    }
}

function isProcessAlive(pid: number) {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readSessionLogTail(maxLines = 80) {
    try {
        const text = readFileSync(sessionLogFilePath(), 'utf8');
        const lines = text.split('\n');
        return lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trim();
    } catch {
        return '';
    }
}

function markSessionStarting(pid: number) {
    mkdirSync(sessionDir(), { recursive: true });
    writeFileSync(sessionStartingFilePath(), JSON.stringify({
        pid,
        startedAt: Date.now(),
    }));
}

function clearSessionStarting(name = currentSessionName) {
    try { unlinkSync(sessionStartingFilePath(name)); } catch {}
}

function isSessionStarting(name = currentSessionName) {
    const info = getSessionStartingInfo(name);
    if (!info) {
        return false;
    }
    const startupAge = Date.now() - info.startedAt;
    if (startupAge > 5 * 60_000 || !isProcessAlive(info.pid)) {
        clearSessionStarting(name);
        return false;
    }
    return true;
}

async function cleanupStaleSessionArtifacts(name = currentSessionName) {
    const info = getSessionInfo(name);
    if (info && !isProcessAlive(info.pid)) {
        try { unlinkSync(sessionFilePath(name)); } catch {}
    }

    const starting = getSessionStartingInfo(name);
    if (starting && !isProcessAlive(starting.pid)) {
        clearSessionStarting(name);
    }

    if (info && !(await isSessionRunning(name)) && !isProcessAlive(info.pid)) {
        try { unlinkSync(sessionFilePath(name)); } catch {}
    }
}

async function isSessionRunning(name = currentSessionName): Promise<boolean> {
    const info = getSessionInfo(name);
    if (!info) return false;

    try {
        const res = await fetch(`http://localhost:${info.port}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'ping', args: [] }),
        });
        return res.ok;
    } catch {
        if (!isProcessAlive(info.pid)) {
            try { unlinkSync(sessionFilePath(name)); } catch {}
        }
        return false;
    }
}

// ============ Session Listing ============

function listAllSessionNames(): string[] {
    try {
        return readdirSync(sessionsBaseDir).filter(name => {
            try {
                return existsSync(sessionFilePath(name)) || existsSync(sessionStartingFilePath(name));
            } catch {
                return false;
            }
        });
    } catch {
        return [];
    }
}

async function listRunningSessions(): Promise<string[]> {
    const all = listAllSessionNames();
    const running: string[] = [];
    for (const name of all) {
        const info = getSessionInfo(name);
        if (info && isProcessAlive(info.pid)) {
            running.push(name);
        }
    }
    return running;
}

// ============ Client Commands ============

async function sendCommand(
    command: string,
    args: unknown[] = [],
    requestTimeoutMs = COMMAND_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
    const start = Date.now();
    let didPrintWaitMessage = false;

    while (Date.now() - start < SESSION_WAIT_TIMEOUT_MS) {
        const info = getSessionInfo();

        if (!info) {
            if (!didPrintWaitMessage && Date.now() - start > 2000) {
                didPrintWaitMessage = true;
                console.log(`[Session '${currentSessionName}'] Waiting for session to start...`);
            }
            await delay(250);
            continue;
        }

        let data: { success: boolean; result?: unknown; error?: string } | null = null;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
            const res = await fetch(`http://localhost:${info.port}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command, args }),
                signal: controller.signal,
            });
            data = (await res.json()) as { success: boolean; result?: unknown; error?: string };
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Command "${command}" timed out after ${Math.round(requestTimeoutMs / 1000)}s`);
            }
            if (!didPrintWaitMessage) {
                didPrintWaitMessage = true;
                console.log(`[Session '${currentSessionName}'] Waiting for session to become ready...`);
            }
            await delay(250);
            continue;
        } finally {
            clearTimeout(timeoutId);
        }

        if (!data.success) {
            throw new Error(data.error ?? 'Unknown error');
        }
        return data.result;
    }

    throw new Error(`Session '${currentSessionName}' not ready after ${Math.round(SESSION_WAIT_TIMEOUT_MS / 1000)}s. Start with: pnpm electron:run start --session=${currentSessionName}`);
}

// ============ Stop / Lifecycle ============

async function stopSingleSession(name: string) {
    await cleanupStaleSessionArtifacts(name);

    const info = getSessionInfo(name);
    const starting = getSessionStartingInfo(name);

    if (!info && !starting) {
        console.log(`No session '${name}' running.`);
        return;
    }

    if (info) {
        // Kill session server process
        if (isProcessAlive(info.pid)) {
            try { process.kill(info.pid, 'SIGTERM'); } catch {}
        }

        // Kill Electron by PID
        if (info.electronPid && isProcessAlive(info.electronPid)) {
            try { process.kill(info.electronPid, 'SIGKILL'); } catch {}
        }

        // Kill Nuxt only if no other sessions need it
        if (info.nuxtPid && isProcessAlive(info.nuxtPid)) {
            const others = listAllSessionNames().filter(s => s !== name);
            const othersAlive = others.some(s => {
                const otherInfo = getSessionInfo(s);
                return otherInfo && isProcessAlive(otherInfo.pid);
            });
            if (!othersAlive) {
                try { process.kill(info.nuxtPid, 'SIGKILL'); } catch {}
            } else {
                console.log(`[Nuxt] Left running (other sessions active)`);
            }
        }

        try { unlinkSync(sessionFilePath(name)); } catch {}
    }

    if (starting?.pid && isProcessAlive(starting.pid)) {
        try { process.kill(starting.pid, 'SIGTERM'); } catch {}
    }
    clearSessionStarting(name);

    await delay(250);
    console.log(`Session '${name}' stopped.`);
}

async function stopAllSessions() {
    const names = listAllSessionNames();
    if (names.length === 0) {
        // Fallback: kill any Nuxt on the fixed port
        await killExistingNuxt();
        console.log('No sessions found.');
        return;
    }

    for (const name of names) {
        await stopSingleSession(name);
    }

    // Also clean up any orphaned Nuxt process on the fixed port
    await killExistingNuxt();
    console.log('All sessions stopped.');
}

async function stopSession(stopAll = false) {
    if (stopAll) {
        await stopAllSessions();
    } else {
        await stopSingleSession(currentSessionName);
    }
}

// ============ Utilities ============

async function waitForSessionReady(timeoutMs = SESSION_WAIT_TIMEOUT_MS): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isSessionRunning()) {
            return true;
        }
        await delay(250);
    }
    return false;
}

async function startSessionDetached() {
    await cleanupStaleSessionArtifacts();

    if (await isSessionRunning()) {
        console.log(`Session '${currentSessionName}' already running.`);
        return;
    }
    if (isSessionStarting()) {
        console.log(`Session '${currentSessionName}' startup already in progress. Waiting for readiness...`);
        const ready = await waitForSessionReady(90_000);
        if (!ready) {
            throw new Error(`Startup is still pending. Check logs: ${sessionLogFilePath()}`);
        }
        console.log('Session is ready.');
        return;
    }

    mkdirSync(sessionDir(), { recursive: true });
    const logFd = openSync(sessionLogFilePath(), 'w');
    const child = spawn('pnpm', ['electron:run', `--session=${currentSessionName}`, 'start'], {
        cwd: projectRoot,
        detached: true,
        shell: false,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env },
    });
    closeSync(logFd);
    child.unref();

    const timeoutMs = 120_000;
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < timeoutMs) {
        if (await isSessionRunning()) {
            ready = true;
            break;
        }
        if (child.pid && !isProcessAlive(child.pid) && !isSessionStarting()) {
            break;
        }
        await delay(300);
    }
    if (!ready) {
        const tail = readSessionLogTail();
        const details = tail ? `\n\n--- Recent session log ---\n${tail}` : '';
        throw new Error(`Detached session failed to become ready in ${Math.round(timeoutMs / 1000)}s. Check logs: ${sessionLogFilePath()}${details}`);
    }

    console.log(`Session '${currentSessionName}' started in background (pid: ${child.pid ?? 'unknown'}).`);
    console.log(`Logs: ${sessionLogFilePath()}`);
}

// ============ Legacy Migration ============

function migrateLegacySessionFiles() {
    const legacySessionFile = join(projectRoot, '.devkit', 'electron-session.json');
    const legacyStartingFile = join(projectRoot, '.devkit', 'electron-session-starting.json');

    try {
        if (existsSync(legacySessionFile)) {
            const info = JSON.parse(readFileSync(legacySessionFile, 'utf8'));
            if (info.pid && isProcessAlive(info.pid)) {
                try { process.kill(info.pid, 'SIGTERM'); } catch {}
            }
            unlinkSync(legacySessionFile);
            console.log('[Migration] Cleaned up legacy session file');
        }
    } catch {}

    try {
        if (existsSync(legacyStartingFile)) {
            const starting = JSON.parse(readFileSync(legacyStartingFile, 'utf8'));
            if (starting.pid && isProcessAlive(starting.pid)) {
                try { process.kill(starting.pid, 'SIGTERM'); } catch {}
            }
            unlinkSync(legacyStartingFile);
        }
    } catch {}
}

// ============ CLI ============

async function main() {
    const rawArgs = process.argv.slice(2);

    // Parse flags: --session=<name>, --session <name>, -s <name>, --all
    let sessionName = 'default';
    let stopAll = false;
    const filteredArgs: string[] = [];

    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (arg.startsWith('--session=')) {
            sessionName = arg.split('=')[1] ?? 'default';
        } else if (arg === '--session' || arg === '-s') {
            sessionName = rawArgs[++i] ?? 'default';
        } else if (arg === '--all') {
            stopAll = true;
        } else {
            filteredArgs.push(arg);
        }
    }

    currentSessionName = sessionName;
    const [command, ...args] = filteredArgs;

    // One-time migration from old flat session files
    migrateLegacySessionFiles();

    if (!command) {
        console.log(`
Electron Puppeteer Control - Multi-Session

Usage:
  pnpm electron:run [--session <name>] <command> [args...]

Options:
  --session <name>, -s <name>   Session name (default: "default")
  --all                         Apply to all sessions (with stop)

Session:
  start               Start session (foreground, Ctrl+C to stop)
  startd              Start session in background (detached) and return
  cleanstart          Start with fresh Nuxt server (clears stale cache)
  stop                Stop session (or --all to stop every session)
  status              Check session health (shows connection status)
  restart             Stop and restart the session (useful for recovery)
  list                List all sessions and their status

Commands (require running session):
  health              Check app health status (loaded, API availability)
  screenshot [name]   Take screenshot → .devkit/sessions/<name>/screenshots/<name>.png
  console [level]     Get console messages (all|log|warn|error)
  run <code>          Run Puppeteer code (access: page, screenshot, sleep/wait)
  run-file <path>     Run Puppeteer code from a JS file
  eval <code>         Evaluate JS in page
  click <selector>    Click element
  type <sel> <text>   Type into element
  content <selector>  Get text content
  openPdf <path>      Open PDF file by absolute path

Examples:
  pnpm electron:run startd                        # Start default session
  pnpm electron:run -s test startd                 # Start "test" session
  pnpm electron:run -s test screenshot "home"      # Screenshot in "test" session
  pnpm electron:run list                           # Show all running sessions
  pnpm electron:run stop --all                     # Stop everything
  pnpm electron:run -s test openPdf "/path/to.pdf"
  pnpm electron:run run "await sleep(500); return await page.title()"
`);
        process.exit(0);
    }

    try {
        switch (command) {
            case 'start':
                console.log(`Starting session '${currentSessionName}' (with fresh Nuxt and cleared cache)...`);
                await startSession(true);
                break;

            case 'cleanstart':
                console.log(`Starting fresh session '${currentSessionName}'...`);
                await startSession(true);
                break;

            case 'startd':
                await startSessionDetached();
                break;

            case 'stop':
                await stopSession(stopAll);
                break;

            case 'status': {
                const info = getSessionInfo();
                if (!info) {
                    console.log(`No session '${currentSessionName}' running.`);
                    process.exit(1);
                }
                try {
                    const pingResult = await sendCommand('ping') as { uptime: number };
                    try {
                        await sendCommand('health');
                        console.log(`Session '${currentSessionName}' running (port: ${info.port}, uptime: ${Math.round(pingResult.uptime)}s) - Electron connected ✓`);
                    } catch {
                        console.log(`Session '${currentSessionName}' running (port: ${info.port}, uptime: ${Math.round(pingResult.uptime)}s) - ⚠️  Electron DISCONNECTED`);
                        console.log(`  Use \`pnpm electron:run --session=${currentSessionName} restart\` to recover.`);
                    }
                } catch {
                    console.log('Session file exists but server not responding.');
                    console.log('  Cleaning up stale session file...');
                    try { unlinkSync(sessionFilePath()); } catch {}
                    process.exit(1);
                }
                break;
            }

            case 'restart': {
                console.log(`Restarting session '${currentSessionName}' (with fresh Nuxt)...`);
                await stopSingleSession(currentSessionName);
                await delay(1000);
                await startSession(true);
                break;
            }

            case 'list': {
                const names = listAllSessionNames();
                if (names.length === 0) {
                    console.log('No sessions found.');
                    break;
                }

                console.log('Sessions:\n');
                for (const name of names) {
                    const info = getSessionInfo(name);
                    const starting = getSessionStartingInfo(name);

                    if (info && isProcessAlive(info.pid)) {
                        const running = await isSessionRunning(name);
                        const status = running ? 'running' : 'starting';
                        console.log(`  ${name}`);
                        console.log(`    Status:  ${status}`);
                        console.log(`    PID:     ${info.pid}`);
                        console.log(`    Ports:   server=${info.port}, cdp=${info.cdpPort}`);
                        console.log('');
                    } else if (starting && isProcessAlive(starting.pid)) {
                        console.log(`  ${name}`);
                        console.log(`    Status:  starting`);
                        console.log(`    PID:     ${starting.pid}`);
                        console.log('');
                    } else {
                        // Stale - clean up
                        try { unlinkSync(sessionFilePath(name)); } catch {}
                        clearSessionStarting(name);
                    }
                }
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
                const result = await sendCommand('run', [code], COMMAND_EXECUTION_TIMEOUT_MS);
                if (result !== undefined) {
                    console.log(JSON.stringify(result, null, 2));
                }
                break;
            }

            case 'run-file': {
                const filePath = args[0];
                if (!filePath) {
                    console.error('JS file path required');
                    process.exit(1);
                }
                const code = readFileSync(filePath, 'utf8');
                const result = await sendCommand('run', [code], COMMAND_EXECUTION_TIMEOUT_MS);
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
                const result = await sendCommand('eval', [code], COMMAND_EXECUTION_TIMEOUT_MS);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'openPdf': {
                const pdfPath = args[0];
                if (!pdfPath) {
                    console.error('PDF path required');
                    process.exit(1);
                }
                const result = await sendCommand('openPdf', [pdfPath], COMMAND_EXECUTION_TIMEOUT_MS);
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
