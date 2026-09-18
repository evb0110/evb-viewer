import { getErrorMessage } from '@contracts/getErrorMessage';
import puppeteer, {
    type Browser,
    type HTTPResponse,
    type Page,
} from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import {
    getElectronAppUrl,
    waitForReusableNuxtServer,
} from '@scripts/electron-run/electronRunNuxtServer';
import {
    isElectronAppPageUrl,
    isNuxtDevServerUrl,
} from '@scripts/electron-run/appRendererUrl';
import { createStartupLogger } from '@scripts/electron-run/createStartupLogger';
export {
    isElectronAppPageUrl,
    isNuxtDevServerUrl,
} from '@scripts/electron-run/appRendererUrl';

const RENDERER_READY_TIMEOUT_MS = 30_000;
const ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS = 20_000;
const VITE_OPTIMIZE_DEP_ERROR_MARKER = 'VITE_OPTIMIZE_DEP_504';
const RENDERER_READINESS_ERROR_NAME = 'RendererReadinessError';
const RETRYABLE_RENDERER_BINDINGS_ERROR_NAME = 'RetryableRendererBindingsError';
const RETRYABLE_RENDERER_BODY_ERROR_NAME = 'RetryableRendererBodyError';
const RENDERER_BODY_PROBE_TIMEOUT_MS = 5_000;
const BROWSER_PAGE_DISCOVERY_TIMEOUT_MS = 5_000;
const RENDERER_DEAD_PAGE_RELOAD_INTERVAL_MS = 5_000;
const RENDERER_DEAD_PAGE_MAX_RELOADS = 5;

function createViteOptimizeDepError(details = '') {
    const message = details
        ? `${VITE_OPTIMIZE_DEP_ERROR_MARKER}: ${details}`
        : VITE_OPTIMIZE_DEP_ERROR_MARKER;
    const error = new Error(message);
    error.name = 'ViteOptimizeDepError';
    return error;
}

export function isViteOptimizeDepError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }
    return error.name === 'ViteOptimizeDepError'
        || getErrorMessage(error).includes(VITE_OPTIMIZE_DEP_ERROR_MARKER)
        || getErrorMessage(error).includes('Outdated Optimize Dep')
        || getErrorMessage(error).includes('optimize-dep');
}

function createRendererReadinessError(message: string) {
    const error = new Error(message);
    error.name = RENDERER_READINESS_ERROR_NAME;
    return error;
}

export function isRendererReadinessError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }
    return error.name === RENDERER_READINESS_ERROR_NAME
        || getErrorMessage(error).includes('Renderer readiness timeout')
        || getErrorMessage(error).includes('Renderer startup timed out');
}

export function isTransientPageContextError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return getErrorMessage(error).includes('Execution context was destroyed')
        || getErrorMessage(error).includes('Attempted to use detached Frame')
        || getErrorMessage(error).includes('Cannot find context with specified id')
        || getErrorMessage(error).includes('Most likely the page has been closed');
}

async function checkHydration(page: Page) {
    try {
        return await page.evaluate(() => {
            const automationWindow = window as Window & {__appReady?: boolean;};
            const nuxtEl = document.querySelector('#__nuxt');
            return !!(
                automationWindow.__appReady === true
                || (nuxtEl !== null && nuxtEl.children.length > 0)
            );
        });
    } catch {
        return false;
    }
}

export interface IRendererState {
    openFileDirect: string;
    electronAPI: string;
    nuxtRootChildren: number;
    bodyTextLength: number;
    bodyTextSnippet: string;
    url: string;
}

function readRendererState(page: Page): Promise<IRendererState> {
    return page.evaluate(() => {
        const automationWindow = window as Window & {
            __openFileDirect?: unknown;
            electronAPI?: unknown;
        };
        const nuxtEl = document.querySelector('#__nuxt');
        // lib.dom declares document.body non-null, but this probe runs while the
        // renderer may still be parsing, so query for the element instead.
        const body = document.querySelector('body');
        const bodyText = body === null ? '' : body.innerText.trim();
        return {
            openFileDirect: typeof automationWindow.__openFileDirect,
            electronAPI: typeof automationWindow.electronAPI,
            nuxtRootChildren: nuxtEl?.children.length ?? 0,
            bodyTextLength: bodyText.length,
            bodyTextSnippet: bodyText.replace(/\s+/g, ' ').slice(0, 240),
            url: window.location.href,
        };
    });
}

