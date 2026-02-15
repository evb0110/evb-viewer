import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import { createCommandHandler } from './commands';
import {
    NUXT_PORT,
    SESSION_WAIT_TIMEOUT_MS,
    cleanupStaleSessionArtifacts,
    clearSessionStarting,
    electronUserDataPath,
    findFreePort,
    getCurrentSessionName,
    getPidsOnPort,
    getSessionInfo,
    getSessionStartingInfo,
    isProcessAlive,
    isSessionRunning,
    isSessionStarting,
    killPids,
    listAllSessionNames,
    listRunningSessions,
    markSessionStarting,
    projectRoot,
    readSessionLogTail,
    sessionDir,
    sessionFilePath,
    sessionLogFilePath,
    type ISessionState,
} from './shared';

let sessionState: ISessionState | null = null;

const handleCommand = createCommandHandler(() => sessionState);

async function isNuxtRunning(): Promise<boolean> {
    try {
        const res = await fetch(`http://localhost:${NUXT_PORT}`, { method: 'HEAD' });
        return res.ok;
    } catch {
        return false;
    }
}

export async function killExistingNuxt(): Promise<void> {
    try {
        const pids = await getPidsOnPort(NUXT_PORT);
        await killPids(pids);
        await delay(500);
    } catch {}
}

async function clearViteCache(): Promise<void> {
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
            if (!viteClientBuilt) {
                missing.push('Vite client');
            }
            if (!viteServerBuilt) {
                missing.push('Vite server');
            }
            if (!nitroBuilt) {
                missing.push('Nitro');
            }
            if (!viteClientWarmed) {
                missing.push('Vite warmup');
            }
            console.log(`[Nuxt] Waiting for builds: ${missing.join(', ')}`);
            lastLog = now;
        }

        await delay(500);
    }

    nuxt.kill();
    throw new Error('Nuxt server failed to start');
}

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
                (window as any).__appReady
                || (nuxtEl && nuxtEl.children.length > 0)
            );
        });
    } catch {
        return false;
    }
}

