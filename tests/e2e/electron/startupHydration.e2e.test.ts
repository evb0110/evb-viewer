import { execFileSync } from 'node:child_process';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';

const HYDRATION_CONSOLE_QUIET_WINDOW_MS = 1_500;
const HYDRATION_CONSOLE_POLL_INTERVAL_MS = 100;
const HYDRATION_CONSOLE_MAX_WAIT_MS = 10_000;
const STARTUP_READY_MAX_WAIT_MS = 60_000;
const TOOLBAR_STARTUP_SAMPLE_WINDOW_MS = 1_800;
const TOOLBAR_MIN_VISIBLE_HEIGHT_PX = 40;
const TOOLBAR_MAX_STARTUP_SHIFT_PX = 2;
const AGENTATION_CLIPBOARD_TEXT = 'Agentation E2E clipboard permission';

interface IConsoleCommandResult { messages: Array<{
    type: string;
    text: string;
    timestamp: number;
}>; }
interface IToolbarStartupRect {
    height: number;
    top: number;
    width: number;
}
interface IToolbarStartupSample {
    elapsedMs: number;
    hasShell: boolean;
    hasWorkspace: boolean;
    shell: IToolbarStartupRect | null;
    toolbar: IToolbarStartupRect | null;
    workspace: IToolbarStartupRect | null;
    toolbarText: string;
    toolbarVisible: boolean;
}
interface IStartupReadinessSample {
    appReadyAt: number | null;
    appReadyEventAt: number | null;
    appReadyObservedAt: number | null;
    claimAt: number | null;
    navigationStartedAt: number;
    overlayRemovedAt: number | null;
    pathCount: number | null;
    viewerPresentAtAppReady: boolean | null;
}

function findHydrationWarnings(messages: IConsoleCommandResult['messages']) {
    return messages.filter(message => {
        const text = message.text.toLowerCase();
        return text.includes('hydration node mismatch')
            || text.includes('hydration text content mismatch')
            || text.includes('hydration completed but contains mismatches');
    });
}

async function waitForHydrationConsoleQuiet(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => (
        document.readyState !== 'loading'
        && Boolean(document.querySelector('.app-shell-root'))
    ), {timeout: STARTUP_READY_MAX_WAIT_MS});

    const startedAt = Date.now();
    let consoleResult = await session.command<IConsoleCommandResult>('console', [
        'all',
        200,
    ]);

    while (Date.now() - startedAt < HYDRATION_CONSOLE_MAX_WAIT_MS) {
        if (findHydrationWarnings(consoleResult.messages).length > 0) {
            return consoleResult;
        }

        const latestConsoleTimestamp = Math.max(
            startedAt,
            ...consoleResult.messages.map(message => message.timestamp),
        );
        const quietForMs = Date.now() - latestConsoleTimestamp;
        if (quietForMs >= HYDRATION_CONSOLE_QUIET_WINDOW_MS) {
            return consoleResult;
        }

        await delay(Math.min(
            HYDRATION_CONSOLE_POLL_INTERVAL_MS,
            HYDRATION_CONSOLE_QUIET_WINDOW_MS - quietForMs,
        ));
        consoleResult = await session.command<IConsoleCommandResult>('console', [
            'all',
            200,
        ]);
    }

    return consoleResult;
}

async function waitForAppReady(session: IElectronE2ESession) {
    await session.page.waitForFunction(() => (
        (window as Window & {__appReady?: boolean}).__appReady === true
    ), {timeout: STARTUP_READY_MAX_WAIT_MS});
}

async function installToolbarStartupSampler(session: IElectronE2ESession) {
    await session.page.evaluateOnNewDocument((durationMs: number) => {
        const samples: IToolbarStartupSample[] = [];
        const startedAt = performance.now();

        function readRect(selector: string): IToolbarStartupRect | null {
            const element = document.querySelector(selector);
            if (!element) {
                return null;
            }

            const rect = element.getBoundingClientRect();
            return {
                height: rect.height,
                top: rect.top,
                width: rect.width,
            };
        }

        function isVisible(element: Element | null) {
            if (!element) {
                return false;
            }

            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.height > 0
                && rect.width > 0;
        }

        function sampleToolbarStartup() {
            const toolbar = document.querySelector('.editor-global-toolbar-shell .toolbar');
            samples.push({
                elapsedMs: Math.round(performance.now() - startedAt),
                hasShell: Boolean(document.querySelector('.editor-global-toolbar-shell')),
                hasWorkspace: Boolean(document.querySelector('.workspace-main-shell')),
                shell: readRect('.editor-global-toolbar-shell'),
                toolbar: readRect('.editor-global-toolbar-shell .toolbar'),
                workspace: readRect('.workspace-main-shell'),
                toolbarText: toolbar?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                toolbarVisible: isVisible(toolbar),
            });

            const appReady = (window as Window & {__appReady?: boolean}).__appReady === true;
            if (performance.now() - startedAt < durationMs || !appReady) {
                requestAnimationFrame(sampleToolbarStartup);
            }
        }

        Object.defineProperty(window, '__evbToolbarStartupSamples', {
            configurable: true,
            value: samples,
        });
        requestAnimationFrame(sampleToolbarStartup);
    }, TOOLBAR_STARTUP_SAMPLE_WINDOW_MS);
}