export function classifyRendererBindingReadiness(state: IRendererState) {
    if (
        state.openFileDirect === 'function'
        && state.electronAPI === 'object'
        && state.nuxtRootChildren > 0
    ) {
        return 'ready' as const;
    }
    if (
        state.nuxtRootChildren > 0
        && state.electronAPI !== 'object'
    ) {
        // Electron runs preload before page JavaScript. Once Nuxt has mounted,
        // a missing bridge cannot recover inside this renderer. Treat it as a
        // failed launch immediately so the outer launch owner can retry with a
        // fresh process instead of spending the whole readiness allowance.
        return 'retryable-preload-missing' as const;
    }
    return 'waiting' as const;
}

function isRendererReady(state: IRendererState) {
    return classifyRendererBindingReadiness(state) === 'ready';
}

function createRetryableRendererBindingsError(state: IRendererState) {
    const error = new Error(
        `Renderer preload bindings are unavailable after hydration (openFileDirect=${state.openFileDirect}, electronAPI=${state.electronAPI}, nuxtChildren=${state.nuxtRootChildren}, url=${state.url})`,
    );
    error.name = RETRYABLE_RENDERER_BINDINGS_ERROR_NAME;
    return error;
}

function createRetryableRendererBodyError() {
    const error = new Error(
        `Renderer body probe did not respond within ${String(RENDERER_BODY_PROBE_TIMEOUT_MS)}ms`,
    );
    error.name = RETRYABLE_RENDERER_BODY_ERROR_NAME;
    return error;
}

export async function probeRendererBody(
    page: Pick<Page, 'evaluate'>,
    timeoutMs = RENDERER_BODY_PROBE_TIMEOUT_MS,
) {
    const timeoutMarker = {};
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
        // Readiness needs a boolean, not an element handle from Puppeteer's
        // isolated DOM-query realm, which may still be initializing on attach.
        const result = await Promise.race([
            page.evaluate(() => Boolean(document.body)),
            new Promise<typeof timeoutMarker>((resolve) => {
                timeoutHandle = setTimeout(() => resolve(timeoutMarker), timeoutMs);
            }),
        ]);
        if (result === timeoutMarker) {
            return 'unresponsive' as const;
        }
        return result === true ? 'ready' as const : 'waiting' as const;
    } finally {
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
        }
    }
}

function hasRendererDeadDevServerBody(state: IRendererState) {
    return state.bodyTextSnippet.includes('Failed to fetch dynamically imported module')
        || state.bodyTextSnippet.includes('500 Internal Server Error');
}

async function waitForRendererBindings(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
    timeoutMs = RENDERER_READY_TIMEOUT_MS,
): Promise<{
    page: Page;
    state: IRendererState;
}> {
    const start = Date.now();
    let currentPage = page;
    let reloadCount = 0;
    let lastReloadAt = 0;
    let lastState: IRendererState = {
        openFileDirect: 'undefined',
        electronAPI: 'undefined',
        nuxtRootChildren: 0,
        bodyTextLength: 0,
        bodyTextSnippet: '',
        url: currentPage.url(),
    };
    while (Date.now() - start < timeoutMs) {
        currentPage = await reattachToAppPage(browser, currentPage, watcher.attach);
        try {
            lastState = await readRendererState(currentPage);
        } catch {
            await delay(250);
            continue;
        }
        const readiness = classifyRendererBindingReadiness(lastState);
        if (readiness === 'ready') {
            return {
                page: currentPage,
                state: lastState,
            };
        }
        if (readiness === 'retryable-preload-missing') {
            throw createRetryableRendererBindingsError(lastState);
        }
        const now = Date.now();
        if (
            hasRendererDeadDevServerBody(lastState)
            && reloadCount < RENDERER_DEAD_PAGE_MAX_RELOADS
            && now - lastReloadAt >= RENDERER_DEAD_PAGE_RELOAD_INTERVAL_MS
        ) {
            reloadCount += 1;
            lastReloadAt = now;
            console.log(`[Puppeteer] Renderer loaded transient dev-server error, reloading (${reloadCount}/${RENDERER_DEAD_PAGE_MAX_RELOADS})...`);
            try {
                await currentPage.reload({
                    waitUntil: 'domcontentloaded',
                    timeout: 10_000,
                });
            } catch (error) {
                if (!isTransientPageContextError(error) && !isNavigationAbortedError(error)) {
                    console.log(`[Puppeteer] Renderer reload failed while recovering from transient dev-server error: ${getErrorMessage(error)}`);
                }
            }
        }
        await delay(250);
    }
    return {
        page: currentPage,
        state: lastState,
    };
}

