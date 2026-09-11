import {
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    mkdirSync,
    readFileSync,
    unlinkSync,
} from 'node:fs';
import {
    basename,
    dirname,
} from 'node:path';
import {
    createFixturePath,
    createLargeScannedFixturePdf,
    createScannedTextFixturePdf,
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    openDjvuInApp,
    openPdfInApp,
    waitForDjvuLoaded,
    waitForActiveDocumentSource,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {callWorkspaceCommand} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    findCommittedSurfaceCausalOpenViolations,
    installCommittedSurfaceSampler,
    stopCommittedSurfaceSampler,
    summarizeCommittedSurfaceTiming,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';

const RECENT_ROW_TIMEOUT_MS = 15_000;
const RECENT_OPEN_TIMEOUT_MS = 12_000;
const RECENT_STARTUP_STABILITY_MS = 1_500;
const RECENT_OPEN_STABILITY_MS = 2_500;
const RECENT_POLL_INTERVAL_MS = 50;
const RECENT_EMPTY_TAB_ACTIONABLE_BUDGET_MS = 500;
const RECENT_FIRST_PAGE_SHELL_BUDGET_MS = 100;
const RECENT_FIRST_VISIBLE_PAGE_SHELL_BUDGET_FRAMES = 2;
const RECENT_FIRST_CANVAS_BUDGET_MS = 2_500;
const RECENT_READY_AFTER_CANVAS_BUDGET_MS = 1_000;
const TOOLBAR_OPEN_TRANSITION_POLL_MS = 25;
const TOOLBAR_MIN_VISIBLE_HEIGHT_PX = 40;
const TOOLBAR_MAX_OPEN_SHIFT_PX = 2;
const TOOLBAR_MIN_VISIBLE_CONTROL_COUNT = 4;

interface IRecentOpenDomState {
    hasHost: boolean;
    hasLoader: boolean;
    hasViewer: boolean;
    hasRenderedContent: boolean;
    recentRowVisible: boolean;
    visibleRecentRows: number;
    visibleText: string;
}
interface IToolbarTransitionSample {
    atMs: number;
    hasShell: boolean;
    hasWorkspace: boolean;
    owner: 'shell' | 'workspace' | 'none';
    shellHeight: number;
    workspaceTop: number;
    toolbarHeight: number;
    toolbarText: string;
    toolbarVisible: boolean;
    visibleControlCount: number;
    visibleIconCount: number;
}

interface IRecentOpenTransitionResult {
    activeTabChanged: boolean;
    actionableElapsedMs: number | null;
    clickAtMs: number | null;
    emptyTabCreatedAtMs: number | null;
    framesAfterClick: number;
    preSurfaceFrames: number;
    prewarmAtMs: number | null;
    shellInteractiveAtMs: number | null;
    recentRowVisibleAtShell: boolean;
    sawVisibleDisabledTargetRow: boolean;
    shellAtMs: number | null;
    shellElapsedMs: number | null;
    shellFound: boolean;
    targetReadyAtClick: boolean;
    targetActionableAtClick: boolean;
    firstOpenSurfaceFrame: {
        activeTabTitle: string;
        openSurfacePhase: string | null;
        openSurfacePresentation: string | null;
        viewportVisualPresentation: string | null;
        recentRowVisible: boolean;
        shellVisible: boolean;
        skeletonVisible: boolean;
    } | null;
    visibleTextAtDeadline: string;
}

async function startToolbarTransitionSampling(session: IElectronE2ESession) {
    await evaluateInPage(session.page, (pollMs: number) => {
        const transitionWindow = window as Window & {
            __evbToolbarOpenTransitionInterval?: number;
            __evbToolbarOpenTransitionSamples?: IToolbarTransitionSample[];
        };
        const samples: IToolbarTransitionSample[] = [];
        const startedAt = performance.now();

        function isVisible(element: HTMLElement | null) {
            if (!element?.isConnected) {
                return false;
            }

            let current: HTMLElement | null = element;
            while (current) {
                const style = window.getComputedStyle(current);
                if (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') <= 0.05
                ) {
                    return false;
                }
                current = current.parentElement;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function countVisible(toolbar: HTMLElement | null, selector: string) {
            if (!toolbar) {
                return 0;
            }
            return Array.from(toolbar.querySelectorAll<HTMLElement>(selector))
                .filter(isVisible)
                .length;
        }

        function sampleToolbar() {
            const shell = document.querySelector<HTMLElement>('.editor-global-toolbar-shell');
            const workspace = document.querySelector<HTMLElement>('.workspace-main-shell');
            const shellToolbar = shell?.querySelector<HTMLElement>(':scope > .toolbar') ?? null;
            const hostToolbar = document.querySelector<HTMLElement>('#editor-global-toolbar-host .toolbar');
            const visibleHostToolbar = isVisible(hostToolbar);
            const visibleShellToolbar = isVisible(shellToolbar);
            const toolbar = visibleHostToolbar ? hostToolbar : (visibleShellToolbar ? shellToolbar : null);
            const shellRect = shell?.getBoundingClientRect();
            const workspaceRect = workspace?.getBoundingClientRect();
            const toolbarRect = toolbar?.getBoundingClientRect();
            const owner = visibleHostToolbar ? 'workspace' : (visibleShellToolbar ? 'shell' : 'none');

            samples.push({
                atMs: Math.round(performance.now() - startedAt),
                hasShell: Boolean(shell),
                hasWorkspace: Boolean(workspace),
                owner,
                shellHeight: shellRect?.height ?? 0,
                workspaceTop: workspaceRect?.top ?? 0,
                toolbarHeight: toolbarRect?.height ?? 0,
                toolbarText: toolbar?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                toolbarVisible: Boolean(toolbar && isVisible(toolbar)),
                visibleControlCount: countVisible(toolbar, 'button, [role="button"], input, select'),
                visibleIconCount: countVisible(toolbar, '.iconify, svg, [class*="i-ph-"]'),
            });
        }

        window.clearInterval(transitionWindow.__evbToolbarOpenTransitionInterval);
        sampleToolbar();
        transitionWindow.__evbToolbarOpenTransitionSamples = samples;
        transitionWindow.__evbToolbarOpenTransitionInterval = window.setInterval(sampleToolbar, pollMs);
    }, TOOLBAR_OPEN_TRANSITION_POLL_MS);
}

async function stopToolbarTransitionSampling(session: IElectronE2ESession) {
    return evaluateInPage(session.page, () => {
        const transitionWindow = window as Window & {
            __evbToolbarOpenTransitionInterval?: number;
            __evbToolbarOpenTransitionSamples?: IToolbarTransitionSample[];
        };
        window.clearInterval(transitionWindow.__evbToolbarOpenTransitionInterval);
        delete transitionWindow.__evbToolbarOpenTransitionInterval;
        return transitionWindow.__evbToolbarOpenTransitionSamples ?? [];
    });
}

function assertToolbarTransitionStable(samples: IToolbarTransitionSample[]) {
    const relevantSamples = samples.filter(sample => sample.hasShell && sample.hasWorkspace);
    expect(relevantSamples.length, JSON.stringify(samples)).toBeGreaterThan(5);

    const collapsedSamples = relevantSamples.filter(sample => sample.shellHeight < TOOLBAR_MIN_VISIBLE_HEIGHT_PX);
    expect(collapsedSamples, JSON.stringify(samples)).toEqual([]);

    const absentToolbarSamples = relevantSamples.filter(sample => (
        !sample.toolbarVisible
        || sample.owner === 'none'
        || sample.toolbarHeight < TOOLBAR_MIN_VISIBLE_HEIGHT_PX
    ));
    expect(absentToolbarSamples, JSON.stringify(samples)).toEqual([]);

    const sparseToolbarSamples = relevantSamples.filter(sample => (
        sample.visibleControlCount < TOOLBAR_MIN_VISIBLE_CONTROL_COUNT
        && sample.visibleIconCount < TOOLBAR_MIN_VISIBLE_CONTROL_COUNT
    ));
    expect(sparseToolbarSamples, JSON.stringify(samples)).toEqual([]);

    const workspaceTops = relevantSamples.map(sample => sample.workspaceTop);
    const workspaceTopDelta = Math.max(...workspaceTops) - Math.min(...workspaceTops);
    expect(workspaceTopDelta, JSON.stringify(samples)).toBeLessThanOrEqual(TOOLBAR_MAX_OPEN_SHIFT_PX);

    expect(relevantSamples.some(sample => sample.owner === 'shell'), JSON.stringify(samples)).toBe(true);
    expect(relevantSamples.some(sample => sample.owner === 'workspace'), JSON.stringify(samples)).toBe(true);
}

async function readRecentOpenDomState(
    session: IElectronE2ESession,
    sourcePath: string,
): Promise<IRecentOpenDomState> {
    return evaluateInPage(session.page, (targetSourcePath: string) => {
        const isVisible = (element: HTMLElement) => {
            let current: HTMLElement | null = element;
            while (current) {
                const style = window.getComputedStyle(current);
                if (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') === 0
                ) {
                    return false;
                }
                current = current.parentElement;
            }
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const activeHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        )
            ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host');
        if (!activeHost) {
            return {
                hasHost: false,
                hasLoader: false,
                hasViewer: false,
                hasRenderedContent: false,
                recentRowVisible: false,
                visibleRecentRows: 0,
                visibleText: '',
            };
        }

        const recentRows = Array.from(activeHost.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'))
            .filter(isVisible);
        const viewer = activeHost.querySelector<HTMLElement>('#pdf-viewer');
        const hasOpeningSurface = Array.from(activeHost.querySelectorAll<HTMLElement>(
            '.document-viewer-chassis__opening-page, .native-pdf-page-content, .document-page-source-feature-pack__page',
        )).some(isVisible);
        const hasRenderedContent = Array.from(viewer?.querySelectorAll<HTMLElement>(
            '.page_canvas canvas, .text-layer span, .textLayer span',
        ) ?? []).some(isVisible);

        return {
            hasHost: true,
            hasLoader: Array.from(activeHost.querySelectorAll<HTMLElement>('.workspace-host__loading')).some(isVisible),
            hasViewer: hasOpeningSurface || hasRenderedContent,
            hasRenderedContent,
            recentRowVisible: recentRows.some(row => row.dataset.recentSource === targetSourcePath),
            visibleRecentRows: recentRows.length,
            visibleText: (activeHost.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        };
    }, sourcePath);
}

function describeRecentOpenDomState(state: IRecentOpenDomState) {
    return JSON.stringify(state);
}

async function waitForRecentFileRow(session: IElectronE2ESession, sourcePath: string) {
    await waitForFunctionInPage(session.page, (targetSourcePath: string) => {
        return Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'))
            .some(row => row.dataset.recentSource === targetSourcePath);
    }, { timeout: RECENT_ROW_TIMEOUT_MS }, sourcePath);
}

async function clickRecentFile(session: IElectronE2ESession, sourcePath: string) {
    await waitForRecentFileRow(session, sourcePath);

    const clicked = await evaluateInPage(session.page, (targetSourcePath: string) => {
        const row = Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'))
            .find(candidate => candidate.dataset.recentSource === targetSourcePath);
        const openButton = row?.querySelector<HTMLButtonElement>('button.recent-open') ?? null;
        openButton?.click();
        return Boolean(openButton);
    }, sourcePath);

    expect(clicked).toBe(true);
}

async function waitForStartupOverlayRemoved(session: IElectronE2ESession) {
    await waitForFunctionInPage(session.page, () => (
        document.querySelector('#evb-startup-overlay') === null
    ), {timeout: RECENT_ROW_TIMEOUT_MS});
}

async function emptyCurrentTabAndOpenRecentAtFirstOpenSurface(
    session: IElectronE2ESession,
    sourcePath: string,
): Promise<IRecentOpenTransitionResult> {
    // A Recent click first validates that the persisted path still exists. The
    // IPC/stat preflight has variable duration, so page-shell paint budgets
    // start with the first positive open-surface snapshot—not the raw click or
    // the tab/session bookkeeping that may precede that snapshot.
    return evaluateInPage(session.page, (
        targetSourcePath: string,
        shellBudgetMs: number,
    ) => new Promise<IRecentOpenTransitionResult>((resolve) => {
        const previousActiveTabId = document.querySelector<HTMLElement>(
            '.tab-list .tab.is-active[data-tab-id]',
        )?.dataset.tabId ?? null;
        const currentTabCloseButton = document.querySelector<HTMLButtonElement>(
            '.tab-list .tab.is-active .tab-close',
        );
        let prewarmAtMs: number | null = null;
        const prewarmDeadlineAtMs = performance.now() + shellBudgetMs;
        const shellInteractiveAtMs = performance
            .getEntriesByName('evb:shell-interactive', 'mark')
            .at(-1)?.startTime ?? null;
        let emptyTabCreatedAtMs: number | null = null;
        let clickAtMs: number | null = null;
        let framesAfterClick = 0;
        let preSurfaceFrames = 0;
        let sawVisibleDisabledTargetRow = false;
        let targetReadyAtClick = false;
        let targetActionableAtClick = false;
        let firstOpenSurfaceFrame: IRecentOpenTransitionResult['firstOpenSurfaceFrame'] = null;

        const isVisible = (element: HTMLElement | null) => {
            if (!element?.isConnected) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        };
        const getActiveHost = () => document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        );
        const getTargetRecentRows = () => Array.from(
            getActiveHost()?.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)') ?? [],
        ).filter(row => (
            row.dataset.recentSource === targetSourcePath
            && isVisible(row)
        ));
        const getRecentRow = () => getTargetRecentRows()
            .find(row => row.dataset.recentOpenActionable === 'true') ?? null;
        const getExactPageShell = () => {
            const openingShell = getActiveHost()?.querySelector<HTMLElement>(
                '.document-viewer-chassis__opening-page',
            ) ?? null;
            if (isVisible(openingShell)) {
                return openingShell;
            }
            const pageCanvas = getActiveHost()?.querySelector<HTMLElement>(
                '#pdf-viewer .page_container[data-page="1"] .page_canvas',
            ) ?? null;
            return isVisible(pageCanvas) ? pageCanvas : null;
        };
        const readOpenSurfaceFrame = (): NonNullable<IRecentOpenTransitionResult['firstOpenSurfaceFrame']> => {
            const activeHost = getActiveHost();
            const chassis = activeHost?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
            const exactPageShell = getExactPageShell();
            return {
                activeTabTitle: document.querySelector<HTMLElement>(
                    '.tab-list .tab.is-active .tab-label',
                )?.textContent?.trim() ?? '',
                openSurfacePhase: activeHost?.querySelector<HTMLElement>(
                    '[data-document-viewer-chassis-viewport]',
                )?.dataset.openSurfacePhase ?? null,
                openSurfacePresentation: chassis?.dataset.openSurfacePresentation ?? null,
                viewportVisualPresentation: chassis?.dataset.viewportVisualPresentation ?? null,
                recentRowVisible: isVisible(getRecentRow()),
                shellVisible: exactPageShell !== null,
                skeletonVisible: Boolean(
                    exactPageShell?.querySelector('.document-page-skeleton'),
                ),
            };
        };
        // Keep this predicate aligned with the committed-surface trace rebase
        // below. Tab-title and Recent-row updates belong to session bookkeeping;
        // they are asserted at the first surface frame but do not start its clock.
        // Presentation remains idle for the supported provisional-shell begin
        // path, so it is a transition signal here but not a required value.
        const hasOpenSurfaceTransitionStarted = (
            frame: NonNullable<IRecentOpenTransitionResult['firstOpenSurfaceFrame']>,
        ) => (
            (frame.openSurfacePhase !== null && frame.openSurfacePhase !== 'idle')
            || (frame.openSurfacePresentation !== null && frame.openSurfacePresentation !== 'idle')
            || frame.shellVisible
        );
        const finish = (shellAtMs: number | null) => {
            const activeTabId = document.querySelector<HTMLElement>(
                '.tab-list .tab.is-active[data-tab-id]',
            )?.dataset.tabId ?? null;
            resolve({
                activeTabChanged: Boolean(activeTabId && activeTabId !== previousActiveTabId),
                actionableElapsedMs: emptyTabCreatedAtMs !== null && clickAtMs !== null
                    ? Math.round(clickAtMs - emptyTabCreatedAtMs)
                    : null,
                clickAtMs,
                emptyTabCreatedAtMs,
                framesAfterClick,
                preSurfaceFrames,
                prewarmAtMs,
                shellInteractiveAtMs,
                recentRowVisibleAtShell: isVisible(getRecentRow()),
                sawVisibleDisabledTargetRow,
                shellAtMs,
                shellElapsedMs: clickAtMs !== null && shellAtMs !== null
                    ? Math.round(shellAtMs - clickAtMs)
                    : null,
                shellFound: shellAtMs !== null,
                targetReadyAtClick,
                targetActionableAtClick,
                firstOpenSurfaceFrame,
                visibleTextAtDeadline: (getActiveHost()?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
            });
        };
        const sample = () => {
            if (clickAtMs === null) {
                sawVisibleDisabledTargetRow ||= getTargetRecentRows()
                    .some(row => row.dataset.recentOpenActionable !== 'true');
                const recentRow = getRecentRow();
                if (recentRow) {
                    targetReadyAtClick = recentRow.dataset.recentOpenReady === 'true';
                    targetActionableAtClick = recentRow.dataset.recentOpenActionable === 'true';
                    clickAtMs = performance.now();
                    (window as Window & {__committedSurfaceInteractionCheckpoint?: string | null;})
                        .__committedSurfaceInteractionCheckpoint = 'recent-click';
                    recentRow.querySelector<HTMLButtonElement>('button.recent-open')?.click();
                }
                window.requestAnimationFrame(sample);
                return;
            }
            const sampledAtMs = performance.now();
            framesAfterClick += 1;
            const transitionFrame = readOpenSurfaceFrame();
            if (
                firstOpenSurfaceFrame === null
                && hasOpenSurfaceTransitionStarted(transitionFrame)
            ) {
                firstOpenSurfaceFrame = transitionFrame;
            } else if (firstOpenSurfaceFrame === null) {
                preSurfaceFrames += 1;
            }
            if (getExactPageShell()) {
                finish(sampledAtMs);
                return;
            }
            if (sampledAtMs - clickAtMs > shellBudgetMs) {
                finish(null);
                return;
            }
            window.requestAnimationFrame(sample);
        };

        const startWhenPrewarmed = () => {
            prewarmAtMs = performance
                .getEntriesByName('evb:recent-pdf-geometry-prewarmed', 'mark')
                .at(-1)?.startTime ?? null;
            if (prewarmAtMs === null) {
                if (performance.now() > prewarmDeadlineAtMs) {
                    finish(null);
                    return;
                }
                window.requestAnimationFrame(startWhenPrewarmed);
                return;
            }
            currentTabCloseButton?.click();
            emptyTabCreatedAtMs = performance.now();
            window.requestAnimationFrame(sample);
        };
        startWhenPrewarmed();
    }), sourcePath, RECENT_OPEN_TIMEOUT_MS);
}

async function assertRecentListStaysStableBeforeOpen(session: IElectronE2ESession, sourcePath: string) {
    await waitForRecentFileRow(session, sourcePath);

    const deadline = Date.now() + RECENT_STARTUP_STABILITY_MS;
    while (Date.now() < deadline) {
        const state = await readRecentOpenDomState(session, sourcePath);
        if (state.hasLoader) {
            throw new Error(`Recent files list returned to loader after first render: ${describeRecentOpenDomState(state)}`);
        }
        if (!state.recentRowVisible || state.hasViewer) {
            throw new Error(`Recent files list did not remain stable before click: ${describeRecentOpenDomState(state)}`);
        }
        await delay(RECENT_POLL_INTERVAL_MS);
    }
}

async function waitForRecentPdfOpen(session: IElectronE2ESession, sourcePath: string) {
    const deadline = Date.now() + RECENT_OPEN_TIMEOUT_MS;
    let sawOpenAttempt = false;
    let lastState: IRecentOpenDomState | null = null;

    while (Date.now() < deadline) {
        const state = await readRecentOpenDomState(session, sourcePath);
        lastState = state;

        if (state.hasLoader || state.hasViewer) {
            sawOpenAttempt = true;
        }

        if (sawOpenAttempt && state.recentRowVisible && !state.hasViewer && !state.hasLoader) {
            throw new Error(`Recent file "${sourcePath}" returned to the placeholder instead of opening: ${describeRecentOpenDomState(state)}`);
        }

        if (state.hasViewer && state.hasRenderedContent) {
            await waitForPdfLoaded(session.page, RECENT_OPEN_TIMEOUT_MS);
            return;
        }

        await delay(RECENT_POLL_INTERVAL_MS);
    }

    throw new Error(`Recent file "${sourcePath}" did not settle into a loaded viewer: ${describeRecentOpenDomState(lastState ?? {
        hasHost: false,
        hasLoader: false,
        hasViewer: false,
        hasRenderedContent: false,
        recentRowVisible: false,
        visibleRecentRows: 0,
        visibleText: '',
    })}`);
}

async function waitForRecentDjvuOpen(session: IElectronE2ESession, sourcePath: string) {
    const deadline = Date.now() + RECENT_OPEN_TIMEOUT_MS;
    let sawOpenAttempt = false;
    let lastState: IRecentOpenDomState | null = null;

    while (Date.now() < deadline) {
        const state = await readRecentOpenDomState(session, sourcePath);
        lastState = state;

        // The persisted source path is already present in the Recent row, so
        // source text cannot prove that the open transaction owns the
        // workspace. Start failure detection only after a loader or viewer
        // surface has positively claimed it.
        if (state.hasLoader || state.hasViewer) {
            sawOpenAttempt = true;
        }

        if (sawOpenAttempt && state.recentRowVisible && !state.hasViewer && !state.hasLoader) {
            throw new Error(`Recent DjVu "${sourcePath}" returned to the placeholder instead of opening: ${describeRecentOpenDomState(state)}`);
        }

        const loaded = await evaluateInPage(session.page, () => {
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host')
                ?? document.querySelector<HTMLElement>('.workspace-host');
            return (activeHost?.querySelectorAll('[data-testid="document-page-source-image"]').length ?? 0) > 0;
        });
        if (loaded) {
            await waitForDjvuLoaded(session.page, RECENT_OPEN_TIMEOUT_MS);
            return;
        }

        await delay(RECENT_POLL_INTERVAL_MS);
    }

    throw new Error(`Recent DjVu "${sourcePath}" did not settle into a loaded viewer: ${describeRecentOpenDomState(lastState ?? {
        hasHost: false,
        hasLoader: false,
        hasViewer: false,
        hasRenderedContent: false,
        recentRowVisible: false,
        visibleRecentRows: 0,
        visibleText: '',
    })}`);
}

async function assertRecentPdfStaysLoaded(session: IElectronE2ESession, sourcePath: string) {
    const deadline = Date.now() + RECENT_OPEN_STABILITY_MS;
    while (Date.now() < deadline) {
        const state = await readRecentOpenDomState(session, sourcePath);
        if (!state.hasViewer || state.recentRowVisible || state.hasLoader) {
            throw new Error(`Recent file "${sourcePath}" did not remain loaded after open: ${describeRecentOpenDomState(state)}`);
        }
        await delay(RECENT_POLL_INTERVAL_MS);
    }
}

describe('Electron E2E - Recent Files', () => {
    const sessionName = `e2e-recent-files-${Date.now()}`;

    const sessionFixture = createElectronE2ESessionFixture({sessionName});

    it('opens Recent from the current empty startup tab with an exact page-shell as its first document surface', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }

        const fixturePath = await createLargeScannedFixturePdf(`recent-file-${Date.now()}.pdf`);
        const fixtureDocumentRef = requireDocumentRef(fixturePath);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        session = await sessionFixture.restart({
            clean: false,
            keepNuxt: true,
        });
        if (!session) {
            return;
        }

        await waitForStartupOverlayRemoved(session);
        await installCommittedSurfaceSampler(session.page);
        await startToolbarTransitionSampling(session);
        const sourceDeferred = await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__deferDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef);
        expect(sourceDeferred).toBe(true);
        const immediateOpen = await emptyCurrentTabAndOpenRecentAtFirstOpenSurface(
            session,
            fixturePath,
        );
        expect(immediateOpen.shellFound, JSON.stringify(immediateOpen)).toBe(true);
        const openingShellState = await evaluateInPage(session.page, () => {
            const shell = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .document-viewer-chassis__opening-page',
            ) ?? document.querySelector<HTMLElement>(
                '.editor-pane.is-active #pdf-viewer .page_container[data-page="1"] .page_canvas',
            );
            if (!shell) {
                return {
                    found: false,
                    hasSkeleton: false,
                    rect: null,
                    borderRadius: '',
                    boxShadow: '',
                    livePageMounted: false,
                    livePageBoxShadow: '',
                };
            }
            shell.dataset.e2eRecentOpeningShell = 'stable';
            const rect = shell.getBoundingClientRect();
            const style = window.getComputedStyle(shell);
            const livePage = document.querySelector<HTMLElement>(
                '.editor-pane.is-active #pdf-viewer .page_canvas',
            );
            const viewport = document.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]');
            const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const workspace = document.querySelector<HTMLElement>('.workspace-main-shell');
            const track = document.querySelector<HTMLElement>('[data-pdf-page-track]');
            return {
                found: true,
                hasSkeleton: shell.querySelector('.document-page-skeleton') !== null,
                rect: {
                    height: rect.height,
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                },
                borderRadius: style.borderRadius,
                boxShadow: style.boxShadow,
                livePageMounted: livePage !== null,
                livePageBoxShadow: livePage ? window.getComputedStyle(livePage).boxShadow : '',
                diagnostics: {
                    frameOwner: shell.dataset.openSurfaceFrameOwner ?? '',
                    hostClientWidth: host?.clientWidth ?? 0,
                    viewportClientWidth: viewport?.clientWidth ?? 0,
                    viewportOffsetWidth: viewport?.offsetWidth ?? 0,
                    viewportScrollTop: viewport?.scrollTop ?? 0,
                    viewportTop: viewport?.getBoundingClientRect().top ?? 0,
                    workspaceTop: workspace?.getBoundingClientRect().top ?? 0,
                    trackTop: track?.getBoundingClientRect().top ?? 0,
                    shellOffsetTop: shell.offsetTop,
                    shellStyleTop: style.top,
                    shellPageNumber: shell.dataset.pageNumber ?? '',
                },
            };
        });
        expect(openingShellState.found).toBe(true);
        expect(openingShellState.rect).not.toBeNull();
        if (openingShellState.livePageMounted) {
            expect(openingShellState.livePageBoxShadow).toBe('none');
        } else {
            expect(openingShellState.livePageBoxShadow).toBe('');
        }
        await delay(130);
        const debouncedSkeletonVisible = await evaluateInPage(session.page, () => {
            const shell = document.querySelector<HTMLElement>('[data-e2e-recent-opening-shell="stable"]');
            return shell?.querySelector('.document-page-skeleton') !== null;
        });
        const sourceReleased = await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__releaseDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef);
        expect(debouncedSkeletonVisible).toBe(true);
        expect(sourceReleased).toBe(true);
        // Opening a Recent file consumes the current empty tab; it must not create
        // another tab or replace the current tab identity.
        expect(immediateOpen.activeTabChanged, JSON.stringify(immediateOpen)).toBe(false);
        expect(immediateOpen.prewarmAtMs, JSON.stringify(immediateOpen)).not.toBeNull();
        expect(immediateOpen.shellInteractiveAtMs, JSON.stringify(immediateOpen)).not.toBeNull();
        expect(immediateOpen.clickAtMs, JSON.stringify(immediateOpen)).not.toBeNull();
        expect(
            immediateOpen.actionableElapsedMs,
            JSON.stringify(immediateOpen),
        ).toBeLessThanOrEqual(RECENT_EMPTY_TAB_ACTIONABLE_BUDGET_MS);
        expect(immediateOpen.targetReadyAtClick, JSON.stringify(immediateOpen)).toBe(true);
        expect(immediateOpen.targetActionableAtClick, JSON.stringify(immediateOpen)).toBe(true);
        expect(
            immediateOpen.prewarmAtMs! >= immediateOpen.shellInteractiveAtMs!,
            JSON.stringify(immediateOpen),
        ).toBe(true);
        expect(
            immediateOpen.prewarmAtMs! <= immediateOpen.clickAtMs!,
            JSON.stringify(immediateOpen),
        ).toBe(true);
        expect(immediateOpen.recentRowVisibleAtShell, JSON.stringify(immediateOpen)).toBe(false);
        expect(immediateOpen.firstOpenSurfaceFrame, JSON.stringify(immediateOpen)).toMatchObject({
            activeTabTitle: basename(fixturePath),
            recentRowVisible: false,
            shellVisible: true,
        });
        const initialOpenSurfaceFrame = immediateOpen.firstOpenSurfaceFrame;
        expect(
            [
                'cold-shell',
                'prepared-shell',
                'skeleton',
                'canvas',
            ],
            JSON.stringify(immediateOpen),
        ).toContain(initialOpenSurfaceFrame?.viewportVisualPresentation);
        expect(
            initialOpenSurfaceFrame?.skeletonVisible,
            JSON.stringify(immediateOpen),
        ).toBe(initialOpenSurfaceFrame?.viewportVisualPresentation !== 'canvas');
        expect([
            'pending',
            'geometry-committed',
            'canvas-committed',
            'viewport-committed',
        ], JSON.stringify(immediateOpen)).toContain(
            immediateOpen.firstOpenSurfaceFrame?.openSurfacePhase,
        );
        await waitForRecentPdfOpen(session, fixturePath);
        const committedCanvasState = await evaluateInPage(session.page, () => {
            const shell = document.querySelector<HTMLElement>(
                '.editor-pane.is-active #pdf-viewer .page_canvas',
            );
            if (!shell) {
                return {
                    found: false,
                    rect: null,
                    borderRadius: '',
                    boxShadow: '',
                    hasSkeleton: true,
                };
            }
            const rect = shell.getBoundingClientRect();
            const style = window.getComputedStyle(shell);
            const viewport = document.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]');
            const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const workspace = document.querySelector<HTMLElement>('.workspace-main-shell');
            const track = document.querySelector<HTMLElement>('[data-pdf-page-track]');
            const pageContainer = shell.closest<HTMLElement>('.page_container');
            return {
                found: shell.querySelector('canvas') !== null,
                rect: {
                    height: rect.height,
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                },
                borderRadius: style.borderRadius,
                boxShadow: style.boxShadow,
                hasSkeleton: shell.querySelector('.document-page-skeleton') !== null,
                diagnostics: {
                    hostClientWidth: host?.clientWidth ?? 0,
                    viewportClientWidth: viewport?.clientWidth ?? 0,
                    viewportOffsetWidth: viewport?.offsetWidth ?? 0,
                    viewportScrollTop: viewport?.scrollTop ?? 0,
                    viewportTop: viewport?.getBoundingClientRect().top ?? 0,
                    workspaceTop: workspace?.getBoundingClientRect().top ?? 0,
                    trackTop: track?.getBoundingClientRect().top ?? 0,
                    pageContainerTop: pageContainer?.getBoundingClientRect().top ?? 0,
                    pageContainerOffsetTop: pageContainer?.offsetTop ?? 0,
                    trackPaddingTop: track ? window.getComputedStyle(track).paddingTop : '',
                },
            };
        });
        expect(committedCanvasState.found).toBe(true);
        expect(committedCanvasState.hasSkeleton).toBe(false);
        expect(committedCanvasState.borderRadius).toBe(openingShellState.borderRadius);
        expect(committedCanvasState.boxShadow).toBe(openingShellState.boxShadow);
        expect(committedCanvasState.rect).not.toBeNull();
        for (const key of [
            'height',
            'left',
            'top',
            'width',
        ] as const) {
            expect(Math.abs(
                committedCanvasState.rect![key] - openingShellState.rect![key],
            ), JSON.stringify({
                key,
                committedCanvasState,
                openingShellState,
            })).toBeLessThanOrEqual(0.5);
        }
        assertToolbarTransitionStable(await stopToolbarTransitionSampling(session));
        await delay(250);
        const committedSurfaceTrace = await stopCommittedSurfaceSampler(session.page);
        const postClickFrames = committedSurfaceTrace.frames.filter(
            frame => frame.interactionCheckpoint === 'recent-click',
        );
        // Keep the raw-click checkpoint for pre-surface diagnostics, then rebase
        // paint timing at the first positive open-surface transition signal.
        const firstOpenSurfaceIndex = postClickFrames.findIndex(frame => (
            (frame.openSurfacePhase !== null && frame.openSurfacePhase !== 'idle')
            || (frame.openSurfacePresentation !== null && frame.openSurfacePresentation !== 'idle')
            || frame.kind === 'page-shell'
        ));
        const openSurfaceFrames = firstOpenSurfaceIndex >= 0
            ? postClickFrames.slice(firstOpenSurfaceIndex)
            : [];
        const firstOpenSurfaceElapsedMs = openSurfaceFrames[0]?.elapsedMs ?? 0;
        const openSurfaceTrace = {
            ...(committedSurfaceTrace.errors
                ? { errors: committedSurfaceTrace.errors }
                : {}),
            frames: openSurfaceFrames.map(frame => ({
                ...frame,
                elapsedMs: Math.max(0, frame.elapsedMs - firstOpenSurfaceElapsedMs),
            })),
        };
        const causalViolations = findCommittedSurfaceCausalOpenViolations(openSurfaceTrace, {
            maxFirstCanvasMs: RECENT_FIRST_CANVAS_BUDGET_MS,
            maxFirstPageShellMs: RECENT_FIRST_PAGE_SHELL_BUDGET_MS,
            maxReadyAfterCanvasMs: RECENT_READY_AFTER_CANVAS_BUDGET_MS,
            requirePageShell: true,
        });
        const firstOpenSurfaceFrame = openSurfaceTrace.frames[0];
        const firstVisiblePageShellFrame = openSurfaceTrace.frames.find(frame => frame.kind === 'page-shell');
        const visiblePageShellFrameDelta = firstOpenSurfaceFrame && firstVisiblePageShellFrame
            ? firstVisiblePageShellFrame.frame - firstOpenSurfaceFrame.frame
            : null;
        console.info('[E2E recent PDF open timing]', JSON.stringify({
            actionableElapsedMs: immediateOpen.actionableElapsedMs,
            firstOpenSurfaceFrame: immediateOpen.firstOpenSurfaceFrame,
            framesAfterClick: immediateOpen.framesAfterClick,
            preSurfaceFrames: immediateOpen.preSurfaceFrames,
            preSurfaceTraceFrames: Math.max(0, firstOpenSurfaceIndex),
            framesThroughFirstVisibleShell: openSurfaceTrace.frames
                .slice(0, Math.max(1, openSurfaceTrace.frames.findIndex(frame => frame.kind === 'page-shell') + 1))
                .map(frame => ({
                    elapsedMs: frame.elapsedMs,
                    frame: frame.frame,
                    kind: frame.kind,
                    openSurfacePhase: frame.openSurfacePhase,
                    openSurfacePresentation: frame.openSurfacePresentation,
                    outerPlaceholderOwnsCenter: frame.outerPlaceholderOwnsCenter,
                    topElementPath: frame.topElementPath,
                })),
            prewarmLeadMs: immediateOpen.clickAtMs! - immediateOpen.prewarmAtMs!,
            shellElapsedMs: immediateOpen.shellElapsedMs,
            timing: summarizeCommittedSurfaceTiming(openSurfaceTrace),
            visiblePageShellFrameDelta,
        }));
        expect(
            visiblePageShellFrameDelta,
            JSON.stringify({
                immediateOpen,
                frames: openSurfaceTrace.frames,
            }),
        ).not.toBeNull();
        expect(
            visiblePageShellFrameDelta!,
            JSON.stringify({
                immediateOpen,
                frames: openSurfaceTrace.frames,
            }),
        ).toBeLessThanOrEqual(RECENT_FIRST_VISIBLE_PAGE_SHELL_BUDGET_FRAMES);
        expect(
            causalViolations,
            JSON.stringify({
                causalViolations,
                immediateOpen,
                frames: openSurfaceTrace.frames.map(frame => ({
                    elapsedMs: frame.elapsedMs,
                    frame: frame.frame,
                    kind: frame.kind,
                    openSurfacePhase: frame.openSurfacePhase,
                    openSurfacePresentation: frame.openSurfacePresentation,
                    outerPlaceholderOwnsCenter: frame.outerPlaceholderOwnsCenter,
                    pageClassName: frame.pageClassName,
                    shellRect: frame.shellRect,
                    skeletonCount: frame.skeletonCount,
                    skeletonRect: frame.skeletonRect,
                    topElementPath: frame.topElementPath,
                })),
                timing: summarizeCommittedSurfaceTiming(openSurfaceTrace),
            }),
        ).toEqual([]);
        await assertRecentPdfStaysLoaded(session, fixturePath);
    });

    it('fits the first Recent PDF to the viewport after startup', async () => {
        let session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-cold-fit-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        const fixturePath = await createLargeScannedFixturePdf(
            `recent-cold-fit-${Date.now()}.pdf`,
            3,
            0,
        );
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);

        // Restart into the Recent placeholder. The empty workspace must already
        // carry the configured next-document view before the synchronous host
        // drafts its prepared opening frame.
        session = await sessionFixture.restart({
            clean: false,
            keepNuxt: true,
        });
        if (!session) {
            return;
        }

        await waitForStartupOverlayRemoved(session);
        await waitForRecentFileRow(session, fixturePath);
        await installCommittedSurfaceSampler(session.page);
        await clickRecentFile(session, fixturePath);
        await waitForRecentPdfOpen(session, fixturePath);
        await delay(RECENT_OPEN_STABILITY_MS);
        const coldOpenTrace = await stopCommittedSurfaceSampler(session.page);

        const layout = await evaluateInPage(session.page, () => {
            const viewport = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-document-viewer-chassis-viewport]',
            );
            const page = document.querySelector<HTMLElement>(
                '.editor-pane.is-active #pdf-viewer .page_container[data-page="1"] .page_canvas',
            );
            return {
                pageWidth: page?.getBoundingClientRect().width ?? 0,
                viewportWidth: viewport?.clientWidth ?? 0,
            };
        });
        const firstPreparedFrame = coldOpenTrace.frames.find(frame => (
            frame.openSurfaceDiagnostic?.openSurfaceOpeningFrameOwner?.startsWith('document-viewer-chassis:')
            && frame.shellRect !== null
            && (frame.viewportClientWidth ?? 0) > 0
        ));
        expect(firstPreparedFrame, JSON.stringify({
            layout,
            frames: coldOpenTrace.frames,
        })).toBeDefined();
        expect(
            Math.abs(
                firstPreparedFrame!.shellRect!.width
                - (firstPreparedFrame!.viewportClientWidth! - 40),
            ),
            JSON.stringify({
                layout,
                firstPreparedFrame,
            }),
        ).toBeLessThanOrEqual(1);
        expect(layout.viewportWidth).toBeGreaterThan(0);
        expect(layout.pageWidth).toBeGreaterThan(0);
        expect(
            Math.abs(layout.pageWidth - (layout.viewportWidth - 40)),
            JSON.stringify(layout),
        ).toBeLessThanOrEqual(1);
    });

    it('removes a deleted Recent file without starting a visible open transaction', async () => {
        let session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-missing-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        const fixturePath = await createLargeScannedFixturePdf(
            `recent-missing-${Date.now()}.pdf`,
            2,
            0,
        );
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        session = await sessionFixture.restart({
            clean: false,
            keepNuxt: true,
        });
        if (!session) {
            return;
        }

        await waitForStartupOverlayRemoved(session);
        await waitForRecentFileRow(session, fixturePath);
        unlinkSync(fixturePath);

        const transition = await evaluateInPage(session.page, (
            targetSourcePath: string,
            timeoutMs: number,
        ) => new Promise<{
            removed: boolean;
            sawDocumentTitleChange: boolean;
            sawOpenButtonDisabled: boolean;
            sawOpeningSurface: boolean;
            sawTabTitleChange: boolean;
            sawTargetDisabled: boolean;
        }>((resolve) => {
            const initialDocumentTitle = document.title;
            const initialTabTitle = document.querySelector<HTMLElement>(
                '.tab-list .tab.is-active .tab-label',
            )?.textContent?.trim() ?? '';
            let sawDocumentTitleChange = false;
            let sawOpenButtonDisabled = false;
            let sawOpeningSurface = false;
            let sawTabTitleChange = false;
            let sawTargetDisabled = false;
            let settled = false;

            const findRow = () => Array.from(document.querySelectorAll<HTMLElement>(
                '.recent-row--data:not(.recent-row--skeleton)',
            )).find(row => row.dataset.recentSource === targetSourcePath) ?? null;
            const finish = (removed: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                observer.disconnect();
                window.clearTimeout(timeout);
                resolve({
                    removed,
                    sawDocumentTitleChange,
                    sawOpenButtonDisabled,
                    sawOpeningSurface,
                    sawTabTitleChange,
                    sawTargetDisabled,
                });
            };
            const sample = () => {
                const row = findRow();
                const activeTabTitle = document.querySelector<HTMLElement>(
                    '.tab-list .tab.is-active .tab-label',
                )?.textContent?.trim() ?? '';
                sawDocumentTitleChange ||= document.title !== initialDocumentTitle;
                sawTabTitleChange ||= activeTabTitle !== initialTabTitle;
                sawOpenButtonDisabled ||= Boolean(
                    document.querySelector<HTMLButtonElement>('.open-panel-cta')?.disabled,
                );
                sawTargetDisabled ||= Boolean(
                    row?.classList.contains('is-disabled')
                    || row?.querySelector<HTMLButtonElement>('button.recent-open')?.disabled,
                );
                sawOpeningSurface ||= document.querySelector(
                    '.document-viewer-chassis__opening-page, .workspace-host__loading',
                ) !== null;
                if (!row) {
                    finish(true);
                }
            };
            const observer = new MutationObserver(sample);
            observer.observe(document.documentElement, {
                attributes: true,
                characterData: true,
                childList: true,
                subtree: true,
            });
            const timeout = window.setTimeout(() => finish(false), timeoutMs);
            const row = findRow();
            sample();
            row?.querySelector<HTMLButtonElement>('button.recent-open')?.click();
        }), fixturePath, RECENT_ROW_TIMEOUT_MS);

        expect(transition).toEqual({
            removed: true,
            sawDocumentTitleChange: false,
            sawOpenButtonDisabled: false,
            sawOpeningSurface: false,
            sawTabTitleChange: false,
            sawTargetDisabled: false,
        });
        await waitForFunctionInPage(session.page, (targetFileName: string) => (
            document.body.textContent?.includes(targetFileName) === true
        ), {timeout: RECENT_ROW_TIMEOUT_MS}, basename(fixturePath));
    });

    it('keeps keyboard remove isolated from opening the recent document', async () => {
        let session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-keyboard-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        const fixturePath = await createLargeScannedFixturePdf(
            `recent-keyboard-${Date.now()}.pdf`,
            3,
            0,
        );
        const fixtureName = basename(fixturePath);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        session = await sessionFixture.restart({
            clean: false,
            keepNuxt: true,
        });
        if (!session) {
            return;
        }

        await waitForStartupOverlayRemoved(session);
        await assertRecentListStaysStableBeforeOpen(session, fixturePath);
        const semanticSnapshot = await evaluateInPage(session.page, (targetSourcePath: string) => {
            const row = Array.from(document.querySelectorAll<HTMLElement>(
                '.recent-row--data:not(.recent-row--skeleton)',
            )).find(candidate => candidate.dataset.recentSource === targetSourcePath);
            return {
                rowTag: row?.tagName ?? null,
                openTag: row?.querySelector('.recent-open')?.tagName ?? null,
                revealTag: row?.querySelector('.recent-location--reveal')?.tagName ?? null,
                removeTag: row?.querySelector('.recent-action--remove')?.tagName ?? null,
                nestedButtons: row?.querySelectorAll('button button').length ?? -1,
            };
        }, fixturePath);
        expect(semanticSnapshot).toEqual({
            rowTag: 'DIV',
            openTag: 'BUTTON',
            revealTag: 'BUTTON',
            removeTag: 'BUTTON',
            nestedButtons: 0,
        });

        const searchInput = await session.page.$(
            '.editor-pane.is-active input[aria-label="Search recent files"]',
        );
        expect(searchInput).not.toBeNull();
        await searchInput!.type(fixtureName);
        await waitForFunctionInPage(session.page, (targetFileName: string) => {
            const rows = Array.from(document.querySelectorAll<HTMLElement>(
                '.recent-row--data:not(.recent-row--skeleton)',
            ));
            return rows.length === 1 && rows[0]?.textContent?.includes(targetFileName);
        }, { timeout: RECENT_ROW_TIMEOUT_MS }, fixtureName);

        const removeButton = await session.page.$(
            '.editor-pane.is-active .recent-row--data:not(.recent-row--skeleton) button.recent-action--remove',
        );
        expect(removeButton).not.toBeNull();
        await removeButton!.focus();
        await session.page.keyboard.press('Enter');
        await waitForFunctionInPage(session.page, (targetSourcePath: string) => (
            !Array.from(document.querySelectorAll<HTMLElement>(
                '.recent-row--data:not(.recent-row--skeleton)',
            )).some(row => row.dataset.recentSource === targetSourcePath)
        ), { timeout: RECENT_ROW_TIMEOUT_MS }, fixturePath);

        const finalState = await evaluateInPage(session.page, () => {
            const isVisible = (element: HTMLElement) => {
                let current: HTMLElement | null = element;
                while (current) {
                    const style = window.getComputedStyle(current);
                    if (
                        style.display === 'none'
                        || style.visibility === 'hidden'
                        || Number(style.opacity || '1') === 0
                    ) {
                        return false;
                    }
                    current = current.parentElement;
                }
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            const activeHost = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            );
            return {
                activeTabTitle: document.querySelector<HTMLElement>(
                    '.tab-list .tab.is-active .tab-label',
                )?.textContent?.trim() ?? '',
                hasVisibleDocumentContent: Array.from(activeHost?.querySelectorAll<HTMLElement>(
                    '#pdf-viewer .page_canvas canvas, .document-viewer-chassis__opening-page, .native-pdf-page-content',
                ) ?? []).some(isVisible),
            };
        });
        expect(finalState).toEqual({
            activeTabTitle: 'New Tab',
            hasVisibleDocumentContent: false,
        });
    });

    it('opens the exact recent source when two files share a basename', async () => {
        let session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-duplicate-basename-${Date.now()}`,
        });
        if (!session) {
            return;
        }

        const sharedName = 'duplicate-recent-source.pdf';
        const firstPath = createFixturePath(`duplicate-source-a/${sharedName}`);
        const secondPath = createFixturePath(`duplicate-source-b/${sharedName}`);
        mkdirSync(dirname(firstPath), {recursive: true});
        mkdirSync(dirname(secondPath), {recursive: true});
        await createScannedTextFixturePdf(`duplicate-source-a/${sharedName}`, 'EVB SOURCE A');
        await createScannedTextFixturePdf(`duplicate-source-b/${sharedName}`, 'EVB SOURCE B');
        const secondBeforeSave = readFileSync(secondPath);

        await openPdfInApp(session.page, firstPath);
        await waitForPdfLoaded(session.page);
        await expect(callWorkspaceCommand<boolean>(session.page, 'handleRotateCw', [[1]])).resolves.toMatchObject({
            called: true,
            value: true,
        });
        await expect(callWorkspaceCommand<boolean>(session.page, 'handleSave')).resolves.toMatchObject({
            called: true,
            value: true,
        });
        expect(readFileSync(secondPath)).toEqual(secondBeforeSave);
        await openPdfInApp(session.page, secondPath);
        await waitForPdfLoaded(session.page);
        session = await sessionFixture.restart({
            clean: false,
            keepNuxt: true,
        });
        if (!session) {
            return;
        }

        await waitForStartupOverlayRemoved(session);
        await waitForRecentFileRow(session, firstPath);
        await waitForRecentFileRow(session, secondPath);
        expect(await evaluateInPage(session.page, (paths: string[]) => (
            paths.map(path => Array.from(document.querySelectorAll<HTMLElement>(
                '.recent-row--data:not(.recent-row--skeleton)',
            )).filter(row => row.dataset.recentSource === path).length)
        ), [
            firstPath,
            secondPath,
        ])).toEqual([
            1,
            1,
        ]);

        await clickRecentFile(session, firstPath);
        await waitForRecentPdfOpen(session, firstPath);
        await waitForActiveDocumentSource(session.page, firstPath);
        session = await sessionFixture.restart({
            clean: false,
            keepNuxt: true,
        });
        if (!session) {
            return;
        }
        await waitForStartupOverlayRemoved(session);
        await waitForRecentFileRow(session, secondPath);
        await clickRecentFile(session, secondPath);
        await waitForRecentPdfOpen(session, secondPath);
        await waitForActiveDocumentSource(session.page, secondPath);
    });
});

const djvuFixture = resolveDjvuFixturePath();
const runDjvuRecentOrSkip = selectFixtureDescribe(describe, djvuFixture);

runDjvuRecentOrSkip('Electron E2E - Recent DjVu Files', () => {
    const sessionName = `e2e-recent-djvu-files-${Date.now()}`;

    const sessionFixture = createElectronE2ESessionFixture({sessionName});

    it('opens a persisted recent DjVu after restarting Electron', async () => {
        let session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        await openDjvuInApp(session.page, djvuFixture.path, 90_000);
        await waitForDjvuLoaded(session.page, 90_000);
        session = await sessionFixture.restart({
            clean: false,
            keepNuxt: true,
        });
        if (!session) {
            return;
        }

        await assertRecentListStaysStableBeforeOpen(session, djvuFixture.path);
        await clickRecentFile(session, djvuFixture.path);
        await waitForRecentDjvuOpen(session, djvuFixture.path);
    });
});
