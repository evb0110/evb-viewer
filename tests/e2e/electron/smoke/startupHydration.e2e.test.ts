import {
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import {
    mkdtempSync, copyFileSync, readFileSync, writeFileSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {waitForPdfLoaded} from '@tests/e2e/electron/helpers/viewerCore';
import {readWorkspaceStateValues} from '@tests/e2e/electron/helpers/workspaceExpose';
import {createNewWorkspaceTab} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    activateMenuItemAsUser,
    clickAsUser,
} from '@tests/e2e/electron/helpers/userInput';

const HYDRATION_CONSOLE_QUIET_WINDOW_MS = 1_500;
const HYDRATION_CONSOLE_POLL_INTERVAL_MS = 100;
const HYDRATION_CONSOLE_MAX_WAIT_MS = 10_000;
const STARTUP_READY_MAX_WAIT_MS = 60_000;
const TOOLBAR_STARTUP_SAMPLE_WINDOW_MS = 1_800;
const TOOLBAR_MIN_VISIBLE_HEIGHT_PX = 40;
const TOOLBAR_MAX_STARTUP_SHIFT_PX = 2;

describe('Electron E2E - startup external-open ownership', () => {
    it('opens one encrypted startup document after a password wait longer than 30 seconds', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-startup-claim-evidence-'));
        const requested = join(directory, 'encrypted-startup.pdf');
        writeFileSync(requested, Buffer.from(readFileSync(
            resolve('tests/fixtures/electron/password-protected.pdf.b64'), 'utf8',
        ).trim(), 'base64'));
        let session: IElectronE2ESession | null = null;
        try {
            session = await startElectronE2ESession(`e2e-startup-claim-${Date.now()}`, {
                initialOpenPaths: [requested],
                extraEnv: {EVB_E2E_OPEN_DIALOG_PATH: requested},
            });
            const {page} = session;
            const passwordInput = '[role="dialog"] input[type="password"]';
            await page.waitForSelector(passwordInput, {visible: true});
            await page.screenshot({path: join(directory, 'password-prompt.png')});
            const holdStartedAt = Date.now();
            // Bounded harness hold reproduces a person leaving the real prompt open.
            await delay(31_000);
            const heldForMs = Date.now() - holdStartedAt;
            await page.screenshot({path: join(directory, 'held-password-prompt.png')});
            expect(heldForMs).toBeGreaterThan(30_000);
            expect(await page.evaluate(() => Boolean(document.getElementById('evb-startup-overlay'))),
                'the startup loading overlay must not cover the password prompt').toBe(false);
            await clickAsUser(page, passwordInput);
            await page.keyboard.type('frame-secret');
            await page.keyboard.press('Enter');
            await waitForPdfLoaded(page);
            await page.waitForFunction(() => (
                (window as IE2EWindow).__evbTestApi?.isStartupOpenClaimPending() === false
            ));
            // Observe the manager's queued delivery after startup has settled.
            await delay(HYDRATION_CONSOLE_QUIET_WINDOW_MS);
            const first = await readWorkspaceStateValues(page, [
                'documentIdentity',
                'originalPath',
            ]);
            const startup = await page.evaluate(() => ({
                passwordPrompts: document.querySelectorAll('[role="dialog"] input[type="password"]').length,
                tabs: Array.from(document.querySelectorAll<HTMLElement>('.tab[data-tab-id]')).map(tab => ({
                    id: tab.dataset.tabId,
                    label: tab.querySelector('.tab-label')?.textContent?.trim(),
                })),
            }));
            writeFileSync(join(directory, 'startup.json'), JSON.stringify({
                heldForMs,
                first,
                startup,
            }, null, 2));
            await page.screenshot({path: join(directory, 'startup-settled.png')});
            console.log(`[startup claim evidence] ${directory}`);
            expect(startup.passwordPrompts, 'one startup request must not prompt again').toBe(0);
            expect(startup.tabs).toHaveLength(1);
            expect(first.originalPath).toBe(requested);
            expect(first.documentIdentity).toBeTruthy();

            // T4: opening the same source in a new tab creates its own document.
            await createNewWorkspaceTab(session);
            await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+O'});
            await page.waitForSelector(passwordInput, {visible: true});
            await clickAsUser(page, passwordInput);
            await page.keyboard.type('frame-secret');
            await page.keyboard.press('Enter');
            await waitForPdfLoaded(page);
            await page.waitForFunction(() => (
                document.querySelectorAll('.tab[data-tab-id]').length === 2
                && !document.querySelector('[role="dialog"] input[type="password"]')
            ));
            const second = await readWorkspaceStateValues(page, [
                'documentIdentity',
                'originalPath',
            ]);
            expect(second.originalPath).toBe(requested);
            expect(second.documentIdentity).toBeTruthy();
            expect(second.documentIdentity).not.toEqual(first.documentIdentity);
            await clickAsUser(page, `.tab[data-tab-id="${startup.tabs[0]!.id}"]`);
            expect((await readWorkspaceStateValues(page, ['documentIdentity'])).documentIdentity).toEqual(first.documentIdentity);
            writeFileSync(join(directory, 'deliberate-open.json'), JSON.stringify({
                first,
                second,
            }, null, 2));
            await page.screenshot({path: join(directory, 'deliberate-open.png')});
        } catch (error) {
            await session?.captureFailureArtifacts('startup-claim-password-wait');
            throw error;
        } finally {
            await session?.stop({preserveArtifacts: true});
            await rm(requested, {force: true});
        }
    });
});