async function reattachToAppPage(
    browser: Browser,
    currentPage: Page,
    onPageChanged?: (page: Page) => void,
): Promise<Page> {
    const freshPage = await findAppPage(browser);
    if (freshPage && freshPage !== currentPage) {
        onPageChanged?.(freshPage);
        return freshPage;
    }
    return currentPage;
}

export function selectNewestElectronAppPage<TPage extends {
    isClosed: () => boolean;
    url: () => string;
}>(pages: readonly TPage[]): TPage | null {
    for (let index = pages.length - 1; index >= 0; index -= 1) {
        const page = pages[index];
        if (page && !page.isClosed() && isElectronAppPageUrl(page.url())) {
            return page;
        }
    }
    return null;
}

async function getBrowserPages(
    browser: Pick<Browser, 'pages'>,
    timeoutMs = BROWSER_PAGE_DISCOVERY_TIMEOUT_MS,
): Promise<Page[]> {
    // Puppeteer attaches every page target before browser.pages() resolves. A
    // stuck CDP target attach must fail inside the launch deadline so the
    // existing Electron recovery loop can replace this process.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            browser.pages(),
            new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new Error(`Puppeteer page discovery did not respond within ${String(timeoutMs)}ms`));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
        }
    }
}

export async function findAppPage(
    browser: Pick<Browser, 'pages'>,
    timeoutMs = BROWSER_PAGE_DISCOVERY_TIMEOUT_MS,
): Promise<Page | null> {
    return selectNewestElectronAppPage(await getBrowserPages(browser, timeoutMs));
}

async function waitForAppPage(browser: Browser, timeoutMs: number): Promise<Page | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const page = await findAppPage(browser);
        if (page) {
            return page;
        }
        await delay(250);
    }
    return null;
}

function isNavigationAbortedError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }
    return getErrorMessage(error).includes('net::ERR_ABORTED');
}

async function waitForElectronPageTarget(cdpPort: number, timeoutMs = 30_000) {
    const start = Date.now();
    let lastLoggedTargets = '';
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
            if (res.ok) {
                const targets = await res.json() as Array<{
                    type: string;
                    url: string;
                    webSocketDebuggerUrl?: string;
                }>;
                const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
                if (pageTarget?.webSocketDebuggerUrl) {
                    console.log(`[CDP] Discovered page target: ${pageTarget.url}`);
                    return;
                }
                const summary = JSON.stringify(targets.map(t => ({
                    type: t.type,
                    url: t.url,
                })));
                if (summary !== lastLoggedTargets) {
                    console.log(`[CDP] /json/list targets: ${summary}`);
                    lastLoggedTargets = summary;
                }
            }
        } catch {
            // CDP endpoint not ready yet.
        }
        await delay(500);
    }
    throw new Error(`No Electron page target found via /json/list within ${Math.round(timeoutMs / 1000)}s`);
}

async function getBrowserWsEndpoint(cdpPort: number) {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (!res.ok) {
        throw new Error(`Failed to fetch /json/version: HTTP ${res.status}`);
    }
    const data = await res.json() as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) {
        throw new Error('/json/version did not include webSocketDebuggerUrl');
    }
    return data.webSocketDebuggerUrl;
}

async function connectPuppeteerWithRetries(browserWsUrl: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            return await Promise.race([
                puppeteer.connect({
                    browserWSEndpoint: browserWsUrl,
                    defaultViewport: null,
                }),
                delay(5000).then(() => {
                    throw new Error('CDP connect timeout');
                }),
            ]);
        } catch (error) {
            if (attempt === 0 || attempt === 4 || attempt === 9) {
                const message = getErrorMessage(error);
                console.log(`[Puppeteer] CDP connect retry ${attempt + 1}/10: ${message}`);
            }
            await delay(500);
        }
    }

    throw new Error('Could not connect to Electron CDP');
}

async function findInitialElectronPage(browser: Browser) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS) {
        const page = await findAppPage(browser);
        if (!page) {
            const allPages = await getBrowserPages(browser);
            const fallbackPage = allPages.find(candidate => !candidate.isClosed()) ?? null;
            if (fallbackPage) {
                return fallbackPage;
            }
        } else {
            return page;
        }
        await delay(500);
    }

    throw new Error('No Electron page found after CDP connection');
}

