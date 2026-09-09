import {
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import type {
    Browser,
    Page,
} from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import { sendCommand } from '@scripts/electron-run/sendCommand';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    buildElectronE2EAutomationEnv,
    buildVisibleWindowElectronE2EAutomationEnv,
} from '@scripts/electron-run/electronRunLaunchConfig';
import { DEFAULT_NUXT_PORT } from '@scripts/electron-run/electronRunPortConfig';
import { assertE2ESessionName } from '@scripts/electron-run/electronRunE2ESessionPrune';
import { isProcessAlive } from '@scripts/electron-run/electronRunProcessTree';
import { formatElectronStartupDiagnostics } from '@scripts/electron-run/electronRunStartupDiagnostics';
import {
    getSessionInfo,
    getSessionStartingInfo,
    readSessionLogTail,
    waitForSessionReady,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    releaseCurrentSessionName,
    sessionDir,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    buildStrictE2ERunEnv,
    createE2ERunScopedSessionName,
} from '@scripts/electron-run/electronRunRunId';
import { readE2ESharedRendererConfig } from '@scripts/electron-run/electronRunE2ESharedRenderer';
import type { TElectronRunCommand } from '@scripts/electron-run/electronRunProtocol';
import {
    DEFAULT_SETTINGS,
    pickSettingsSavePatch,
} from '@contracts/settings';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import {
    E2E_SESSION_START_TIMEOUT_MS,
    startSessionDetached,
} from '@scripts/electron-run/startSessionDetached';
import { stopSingleSession } from '@scripts/electron-run/stopSession';
import { cleanupSessionFixtures } from '@tests/e2e/electron/helpers/fixtures';
import {
    installPageEvaluationShims,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    createElectronE2EHealthReadinessFailure,
    ElectronE2EInfrastructureError,
    runElectronE2EInfrastructureStage,
    runElectronE2EProcessLaunchStage,
    runElectronE2ETeardown,
    runWithElectronE2EDeadline,
} from '@tests/e2e/electron/helpers/electronE2ESessionFailure';

const SESSION_READY_TIMEOUT_MS = E2E_SESSION_START_TIMEOUT_MS;
const RENDERER_READY_TIMEOUT_MS = 30_000;
const SESSION_STOP_TIMEOUT_MS = 15_000;
const PRESERVE_E2E_ARTIFACTS_ENV = 'EVB_E2E_PRESERVE_ARTIFACTS';
const FAILURE_ARTIFACTS_BASE_DIR = join(projectRoot, '.devkit', 'test', 'electron-e2e-artifacts');
const SHARED_RENDERER_CLIENT_IDLE_MS = 10_000;
const SHARED_RENDERER_CLIENT_SETTLE_TIMEOUT_MS = 75_000;
const SHARED_RENDERER_CLIENT_RECOVERY_ATTEMPTS = 2;
const SHARED_RENDERER_CLIENT_STABILIZE_TIMEOUT_MS = SHARED_RENDERER_CLIENT_SETTLE_TIMEOUT_MS
    * (SHARED_RENDERER_CLIENT_RECOVERY_ATTEMPTS * 3 - 2);
let sharedRendererClientStabilized = false;

export interface IElectronE2ESession {
    name: string;
    browser: Browser;
    page: Page;
    command: <T = unknown>(command: TElectronRunCommand, args?: unknown[], timeoutMs?: number) => Promise<T>;
    captureFailureArtifacts: (label: string) => Promise<IElectronE2EFailureArtifacts>;
    resetForE2E: () => Promise<void>;
    stop: (options?: IElectronE2ESessionStopOptions) => Promise<void>;
}

export interface IElectronE2EFailureArtifacts {
    diagnosticsPath: string;
    screenshotError: string | null;
    screenshotPath: string | null;
}

export interface IElectronE2ESessionStopOptions {
    keepNuxt?: boolean;
    preserveArtifacts?: boolean;
    crashElectronBeforeStop?: boolean;
}