async function readToolbarStartupSamples(session: IElectronE2ESession) {
    return session.page.evaluate(() => (
        (window as Window & {__evbToolbarStartupSamples?: IToolbarStartupSample[];}).__evbToolbarStartupSamples ?? []
    ));
}

function getShellStartupSamples(samples: IToolbarStartupSample[]) {
    return samples.filter(sample => (
        sample.hasShell
        && sample.hasWorkspace
        && sample.shell
        && sample.workspace
    ));
}

async function installStartupReadinessSampler(session: IElectronE2ESession) {
    await session.page.evaluateOnNewDocument(() => {
        const sample: IStartupReadinessSample = {
            appReadyAt: null,
            appReadyEventAt: null,
            appReadyObservedAt: null,
            claimAt: null,
            navigationStartedAt: performance.timeOrigin,
            overlayRemovedAt: null,
            pathCount: null,
            viewerPresentAtAppReady: null,
        };
        let overlaySeen = false;
        const sampleOverlay = () => {
            const overlayPresent = document.querySelector('#evb-startup-overlay') !== null;
            if (overlayPresent) {
                overlaySeen = true;
            } else if (overlaySeen && sample.overlayRemovedAt === null) {
                sample.overlayRemovedAt = performance.now();
            }
        };
        new MutationObserver(sampleOverlay).observe(document, {
            childList: true,
            subtree: true,
        });
        window.addEventListener('evb:app-ready', () => {
            sample.appReadyEventAt = performance.now();
            sample.appReadyObservedAt = Date.now();
            sample.appReadyAt = (window as Window & {__appReadyAt?: number}).__appReadyAt ?? null;
            sample.viewerPresentAtAppReady = document.querySelector(
                '#pdf-viewer canvas, .native-pdf-page-content canvas, [data-testid="document-page-source-image"]',
            ) !== null;
            sampleOverlay();
        }, {once: true});
        window.addEventListener('evb:startup-open-claimed', (event) => {
            const detail = event instanceof CustomEvent
                ? event.detail as {pathCount?: unknown} | null
                : null;
            sample.claimAt = performance.now();
            sample.pathCount = typeof detail?.pathCount === 'number'
                ? detail.pathCount
                : null;
            sampleOverlay();
        }, {once: true});
        Object.defineProperty(window, '__evbStartupReadinessSample', {
            configurable: true,
            value: sample,
        });
    });
}