async function findAppPage(browser: Browser): Promise<Page | null> {
    const pages = await browser.pages();
    return pages.find(page => page.url().includes(`localhost:${NUXT_PORT}`)) ?? null;
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
    for (let i = 0; i < 30; i += 1) {
        page = await findAppPage(browser);
        if (page) {
            break;
        }
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

    for (let attempt = 0; attempt < 30; attempt += 1) {
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
                navigationCount += 1;
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
    return {
        browser,
        page,
    };
}

export async function startSession(forceClean = false) {
    await cleanupStaleSessionArtifacts();

    if (await isSessionRunning()) {
        console.log(`Session '${getCurrentSessionName()}' already running. Use \`pnpm electron:run stop --session=${getCurrentSessionName()}\` to stop it.`);
        return;
    }
    if (isSessionStarting()) {
        console.log(`Session '${getCurrentSessionName()}' startup already in progress. Waiting for readiness...`);
        const ready = await waitForSessionReady(90_000);
        if (!ready) {
            throw new Error(`Session '${getCurrentSessionName()}' startup is stuck. Run stop and retry.`);
        }
        return;
    }
    markSessionStarting(process.pid);

    console.log(`Starting Electron Puppeteer session '${getCurrentSessionName()}'...\n`);

    try {
        const otherRunning = (await listRunningSessions()).filter(name => name !== getCurrentSessionName());
        if (forceClean && otherRunning.length > 0) {
            console.log(`[Nuxt] ${otherRunning.length} other session(s) running (${otherRunning.join(', ')}), skipping Nuxt restart`);
            forceClean = false;
        }

        const nuxtProcess = await startNuxtServer(forceClean);

        try {
            rmSync(electronUserDataPath(), { recursive: true, force: true });
            console.log(`[Cache] Cleared ${electronUserDataPath().replace(projectRoot + '/', '')}`);
        } catch {}

        const staleInfo = getSessionInfo();
        if (staleInfo?.electronPid && isProcessAlive(staleInfo.electronPid)) {
            try {
                process.kill(staleInfo.electronPid, 'SIGKILL');
            } catch {}
            await delay(500);
        }

        const cdpPort = await findFreePort();
        const serverPort = await findFreePort();
        console.log(`[Ports] CDP: ${cdpPort}, HTTP server: ${serverPort}`);

        const electronProcess = await startElectron(cdpPort);

        let browser: Browser;
        let page: Page;
        try {
            ({
                browser,
                page,
            } = await connectToBrowser(cdpPort));
        } catch (error) {
            console.error('[Session] Failed to connect to browser, cleaning up...');
            try {
                electronProcess.kill();
            } catch {}
            try {
                nuxtProcess?.kill();
            } catch {}
            throw error;
        }

        const consoleMessages: ISessionState['consoleMessages'] = [];
        page.on('console', (msg) => {
            const entry = {
                type: msg.type(),
                text: msg.text(),
                timestamp: Date.now(),
            };
            consoleMessages.push(entry);
            console.log(`[${entry.type.toUpperCase()}] ${entry.text}`);
            if (consoleMessages.length > 100) {
                consoleMessages.shift();
            }
        });

        page.on('error', (error) => {
            const entry = {
                type: 'error',
                text: `[PAGE ERROR] ${error.message}`,
                timestamp: Date.now(),
            };
            consoleMessages.push(entry);
            console.log(`[ERROR] ${error.message}`);
            if (consoleMessages.length > 100) {
                consoleMessages.shift();
            }
        });

        page.on('pageerror', (error) => {
            const message = error instanceof Error ? error.message : String(error);
            const entry = {
                type: 'error',
                text: `[PAGE CRASH] ${message}`,
                timestamp: Date.now(),
            };
            consoleMessages.push(entry);
            console.log(`[ERROR] ${message}`);
            if (consoleMessages.length > 100) {
                consoleMessages.shift();
            }
        });

        sessionState = {
            browser,
            page,
            electronProcess,
            nuxtProcess,
            consoleMessages,
        };

        let isShuttingDown = false;
        let httpServer: ReturnType<typeof createServer> | null = null;

        const cleanupAndExit = async (exitCode: number) => {
            if (isShuttingDown) {
                return;
            }
            isShuttingDown = true;

            console.log('\nShutting down...');
            try {
                unlinkSync(sessionFilePath());
            } catch {}
            clearSessionStarting();
            httpServer?.close();

            await sessionState?.browser.disconnect().catch(() => {});
            try {
                sessionState?.electronProcess.kill();
            } catch {}

            if (sessionState?.nuxtProcess) {
                const otherNames = listAllSessionNames().filter(name => name !== getCurrentSessionName());
                const othersAlive = otherNames.some((name) => {
                    const info = getSessionInfo(name);
                    return !!(info && isProcessAlive(info.pid));
                });
                if (!othersAlive) {
                    try {
                        sessionState.nuxtProcess.kill();
                    } catch {}
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
            void cleanupAndExit(1);
        });

        browser.on('disconnected', () => {
            if (isShuttingDown) {
                return;
            }
            console.log('\n[Puppeteer] Browser disconnected');
            console.log('[Session] Lost connection to Electron - shutting down session...');
            void cleanupAndExit(1);
        });

        const server = createServer(async (req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405);
                res.end('Method not allowed');
                return;
            }

            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', async () => {
                try {
                    const {
                        command,
                        args,
                    } = JSON.parse(body) as { command: string; args: unknown[] };
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

            console.log(`\n\u2713 Session '${getCurrentSessionName()}' ready on port ${serverPort}`);
            console.log('  Press Ctrl+C to stop\n');
        });

        process.on('SIGINT', () => {
            void cleanupAndExit(0);
        });
        process.on('SIGTERM', () => {
            void cleanupAndExit(0);
        });

        await new Promise(() => {});
    } catch (error) {
        clearSessionStarting();
        throw error;
    }
}

export async function stopSingleSession(name: string) {
    await cleanupStaleSessionArtifacts(name);

    const info = getSessionInfo(name);
    const starting = getSessionStartingInfo(name);

    if (!info && !starting) {
        console.log(`No session '${name}' running.`);
        return;
    }

    if (info) {
        if (isProcessAlive(info.pid)) {
            try {
                process.kill(info.pid, 'SIGTERM');
            } catch {}
        }

        if (info.electronPid && isProcessAlive(info.electronPid)) {
            try {
                process.kill(info.electronPid, 'SIGKILL');
            } catch {}
        }

        if (info.nuxtPid && isProcessAlive(info.nuxtPid)) {
            const others = listAllSessionNames().filter(sessionName => sessionName !== name);
            const othersAlive = others.some((sessionName) => {
                const otherInfo = getSessionInfo(sessionName);
                return !!(otherInfo && isProcessAlive(otherInfo.pid));
            });
            if (!othersAlive) {
                try {
                    process.kill(info.nuxtPid, 'SIGKILL');
                } catch {}
            } else {
                console.log('[Nuxt] Left running (other sessions active)');
            }
        }

        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
    }

    if (starting?.pid && isProcessAlive(starting.pid)) {
        try {
            process.kill(starting.pid, 'SIGTERM');
        } catch {}
    }
    clearSessionStarting(name);

    await delay(250);
    console.log(`Session '${name}' stopped.`);
}

export async function stopAllSessions() {
    const names = listAllSessionNames();
    if (names.length === 0) {
        await killExistingNuxt();
        console.log('No sessions found.');
        return;
    }

    for (const name of names) {
        await stopSingleSession(name);
    }

    await killExistingNuxt();
    console.log('All sessions stopped.');
}

export async function stopSession(stopAll = false) {
    if (stopAll) {
        await stopAllSessions();
    } else {
        await stopSingleSession(getCurrentSessionName());
    }
}

export async function waitForSessionReady(timeoutMs = SESSION_WAIT_TIMEOUT_MS): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isSessionRunning()) {
            return true;
        }
        await delay(250);
    }
    return false;
}

export async function startSessionDetached() {
    await cleanupStaleSessionArtifacts();

    if (await isSessionRunning()) {
        console.log(`Session '${getCurrentSessionName()}' already running.`);
        return;
    }
    if (isSessionStarting()) {
        console.log(`Session '${getCurrentSessionName()}' startup already in progress. Waiting for readiness...`);
        const ready = await waitForSessionReady(90_000);
        if (!ready) {
            throw new Error(`Startup is still pending. Check logs: ${sessionLogFilePath()}`);
        }
        console.log('Session is ready.');
        return;
    }

    mkdirSync(sessionDir(), { recursive: true });
    const logFd = openSync(sessionLogFilePath(), 'w');
    const child = spawn('pnpm', ['electron:run', `--session=${getCurrentSessionName()}`, 'start'], {
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

    console.log(`Session '${getCurrentSessionName()}' started in background (pid: ${child.pid ?? 'unknown'}).`);
    console.log(`Logs: ${sessionLogFilePath()}`);
}