describe.skipIf(process.platform === 'win32')('Electron E2E - literal POSIX quoted filename', () => {
    it('opens and renders a literal quoted PDF filename on a cold CLI launch', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-e2e-quoted-startup-'));
        const requested = join(directory, '"quoted.pdf"');
        copyFileSync(resolve('tests/fixtures/electron/generated-text.pdf'), requested);
        let session: IElectronE2ESession | null = null;
        try {
            session = await startElectronE2ESession(`e2e-quoted-startup-${Date.now()}`, {initialOpenPaths: [requested]});
            await waitForPdfLoaded(session.page, 30_000);
            expect((await readWorkspaceStateValues(session.page, ['originalPath'])).originalPath).toBe(requested);
            const text = await session.page.$eval('.workspace-host[data-workspace-active="true"] .textLayer', element => element.textContent);
            expect(text).toContain('Hello Arabic world');
        } catch (error) {
            await session?.captureFailureArtifacts('quoted-cold-launch');
            throw error;
        } finally {
            await session?.stop({preserveArtifacts: true});
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    }, 120_000);
});

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
    workspace: IToolbarStartupRect | null;
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

        function sampleToolbarStartup() {
            samples.push({
                elapsedMs: Math.round(performance.now() - startedAt),
                hasShell: Boolean(document.querySelector('.editor-global-toolbar-shell')),
                hasWorkspace: Boolean(document.querySelector('.workspace-main-shell')),
                shell: readRect('.editor-global-toolbar-shell'),
                workspace: readRect('.workspace-main-shell'),
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
                '#pdf-viewer canvas, [data-testid="document-page-source-image"]',
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

async function expectStableToolbarAcrossReload(session: IElectronE2ESession) {
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

    const workspaceTops = shellSamples.map(sample => sample.workspace?.top ?? 0);
    const workspaceTopShift = Math.max(...workspaceTops) - Math.min(...workspaceTops);
    expect(workspaceTopShift).toBeLessThanOrEqual(TOOLBAR_MAX_STARTUP_SHIFT_PX);
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
        await expectStableToolbarAcrossReload(sessionFixture.getSession());
    });

    it('keeps the start-page toolbar row stable with a non-default UI scale', async () => {
        const session = sessionFixture.getSession();

        await waitForAppReady(session);
        await session.page.evaluate(async () => {
            const saveSettings = (window as IE2EWindow).electronAPI?.settings.save;
            if (!saveSettings) {
                throw new Error('Electron settings save bridge is unavailable');
            }
            await saveSettings({uiScale: 'large'});
        });
        // Main hands the stored preference to a window when it creates it.
        const restarted = await sessionFixture.restart({
            clean: false,
            hard: true,
        });
        await expectStableToolbarAcrossReload(restarted);
        expect(await restarted.page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('20px');
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
});