export function shouldPreserveE2EArtifacts(env: NodeJS.ProcessEnv = process.env) {
    const value = env[PRESERVE_E2E_ARTIFACTS_ENV]?.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function sanitizeArtifactLabel(label: string) {
    return label
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'electron-e2e-failure';
}

function cleanupSessionArtifacts(sessionName: string) {
    assertE2ESessionName(sessionName);
    cleanupSessionFixtures(sessionName);
    rmSync(sessionDir(sessionName), {
        recursive: true,
        force: true,
    });
}

export function prunePreservedSessionArtifacts(sessionName: string) {
    assertE2ESessionName(sessionName);
    cleanupSessionFixtures(sessionName);
    for (const directoryName of [
        'automation-electron-app',
        'automation-electron-app-entry',
        'electron-user-data',
    ]) {
        rmSync(join(sessionDir(sessionName), directoryName), {
            recursive: true,
            force: true,
        });
    }
}

function createSessionDiagnostics(sessionName: string) {
    setCurrentSessionName(sessionName);
    const info = getSessionInfo(sessionName);
    const starting = getSessionStartingInfo(sessionName);
    const details = {
        sessionName,
        info: info
            ? {
                ...info,
                pidAlive: isProcessAlive(info.pid),
                electronPidAlive: info.electronPid ? isProcessAlive(info.electronPid) : null,
                nuxtPidAlive: info.nuxtPid ? isProcessAlive(info.nuxtPid) : null,
            }
            : null,
        starting: starting
            ? {
                ...starting,
                pidAlive: isProcessAlive(starting.pid),
                ageMs: Date.now() - starting.startedAt,
            }
            : null,
    };
    const logTail = readSessionLogTail(120);
    return [
        `Session diagnostics: ${JSON.stringify(details, null, 2)}`,
        formatElectronStartupDiagnostics(),
        logTail ? `--- Recent session log ---\n${logTail}` : 'No session log tail available.',
    ].join('\n');
}

async function captureFailureArtifacts(
    sessionName: string,
    page: Page,
    label: string,
): Promise<IElectronE2EFailureArtifacts> {
    setCurrentSessionName(sessionName);
    const outputDir = join(FAILURE_ARTIFACTS_BASE_DIR, sessionName);
    mkdirSync(outputDir, { recursive: true });
    const basename = `${sanitizeArtifactLabel(label)}-${Date.now()}`;
    const screenshotPath = join(outputDir, `${basename}.png`);
    const diagnosticsPath = join(outputDir, `${basename}.txt`);
    let screenshotError: string | null = null;

    try {
        await page.screenshot({
            path: screenshotPath,
            type: 'png',
        });
    } catch (error) {
        screenshotError = error instanceof Error ? error.stack ?? error.message : String(error);
    }

    writeFileSync(diagnosticsPath, [
        `Electron E2E failure: ${label}`,
        `Captured: ${new Date().toISOString()}`,
        screenshotError ? `Screenshot failed: ${screenshotError}` : `Screenshot: ${screenshotPath}`,
        createSessionDiagnostics(sessionName),
    ].join('\n\n'));

    return {
        diagnosticsPath,
        screenshotError,
        screenshotPath: screenshotError ? null : screenshotPath,
    };
}

async function withSessionTimeout<T>(
    sessionName: string,
    label: string,
    timeoutMs: number,
    task: (signal: AbortSignal) => Promise<T>,
    options: { cleanupOnTimeout?: boolean } = {},
): Promise<T> {
    return runWithElectronE2EDeadline(label, timeoutMs, task, {
        diagnostics: () => createSessionDiagnostics(sessionName),
        ...(options.cleanupOnTimeout
            ? {onTimeout: () => stopSingleSession(sessionName)}
            : {}),
    });
}

async function waitForRendererReady(page: Page, timeoutMs = RENDERER_READY_TIMEOUT_MS) {
    await waitForFunctionInPage(page, () => {
        const nuxtRoot = document.querySelector('#__nuxt');
        const hasNuxt = Boolean(nuxtRoot && nuxtRoot.children.length > 0);
        const hasOpenFile = typeof (window as IE2EWindow & { __openFileDirect?: unknown }).__openFileDirect === 'function';
        const hasElectronApi = typeof (window as IE2EWindow & { electronAPI?: unknown }).electronAPI === 'object';
        return hasNuxt && hasOpenFile && hasElectronApi;
    }, { timeout: timeoutMs });
}

async function waitForSharedRendererClientQuiet(page: Page) {
    const startedAt = Date.now();
    let stableSince = startedAt;
    let previousSignature = '';

    while (Date.now() - startedAt < SHARED_RENDERER_CLIENT_SETTLE_TIMEOUT_MS) {
        try {
            const state = await page.evaluate(() => ({
                bindingsReady: typeof (window as IE2EWindow & {__openFileDirect?: unknown}).__openFileDirect === 'function',
                bodyText: document.body?.innerText ?? '',
                navigationEpoch: performance.timeOrigin,
                resourceCount: performance.getEntriesByType('resource').length,
            }));
            const signature = `${String(state.navigationEpoch)}:${String(state.resourceCount)}`;
            if (signature !== previousSignature) {
                previousSignature = signature;
                stableSince = Date.now();
            } else if (Date.now() - stableSince >= SHARED_RENDERER_CLIENT_IDLE_MS) {
                return state;
            }
        } catch {
            previousSignature = '';
            stableSince = Date.now();
        }
        await delay(500);
    }

    throw new Error('Shared Electron renderer client resources did not settle');
}

export async function stabilizeSharedRendererClient(page: Page) {
    if (!readE2ESharedRendererConfig(process.env)) {
        return;
    }
    await installPageEvaluationShims(page);
    await waitForRendererReady(page, SHARED_RENDERER_CLIENT_SETTLE_TIMEOUT_MS);
    for (let attempt = 0; attempt < SHARED_RENDERER_CLIENT_RECOVERY_ATTEMPTS; attempt += 1) {
        const state = await waitForSharedRendererClientQuiet(page);
        const initializationFailed = state.bodyText.includes('Internal Server Error')
            || state.bodyText.includes('useHead() was called without provide context');
        if (state.bindingsReady && !initializationFailed) {
            sharedRendererClientStabilized = true;
            return;
        }
        if (attempt + 1 >= SHARED_RENDERER_CLIENT_RECOVERY_ATTEMPTS) {
            throw new Error(
                'Shared Electron renderer client did not stabilize after Vite dependency discovery'
                + ` (bindingsReady=${String(state.bindingsReady)}, body="${state.bodyText.replace(/\s+/g, ' ').slice(0, 180)}")`,
            );
        }
        await page.reload({
            waitUntil: 'domcontentloaded',
            timeout: SHARED_RENDERER_CLIENT_SETTLE_TIMEOUT_MS,
        });
        await installPageEvaluationShims(page);
        await waitForRendererReady(page, SHARED_RENDERER_CLIENT_SETTLE_TIMEOUT_MS);
    }
}

async function waitForHealthReady(sessionName: string, timeoutMs: number, signal: AbortSignal) {
    const start = Date.now();
    let successfulResponseCount = 0;
    let lastTransportError: unknown;
    let lastApplicationError: unknown;

    while (!signal.aborted && Date.now() - start < timeoutMs) {
        try {
            setCurrentSessionName(sessionName);
            const health = await sendCommand('health', [], undefined, {
                signal,
                retryOnTransportFailure: true,
            }) as {ready?: boolean;};
            successfulResponseCount += 1;
            if (health?.ready) {
                return;
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'ElectronRunCommandError') {
                successfulResponseCount += 1;
                lastApplicationError = error;
            } else {
                lastTransportError = error;
            }
            // Transport races can recover during startup. A command-handler
            // error proves the runner answered, so keep it non-retryable.
        }

        await delay(250);
    }

    if (signal.aborted) {
        throw signal.reason;
    }
    throw createElectronE2EHealthReadinessFailure(
        sessionName,
        successfulResponseCount,
        lastTransportError,
        lastApplicationError,
    );
}

async function waitForPageTarget(cdpPort: number, signal: AbortSignal, timeoutMs = 15_000) {
    const start = Date.now();
    while (!signal.aborted && Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
            if (res.ok) {
                const targets = await res.json() as Array<{
                    type: string;
                    webSocketDebuggerUrl?: string;
                }>;
                if (targets.some(t => t.type === 'page' && t.webSocketDebuggerUrl)) {
                    return;
                }
            }
        } catch {
            // CDP endpoint not ready yet.
        }
        await delay(500);
    }
    if (signal.aborted) {
        throw signal.reason;
    }
    throw new Error(`No page target found via /json/list within ${Math.round(timeoutMs / 1000)}s`);
}