describe('Electron E2E - Startup Hydration', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-startup-hydration-${Date.now()}`});

    it('does not emit Vue hydration mismatch warnings on initial desktop startup', async () => {
        const session = sessionFixture.getSession();

        const consoleResult = await waitForHydrationConsoleQuiet(session);
        const hydrationWarnings = findHydrationWarnings(consoleResult.messages);

        expect(hydrationWarnings).toEqual([]);
        expect(session.page.url()).toContain('/electron');
    });

    it('keeps the start-page toolbar row stable across startup hydration', async () => {
        const session = sessionFixture.getSession();

        await waitForAppReady(session);
        await installToolbarStartupSampler(session);
        await session.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(session);
        await waitForHydrationConsoleQuiet(session);
        await delay(100);

        const shellSamples = getShellStartupSamples(await readToolbarStartupSamples(session));
        expect(shellSamples.length).toBeGreaterThan(0);

        const collapsedSamples = shellSamples.filter(sample => (
            (sample.shell?.height ?? 0) < TOOLBAR_MIN_VISIBLE_HEIGHT_PX
        ));
        expect(collapsedSamples).toEqual([]);

        const hiddenToolbarSamples = shellSamples.filter(sample => !sample.toolbarVisible);
        expect(hiddenToolbarSamples).toEqual([]);

        const workspaceTops = shellSamples.map(sample => sample.workspace?.top ?? 0);
        const workspaceTopShift = Math.max(...workspaceTops) - Math.min(...workspaceTops);
        expect(workspaceTopShift).toBeLessThanOrEqual(TOOLBAR_MAX_STARTUP_SHIFT_PX);

        const finalSample = shellSamples.at(-1);
        expect(finalSample?.toolbarVisible).toBe(true);
        expect(finalSample?.toolbar).not.toBeNull();
    });

    it('keeps the empty-shell overlay until app-ready and an empty startup claim', async () => {
        const session = sessionFixture.getSession();

        await waitForAppReady(session);
        await installStartupReadinessSampler(session);
        await session.page.reload({waitUntil: 'domcontentloaded'});
        await session.page.waitForFunction(() => {
            const sample = (window as Window & {__evbStartupReadinessSample?: IStartupReadinessSample;}).__evbStartupReadinessSample;
            return sample?.appReadyEventAt !== null
                && sample?.claimAt !== null
                && sample?.overlayRemovedAt !== null;
        }, {timeout: STARTUP_READY_MAX_WAIT_MS});

        const result = await session.page.evaluate(() => {
            const sample = (window as Window & {__evbStartupReadinessSample?: IStartupReadinessSample;}).__evbStartupReadinessSample;
            return {
                sample,
                appReady: (window as Window & {__appReady?: boolean}).__appReady ?? false,
                shellInteractiveAt: performance
                    .getEntriesByName('evb:shell-interactive', 'mark')
                    .at(-1)?.startTime ?? null,
            };
        });

        expect(result.appReady).toBe(true);
        expect(result.sample?.pathCount).toBe(0);
        expect(result.sample?.viewerPresentAtAppReady).toBe(false);
        expect(result.shellInteractiveAt).not.toBeNull();
        expect(result.sample?.appReadyEventAt).not.toBeNull();
        expect(result.sample?.claimAt).not.toBeNull();
        expect(result.sample?.overlayRemovedAt).not.toBeNull();
        expect(result.shellInteractiveAt!).toBeLessThanOrEqual(result.sample!.appReadyEventAt!);
        expect(result.sample!.appReadyEventAt!).toBeLessThan(result.sample!.overlayRemovedAt!);
        expect(result.sample!.claimAt!).toBeLessThan(result.sample!.overlayRemovedAt!);
        expect(result.sample!.appReadyAt!).toBeGreaterThanOrEqual(result.sample!.navigationStartedAt);
        expect(result.sample!.appReadyAt!).toBeLessThanOrEqual(result.sample!.appReadyObservedAt!);
    });

    it('copies Agentation feedback and auto-clears it after a successful clipboard write', async () => {
        const session = sessionFixture.getSession();

        const originalMacClipboard = process.platform === 'darwin'
            ? execFileSync('pbpaste', {encoding: 'utf8'})
            : null;

        try {
            const annotationStorageKey = await session.page.evaluate((feedbackText) => {
                const pagePath = window.location.hash.startsWith('#')
                    ? window.location.hash.replace(/^#!?/u, '') || '/'
                    : window.location.pathname;
                const storageKey = `feedback-annotations-${pagePath}`;
                localStorage.setItem('feedback-toolbar-settings', JSON.stringify({autoClearAfterCopy: true}));
                localStorage.setItem(storageKey, JSON.stringify([{
                    id: 'agentation-clipboard-e2e',
                    x: 50,
                    y: 120,
                    comment: feedbackText,
                    element: 'start page',
                    elementPath: '.app-shell-root',
                    timestamp: Date.now(),
                    boundingBox: {
                        x: 20,
                        y: 20,
                        width: 200,
                        height: 100,
                    },
                }]));
                return storageKey;
            }, AGENTATION_CLIPBOARD_TEXT);

            await session.page.reload({waitUntil: 'domcontentloaded'});
            await waitForHydrationConsoleQuiet(session);
            await session.page.click('[data-feedback-toolbar] > div');
            await session.page.waitForSelector('[data-annotation-marker]');
            await session.page.waitForSelector(
                '[data-feedback-toolbar] button[aria-label="Copy as markdown"]:not([disabled])',
            );
            await session.page.click('[data-feedback-toolbar] button[aria-label="Copy as markdown"]');
            await session.page.waitForFunction((storageKey) => (
                localStorage.getItem(storageKey) === null
                && document.querySelector('[data-annotation-marker]') === null
            ), {timeout: 5_000}, annotationStorageKey);

            if (process.platform === 'darwin') {
                const clipboardText = execFileSync('pbpaste', {encoding: 'utf8'});
                expect(clipboardText).toContain(AGENTATION_CLIPBOARD_TEXT);
            }
        } finally {
            if (originalMacClipboard !== null) {
                execFileSync('pbcopy', {input: originalMacClipboard});
            }
        }
    });
});