async function ensureAppPageLoaded(
    browser: Browser,
    page: Page,
    logTiming: (message: string) => void,
) {
    if (isElectronAppPageUrl(page.url())) {
        return page;
    }

    const appLoadedPage = await waitForAppPage(browser, ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS);
    if (appLoadedPage) {
        logTiming('Electron app page appeared without fallback navigation');
        return appLoadedPage;
    }

    try {
        await waitForReusableNuxtServer(30_000);
        await page.goto(getElectronAppUrl(), {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
        });
        logTiming('Fallback navigation to Electron app URL complete');
        return page;
    } catch (error) {
        if (!isNavigationAbortedError(error)) {
            throw error;
        }
        const recoveredPage = await waitForAppPage(browser, ELECTRON_APP_PAGE_APPEAR_TIMEOUT_MS);
        if (!recoveredPage) {
            throw error;
        }
        logTiming('Recovered from aborted fallback navigation');
        return recoveredPage;
    }
}

function createOptimizeDepWatcher() {
    let trackedPage: Page | null = null;
    let responseListener: ((response: HTTPResponse) => void) | null = null;
    let sawOutdatedOptimizeDep = false;
    let optimizeDepUrl: string | null = null;

    return {
        attach(nextPage: Page) {
            if (trackedPage && responseListener) {
                trackedPage.off('response', responseListener);
            }
            trackedPage = nextPage;
            responseListener = (response) => {
                if (response.status() === 504 && isNuxtDevServerUrl(response.url())) {
                    sawOutdatedOptimizeDep = true;
                    optimizeDepUrl = response.url();
                }
            };
            trackedPage.on('response', responseListener);
        },
        detach() {
            if (trackedPage && responseListener) {
                trackedPage.off('response', responseListener);
            }
        },
        reset() {
            sawOutdatedOptimizeDep = false;
            optimizeDepUrl = null;
        },
        sawOutdatedOptimizeDep() {
            return sawOutdatedOptimizeDep;
        },
        optimizeDepUrl() {
            return optimizeDepUrl;
        },
    };
}

type TOptimizeDepWatcher = ReturnType<typeof createOptimizeDepWatcher>;

async function waitForBodyElement(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
) {
    const startedAt = Date.now();
    let currentPage = page;
    while (Date.now() - startedAt < RENDERER_READY_TIMEOUT_MS) {
        const nextPage = await findAppPage(browser);
        if (nextPage && nextPage !== currentPage) {
            console.log('[Puppeteer] App target changed during initial load, re-attaching...');
            currentPage = nextPage;
            watcher.attach(currentPage);
        }
        if (!currentPage.isClosed()) {
            try {
                const bodyProbe = await probeRendererBody(currentPage);
                if (bodyProbe === 'unresponsive') {
                    throw createRetryableRendererBodyError();
                }
                if (bodyProbe === 'ready') {
                    return currentPage;
                }
            } catch (error) {
                if (!isTransientPageContextError(error)) {
                    throw error;
                }
            }
        }
        await delay(250);
    }
    throw createRendererReadinessError(`Renderer startup timed out after ${String(RENDERER_READY_TIMEOUT_MS)}ms while waiting for body on the newest app target`);
}

async function waitForHydration(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
): Promise<{
    page: Page;
    hydrated: boolean;
}> {
    let navigationCount = 0;
    const MAX_NAVIGATIONS = 3;

    return pollHydration(browser, page, watcher, {
        delayMs: 500,
        onOutdated: () => {
            console.log('[Puppeteer] Detected Vite 504 (Outdated Optimize Dep), reloading...');
        },
        onInterval: async (current) => {
            const freshPage = await findAppPage(browser);
            if (freshPage && freshPage !== current) {
                navigationCount += 1;
                console.log(`[Puppeteer] Page navigated (${navigationCount}/${MAX_NAVIGATIONS}), re-attaching...`);
                if (navigationCount > MAX_NAVIGATIONS) {
                    console.log('[Puppeteer] Too many navigations, proceeding with current page');
                    return null;
                }
                watcher.attach(freshPage);
                return freshPage;
            }
            return current;
        },
    });
}

async function reloadAndWaitForHydration(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
): Promise<{
    page: Page;
    hydrated: boolean;
}> {
    let currentPage = page;
    try {
        await currentPage.goto(getElectronAppUrl(), { waitUntil: 'networkidle2' });
    } catch {
        await delay(2000);
        currentPage = await findAppPage(browser) ?? currentPage;
        watcher.attach(currentPage);
    }

    await delay(1500);
    currentPage = await reattachToAppPage(browser, currentPage, watcher.attach);
    return pollHydration(browser, currentPage, watcher, {
        delayMs: 350,
        onInterval: async (page) => reattachToAppPage(browser, page, watcher.attach),
    });
}