async function getBrowserWsEndpoint(cdpPort: number) {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (!res.ok) {
        throw new Error(`Failed to fetch /json/version: HTTP ${res.status}`);
    }
    const data = await res.json() as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) {
        throw new Error('/json/version missing webSocketDebuggerUrl');
    }
    return data.webSocketDebuggerUrl;
}

async function connectToSessionPage(sessionName: string, signal: AbortSignal) {
    setCurrentSessionName(sessionName);
    const info = getSessionInfo(sessionName);
    if (!info) {
        throw new ElectronE2EInfrastructureError(
            'session-runner',
            `Session '${sessionName}' metadata was unavailable during CDP connection`,
        );
    }

    return runElectronE2EInfrastructureStage(
        'cdp-connection',
        `Connecting to Electron session '${sessionName}' over CDP`,
        async () => {
            await waitForPageTarget(info.cdpPort, signal);
            const browserWsUrl = await getBrowserWsEndpoint(info.cdpPort);
            const browser = await puppeteer.connect({
                browserWSEndpoint: browserWsUrl,
                defaultViewport: null,
                protocolTimeout: 420_000,
            });
            if (signal.aborted) {
                await browser.disconnect();
                throw signal.reason;
            }

            const nuxtPort = info.nuxtPort || DEFAULT_NUXT_PORT;
            const pages = await browser.pages();
            let page = pages.find(candidate => {
                const url = candidate.url();
                return url.startsWith('evb-viewer://app/')
                    || url.includes(`localhost:${nuxtPort}`)
                    || url.includes(`127.0.0.1:${nuxtPort}`);
            }) ?? null;

            if (!page) {
                page = pages.find(candidate => !candidate.isClosed()) ?? null;
                if (!page) {
                    throw new Error('No Electron page found via CDP');
                }
                await page.goto(`http://127.0.0.1:${nuxtPort}/`, {waitUntil: 'domcontentloaded'});
            }

            return {
                browser,
                page,
            };
        },
    );
}

