import {
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import {
    activateMenuItemAsUser,
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import {
    basename,
    dirname,
} from 'node:path';
import {
    createFixturePath,
    createLargeScannedFixturePdf,
    createMixedPageSizeTextFixturePdf,
    createMultiPageTextFixturePdf,
    createScannedTextFixturePdf,
    resolveDjvuFixturePath,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    clickVisibleToolbarButton,
    goToPageViaToolbar,
    openDjvuInApp,
    openPdfInApp,
    waitForToolbarCurrentPage,
    waitForDjvuLoaded,
    waitForActiveDocumentSource,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {
    activatePaneByTab,
    splitActiveTabFromTabMenu,
} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    callWorkspaceCommand,
    requireWorkspaceCommand,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    findCommittedSurfaceCausalOpenViolations,
    installCommittedSurfaceSampler,
    isOpeningBeforePageGeometry,
    markCommittedSurfaceInteractionCheckpoint,
    stopCommittedSurfaceSampler,
    summarizeCommittedSurfaceTiming,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';
import { expectWithinTimingBudget } from '@tests/e2e/electron/helpers/timingBudget';

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
// A mouse click holds the button down for about a tenth of a second.
const RECENT_PRESS_MS = 80;
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
    atPageMs: number;
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
    shellInteractiveAtMs: number | null;
    recentRowVisibleAtShell: boolean;
    sawVisibleDisabledTargetRow: boolean;
    openingSurfaceAtMs: number | null;
    openingSurfaceElapsedMs: number | null;
    openingSurfaceFound: boolean;
    targetReadyAtClick: boolean;
    targetActionableAtClick: boolean;
    firstOpenSurfaceFrame: {
        activeTabTitle: string;
        openSurfacePhase: string | null;
        openSurfacePresentation: string | null;
        openingGeometryKnown: boolean;
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
                atPageMs: performance.now(),
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

// The held opening page shell, and a drawn page, as rects in the window.
function readHeldShell(session: IElectronE2ESession) {
    return evaluateInPage(session.page, () => {
        const shell = document.querySelector<HTMLElement>('.editor-pane.is-active [data-document-opening-shell-id]');
        const rect = shell?.getBoundingClientRect();
        return shell && rect ? {
            page: Number(shell.dataset.pageNumber),
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
        } : null;
    });
}

function readDrawnPage(session: IElectronE2ESession, pageNumber: number) {
    return evaluateInPage(session.page, (page: number) => {
        const rect = document.querySelector<HTMLElement>(
            `.editor-pane.is-active #pdf-viewer .page_container[data-page="${page}"]`,
        )?.getBoundingClientRect();
        return rect ? {
            page,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
        } : null;
    }, pageNumber);
}

// A drawn page sits where its shell sat, within the committed surface
// contract's one CSS pixel (scroll positions snap to device pixels).
function expectSameRect(actual: Awaited<ReturnType<typeof readDrawnPage>>, expected: Awaited<ReturnType<typeof readHeldShell>>) {
    expect(actual?.page).toBe(expected?.page);
    for (const key of [
        'top',
        'left',
        'width',
        'height',
    ] as const) {
        expect(Math.abs((actual?.[key] ?? Number.NaN) - (expected?.[key] ?? Number.NaN)), `${key}: ${JSON.stringify({
            actual,
            expected,
        })}`).toBeLessThanOrEqual(1);
    }
}

function assertToolbarTransitionStable(
    samples: IToolbarTransitionSample[],
    openClickAtPageMs: number | null,
) {
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

    // Before the Recent click the tab is the New Tab screen, whose toolbar
    // deliberately shows only its shell actions (13e432ddd). The document
    // toolbar must be full from the click that starts the open.
    expect(openClickAtPageMs, JSON.stringify(samples)).not.toBeNull();
    const sparseToolbarSamples = relevantSamples.filter(sample => (
        sample.atPageMs >= openClickAtPageMs!
        && sample.visibleControlCount < TOOLBAR_MIN_VISIBLE_CONTROL_COUNT
        && sample.visibleIconCount < TOOLBAR_MIN_VISIBLE_CONTROL_COUNT
    ));
    expect(sparseToolbarSamples, JSON.stringify(samples)).toEqual([]);

    const workspaceTops = relevantSamples.map(sample => sample.workspaceTop);
    const workspaceTopDelta = Math.max(...workspaceTops) - Math.min(...workspaceTops);
    expect(workspaceTopDelta, JSON.stringify(samples)).toBeLessThanOrEqual(TOOLBAR_MAX_OPEN_SHIFT_PX);

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
            '.document-viewer-chassis__opening-page, .document-page-source-feature-pack__page',
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

// The place a reader sees: the toolbar's page and zoom, and that page's own
// text drawn in the viewport.
async function expectReadingPlace(session: IElectronE2ESession, pageNumber: number, zoomLabel: string) {
    await waitForToolbarCurrentPage(session.page, pageNumber);
    await waitForFunctionInPage(session.page, (expected: {
        pageNumber: number;
        zoomLabel: string;
    }) => {
        const viewport = document.querySelector<HTMLElement>(
            '.editor-pane.is-active [data-document-viewer-chassis-viewport]',
        )?.getBoundingClientRect();
        const container = document.querySelector<HTMLElement>(
            `.editor-pane.is-active #pdf-viewer .page_container[data-page="${expected.pageNumber}"]`,
        );
        const rect = container?.getBoundingClientRect();
        const zoom = document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')?.textContent?.trim();
        return Boolean(
            viewport && rect
            && rect.bottom > viewport.top && rect.top < viewport.bottom
            && container?.querySelector('.textLayer, .text-layer')?.textContent
                ?.includes(`E2E Multi Page Fixture ${expected.pageNumber}/40`)
            && zoom === expected.zoomLabel,
        );
    }, {timeout: RECENT_OPEN_TIMEOUT_MS}, {
        pageNumber,
        zoomLabel,
    });
}

function readZoomLabel(session: IElectronE2ESession) {
    return evaluateInPage(session.page, () => (
        document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')?.textContent?.trim() ?? ''
    ));
}

// Each Zoom In shows a new zoom before the next is pressed.
async function zoomInTwiceAsReader(session: IElectronE2ESession, before: string) {
    let shown = before;
    for (let step = 0; step < 2; step += 1) {
        await clickVisibleToolbarButton(session.page, 'Zoom In');
        await waitForFunctionInPage(session.page, (previous: string) => {
            const zoom = document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')?.textContent?.trim();
            return Boolean(zoom) && zoom !== previous;
        }, {timeout: RECENT_OPEN_TIMEOUT_MS}, shown);
        shown = await readZoomLabel(session);
    }
    return shown;
}

// From now on, the pages drawn with content (a PDF page's raster, a DjVu
// page's committed image), in the order they are drawn.
// Record the first pages painted inside the viewport: a rendered PDF page or a
// decoded committed page image. Pages committed offscreen are not seen.
async function recordDrawnPages(session: IElectronE2ESession) {
    await evaluateInPage(session.page, () => {
        const drawn: number[] = [];
        (window as Window & {__drawnPagesForTest?: number[]}).__drawnPagesForTest = drawn;
        const record = () => {
            const viewport = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-document-viewer-chassis-viewport]',
            )?.getBoundingClientRect();
            for (const page of document.querySelectorAll<HTMLElement>('.editor-pane.is-active [data-document-page-number]')) {
                const pageNumber = Number(page.dataset.documentPageNumber);
                if (!viewport || drawn.includes(pageNumber)) {
                    continue;
                }
                const image = page.querySelector<HTMLImageElement>('img[data-document-page-visual="committed"]');
                const painted = page.classList.contains('page_container--rendered')
                    ? page
                    : (image?.complete && image.naturalWidth > 0 ? image : null);
                const rect = painted?.getBoundingClientRect();
                if (rect && rect.bottom > viewport.top && rect.top < viewport.bottom
                    && rect.right > viewport.left && rect.left < viewport.right) {
                    drawn.push(pageNumber);
                }
            }
            if (drawn.length === 0) {
                requestAnimationFrame(record);
            }
        };
        requestAnimationFrame(record);
    });
}

// The first page drawn is the remembered one or its neighbour, never page 1
// painted and then replaced.
async function expectFirstDrawnPageNear(session: IElectronE2ESession, pageNumber: number) {
    const drawn = await evaluateInPage(session.page, () => (
        (window as Window & {__drawnPagesForTest?: number[]}).__drawnPagesForTest ?? []
    ));
    expect(drawn.length, JSON.stringify(drawn)).toBeGreaterThan(0);
    expect(Math.abs(drawn[0]! - pageNumber), JSON.stringify(drawn)).toBeLessThanOrEqual(1);
}

// Quit through the installed menu's accelerator, as the reader would, and wait
// for this window to go: the quit must pass the window's close decision.
async function quitAsUser(session: IElectronE2ESession) {
    const windowClosed = new Promise<void>(resolve => session.page.once('close', () => resolve()));
    await activateMenuItemAsUser(session.page, {accelerator: 'CmdOrCtrl+Q'});
    await windowClosed;
}

async function waitForRecentFileRow(session: IElectronE2ESession, sourcePath: string) {
    await waitForFunctionInPage(session.page, (targetSourcePath: string) => {
        return Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'))
            .some(row => row.dataset.recentSource === targetSourcePath);
    }, { timeout: RECENT_ROW_TIMEOUT_MS }, sourcePath);
}

async function clickRecentFile(session: IElectronE2ESession, sourcePath: string) {
    await waitForRecentFileRow(session, sourcePath);

    await clickFoundAsUser(session.page, (targetSourcePath: string) => Array.from(
        document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'),
    ).find(candidate => candidate.dataset.recentSource === targetSourcePath)
        ?.querySelector<HTMLButtonElement>('button.recent-open'), sourcePath, {description: `recent open button for ${sourcePath}`});
}

// The open is held before its working copy exists, so a skeleton now was sized
// from the source file, not from the copy.
async function waitForOpeningSkeletonWhileOpenHeld(session: IElectronE2ESession) {
    await waitForFunctionInPage(session.page, () => Array.from(
        document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .document-page-skeleton',
        ),
    ).some((skeleton) => {
        const rect = skeleton.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && window.getComputedStyle(skeleton).visibility !== 'hidden';
    }), {timeout: RECENT_OPEN_TIMEOUT_MS});
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
    // IPC/stat preflight has variable duration, so opening-surface budgets
    // start with the first positive open-surface snapshot—not the raw click or
    // the tab/session bookkeeping that may precede that snapshot.
    const transition = evaluateInPage(session.page, (
        targetSourcePath: string,
        shellBudgetMs: number,
    ) => new Promise<IRecentOpenTransitionResult>((resolve) => {
        const previousActiveTabId = document.querySelector<HTMLElement>(
            '.tab-list .tab.is-active[data-tab-id]',
        )?.dataset.tabId ?? null;
        const currentTabCloseButton = document.querySelector<HTMLButtonElement>(
            '.tab-list .tab.is-active .tab-close',
        );
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
                openingGeometryKnown: chassis?.dataset.openSurfaceHasOpeningGeometry === 'true',
                viewportVisualPresentation: chassis?.dataset.viewportVisualPresentation ?? null,
                recentRowVisible: isVisible(getRecentRow()),
                shellVisible: exactPageShell !== null,
                // Any skeleton the tab paints, not only the page shell's: a
                // placeholder that is not page-shaped is what this rules out.
                skeletonVisible: Array.from(
                    activeHost?.querySelectorAll<HTMLElement>('.document-page-skeleton') ?? [],
                ).some(isVisible),
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
        const finish = (openingSurfaceAtMs: number | null) => {
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
                shellInteractiveAtMs,
                recentRowVisibleAtShell: isVisible(getRecentRow()),
                sawVisibleDisabledTargetRow,
                openingSurfaceAtMs,
                openingSurfaceElapsedMs: clickAtMs !== null && openingSurfaceAtMs !== null
                    ? Math.round(openingSurfaceAtMs - clickAtMs)
                    : null,
                openingSurfaceFound: openingSurfaceAtMs !== null,
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
                const openButton = recentRow?.querySelector<HTMLButtonElement>('button.recent-open') ?? null;
                const pressWindow = window as Window & {__recentPressPoint?: {
                    x: number;
                    y: number
                } | null};
                if (recentRow && openButton && pressWindow.__recentPressPoint === undefined) {
                    // The row is pressed with the mouse; its click is the open.
                    openButton.addEventListener('click', () => {
                        targetReadyAtClick = recentRow.dataset.recentOpenReady === 'true';
                        targetActionableAtClick = recentRow.dataset.recentOpenActionable === 'true';
                        clickAtMs = performance.now();
                        pressWindow.__recentPressPoint = null;
                        (window as Window & {__committedSurfaceInteractionCheckpoint?: string | null;})
                            .__committedSurfaceInteractionCheckpoint = 'recent-click';
                    }, {
                        capture: true,
                        once: true,
                    });
                    const rect = openButton.getBoundingClientRect();
                    pressWindow.__recentPressPoint = {
                        x: rect.left + (rect.width / 2),
                        y: rect.top + (rect.height / 2),
                    };
                }
                window.requestAnimationFrame(sample);
                return;
            }
            const sampledAtMs = performance.now();
            framesAfterClick += 1;
            const transitionFrame = readOpenSurfaceFrame();
            if (hasOpenSurfaceTransitionStarted(transitionFrame)) {
                firstOpenSurfaceFrame = transitionFrame;
                finish(sampledAtMs);
                return;
            }
            preSurfaceFrames += 1;
            if (sampledAtMs - clickAtMs > shellBudgetMs) {
                finish(null);
                return;
            }
            window.requestAnimationFrame(sample);
        };

        delete (window as Window & {__recentPressPoint?: unknown}).__recentPressPoint;
        currentTabCloseButton?.click();
        emptyTabCreatedAtMs = performance.now();
        window.requestAnimationFrame(sample);
    }), sourcePath, RECENT_OPEN_TIMEOUT_MS);
    await waitForFunctionInPage(session.page, () => (
        (window as Window & {__recentPressPoint?: unknown}).__recentPressPoint !== undefined
    ), {timeout: RECENT_ROW_TIMEOUT_MS});
    const pressPoint = await evaluateInPage(session.page, () => (
        (window as Window & {__recentPressPoint?: {
            x: number;
            y: number
        }}).__recentPressPoint!
    ));
    await session.page.mouse.move(pressPoint.x, pressPoint.y);
    await session.page.mouse.down();
    await delay(RECENT_PRESS_MS);
    await session.page.mouse.up();
    // The press opens only if its click reached the row's open button. One
    // that missed, because the row moved or was replaced after its point was
    // read, would leave the sampler waiting for a click until the test timed out.
    const clicked = await waitForFunctionInPage(session.page, () => (
        (window as Window & {__recentPressPoint?: unknown}).__recentPressPoint === null
    ), {timeout: RECENT_ROW_TIMEOUT_MS}).then(() => true, () => false);
    if (!clicked) {
        void transition.catch(() => undefined);
        throw new Error(`The press at ${JSON.stringify(pressPoint)} did not click the Recent row of ${sourcePath}: ${
            describeRecentOpenDomState(await readRecentOpenDomState(session, sourcePath))
        }`);
    }
    return transition;
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

    it('opens a previously read Recent file to its page-shaped skeleton in the first frame, before the working copy is made', async () => {
        const session = sessionFixture.getSession();

        const fixturePath = await createScannedTextFixturePdf(
            `recent-file-${Date.now()}.pdf`,
            'NON-LETTER PAGE',
        );
        const fixtureDocumentRef = requireDocumentRef(fixturePath);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);

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
        expect(immediateOpen.openingSurfaceFound, JSON.stringify(immediateOpen)).toBe(true);
        // The open is held before the working copy exists, as a slow disk holds
        // it. The page's shape does not wait for the working copy, so the
        // page-shaped skeleton is on screen while the open is still held.
        await waitForOpeningSkeletonWhileOpenHeld(session);
        const sourceReleased = await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__releaseDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef);
        expect(sourceReleased).toBe(true);
        // Opening a Recent file consumes the current empty tab; it must not create
        // another tab or replace the current tab identity.
        expect(immediateOpen.activeTabChanged, JSON.stringify(immediateOpen)).toBe(false);
        expect(immediateOpen.shellInteractiveAtMs, JSON.stringify(immediateOpen)).not.toBeNull();
        expect(immediateOpen.clickAtMs, JSON.stringify(immediateOpen)).not.toBeNull();
        expectWithinTimingBudget(
            immediateOpen.actionableElapsedMs,
            RECENT_EMPTY_TAB_ACTIONABLE_BUDGET_MS,
            JSON.stringify(immediateOpen),
        );
        expect(immediateOpen.targetReadyAtClick, JSON.stringify(immediateOpen)).toBe(true);
        expect(immediateOpen.targetActionableAtClick, JSON.stringify(immediateOpen)).toBe(true);
        expect(immediateOpen.recentRowVisibleAtShell, JSON.stringify(immediateOpen)).toBe(false);
        // The app has read this file before, so its page shape is known when
        // the open claims the tab: the first frame after the click shows the
        // page skeleton, never the bare viewer (#931).
        expect(immediateOpen.firstOpenSurfaceFrame, JSON.stringify(immediateOpen)).toMatchObject({
            activeTabTitle: basename(fixturePath),
            openingGeometryKnown: true,
            recentRowVisible: false,
            shellVisible: true,
            skeletonVisible: true,
        });
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
        expect(committedCanvasState.rect).not.toBeNull();
        assertToolbarTransitionStable(await stopToolbarTransitionSampling(session), immediateOpen.clickAtMs);
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
        const firstGeometryIndex = openSurfaceTrace.frames.findIndex(frame => (
            frame.openSurfaceDiagnostic?.openSurfaceHasOpeningGeometry === 'true'
        ));
        expect(firstGeometryIndex, JSON.stringify(openSurfaceTrace.frames)).toBeGreaterThanOrEqual(0);
        const firstGeometryFrame = openSurfaceTrace.frames[firstGeometryIndex]!;
        const geometryTrace = {
            ...(openSurfaceTrace.errors ? {errors: openSurfaceTrace.errors} : {}),
            frames: openSurfaceTrace.frames.slice(firstGeometryIndex).map(frame => ({
                ...frame,
                elapsedMs: Math.max(0, frame.elapsedMs - firstGeometryFrame.elapsedMs),
            })),
        };
        const causalViolations = findCommittedSurfaceCausalOpenViolations(geometryTrace, {
            maxFirstCanvasMs: RECENT_FIRST_CANVAS_BUDGET_MS,
            maxFirstPageShellMs: RECENT_FIRST_PAGE_SHELL_BUDGET_MS,
            maxReadyAfterCanvasMs: RECENT_READY_AFTER_CANVAS_BUDGET_MS,
            requirePageShell: true,
        });
        const firstGeometryTraceFrame = geometryTrace.frames[0];
        const firstVisiblePageShellFrame = openSurfaceTrace.frames.find(frame => frame.kind === 'page-shell');
        expect(firstVisiblePageShellFrame, JSON.stringify(openSurfaceTrace.frames)).toBeDefined();
        expect(
            firstVisiblePageShellFrame?.openSurfaceDiagnostic?.openSurfaceHasOpeningGeometry,
            JSON.stringify(firstVisiblePageShellFrame),
        ).toBe('true');
        expect(
            firstVisiblePageShellFrame?.shellRect
                ? firstVisiblePageShellFrame.shellRect.width / firstVisiblePageShellFrame.shellRect.height
                : null,
            JSON.stringify(firstVisiblePageShellFrame),
        ).toBeCloseTo(2.4, 2);
        expect(committedCanvasState.borderRadius).toBe(firstVisiblePageShellFrame?.shellStyle?.borderRadius);
        expect(committedCanvasState.boxShadow).toBe(firstVisiblePageShellFrame?.shellStyle?.boxShadow);
        for (const key of [
            'height',
            'left',
            'top',
            'width',
        ] as const) {
            expect(Math.abs(
                committedCanvasState.rect![key] - firstVisiblePageShellFrame!.shellRect![key],
            ), JSON.stringify({
                key,
                committedCanvasState,
                openingPageShell: firstVisiblePageShellFrame,
            })).toBeLessThanOrEqual(0.5);
        }
        const visiblePageShellFrameDelta = firstGeometryTraceFrame && firstVisiblePageShellFrame
            ? firstVisiblePageShellFrame.frame - firstGeometryTraceFrame.frame
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
            openingSurfaceElapsedMs: immediateOpen.openingSurfaceElapsedMs,
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

    it('opens a dropped PDF in a new tab through one page-shaped skeleton', async () => {
        const session = await sessionFixture.restart({clean: true});
        await waitForStartupOverlayRemoved(session);
        const openPath = await createScannedTextFixturePdf(`drop-target-${Date.now()}.pdf`, 'OPEN PAGE');
        const droppedPath = await createScannedTextFixturePdf(`dropped-${Date.now()}.pdf`, 'DROPPED PAGE');
        await openPdfInApp(session.page, openPath);
        await waitForPdfLoaded(session.page);
        const dropPoint = await evaluateInPage(session.page, () => {
            const rect = document.querySelector<HTMLElement>(
                '.editor-pane.is-active [data-document-viewer-chassis-viewport]',
            )?.getBoundingClientRect();
            return rect
                ? {
                    x: rect.left + (rect.width / 2),
                    y: rect.top + (rect.height / 2),
                }
                : null;
        });
        expect(dropPoint).not.toBeNull();

        await installCommittedSurfaceSampler(session.page);
        await markCommittedSurfaceInteractionCheckpoint(session.page, 'drop');
        // Hold the open before its working copy exists, as a slow disk does.
        const droppedDocumentRef = requireDocumentRef(droppedPath);
        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__deferDocumentOpenForAutomation?.(path) ?? false
        ), droppedDocumentRef)).toBe(true);
        // A file dragged in from the desktop, through the browser's drag input.
        const cdp = await session.page.createCDPSession();
        try {
            const data = {
                items: [],
                files: [droppedPath],
                dragOperationsMask: 1,
            };
            for (const type of [
                'dragEnter',
                'dragOver',
                'drop',
            ] as const) {
                await cdp.send('Input.dispatchDragEvent', {
                    type,
                    x: dropPoint!.x,
                    y: dropPoint!.y,
                    data,
                });
            }
        } finally {
            await cdp.detach();
        }
        // The dropped file's page shape is read from the file itself, so its
        // skeleton is on screen while the open is still held.
        await waitForOpeningSkeletonWhileOpenHeld(session);
        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__releaseDocumentOpenForAutomation?.(path) ?? false
        ), droppedDocumentRef)).toBe(true);
        await waitForFunctionInPage(session.page, (fileName: string) => (
            document.querySelector('.tab-list .tab.is-active .tab-label')?.textContent?.trim() === fileName
            && document.querySelector(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .page_container--rendered canvas',
            ) !== null
        ), {timeout: RECENT_OPEN_TIMEOUT_MS}, basename(droppedPath));
        await delay(250);
        const trace = await stopCommittedSurfaceSampler(session.page);
        const frames = trace.frames.filter(frame => frame.interactionCheckpoint === 'drop');
        const details = JSON.stringify(frames.map(frame => ({
            elapsedMs: frame.elapsedMs,
            frame: frame.frame,
            hasOpeningGeometry: frame.openSurfaceDiagnostic?.openSurfaceHasOpeningGeometry,
            hosts: frame.visibleWorkspaceHostCount,
            kind: frame.kind,
            phase: frame.openSurfacePhase,
            shellRect: frame.shellRect,
            skeletonCount: frame.skeletonCount,
            skeletonSharesShell: frame.skeletonSharesShell,
        })));

        expect(trace.errors ?? [], details).toEqual([]);
        // The tab the file was dropped on is not kept on screen over the new
        // one, and the new tab never shows its Start page on the way.
        expect(frames.filter(frame => (frame.visibleWorkspaceHostCount ?? 0) > 1), details).toEqual([]);
        expect(frames.filter(frame => (
            frame.kind === 'committed-empty' || frame.kind === 'loader' || frame.kind === 'tool-surface'
        )), details).toEqual([]);
        // Until the page's shape is known the new tab is the bare viewer; then
        // it shows that shape, and then the page in the same place.
        const firstShellIndex = frames.findIndex(frame => frame.kind === 'page-shell');
        expect(firstShellIndex, details).toBeGreaterThan(0);
        expect(frames.slice(0, firstShellIndex).filter(frame => (
            frame.kind === 'blank'
                ? frame.openSurfacePhase !== null && !isOpeningBeforePageGeometry(frame)
                : frame.kind !== 'committed-canvas'
        )), details).toEqual([]);
        // The page's shape is read from the drop on, while the new tab mounts,
        // so at most one frame after the tab claims the open is bare (#931).
        expect(frames.slice(0, firstShellIndex).filter(isOpeningBeforePageGeometry).length, details)
            .toBeLessThanOrEqual(1);
        const opening = frames.slice(firstShellIndex);
        const firstCanvasIndex = opening.findIndex(frame => frame.kind === 'committed-canvas');
        expect(firstCanvasIndex, details).toBeGreaterThan(0);
        // A shell frame is the page frame holding exactly its one skeleton.
        expect(opening.slice(0, firstCanvasIndex).every(frame => (
            frame.kind === 'page-shell'
            && frame.skeletonCount === 1
            && frame.skeletonSharesShell
        )), details).toBe(true);
        expect(opening.slice(firstCanvasIndex).every(frame => frame.kind === 'committed-canvas'), details).toBe(true);
        const canvasRect = opening.at(-1)!.shellRect!;
        for (const shell of opening.slice(0, firstCanvasIndex)) {
            for (const key of [
                'height',
                'left',
                'top',
                'width',
            ] as const) {
                expect(Math.abs(shell.shellRect![key] - canvasRect[key]), details).toBeLessThanOrEqual(0.5);
            }
        }
    });

    it('fits the first Recent PDF to the viewport after startup', async () => {
        let session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-cold-fit-${Date.now()}`,
        });

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
        session = await sessionFixture.restart({clean: false});

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
            frame.openSurfaceDiagnostic?.openSurfaceOpeningFrameOwner?.startsWith('document-viewer-runtime:')
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

    it('keeps keyboard remove isolated from opening the recent document', async () => {
        let session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-keyboard-${Date.now()}`,
        });

        const fixturePath = await createLargeScannedFixturePdf(
            `recent-keyboard-${Date.now()}.pdf`,
            3,
            0,
        );
        const fixtureName = basename(fixturePath);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        session = await sessionFixture.restart({clean: false});

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
                    '#pdf-viewer .page_canvas canvas, .document-viewer-chassis__opening-page',
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
        session = await sessionFixture.restart({clean: false});

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
        session = await sessionFixture.restart({clean: false});
        await waitForStartupOverlayRemoved(session);
        await waitForRecentFileRow(session, secondPath);
        await clickRecentFile(session, secondPath);
        await waitForRecentPdfOpen(session, secondPath);
        await waitForActiveDocumentSource(session.page, secondPath);
    });

    it('reopens an unchanged PDF where it was left, after a tab close and after a relaunch', async () => {
        const fixturePath = await createMultiPageTextFixturePdf(`recent-reading-view-${Date.now()}.pdf`, 40);
        // Open File answers with the fixture, as the native dialog would.
        const extraEnv = {EVB_E2E_OPEN_DIALOG_PATH: fixturePath};
        let session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-reading-view-${Date.now()}`,
            extraEnv,
        });

        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        const defaultZoomLabel = await readZoomLabel(session);
        await goToPageViaToolbar(session.page, 27);
        const readingZoomLabel = await zoomInTwiceAsReader(session, defaultZoomLabel);
        await expectReadingPlace(session, 27, readingZoomLabel);

        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await waitForRecentFileRow(session, fixturePath);
        await recordDrawnPages(session);
        await clickAsUser(session.page, '.editor-pane.is-active .start-open-panel .open-panel-cta');
        await waitForPdfLoaded(session.page);
        await expectReadingPlace(session, 27, readingZoomLabel);
        await expectFirstDrawnPageNear(session, 27);

        // Quitting remembers the place the reader moved to since the reopen.
        await goToPageViaToolbar(session.page, 31);
        await quitAsUser(session);
        session = await sessionFixture.restart({
            clean: false,
            extraEnv,
        });

        await waitForStartupOverlayRemoved(session);
        await recordDrawnPages(session);
        await clickRecentFile(session, fixturePath);
        await waitForRecentPdfOpen(session, fixturePath);
        await expectReadingPlace(session, 31, readingZoomLabel);
        await expectFirstDrawnPageNear(session, 31);

        // Clear History forgets the place with the file: the next open starts at the defaults.
        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await waitForRecentFileRow(session, fixturePath);
        await clickAsUser(session.page, '.editor-pane.is-active .recent-clear');
        await clickFoundAsUser(session.page, () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button'))
            .find(button => button.textContent?.trim() === 'Clear History'), undefined, {description: 'Clear History confirmation'});
        await waitForFunctionInPage(session.page, () => (
            document.querySelectorAll('.recent-row--data:not(.recent-row--skeleton)').length === 0
        ), {timeout: RECENT_ROW_TIMEOUT_MS});
        await clickAsUser(session.page, '.editor-pane.is-active .start-open-panel .open-panel-cta');
        await waitForPdfLoaded(session.page);
        await expectReadingPlace(session, 1, defaultZoomLabel);
    });

    it('opens a changed source at the defaults, not at the place left in its former bytes', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-reading-changed-${Date.now()}`,
        });
        // The clean restart clears session fixtures, so the file is made after it.
        const fixturePath = await createMultiPageTextFixturePdf(`recent-reading-changed-${Date.now()}.pdf`, 40);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        const defaultZoomLabel = await readZoomLabel(session);
        await goToPageViaToolbar(session.page, 27);
        await zoomInTwiceAsReader(session, defaultZoomLabel);
        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await waitForRecentFileRow(session, fixturePath);

        // Another program rewrites the file with other pages.
        const replacement = await createMultiPageTextFixturePdf(`recent-reading-replacement-${Date.now()}.pdf`, 40);
        writeFileSync(fixturePath, Buffer.concat([
            readFileSync(replacement),
            Buffer.from('\n% rewritten\n'),
        ]));

        await clickRecentFile(session, fixturePath);
        await waitForRecentPdfOpen(session, fixturePath);
        await expectReadingPlace(session, 1, defaultZoomLabel);
    });

    it('leaves a reopening view where the reader pressed it while the open was held', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-reading-intent-${Date.now()}`,
        });
        // The clean restart clears session fixtures, so the file is made after it.
        const fixturePath = await createMultiPageTextFixturePdf(`recent-reading-intent-${Date.now()}.pdf`, 40);
        const fixtureDocumentRef = requireDocumentRef(fixturePath);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        const defaultZoomLabel = await readZoomLabel(session);
        await goToPageViaToolbar(session.page, 27);
        const readingZoomLabel = await zoomInTwiceAsReader(session, defaultZoomLabel);
        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await waitForRecentFileRow(session, fixturePath);

        // Hold the open before its working copy exists, as a slow disk does.
        // The held view already shows the place the reader left: page 27 at
        // the reading zoom.
        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__deferDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef)).toBe(true);
        await clickRecentFile(session, fixturePath);
        await waitForOpeningSkeletonWhileOpenHeld(session);
        const held = await readHeldShell(session);
        expect(held?.page).toBe(27);


        // A plain press moves nothing: the held view stays exactly as shown,
        // and the open presents that place, not the defaults.
        await clickAsUser(session.page, '.editor-pane.is-active [data-document-viewer-chassis-viewport]');
        expect(await readHeldShell(session)).toEqual(held);
        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__releaseDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef)).toBe(true);
        await waitForRecentPdfOpen(session, fixturePath);
        await expectReadingPlace(session, 27, readingZoomLabel);
        expectSameRect(await readDrawnPage(session, 27), held);

        // Closing remembers that place; the next reopen returns there.
        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await waitForRecentFileRow(session, fixturePath);
        await clickRecentFile(session, fixturePath);
        await waitForRecentPdfOpen(session, fixturePath);
        await expectReadingPlace(session, 27, readingZoomLabel);
    });

    it('reopens a PDF where it was left in the view it began in, when the reader splits it while the open is held', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-reading-split-${Date.now()}`,
        });
        const fixturePath = await createMultiPageTextFixturePdf(`recent-reading-split-${Date.now()}.pdf`, 40);
        const fixtureDocumentRef = requireDocumentRef(fixturePath);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        const defaultZoomLabel = await readZoomLabel(session);
        await goToPageViaToolbar(session.page, 27);
        const readingZoomLabel = await zoomInTwiceAsReader(session, defaultZoomLabel);
        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await waitForRecentFileRow(session, fixturePath);
        const openingPaneId = await evaluateInPage(session.page, () => (
            document.querySelector<HTMLElement>('.editor-pane.is-active')?.dataset.editorPaneId ?? null
        ));
        expect(openingPaneId).not.toBeNull();

        // Hold the open, then Split Right: the new pane's linked view becomes
        // the one in use before the source arrives.
        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__deferDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef)).toBe(true);
        await clickRecentFile(session, fixturePath);
        await waitForOpeningSkeletonWhileOpenHeld(session);
        await splitActiveTabFromTabMenu(session.page, 'right');
        const linkedPaneId = await evaluateInPage(session.page, () => (
            document.querySelector<HTMLElement>('.editor-pane.is-active')?.dataset.editorPaneId ?? null
        ));
        expect(linkedPaneId).not.toBe(openingPaneId);
        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__releaseDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef)).toBe(true);

        // The linked view shows the document from its own start, at its own
        // pane's fit; the view the open began in returns to the place it was left.
        await waitForPdfLoaded(session.page);
        await waitForToolbarCurrentPage(session.page, 1);
        await activatePaneByTab(session.page, openingPaneId!);
        await expectReadingPlace(session, 27, readingZoomLabel);
        await activatePaneByTab(session.page, linkedPaneId!);
        await waitForToolbarCurrentPage(session.page, 1);
    });

    it('leaves a reopening view where the reader wheel-zoomed it while the open was held', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-reading-zoom-intent-${Date.now()}`,
        });
        // The clean restart clears session fixtures, so the file is made after it.
        const fixturePath = await createMultiPageTextFixturePdf(`recent-reading-zoom-intent-${Date.now()}.pdf`, 40);
        const fixtureDocumentRef = requireDocumentRef(fixturePath);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        const defaultZoomLabel = await readZoomLabel(session);
        await goToPageViaToolbar(session.page, 27);
        const readingZoomLabel = await zoomInTwiceAsReader(session, defaultZoomLabel);
        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await waitForRecentFileRow(session, fixturePath);

        // Hold the open before its working copy exists, as a slow disk does.
        // The held view already shows the place the reader left: page 27 at
        // the reading zoom.
        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__deferDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef)).toBe(true);
        await clickRecentFile(session, fixturePath);
        await waitForOpeningSkeletonWhileOpenHeld(session);
        const held = await readHeldShell(session);
        expect(held?.page).toBe(27);


        // Zoom with the wheel over the held view (Command on macOS, where
        // Control and the wheel scroll; Control elsewhere). The zoom starts
        // from the shown reading scale and keeps the page point under the
        // pointer; the open then presents that zoom and point.
        const pointer = {
            x: held!.left + held!.width / 2,
            y: held!.top + held!.height * 0.25,
        };
        const pointOn = (rect: {
            top: number;
            left: number;
            width: number;
            height: number
        }) => ({
            x: (pointer.x - rect.left) / rect.width,
            y: (pointer.y - rect.top) / rect.height,
        });
        await session.page.mouse.move(pointer.x, pointer.y);
        const zoomModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await session.page.keyboard.down(zoomModifier);
        await session.page.mouse.wheel({deltaY: -40});
        await session.page.keyboard.up(zoomModifier);
        await waitForFunctionInPage(session.page, (heldWidth: number) => {
            const width = document.querySelector('.editor-pane.is-active [data-document-opening-shell-id]')?.getBoundingClientRect().width;
            return width !== undefined && width > heldWidth;
        }, {timeout: RECENT_OPEN_TIMEOUT_MS}, held!.width);
        const zoomed = await readHeldShell(session);
        expect(zoomed?.page).toBe(27);
        expect(pointOn(zoomed!).x).toBeCloseTo(pointOn(held!).x, 2);
        expect(pointOn(zoomed!).y).toBeCloseTo(pointOn(held!).y, 2);

        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__releaseDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef)).toBe(true);
        await waitForRecentPdfOpen(session, fixturePath);
        // The page is drawn at the zoomed shell's rect, so at its scale; the
        // zoom shown is above the reading zoom the open started from.
        await waitForToolbarCurrentPage(session.page, 27);
        const zoomedLabel = await readZoomLabel(session);
        expect(Number.parseFloat(zoomedLabel)).toBeGreaterThan(Number.parseFloat(readingZoomLabel));
        await expectReadingPlace(session, 27, zoomedLabel);
        expectSameRect(await readDrawnPage(session, 27), zoomed);
    });

    it('leaves a quarter-turned reopening view where the reader wheel-zoomed it while the open was held', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-reading-turned-zoom-intent-${Date.now()}`,
        });
        // The clean restart clears session fixtures, so the file is made after it.
        const fixturePath = await createMultiPageTextFixturePdf(`recent-reading-turned-zoom-intent-${Date.now()}.pdf`, 40);
        const fixtureDocumentRef = requireDocumentRef(fixturePath);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        // A quarter-turned view of the letter-sized pages: the page shows
        // wider than it is tall, so the zoom must start from the turned width.
        await requireWorkspaceCommand(session.page, 'handleViewRotationCw');
        const defaultZoomLabel = await readZoomLabel(session);
        await goToPageViaToolbar(session.page, 27);
        const readingZoomLabel = await zoomInTwiceAsReader(session, defaultZoomLabel);
        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await waitForRecentFileRow(session, fixturePath);

        // Hold the open before its working copy exists, as a slow disk does.
        // The held view already shows the place the reader left: page 27 at
        // the reading zoom.
        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__deferDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef)).toBe(true);
        await clickRecentFile(session, fixturePath);
        await waitForOpeningSkeletonWhileOpenHeld(session);
        const held = await readHeldShell(session);
        expect(held?.page).toBe(27);


        // Zoom with the wheel over the held view (Command on macOS, where
        // Control and the wheel scroll; Control elsewhere). The zoom starts
        // from the shown reading scale and keeps the page point under the
        // pointer; the open then presents that zoom and point.
        const pointer = {
            x: held!.left + held!.width / 2,
            y: held!.top + held!.height * 0.25,
        };
        const pointOn = (rect: {
            top: number;
            left: number;
            width: number;
            height: number
        }) => ({
            x: (pointer.x - rect.left) / rect.width,
            y: (pointer.y - rect.top) / rect.height,
        });
        await session.page.mouse.move(pointer.x, pointer.y);
        const zoomModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await session.page.keyboard.down(zoomModifier);
        await session.page.mouse.wheel({deltaY: -40});
        await session.page.keyboard.up(zoomModifier);
        await waitForFunctionInPage(session.page, (heldWidth: number) => {
            const width = document.querySelector('.editor-pane.is-active [data-document-opening-shell-id]')?.getBoundingClientRect().width;
            return width !== undefined && width > heldWidth;
        }, {timeout: RECENT_OPEN_TIMEOUT_MS}, held!.width);
        const zoomed = await readHeldShell(session);
        expect(zoomed?.page).toBe(27);
        expect(pointOn(zoomed!).x).toBeCloseTo(pointOn(held!).x, 2);
        expect(pointOn(zoomed!).y).toBeCloseTo(pointOn(held!).y, 2);

        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__releaseDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef)).toBe(true);
        await waitForRecentPdfOpen(session, fixturePath);
        // The page is drawn at the zoomed shell's rect, so at its scale; the
        // zoom shown is above the reading zoom the open started from.
        await waitForToolbarCurrentPage(session.page, 27);
        const zoomedLabel = await readZoomLabel(session);
        expect(Number.parseFloat(zoomedLabel)).toBeGreaterThan(Number.parseFloat(readingZoomLabel));
        await expectReadingPlace(session, 27, zoomedLabel);
        expectSameRect(await readDrawnPage(session, 27), zoomed);

        // The held view zoomed by the step the shown view zooms by: the same
        // packet over the drawn page scales it as it scaled the held one.
        const drawnBefore = await readDrawnPage(session, 27);
        await session.page.keyboard.down(zoomModifier);
        await session.page.mouse.wheel({deltaY: -40});
        await session.page.keyboard.up(zoomModifier);
        await waitForFunctionInPage(session.page, (width: number) => {
            const drawnWidth = document.querySelector('.editor-pane.is-active #pdf-viewer .page_container[data-page="27"]')?.getBoundingClientRect().width;
            return drawnWidth !== undefined && Math.abs(drawnWidth - width) > 1;
        }, {timeout: RECENT_OPEN_TIMEOUT_MS}, drawnBefore!.width);
        const drawnAfter = await readDrawnPage(session, 27);
        expect(zoomed!.width / held!.width).toBeCloseTo(drawnAfter!.width / drawnBefore!.width, 2);
    });

    // A reopened place is shown at once at the rect the drawn page takes, in
    // every layout the viewer has: the exact pages around it, each view mode,
    // paged and continuous scroll, and a quarter-turned view.
    async function expectHeldReopenOnDrawnRect(session: IElectronE2ESession, fixturePath: string, pageNumber: number) {
        const fixtureDocumentRef = requireDocumentRef(fixturePath);
        const readView = async () => {
            const snapshot = await requireWorkspaceCommand<{
                viewMode: string;
                continuousScroll: boolean;
                viewRotation: number
            }>(session.page, 'getToolbarSnapshot');
            return {
                viewMode: snapshot?.viewMode,
                continuousScroll: snapshot?.continuousScroll,
                viewRotation: snapshot?.viewRotation,
            };
        };
        const left = await readView();
        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await waitForRecentFileRow(session, fixturePath);
        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__deferDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef)).toBe(true);
        await clickRecentFile(session, fixturePath);
        await waitForOpeningSkeletonWhileOpenHeld(session);
        const held = await readHeldShell(session);
        expect(held?.page, JSON.stringify(left)).toBe(pageNumber);
        expect(await evaluateInPage(session.page, (path: TDocumentRef) => (
            window.__releaseDocumentOpenForAutomation?.(path) ?? false
        ), fixtureDocumentRef)).toBe(true);
        await waitForRecentPdfOpen(session, fixturePath);
        await waitForToolbarCurrentPage(session.page, pageNumber);
        await waitForFunctionInPage(session.page, (page: number) => Boolean(document.querySelector(
            `.editor-pane.is-active #pdf-viewer .page_container[data-page="${page}"] canvas`,
        )), {timeout: RECENT_OPEN_TIMEOUT_MS}, pageNumber);
        const drawn = await readDrawnPage(session, pageNumber);
        // Within the committed surface contract's one CSS pixel.
        for (const key of [
            'top',
            'left',
            'width',
            'height',
        ] as const) {
            expect(Math.abs((drawn?.[key] ?? Number.NaN) - (held?.[key] ?? Number.NaN)), `${key}: ${JSON.stringify({
                left,
                held,
                drawn,
            })}`).toBeLessThanOrEqual(1);
        }
        expect(await readView()).toEqual(left);
    }

    it('reopens a mixed-size PDF in each laid-out view on the rect its page is drawn at', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-reading-layouts-${Date.now()}`,
        });
        const views: Array<{
            name: string;
            commands: string[];
            page: number
        }> = [
            {
                name: 'continuous-last',
                commands: [],
                page: 3,
            },
            {
                name: 'paged-single',
                commands: ['handleToggleContinuousScroll'],
                page: 2,
            },
            {
                name: 'facing',
                commands: ['handleViewModeFacing'],
                page: 3,
            },
            {
                name: 'facing-first-single',
                commands: ['handleViewModeFacingFirstSingle'],
                page: 2,
            },
            {
                name: 'turned-90',
                commands: ['handleViewRotationCw'],
                page: 3,
            },
            {
                name: 'turned-270',
                commands: ['handleViewRotationCcw'],
                page: 2,
            },
        ];
        for (const view of views) {
            // Each view its own file: a reopen keeps the view its file was left in.
            const fixturePath = await createMixedPageSizeTextFixturePdf(`recent-reading-${view.name}-${Date.now()}.pdf`);
            await openPdfInApp(session.page, fixturePath);
            await waitForPdfLoaded(session.page);
            for (const command of view.commands) {
                await requireWorkspaceCommand(session.page, command);
            }
            await goToPageViaToolbar(session.page, view.page);
            await expectHeldReopenOnDrawnRect(session, fixturePath, view.page);
            await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
            await waitForRecentFileRow(session, fixturePath);
        }
    });

    it('reopens a PDF at a page past the five-thousandth on the rect its page is drawn at', async () => {
        const session = await sessionFixture.restart({
            clean: true,
            sessionName: () => `e2e-recent-reading-5001-${Date.now()}`,
        });
        const fixturePath = await createMultiPageTextFixturePdf(`recent-reading-5001-${Date.now()}.pdf`, 5001);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
        await goToPageViaToolbar(session.page, 5001);
        await expectHeldReopenOnDrawnRect(session, fixturePath, 5001);
    });
});

const djvuFixture = resolveDjvuFixturePath();
const runDjvuRecentOrSkip = selectFixtureDescribe(describe, djvuFixture);

runDjvuRecentOrSkip('Electron E2E - Recent DjVu Files', () => {
    const sessionName = `e2e-recent-djvu-files-${Date.now()}`;

    const sessionFixture = createElectronE2ESessionFixture({sessionName});

    it('reopens an unchanged DjVu where it was left, after a tab close and after a relaunch', async () => {
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }
        const sourcePath = djvuFixture.path;
        // Open File answers with the fixture, as the native dialog would.
        const extraEnv = {EVB_E2E_OPEN_DIALOG_PATH: sourcePath};
        let session = await sessionFixture.restart({
            clean: true,
            extraEnv,
        });
        // The toolbar's page and zoom, and a drawn page image in the viewport.
        async function expectDjvuPlace(pageNumber: number, zoomLabel: string) {
            await waitForToolbarCurrentPage(session.page, pageNumber);
            await waitForFunctionInPage(session.page, (expectedZoom: string) => {
                const viewport = document.querySelector<HTMLElement>(
                    '.editor-pane.is-active [data-document-viewer-chassis-viewport]',
                )?.getBoundingClientRect();
                const drawn = Array.from(document.querySelectorAll<HTMLElement>(
                    '.editor-pane.is-active [data-testid="document-page-source-image"][data-document-page-visual="committed"]',
                )).some((image) => {
                    const rect = image.getBoundingClientRect();
                    return viewport && rect.bottom > viewport.top && rect.top < viewport.bottom;
                });
                const zoom = document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')?.textContent?.trim();
                return drawn && zoom === expectedZoom;
            }, {timeout: RECENT_OPEN_TIMEOUT_MS}, zoomLabel);
        }

        await openDjvuInApp(session.page, sourcePath, 90_000);
        await waitForDjvuLoaded(session.page, 90_000);
        const totalPages = Number((await readToolbarPageIndicator(session.page)).totalPagesText?.replace(/\D/gu, ''));
        expect(totalPages, 'the DjVu fixture has a second page to leave the reader on').toBeGreaterThan(1);
        const readingPage = Math.min(3, totalPages);
        const defaultZoomLabel = await readZoomLabel(session);
        await goToPageViaToolbar(session.page, readingPage);
        await clickVisibleToolbarButton(session.page, 'Zoom In');
        await waitForFunctionInPage(session.page, (before: string) => {
            const zoom = document.querySelector('#editor-global-toolbar-host .zoom-controls-display-value')?.textContent?.trim();
            return Boolean(zoom) && zoom !== before;
        }, {timeout: RECENT_OPEN_TIMEOUT_MS}, defaultZoomLabel);
        const readingZoomLabel = await readZoomLabel(session);
        await expectDjvuPlace(readingPage, readingZoomLabel);

        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await waitForRecentFileRow(session, sourcePath);
        await recordDrawnPages(session);
        await clickAsUser(session.page, '.editor-pane.is-active .start-open-panel .open-panel-cta');
        await waitForDjvuLoaded(session.page, 90_000);
        await expectDjvuPlace(readingPage, readingZoomLabel);
        await expectFirstDrawnPageNear(session, readingPage);

        await quitAsUser(session);
        session = await sessionFixture.restart({
            clean: false,
            extraEnv,
        });

        await waitForStartupOverlayRemoved(session);
        await recordDrawnPages(session);
        await clickRecentFile(session, sourcePath);
        await waitForRecentDjvuOpen(session, sourcePath);
        await expectDjvuPlace(readingPage, readingZoomLabel);
        await expectFirstDrawnPageNear(session, readingPage);
    });

    it('opens a persisted recent DjVu after restarting Electron', async () => {
        let session = sessionFixture.getSession();
        if (!djvuFixture.path) {
            throw new Error(djvuFixture.reason);
        }

        await openDjvuInApp(session.page, djvuFixture.path, 90_000);
        await waitForDjvuLoaded(session.page, 90_000);
        session = await sessionFixture.restart({clean: false});

        await assertRecentListStaysStableBeforeOpen(session, djvuFixture.path);
        await clickRecentFile(session, djvuFixture.path);
        await waitForRecentDjvuOpen(session, djvuFixture.path);
    });
});
