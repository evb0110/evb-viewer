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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { delay } from 'es-toolkit/promise';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const screenshotDir = join(projectRoot, '.devkit', 'screenshots');
const sessionFile = join(projectRoot, '.devkit', 'electron-session.json');
const sessionStartingFile = join(projectRoot, '.devkit', 'electron-session-starting.json');
const sessionLogFile = join(projectRoot, '.devkit', 'electron-run-session.log');
const electronUserDataDir = join(projectRoot, '.devkit', 'electron-user-data');
const SERVER_PORT = 9847;
const CDP_PORT = 9222;
const NUXT_PORT = 3235;
const SESSION_WAIT_TIMEOUT_MS = 60_000;
const COMMAND_REQUEST_TIMEOUT_MS = 120_000;
const OPEN_PDF_READY_TIMEOUT_MS = 120_000;
const OPEN_PDF_TRIGGER_TIMEOUT_MS = 12_000;
const COMMAND_EXECUTION_TIMEOUT_MS = 180_000;

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

async function killExistingElectronOnDebugPort(): Promise<void> {
    try {
        const pids = await getPidsOnPort(CDP_PORT);
        await killPids(pids);
        await delay(500);
    } catch {}
}

async function killExistingSessionServerOnPort(): Promise<void> {
    try {
        const pids = await getPidsOnPort(SERVER_PORT);
        await killPids(pids);
        await delay(300);
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
        await clearViteCache();  // Critical: clear stale dependency cache
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

    // Track build completion signals from Nuxt
    let viteClientBuilt = false;
    let viteServerBuilt = false;
    let nitroBuilt = false;
    let viteClientWarmed = false;

    const checkOutput = (text: string) => {
        // Nuxt outputs these messages (in order) when builds complete:
        // "✔ Vite client built in 36ms"
        // "✔ Vite server built in 3ms"
        // "[nitro] ✔ Nuxt Nitro server built in 369ms"
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

    // Wait for all builds to complete
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

            // Warmup request to trigger any on-demand dependency optimization
            console.log('[Nuxt] Warming up dependencies...');
            try {
                await fetch(`http://localhost:${NUXT_PORT}/`, { method: 'GET' });
                await delay(2000);  // Give Vite time to finish any on-demand optimization
            } catch {}

            return nuxt;
        }

        // Log progress every 5 seconds
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

async function startElectron(): Promise<ChildProcess> {
    const mainJs = join(projectRoot, 'dist-electron', 'main.js');
    if (!existsSync(mainJs)) {
        throw new Error('dist-electron/main.js not found. Run `pnpm run build:electron` first.');
    }

    console.log('[Electron] Starting with CDP on port', CDP_PORT);
    mkdirSync(join(projectRoot, '.devkit'), { recursive: true });

    const electronPath = join(projectRoot, 'node_modules/.bin/electron');
    const electron = spawn(electronPath, [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${electronUserDataDir}`,
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
        // Execution context destroyed (page navigated) — not hydrated yet
        return false;
    }
}

async function findAppPage(browser: Browser): Promise<Page | null> {
    const pages = await browser.pages();
    return pages.find(p => p.url().includes(`localhost:${NUXT_PORT}`)) ?? null;
}

async function connectToBrowser(): Promise<{ browser: Browser; page: Page }> {
    console.log('[Puppeteer] Connecting via CDP...');
    let browser: Browser | null = null;

    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            browser = await Promise.race([
                puppeteer.connect({
                    browserURL: `http://localhost:${CDP_PORT}`,
                    defaultViewport: null, // Don't override Electron window's natural viewport
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

    // Wait for the app page (may take a moment after Electron starts)
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

    // Wait for page to fully load (handle navigation during initial load)
    try {
        await page.waitForSelector('body', { timeout: 30000 });
    } catch {
        // Page may have navigated — re-find it and try again
        console.log('[Puppeteer] Page navigated during initial load, re-finding...');
        await delay(2000);
        page = await findAppPage(browser);
        if (!page) {
            throw new Error('Lost app page after navigation');
        }
        await page.waitForSelector('body', { timeout: 15000 });
    }

    // Wait for Vue to hydrate (check for __appReady or #__nuxt children)
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

        // If page.evaluate failed (context destroyed), the page navigated.
        // Re-find the page in case Vite did a full reload.
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

    // If not hydrated after 15s, try a page reload (helps with fresh Nuxt starts)
    if (!hydrated) {
        console.log('[Puppeteer] Vue not ready, reloading page...');
        sawOutdatedOptimizeDep = false;
        try {
            await page.reload({ waitUntil: 'networkidle2' });
        } catch {
            // Reload can fail if page is navigating — re-find
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
        console.log('Session already running. Use `pnpm electron:run stop` to stop it.');
        return;
    }
    if (isSessionStarting()) {
        console.log('Session startup already in progress. Waiting for readiness...');
        const ready = await waitForSessionReady(90_000);
        if (!ready) {
            throw new Error('Session startup is stuck. Run `pnpm electron:run stop` and retry.');
        }
        return;
    }
    await killExistingSessionServerOnPort();
    markSessionStarting(process.pid);

    console.log('Starting Electron Puppeteer session...\n');

    try {
        // Ensure Nuxt is running (force clean if requested)
        const nuxtProcess = await startNuxtServer(forceClean);

        // Clear Electron profile in clean starts to avoid stale cache issues (Vite 504 "Outdated Optimize Dep").
        if (forceClean) {
            try {
                rmSync(electronUserDataDir, { recursive: true, force: true });
                console.log('[Cache] Cleared .devkit/electron-user-data');
            } catch {}
        }

        await killExistingElectronOnDebugPort();

        // Start Electron with CDP
        const electronProcess = await startElectron();

        // Connect via Puppeteer — clean up spawned processes on failure
        let browser: Browser;
        let page: Page;
        try {
            ({ browser, page } = await connectToBrowser());
        } catch (err) {
            console.error('[Session] Failed to connect to browser, cleaning up...');
            try { electronProcess.kill(); } catch {}
            try { nuxtProcess?.kill(); } catch {}
            throw err;
        }

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
            clearSessionStarting();
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
            if (isShuttingDown) {
                return;
            }
            console.log(`\n[Electron] Process exited (code: ${code}, signal: ${signal})`);
            console.log('[Session] Electron died - shutting down session...');
            cleanupAndExit(1);
        });

        // Monitor Puppeteer disconnection
        browser.on('disconnected', () => {
            if (isShuttingDown) {
                return;
            }
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
            clearSessionStarting();

            console.log(`\n✓ Session ready on port ${SERVER_PORT}`);
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

interface ISessionStartingInfo {
    pid: number;
    startedAt: number;
}

function getSessionStartingInfo(): ISessionStartingInfo | null {
    try {
        return JSON.parse(readFileSync(sessionStartingFile, 'utf8')) as ISessionStartingInfo;
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
        const text = readFileSync(sessionLogFile, 'utf8');
        const lines = text.split('\n');
        return lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trim();
    } catch {
        return '';
    }
}

function markSessionStarting(pid: number) {
    mkdirSync(join(projectRoot, '.devkit'), { recursive: true });
    writeFileSync(sessionStartingFile, JSON.stringify({
        pid,
        startedAt: Date.now(),
    }));
}

function clearSessionStarting() {
    try { unlinkSync(sessionStartingFile); } catch {}
}

function isSessionStarting() {
    const info = getSessionStartingInfo();
    if (!info) {
        return false;
    }
    const startupAge = Date.now() - info.startedAt;
    if (startupAge > 5 * 60_000 || !isProcessAlive(info.pid)) {
        clearSessionStarting();
        return false;
    }
    return true;
}

async function cleanupStaleSessionArtifacts() {
    const info = getSessionInfo();
    if (info && !isProcessAlive(info.pid)) {
        try { unlinkSync(sessionFile); } catch {}
    }

    const starting = getSessionStartingInfo();
    if (starting && !isProcessAlive(starting.pid)) {
        clearSessionStarting();
    }

    if (info && !(await isSessionRunning()) && !isProcessAlive(info.pid)) {
        try { unlinkSync(sessionFile); } catch {}
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
        if (!isProcessAlive(info.pid)) {
            try { unlinkSync(sessionFile); } catch {}
        }
        return false;
    }
}

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
                console.log('[Session] Waiting for session to start...');
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
            // Session file exists but the server isn't responding yet (or it's stale).
            // Wait briefly and retry until timeout.
            if (!didPrintWaitMessage) {
                didPrintWaitMessage = true;
                console.log('[Session] Waiting for session to become ready...');
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

    throw new Error(`Session not ready after ${Math.round(SESSION_WAIT_TIMEOUT_MS / 1000)}s. Start with: pnpm electron:run start`);
}

async function stopSession() {
    await cleanupStaleSessionArtifacts();

    const info = getSessionInfo();
    const starting = getSessionStartingInfo();

    if (!info && !starting) {
        await killExistingSessionServerOnPort();
        await killExistingElectronOnDebugPort();
        console.log('No session running.');
        return;
    }

    if (info) {
        try {
            process.kill(info.pid, 'SIGTERM');
            console.log('Session stopped.');
        } catch {
            console.log('Session was not running.');
        }
        try { unlinkSync(sessionFile); } catch {}
    }

    if (starting?.pid && isProcessAlive(starting.pid)) {
        try { process.kill(starting.pid, 'SIGTERM'); } catch {}
    }
    const sessionPortPids = await getPidsOnPort(SERVER_PORT);
    await killPids(sessionPortPids, { signal: 'SIGKILL' });
    const cdpPortPids = await getPidsOnPort(CDP_PORT);
    await killPids(cdpPortPids, { signal: 'SIGKILL' });
    await delay(250);
    clearSessionStarting();
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
        console.log('Session already running.');
        return;
    }
    if (isSessionStarting()) {
        console.log('Session startup already in progress. Waiting for readiness...');
        const ready = await waitForSessionReady(90_000);
        if (!ready) {
            throw new Error(`Startup is still pending. Check logs: ${sessionLogFile}`);
        }
        console.log('Session is ready.');
        return;
    }

    mkdirSync(join(projectRoot, '.devkit'), { recursive: true });
    const logFd = openSync(sessionLogFile, 'w');
    const child = spawn('pnpm', ['electron:run', 'start'], {
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
        throw new Error(`Detached session failed to become ready in ${Math.round(timeoutMs / 1000)}s. Check logs: ${sessionLogFile}${details}`);
    }

    console.log(`Session started in background (pid: ${child.pid ?? 'unknown'}).`);
    console.log(`Logs: ${sessionLogFile}`);
}

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
  startd              Start session in background (detached) and return
  cleanstart          Start with fresh Nuxt server (clears stale cache)
  stop                Stop running session
  status              Check session status and Electron connection health
  restart             Stop and restart the session (useful for recovery)

Commands (require running session):
  health              Check app health status (loaded, API availability)
  screenshot [name]   Take screenshot → .devkit/screenshots/<name>.png
  console [level]     Get console messages (all|log|warn|error)
  run <code>          Run Puppeteer code (access: page, screenshot, sleep/wait)
  run-file <path>     Run Puppeteer code from a JS file
  eval <code>         Evaluate JS in page
  click <selector>    Click element
  type <sel> <text>   Type into element
  content <selector>  Get text content
  openPdf <path>      Open PDF file by absolute path

Examples:
  pnpm electron:run start
  pnpm electron:run startd
  pnpm electron:run screenshot "home"
  pnpm electron:run openPdf "/path/to/document.pdf"
  pnpm electron:run click "text=Open PDF"
  pnpm electron:run run "await sleep(500); return await page.title()"
  pnpm electron:run run-file "/tmp/flow.js"
  pnpm electron:run console error
  pnpm electron:run stop
`);
        process.exit(0);
    }

    try {
        switch (command) {
            case 'start':
                // ALWAYS use clean start for reliability - no more broken sessions
                console.log('Starting session (with fresh Nuxt and cleared cache)...');
                await startSession(true);
                break;

            case 'cleanstart':
                // Alias for start - both do the same thing now
                console.log('Starting fresh session...');
                await startSession(true);
                break;

            case 'startd':
                await startSessionDetached();
                break;

            case 'stop':
                await stopSession();
                break;

            case 'status': {
                const info = getSessionInfo();
                if (!info) {
                    console.log('No session running.');
                    process.exit(1);
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
                    process.exit(1);
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