export async function startElectronE2ESession(
    sessionName: string,
    options?: IElectronE2ESessionStartOptions,
) {
    return startElectronE2ESessionWithAutomationEnv(
        sessionName,
        options,
        buildElectronE2EAutomationEnv,
    );
}

interface IElectronE2ESessionStartOptions {
    clean?: boolean;
    extraEnv?: Record<string, string>;
    initialOpenPaths?: string[];
}

async function startElectronE2ESessionWithAutomationEnv(
    sessionName: string,
    options: IElectronE2ESessionStartOptions | undefined,
    buildAutomationEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv,
): Promise<IElectronE2ESession> {
    const scopedSessionName = assertE2ESessionName(createE2ERunScopedSessionName(sessionName, process.env));
    const clean = options?.clean ?? true;

    await runElectronE2EInfrastructureStage(
        'session-runner',
        `Stopping stale Electron E2E session '${scopedSessionName}'`,
        async () => withSessionTimeout(
            scopedSessionName,
            `Stopping stale Electron E2E session '${scopedSessionName}'`,
            SESSION_STOP_TIMEOUT_MS,
            () => stopSingleSession(scopedSessionName, {preserveWorkspaceCheckpoint: !clean}),
        ),
    );
    if (clean) {
        cleanupSessionArtifacts(scopedSessionName);
    }

    setCurrentSessionName(scopedSessionName);
    const requestedEnv = {
        ...process.env,
        ...(options?.extraEnv ?? {}),
    };
    const startOptions = {
        env: {
            ...buildAutomationEnv(requestedEnv),
            ...buildStrictE2ERunEnv(process.env),
        },
        owner: 'e2e' as const,
        ...(options?.initialOpenPaths ? { initialOpenPaths: options.initialOpenPaths } : {}),
    };
    await runElectronE2EProcessLaunchStage(
        `Starting Electron E2E session '${scopedSessionName}'`,
        async () => withSessionTimeout(
            scopedSessionName,
            `Starting Electron E2E session '${scopedSessionName}'`,
            SESSION_READY_TIMEOUT_MS,
            () => startSessionDetached(startOptions),
            { cleanupOnTimeout: true },
        ),
    );

    await runElectronE2EInfrastructureStage(
        'session-runner',
        `Waiting for Electron E2E session '${scopedSessionName}' metadata`,
        async () => {
            const ready = await withSessionTimeout(
                scopedSessionName,
                `Waiting for Electron E2E session '${scopedSessionName}' metadata`,
                SESSION_READY_TIMEOUT_MS,
                signal => waitForSessionReady(SESSION_READY_TIMEOUT_MS, signal),
                { cleanupOnTimeout: true },
            );
            if (!ready) {
                throw new Error(`Session '${scopedSessionName}' was not ready within ${Math.round(SESSION_READY_TIMEOUT_MS / 1000)}s.\n${createSessionDiagnostics(scopedSessionName)}`);
            }
        },
    );

    await withSessionTimeout(
        scopedSessionName,
        `Waiting for Electron E2E session '${scopedSessionName}' health`,
        SESSION_READY_TIMEOUT_MS + 5_000,
        signal => waitForHealthReady(scopedSessionName, SESSION_READY_TIMEOUT_MS, signal),
        { cleanupOnTimeout: true },
    );
    const {
        browser,
        page,
    } = await runElectronE2EInfrastructureStage(
        'cdp-connection',
        `Connecting to Electron E2E session '${scopedSessionName}' renderer`,
        async () => withSessionTimeout(
            scopedSessionName,
            `Connecting to Electron E2E session '${scopedSessionName}' renderer`,
            RENDERER_READY_TIMEOUT_MS + 20_000,
            signal => connectToSessionPage(scopedSessionName, signal),
            { cleanupOnTimeout: true },
        ),
    );
    await installPageEvaluationShims(page);
    await waitForRendererReady(page);
    if (readE2ESharedRendererConfig(process.env) && !sharedRendererClientStabilized) {
        try {
            await withSessionTimeout(
                scopedSessionName,
                `Stabilizing shared Electron renderer client '${scopedSessionName}'`,
                SHARED_RENDERER_CLIENT_STABILIZE_TIMEOUT_MS,
                () => stabilizeSharedRendererClient(page),
                {cleanupOnTimeout: true},
            );
        } catch (error) {
            await runElectronE2ETeardown(error, [{
                label: `stop session '${scopedSessionName}'`,
                run: () => stopSingleSession(scopedSessionName),
            }]);
        }
    }

    const command = async <T = unknown>(
        nextCommand: TElectronRunCommand,
        args: unknown[] = [],
        timeoutMs?: number,
    ) => {
        setCurrentSessionName(scopedSessionName);
        return await sendCommand(nextCommand, args, timeoutMs) as T;
    };

    const stop = async (stopOptions: IElectronE2ESessionStopOptions = {}) => {
        try {
            await runElectronE2EInfrastructureStage(
                'session-runner',
                `Stopping Electron E2E session '${scopedSessionName}'`,
                async () => withSessionTimeout(
                    scopedSessionName,
                    `Stopping Electron E2E session '${scopedSessionName}'`,
                    SESSION_STOP_TIMEOUT_MS,
                    () => stopSingleSession(scopedSessionName, {
                        keepNuxt: stopOptions.keepNuxt ?? false,
                        crashElectronBeforeStop: stopOptions.crashElectronBeforeStop ?? false,
                    }),
                ),
            );
            if (stopOptions.preserveArtifacts || shouldPreserveE2EArtifacts()) {
                prunePreservedSessionArtifacts(scopedSessionName);
            } else {
                cleanupSessionArtifacts(scopedSessionName);
            }
        } finally {
            releaseCurrentSessionName(scopedSessionName);
        }
    };

    const resetForE2E = async () => {
        const rendererUrl = page.url();
        const rendererOrigin = new URL(rendererUrl).origin;
        const checkpointDiscardToken = await page.evaluate(async (defaultSettings) => {
            const target = window as IE2EWindow;
            await target.electronAPI?.documentRecentFiles?.recentFiles.clear();
            await target.electronAPI?.settings.save(defaultSettings);
            const discardWorkspaceCheckpoint = target.electronAPI?.windowTabs.discardWorkspaceCheckpoint;
            if (!discardWorkspaceCheckpoint) {
                throw new Error('Electron checkpoint discard bridge is unavailable before renderer teardown');
            }
            return discardWorkspaceCheckpoint();
        }, pickSettingsSavePatch(DEFAULT_SETTINGS));
        let checkpointResumed = false;
        const restoreRendererAndResumeCheckpoint = async () => {
            await page.goto(rendererUrl, {waitUntil: 'domcontentloaded'});
            await installPageEvaluationShims(page);
            await waitForRendererReady(page);
            await page.evaluate(async (discardToken) => {
                const target = window as IE2EWindow;
                const resumeWorkspaceCheckpoint = target.electronAPI?.windowTabs.resumeWorkspaceCheckpoint;
                if (!resumeWorkspaceCheckpoint) {
                    throw new Error('Electron checkpoint resume bridge is unavailable after renderer restart');
                }
                await resumeWorkspaceCheckpoint(discardToken);
            }, checkpointDiscardToken);
            checkpointResumed = true;
        };

        try {
            await page.goto('about:blank', {waitUntil: 'domcontentloaded'});
            cleanupSessionFixtures(scopedSessionName);
            const client = await page.createCDPSession();
            try {
                await client.send('Storage.clearDataForOrigin', {
                    origin: rendererOrigin,
                    storageTypes: 'all',
                });
                await client.send('Network.clearBrowserCache');
            } finally {
                await client.detach();
            }
            await restoreRendererAndResumeCheckpoint();
        } catch (error) {
            if (!checkpointResumed) {
                try {
                    await restoreRendererAndResumeCheckpoint();
                } catch (recoveryError) {
                    throw new AggregateError([
                        error,
                        recoveryError,
                    ], 'Electron E2E reset failed and checkpoint persistence could not be resumed');
                }
            }
            throw error;
        }
    };

    return {
        name: scopedSessionName,
        browser,
        page,
        command,
        captureFailureArtifacts: label => captureFailureArtifacts(scopedSessionName, page, label),
        resetForE2E,
        stop,
    };
}

/**
 * Starts a host-visible Electron window. Test suites may use this only through
 * the dedicated visible-window lifecycle fixture. Raw diagnostics must name
 * this capability at their call site so they cannot look like ordinary E2E.
 */
export async function startHostVisibleElectronE2ESession(
    sessionName: string,
    options?: IElectronE2ESessionStartOptions,
) {
    return startElectronE2ESessionWithAutomationEnv(
        sessionName,
        options,
        buildVisibleWindowElectronE2EAutomationEnv,
    );
}