async function pollHydration(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
    options: {
        delayMs: number;
        onInterval: (page: Page, attempt: number) => Promise<Page | null>;
        onOutdated?: () => void;
    },
): Promise<{
    page: Page;
    hydrated: boolean;
}> {
    let currentPage = page;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        if (watcher.sawOutdatedOptimizeDep()) {
            options.onOutdated?.();
            break;
        }
        try {
            if (await checkHydration(currentPage)) {
                return {
                    page: currentPage,
                    hydrated: true,
                };
            }
        } catch (error) {
            if (!isTransientPageContextError(error)) {
                throw error;
            }
            currentPage = await reattachToAppPage(browser, currentPage, watcher.attach);
            await delay(250);
            continue;
        }
        if (attempt > 0 && attempt % 5 === 0) {
            const next = await options.onInterval(currentPage, attempt);
            if (next === null) {
                break;
            }
            currentPage = next;
        }
        await delay(options.delayMs);
    }

    return {
        page: currentPage,
        hydrated: false,
    };
}

async function waitForReadyRenderer(
    browser: Browser,
    page: Page,
    watcher: TOptimizeDepWatcher,
) {
    let currentPage = await reattachToAppPage(browser, page, watcher.attach);
    const result = await waitForRendererBindings(
        browser,
        currentPage,
        watcher,
        RENDERER_READY_TIMEOUT_MS,
    );
    currentPage = result.page;
    const rendererState = result.state;
    if (!isRendererReady(rendererState)) {
        if (watcher.sawOutdatedOptimizeDep()) {
            throw createViteOptimizeDepError(watcher.optimizeDepUrl() ?? 'Outdated Optimize Dep while waiting for renderer bindings');
        }
        throw createRendererReadinessError(`Renderer readiness timeout (openFileDirect=${rendererState.openFileDirect}, electronAPI=${rendererState.electronAPI}, nuxtChildren=${rendererState.nuxtRootChildren}, text=${rendererState.bodyTextLength}, url=${rendererState.url}, body="${rendererState.bodyTextSnippet}")`);
    }
    return currentPage;
}

export async function connectToBrowser(cdpPort: number): Promise<{
    browser: Browser;
    page: Page
}> {
    const logTiming = createStartupLogger();
    console.log('[Puppeteer] Connecting via CDP...');

    await waitForElectronPageTarget(cdpPort);
    logTiming('Electron page target available');
    const browser = await connectPuppeteerWithRetries(await getBrowserWsEndpoint(cdpPort));
    logTiming('Puppeteer connected to CDP');

    let page = await findInitialElectronPage(browser);
    page = await ensureAppPageLoaded(browser, page, logTiming);

    const optimizeDepWatcher = createOptimizeDepWatcher();
    optimizeDepWatcher.attach(page);
    try {
        page = await waitForBodyElement(browser, page, optimizeDepWatcher);
        console.log('[Puppeteer] Waiting for Vue to hydrate...');
        logTiming('Renderer body available');

        const hydrationResult = await waitForHydration(browser, page, optimizeDepWatcher);
        page = hydrationResult.page;
        if (!hydrationResult.hydrated || optimizeDepWatcher.sawOutdatedOptimizeDep()) {
            if (!hydrationResult.hydrated) {
                console.log('[Puppeteer] Vue not ready, reloading page...');
            }
            optimizeDepWatcher.reset();
            const reloadResult = await reloadAndWaitForHydration(browser, page, optimizeDepWatcher);
            page = reloadResult.page;
            if (optimizeDepWatcher.sawOutdatedOptimizeDep()) {
                throw createViteOptimizeDepError(optimizeDepWatcher.optimizeDepUrl() ?? 'Outdated Optimize Dep after reload');
            }
            if (!reloadResult.hydrated) {
                console.log('[Puppeteer] Warning: Vue may not be fully hydrated after reload');
            }
        }

        page = await waitForReadyRenderer(browser, page, optimizeDepWatcher);
        console.log('[Puppeteer] Connected to app');
        logTiming('Renderer bindings ready');
        return {
            browser,
            page,
        };
    } finally {
        optimizeDepWatcher.detach();
    }
}
