import {
    describe,
    expect,
    it,
} from 'vitest';
import { statSync } from 'node:fs';
import { delay } from 'es-toolkit/promise';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createBlankFixturePdf,
    createCorruptPdfFixture,
    createMixedSize66FixturePdf,
    createMultiPageTextFixturePdf,
    createNativeMixedWidthFixturePdf,
    createRotated90FixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    clickVisibleToolbarButton,
    ensureSidebarOpen,
    goToPageViaToolbar,
    installNativePdfOpeningSampler,
    openNativePdfPreviewInApp,
    openPdfInApp,
    stopNativePdfOpeningSampler,
    triggerOpenPathInApp,
    waitForPdfLoaded,
    waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import { readToolbarPageIndicator } from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import { readViewportPageObservation } from '@tests/e2e/electron/helpers/viewportPageObservation';
import {
    getWorkspaceToolbarSnapshot,
    requireWorkspaceCommand,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    findCommittedSurfaceCausalOpenViolations,
    type ICommittedSurfaceTrace,
    installCommittedSurfaceSampler,
    stopCommittedSurfaceSampler,
    summarizeCommittedSurfaceTiming,
    waitForCommittedSurfaceSamples,
} from '@tests/e2e/electron/helpers/viewerCommittedSurfaceContract';
import {
    waitForAnimationFrames,
    wheelPdfViewportAndWaitForSettlement,
} from '@tests/e2e/electron/helpers/viewerVirtualizationContract';
import { PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES } from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfNativePreviewRouting';

const OPEN_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 30_000;
// The reported fixture is 1,859 pages. A generated text PDF of the same order
// of magnitude keeps the virtualized page track, the deep-page navigation, and
// the non-linearized cross-reference table of the report while staying
// byte-deterministic and far below the native-preview routing threshold.
const DEEP_PDF_PAGE_COUNT = 1_200;
const PRIOR_PDF_PAGE_COUNT = 24;
const DEEP_PAGE = 500;
// Budgets measured on the deterministic fixture below, on a headless Linux
// runner under Xvfb, the slowest environment this lane runs in. Observed across
// runs: first page shell 1,787-3,585ms, first committed canvas 4,732-6,853ms,
// readiness after that canvas 0ms. Each budget keeps roughly half again as much
// room so an occluded renderer sampling at ~1s intervals cannot turn scheduling
// noise into a failure, while still rejecting the ~10.5s first-pixel delay from
// the report. The measured numbers, and the per-phase ledger that explains
// them, are printed on every run; tighten these when the lane gets a faster
// floor rather than leaving the slack unexamined.
const FIRST_USEFUL_PIXEL_BUDGET_MS = 10_000;
const FIRST_PAGE_SHELL_BUDGET_MS = 5_500;
const READY_AFTER_CANVAS_BUDGET_MS = 1_500;
const OPENING_WIDTH_TOLERANCE_PX = 0.5;
// A full-page raster of a deep page at a user-chosen zoom is the slowest thing
// this suite waits for, and it competes with an Xvfb renderer that animates at
// about 1fps. Convergence itself is still asserted exactly; only the patience
// is generous.
const RENDER_SETTLE_TIMEOUT_MS = 45_000;

function assertNativeOpeningFitWidthIsSettled(
    frames: Awaited<ReturnType<typeof stopNativePdfOpeningSampler>>,
) {
    const visibleShellFrames = frames.filter(frame => (
        frame.transitionSurfaceVisible
        && frame.transitionShellRect !== null
    ));
    const previewFrames = frames.filter(frame => (
        frame.openingPreviewVisible
        && frame.openingPreviewPage === 1
        && frame.transitionShellRect !== null
    ));
    const firstPreview = previewFrames[0];
    const firstPdfjs = frames.find(frame => (
        frame.pdfjsCanvasVisible
        && frame.pdfjsCanvasRects.some(rect => rect.page === 1)
    ));
    const skeletonFrames = frames.filter(frame => (
        frame.transitionSkeletonCount > 0
        && frame.transitionSkeletonRects.length > 0
        && frame.transitionSurfaceVisible
    ));
    const evidence = JSON.stringify({
        firstPreview,
        firstPdfjs,
        skeletonFrames,
        visibleShellFrames,
        previewFrames,
        frameCount: frames.length,
    });
    expect(visibleShellFrames, evidence).not.toHaveLength(0);
    expect(skeletonFrames, evidence).not.toHaveLength(0);
    const firstSkeleton = skeletonFrames[0];
    if (firstSkeleton === undefined) {
        throw new Error(evidence);
    }
    expect(firstSkeleton.capturedAtMs, evidence).toBeLessThan(firstPreview?.capturedAtMs ?? Number.POSITIVE_INFINITY);
    const skeletonWidths = skeletonFrames.flatMap(frame => frame.transitionSkeletonRects.map(rect => rect.width));
    expect(Math.max(...skeletonWidths) - Math.min(...skeletonWidths), evidence)
        .toBeLessThanOrEqual(OPENING_WIDTH_TOLERANCE_PX);
    const visibleShellWidths = visibleShellFrames.map(frame => frame.transitionShellRect?.width ?? 0);
    expect(Math.max(...visibleShellWidths) - Math.min(...visibleShellWidths), evidence)
        .toBeLessThanOrEqual(OPENING_WIDTH_TOLERANCE_PX);
    expect(firstPreview, evidence).toBeDefined();
    expect(firstPdfjs, evidence).toBeDefined();
    const openingWidth = firstPreview?.transitionShellRect?.width ?? 0;
    const settledRect = firstPdfjs?.pdfjsCanvasRects.find(rect => rect.page === 1) ?? null;
    const settledCanvasWidth = settledRect === null ? 0 : settledRect.right - settledRect.left;
    expect(Math.abs(openingWidth - settledCanvasWidth), evidence)
        .toBeLessThanOrEqual(OPENING_WIDTH_TOLERANCE_PX);
    const previewWidths = previewFrames.map(frame => frame.transitionShellRect?.width ?? 0);
    expect(Math.max(...previewWidths) - Math.min(...previewWidths), evidence)
        .toBeLessThanOrEqual(OPENING_WIDTH_TOLERANCE_PX);
}

interface IVisibleSidebarSample {
    ownerTabId: string | null;
    ownsActiveHost: boolean;
    text: string;
}

interface IOpenGenerationFrame {
    activeTabId: string | null;
    elapsedMs: number;
    openSurfacePhase: string | null;
    openSurfacePresentation: string | null;
    totalPages: number | null;
    visibleSidebars: IVisibleSidebarSample[];
}

interface IFitFrameSample {
    anchorCanvasCount: number;
    anchorRendered: boolean;
    anchorSkeletonVisible: boolean;
    checkpoint: string;
    elapsedMs: number;
    topVisiblePage: number | null;
}

interface IFitProbeWindow {
    __evbFitProbe?: {
        checkpoint: string;
        frames: IFitFrameSample[];
        stop: () => void;
    } | undefined;
    __evbOpenGenerationProbe?: {
        frames: IOpenGenerationFrame[];
        stop: () => void;
    } | undefined;
}

async function readViewerAuthorityState(session: IElectronE2ESession) {
    return evaluateInPage(session.page, () => {
        const activeHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const viewport = activeHost?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const chassis = viewport?.closest<HTMLElement>('.document-viewer-chassis') ?? null;
        const viewportRect = viewport?.getBoundingClientRect() ?? null;
        const pages = Array.from(activeHost?.querySelectorAll<HTMLElement>('.page_container') ?? [])
            .map((container) => {
                const rect = container.getBoundingClientRect();
                return {
                    page: Number(container.dataset.page) || null,
                    rendered: container.classList.contains('page_container--rendered'),
                    visibleHeight: viewportRect
                        ? Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top)
                        : 0,
                };
            })
            .filter(entry => entry.page !== null && entry.visibleHeight > 0)
            .sort((left, right) => right.visibleHeight - left.visibleHeight);
        const toolbar = (window as {__evbTestApi?: {getActiveToolbarSnapshot?: () => {
            currentPage?: number;
            totalPages?: number;
        } | null}}).__evbTestApi?.getActiveToolbarSnapshot?.() ?? null;
        return {
            activeTabId: activeHost?.dataset.workspaceTabId ?? null,
            chassisCurrentPage: Number(chassis?.dataset.chassisCurrentPage) || null,
            committedPage: Number(chassis?.dataset.viewportCommittedPage) || null,
            hasNativePreviewSurface: Boolean(activeHost?.querySelector('.native-pdf-viewer')),
            hasStandardPdfSurface: Boolean(viewport),
            mostVisiblePage: pages[0]?.page ?? null,
            mostVisiblePageRendered: pages[0]?.rendered ?? false,
            observedPage: Number(chassis?.dataset.viewportObservedPage) || null,
            requestedPage: Number(chassis?.dataset.viewportRequestedPage) || null,
            scrollTop: viewport?.scrollTop ?? null,
            sidebarVisible: Boolean(activeHost?.querySelector('.sidebar-wrapper:not(.is-closed)')),
            toolbarPage: toolbar?.currentPage ?? null,
            totalPages: toolbar?.totalPages ?? null,
            viewportLifecycle: chassis?.dataset.viewportLifecycle ?? null,
        };
    });
}

async function readDocumentHostState(session: IElectronE2ESession, tabId: string | null) {
    return evaluateInPage(session.page, (targetTabId: string | null) => {
        const host = targetTabId === null
            ? document.querySelector<HTMLElement>('.workspace-host[data-workspace-active="true"]')
            : document.querySelector<HTMLElement>(
                `.workspace-host[data-workspace-tab-id="${targetTabId}"]`,
            );
        const viewport = host?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
        const viewportRect = viewport?.getBoundingClientRect() ?? null;
        const pages = Array.from(host?.querySelectorAll<HTMLElement>('.page_container') ?? [])
            .map((container) => {
                const rect = container.getBoundingClientRect();
                return {
                    page: Number(container.dataset.page) || null,
                    visibleHeight: viewportRect
                        ? Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top)
                        : 0,
                };
            })
            .filter(entry => entry.page !== null && entry.visibleHeight > 0)
            .sort((left, right) => right.visibleHeight - left.visibleHeight);
        const toolbar = (window as {__evbTestApi?: {getActiveToolbarSnapshot?: () => {
            currentPage?: number;
            totalPages?: number;
        } | null}}).__evbTestApi?.getActiveToolbarSnapshot?.() ?? null;
        return {
            committedPage: Number(chassis?.dataset.viewportCommittedPage) || null,
            hostActive: host?.dataset.workspaceActive === 'true',
            hostPresent: host !== null,
            mostVisiblePage: pages[0]?.page ?? null,
            pageContainerCount: host?.querySelectorAll('.page_container').length ?? 0,
            sidebarVisible: Boolean(host?.querySelector('.sidebar-wrapper:not(.is-closed)')),
            toolbarPage: toolbar?.currentPage ?? null,
            totalPages: toolbar?.totalPages ?? null,
        };
    }, tabId);
}

async function waitForFitSettlement(session: IElectronE2ESession, expectedPage: number) {
    await waitForFunctionInPage(session.page, (targetPage: number) => {
        const activeHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const viewport = activeHost?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const chassis = viewport?.closest<HTMLElement>('.document-viewer-chassis') ?? null;
        const container = activeHost?.querySelector<HTMLElement>(
            `.page_container[data-page="${String(targetPage)}"]`,
        ) ?? null;
        if (!viewport || !container) {
            return false;
        }
        const viewportRect = viewport.getBoundingClientRect();
        const rect = container.getBoundingClientRect();
        const visibleHeight = Math.min(rect.bottom, viewportRect.bottom)
            - Math.max(rect.top, viewportRect.top);
        return chassis?.dataset.viewportLifecycle === 'ready'
            && Number(chassis.dataset.viewportCommittedPage) === targetPage
            && visibleHeight > Math.min(rect.height, viewportRect.height) / 2
            && container.classList.contains('page_container--rendered');
    }, {timeout: RENDER_SETTLE_TIMEOUT_MS}, expectedPage);
    await waitForAnimationFrames(session.page, 4);
}

/**
 * Free scrolling never mints a navigation intent, so the viewport session keeps
 * the last committed page and publishes an observed page instead. What has to
 * follow a physical scroll - and every fit change made from there - is the
 * semantic authority the toolbar and the pagination commands read: the chassis
 * current page, agreeing with the page actually rendered on screen.
 */
interface IPdfRenderTraceWindow {
    __pdfRenderTrace?: boolean;
    __pdfRenderTraceBuffer?: Array<{
        event: string;
        payload: Record<string, unknown>;
    }>;
    __getPdfRenderTrace?: () => Array<{
        event: string;
        payload: Record<string, unknown>;
    }>;
}

/**
 * The viewer's own navigation/viewport trace. Enabled for the fit assertions so
 * a settle failure reports which intent moved the viewport instead of only that
 * it ended somewhere else.
 */
async function enablePdfRenderTrace(session: IElectronE2ESession) {
    await evaluateInPage(session.page, () => {
        const traceWindow = window as Window & IPdfRenderTraceWindow;
        traceWindow.__pdfRenderTrace = true;
        traceWindow.__pdfRenderTraceBuffer = [];
    });
}

/**
 * The open phases the viewer already instruments, in the order the standard
 * PDF.js route runs them. Everything the report blamed for its nine-second open
 * lands in one of these: main-process preflight and validation, reading the
 * head/tail ranges, spinning up the PDF.js worker, parsing the cross-reference
 * table of a non-linearized file, committing document state, and the yield that
 * lets the first frame paint.
 */
const OPEN_PHASE_SPANS = [
    {
        end: 'pdf-open-route-capability-end',
        phase: 'preflight-open-capability',
        start: 'pdf-open-route-start',
    },
    {
        end: 'pdf-open-visual-yield-end',
        phase: 'first-paint-yield',
        start: 'pdf-open-visual-yield-start',
    },
    {
        end: 'pdf-open-source-stat-end',
        phase: 'source-stat',
        start: 'pdf-open-source-stat-start',
    },
    {
        end: 'pdf-open-source-read-end',
        phase: 'source-read',
        start: 'pdf-open-source-read-start',
    },
    {
        end: 'pdf-document-range-preload-end',
        phase: 'pdfjs-range-preload',
        start: 'pdf-document-range-preload-start',
    },
    {
        end: 'pdf-document-options-end',
        phase: 'pdfjs-worker-options',
        start: 'pdf-document-options-start',
    },
    {
        end: 'pdf-document-get-document-resolve',
        phase: 'pdfjs-parse',
        start: 'pdf-document-get-document-submit',
    },
    {
        end: 'pdf-open-validate-end',
        phase: 'parser-validation',
        start: 'pdf-open-validate-start',
    },
    {
        end: 'pdf-open-state-commit-end',
        phase: 'document-state-commit',
        start: 'pdf-open-state-commit-start',
    },
] as const;

/**
 * The phases whose absence would mean the open is no longer measurable by
 * phase. A slow open is only actionable if the trace still says which phase
 * consumed the time, so losing one of these is a regression in its own right.
 */
const REQUIRED_OPEN_PHASES = [
    'preflight-open-capability',
    'parser-validation',
    'pdfjs-parse',
    'document-state-commit',
] as const;

interface IOpenPhaseMeasurement {
    durationMs: number | null;
    endedAtMs: number | null;
    phase: string;
    startedAtMs: number | null;
}

interface IOpenPhaseLedger {
    firstCanvasMountedMs: number | null;
    firstRenderBeginMs: number | null;
    numPages: number | null;
    openStartWallTimeMs: number | null;
    phases: IOpenPhaseMeasurement[];
    /** True when the open origin was missing and every offset is unanchored. */
    routeStartMissing: boolean;
    unaccountedMs: number | null;
}

/**
 * Turns the viewer's open trace into a per-phase ledger measured from the
 * moment the open was claimed. `unaccountedMs` is the part of the wall clock to
 * the first mounted canvas that no instrumented phase explains, so a gap in the
 * instrumentation shows up as a number instead of hiding.
 */
async function readOpenPhaseLedger(session: IElectronE2ESession): Promise<IOpenPhaseLedger> {
    return evaluateInPage(session.page, (spans: ReadonlyArray<{
        end: string;
        phase: string;
        start: string;
    }>) => {
        const traceWindow = window as Window & IPdfRenderTraceWindow;
        const entries = traceWindow.__getPdfRenderTrace?.() ?? traceWindow.__pdfRenderTraceBuffer ?? [];
        const readTraceAt = (entry: {payload: Record<string, unknown>} | undefined) => {
            const value = entry?.payload.traceAtMs;
            return typeof value === 'number' ? value : null;
        };
        // The last open in the buffer is the one under test; a fixture may have
        // opened a previous document into the same trace.
        const openStartIndex = entries.map(entry => entry.event).lastIndexOf('pdf-open-route-start');
        const openEntries = openStartIndex === -1 ? entries : entries.slice(openStartIndex);
        const openStartedAtMs = readTraceAt(openEntries[0]);
        const findEntry = (event: string) => openEntries.find(entry => entry.event === event);
        const offsetOf = (event: string) => {
            const at = readTraceAt(findEntry(event));
            return at === null || openStartedAtMs === null ? null : Math.round(at - openStartedAtMs);
        };
        const phases = spans.map((span) => {
            const startEntry = findEntry(span.start);
            const endEntry = findEntry(span.end);
            const startedAt = readTraceAt(startEntry);
            const endedAt = readTraceAt(endEntry);
            // Some phases only report their own elapsed time on the end event,
            // because the start is on the far side of an await that the trace
            // does not mark.
            const reportedElapsed = endEntry?.payload.elapsedMs;
            const durationMs = typeof reportedElapsed === 'number'
                ? Math.round(reportedElapsed)
                : startedAt !== null && endedAt !== null
                    ? Math.round(endedAt - startedAt)
                    : null;
            return {
                durationMs,
                endedAtMs: endedAt === null || openStartedAtMs === null
                    ? null
                    : Math.round(endedAt - openStartedAtMs),
                phase: span.phase,
                startedAtMs: startedAt === null || openStartedAtMs === null
                    ? null
                    : Math.round(startedAt - openStartedAtMs),
            };
        });
        const firstCanvasMountedMs = offsetOf('renderer-canvas-mounted');
        const measuredMs = phases.reduce((total, entry) => total + (entry.durationMs ?? 0), 0);
        const openStartWallTime = findEntry('pdf-open-direct-start')?.payload.wallTimeMs;
        const routeStartMissing = openStartIndex === -1;
        const resolvedPages = findEntry('pdf-document-get-document-resolve')?.payload.numPages;
        return {
            firstCanvasMountedMs,
            firstRenderBeginMs: offsetOf('renderer-single-page-begin'),
            routeStartMissing,
            numPages: typeof resolvedPages === 'number' ? resolvedPages : null,
            openStartWallTimeMs: typeof openStartWallTime === 'number' ? openStartWallTime : null,
            phases,
            unaccountedMs: firstCanvasMountedMs === null
                ? null
                : Math.round(firstCanvasMountedMs - measuredMs),
        };
    }, OPEN_PHASE_SPANS.map(span => ({
        end: span.end,
        phase: span.phase,
        start: span.start,
    })));
}

async function readPdfRenderTrace(session: IElectronE2ESession, limit: number) {
    return evaluateInPage(session.page, (max: number) => {
        const traceWindow = window as Window & IPdfRenderTraceWindow;
        const noise = [
            'raster-scheduler-snapshot',
            'pdf-document-page-',
            'renderer-single-page-',
            'renderer-canvas-',
        ];
        return (traceWindow.__getPdfRenderTrace?.() ?? traceWindow.__pdfRenderTraceBuffer ?? [])
            .filter(entry => !noise.some(prefix => entry.event.startsWith(prefix)))
            .slice(-max);
    }, limit);
}

/**
 * Unfiltered tail of the render trace. The filtered reader above drops the
 * per-page raster events, which are exactly the ones that say why a committed
 * canvas was released.
 */
async function readRawPdfRenderTrace(session: IElectronE2ESession, limit: number) {
    return evaluateInPage(session.page, (max: number) => {
        const traceWindow = window as Window & IPdfRenderTraceWindow;
        return (traceWindow.__getPdfRenderTrace?.() ?? traceWindow.__pdfRenderTraceBuffer ?? [])
            .slice(-max);
    }, limit);
}

async function readWorkspaceTabState(session: IElectronE2ESession) {
    return evaluateInPage(session.page, () => ({
        activeTabId: document.querySelector<HTMLElement>('.tab-list .tab.is-active')?.dataset.tabId ?? null,
        tabIds: Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'))
            .map(tab => tab.dataset.tabId ?? ''),
    }));
}

interface IDirectOpenRouteOutcome {
    available: boolean;
    error: string | null;
    opened: boolean | null;
}

/**
 * Opens a path through the app's own direct-open route and waits for that route
 * to finish with the file, rejection included. An invalid file may be refused
 * by the main-process preflight, or staged into a tab that is handed back when
 * the parser rejects it; both outcomes are inside this promise, so what follows
 * reads a settled shell instead of a shell sampled after a guessed delay.
 */
async function openPathAndAwaitRouteOutcome(
    session: IElectronE2ESession,
    path: string,
): Promise<IDirectOpenRouteOutcome> {
    return evaluateInPage(session.page, async (targetPath: string) => {
        const openWindow = Object.create(window) as {
            __allowRendererFileOpenForAutomation?: (value: string) => Promise<boolean>;
            __openFileDirect?: (value: string) => Promise<boolean>;
        };
        if (typeof openWindow.__allowRendererFileOpenForAutomation === 'function') {
            await openWindow.__allowRendererFileOpenForAutomation(targetPath);
        }
        const openFileDirect = openWindow.__openFileDirect;
        if (typeof openFileDirect !== 'function') {
            return {
                available: false,
                error: null,
                opened: null,
            };
        }
        try {
            return {
                available: true,
                error: null,
                opened: await openFileDirect(targetPath),
            };
        } catch (error) {
            return {
                available: true,
                error: String(error),
                opened: null,
            };
        }
    }, path);
}

interface IOpenRouteCapabilitySpan {
    elapsedMs: number | null;
    ended: boolean;
    failed: boolean;
    started: boolean;
}

/**
 * The preflight span the open route reports for one path. A refused open has to
 * close its span too, otherwise the phase ledger of the next open measures from
 * an origin that was never terminated.
 */
async function readOpenRouteCapabilitySpan(
    session: IElectronE2ESession,
    path: string,
): Promise<IOpenRouteCapabilitySpan> {
    return evaluateInPage(session.page, (targetPath: string) => {
        const traceWindow = window as Window & IPdfRenderTraceWindow;
        const entries = (traceWindow.__getPdfRenderTrace?.() ?? traceWindow.__pdfRenderTraceBuffer ?? [])
            .filter(entry => entry.payload.path === targetPath);
        const end = entries.find(entry => entry.event === 'pdf-open-route-capability-end');
        const elapsedMs = end?.payload.elapsedMs;
        return {
            elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : null,
            ended: end !== undefined,
            failed: end?.payload.failed === true,
            started: entries.some(entry => entry.event === 'pdf-open-route-start'),
        };
    }, path);
}

/**
 * No workspace in the shell is still claiming an open. The route promise above
 * already settled, so this can only fall back to true for a claim that is over.
 */
async function waitForNoWorkspaceOpening(session: IElectronE2ESession) {
    try {
        await waitForFunctionInPage(session.page, () => {
            const debugState = (window as {__evbTestApi?: {collectWorkspaceDebugState?: () => {workspaces: Array<{toolbarSnapshot: {isOpeningDocument?: boolean} | null}>} | null}})
                .__evbTestApi?.collectWorkspaceDebugState?.();
            return debugState !== undefined
                && debugState !== null
                && debugState.workspaces.every(workspace => workspace.toolbarSnapshot?.isOpeningDocument !== true);
        }, {timeout: SETTLE_TIMEOUT_MS});
    } catch (error) {
        const stuckState = await evaluateInPage(session.page, () => {
            const debugState = (window as {__evbTestApi?: {collectWorkspaceDebugState?: () => unknown}})
                .__evbTestApi?.collectWorkspaceDebugState?.();
            return JSON.stringify(debugState);
        });
        throw new Error(`A workspace still claims an open: ${stuckState}`, {cause: error});
    }
}

async function activateWorkspaceTabById(session: IElectronE2ESession, tabId: string) {
    const clicked = await evaluateInPage(session.page, (targetTabId: string) => {
        const tab = document.querySelector<HTMLElement>(`.tab-list .tab[data-tab-id="${targetTabId}"]`);
        tab?.click();
        return tab !== null;
    }, tabId);
    expect(clicked, `tab '${tabId}' was not in the tab bar`).toBe(true);
    await waitForFunctionInPage(session.page, (targetTabId: string) => (
        document.querySelector(
            `.workspace-host[data-workspace-tab-id="${targetTabId}"][data-workspace-active="true"]`,
        ) !== null
    ), {timeout: OPEN_TIMEOUT_MS}, tabId);
}

async function waitForSemanticPageAuthority(session: IElectronE2ESession, expectedPage: number) {
    await waitForFunctionInPage(session.page, (targetPage: number) => {
        const activeHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const viewport = activeHost?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const chassis = viewport?.closest<HTMLElement>('.document-viewer-chassis') ?? null;
        const container = activeHost?.querySelector<HTMLElement>(
            `.page_container[data-page="${String(targetPage)}"]`,
        ) ?? null;
        if (!viewport || !chassis || !container) {
            return false;
        }
        const viewportRect = viewport.getBoundingClientRect();
        const mostVisiblePage = Array.from(activeHost?.querySelectorAll<HTMLElement>('.page_container') ?? [])
            .map((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return {
                    page: Number(candidate.dataset.page) || null,
                    visibleHeight: Math.min(rect.bottom, viewportRect.bottom)
                        - Math.max(rect.top, viewportRect.top),
                };
            })
            .filter(entry => entry.page !== null && entry.visibleHeight > 0)
            .sort((left, right) => right.visibleHeight - left.visibleHeight)[0]?.page ?? null;
        return chassis.dataset.viewportLifecycle === 'ready'
            && Number(chassis.dataset.chassisCurrentPage) === targetPage
            && mostVisiblePage === targetPage
            && container.classList.contains('page_container--rendered');
    }, {timeout: RENDER_SETTLE_TIMEOUT_MS}, expectedPage);
}

/**
 * What the virtualized page track is actually holding: which rows are mounted,
 * where the mounted window sits, and how the scroll offset relates to it. A
 * page that is semantically committed but visually absent looks identical to a
 * page that landed somewhere else unless this is sampled.
 */
async function readMountedPageWindow(session: IElectronE2ESession) {
    return evaluateInPage(session.page, () => {
        const activeHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const viewport = activeHost?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const containers = Array.from(activeHost?.querySelectorAll<HTMLElement>('.page_container') ?? []);
        const pages = containers
            .map(container => Number(container.dataset.page) || null)
            .filter((page): page is number => page !== null)
            .sort((left, right) => left - right);
        const offsets = containers.map(container => ({
            offsetTop: container.offsetTop,
            page: Number(container.dataset.page) || null,
            rendered: container.classList.contains('page_container--rendered'),
        }));
        return {
            mountedFirst: pages[0] ?? null,
            mountedLast: pages.at(-1) ?? null,
            mountedCount: pages.length,
            offsets: offsets.slice(0, 6),
            scrollHeight: viewport?.scrollHeight ?? null,
            scrollTop: viewport?.scrollTop ?? null,
            viewportHeight: viewport?.clientHeight ?? null,
        };
    });
}

/**
 * Same wait, but a failure reports what the viewer actually settled on instead
 * of only that it did not settle where the test asked. The wait is polled from
 * here rather than inside the page so the whole approach to settlement is on
 * record; a deep-page convergence failure is unreadable from a single
 * end-of-timeout snapshot.
 */
async function settleSemanticPageAuthority(
    session: IElectronE2ESession,
    expectedPage: number,
    label: string,
) {
    const samples: Array<{
        elapsedMs: number;
        mounted: Awaited<ReturnType<typeof readMountedPageWindow>>;
    }> = [];
    const startedAt = Date.now();
    const settled = waitForSemanticPageAuthority(session, expectedPage);
    let pending = true;
    void settled.then(() => {
        pending = false;
    }, () => {
        pending = false;
    });
    const sampler = (async () => {
        while (pending && Date.now() - startedAt < RENDER_SETTLE_TIMEOUT_MS) {
            await delay(1_000);
            if (!pending) {
                return;
            }
            try {
                samples.push({
                    elapsedMs: Date.now() - startedAt,
                    mounted: await readMountedPageWindow(session),
                });
            } catch {
                return;
            }
        }
    })();
    try {
        await settled;
    } catch (error) {
        await sampler;
        console.info(`[standard-pdf-semantic-settle-failure] ${JSON.stringify({
            authority: await readViewerAuthorityState(session),
            expectedPage,
            label,
            mountedSamples: samples.slice(-12),
            toolbar: await getWorkspaceToolbarSnapshot(session.page),
            trace: await readPdfRenderTrace(session, 120),
        })}`);
        throw error;
    }
    await sampler;
}

async function startFitProbe(session: IElectronE2ESession, anchorPage: number) {
    await evaluateInPage(session.page, (targetPage: number) => {
        const probeWindow = window as Window & IFitProbeWindow;
        probeWindow.__evbFitProbe?.stop();
        const startedAt = performance.now();
        const frames: IFitFrameSample[] = [];
        // The automation window is hidden, so requestAnimationFrame ticks about
        // once a second here: far too coarse to prove that no skeleton was ever
        // put on screen. Timers keep their millisecond cadence because the
        // automation renderer disables background throttling.
        let sampleTimer = 0;
        let running = true;
        const probe = {
            checkpoint: 'before-fit',
            frames,
            stop: () => {
                running = false;
                window.clearInterval(sampleTimer);
            },
        };
        const sample = () => {
            if (!running) {
                return;
            }
            const activeHost = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const viewport = activeHost?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
            const anchor = activeHost?.querySelector<HTMLElement>(
                `.page_container[data-page="${String(targetPage)}"]`,
            ) ?? null;
            const viewportRect = viewport?.getBoundingClientRect() ?? null;
            const topVisible = viewportRect
                ? Array.from(activeHost?.querySelectorAll<HTMLElement>('.page_container') ?? [])
                    .map((container) => {
                        const rect = container.getBoundingClientRect();
                        return {
                            page: Number(container.dataset.page) || null,
                            visibleHeight: Math.min(rect.bottom, viewportRect.bottom)
                                - Math.max(rect.top, viewportRect.top),
                        };
                    })
                    .filter(entry => entry.visibleHeight > 0)
                    .sort((left, right) => right.visibleHeight - left.visibleHeight)[0]?.page ?? null
                : null;
            const skeleton = anchor?.querySelector<HTMLElement>('.document-page-skeleton') ?? null;
            frames.push({
                anchorCanvasCount: anchor?.querySelectorAll('.page_canvas canvas').length ?? 0,
                anchorRendered: anchor?.classList.contains('page_container--rendered') ?? false,
                anchorSkeletonVisible: Boolean(
                    skeleton
                    && skeleton.isConnected
                    && window.getComputedStyle(skeleton).display !== 'none',
                ),
                checkpoint: probe.checkpoint,
                elapsedMs: Math.round(performance.now() - startedAt),
                topVisiblePage: topVisible,
            });
        };
        probeWindow.__evbFitProbe = probe;
        sampleTimer = window.setInterval(sample, 16);
    }, anchorPage);
}

async function markFitProbeCheckpoint(session: IElectronE2ESession, checkpoint: string) {
    await evaluateInPage(session.page, (value: string) => {
        const probeWindow = window as Window & IFitProbeWindow;
        if (probeWindow.__evbFitProbe) {
            probeWindow.__evbFitProbe.checkpoint = value;
        }
    }, checkpoint);
}

async function stopFitProbe(session: IElectronE2ESession) {
    return evaluateInPage(session.page, () => {
        const probeWindow = window as Window & IFitProbeWindow;
        const probe = probeWindow.__evbFitProbe;
        probe?.stop();
        probeWindow.__evbFitProbe = undefined;
        return probe?.frames ?? [];
    });
}

async function startOpenGenerationProbe(session: IElectronE2ESession) {
    await evaluateInPage(session.page, () => {
        const probeWindow = window as Window & IFitProbeWindow;
        probeWindow.__evbOpenGenerationProbe?.stop();
        const startedAt = performance.now();
        const frames: IOpenGenerationFrame[] = [];
        // Sampled on a timer for the same reason as the fit probe: a hidden
        // window animates at about 1fps, which would let a stale sidebar sit on
        // screen for hundreds of milliseconds between samples.
        let sampleTimer = 0;
        let running = true;
        const isVisible = (element: HTMLElement | null) => {
            if (!element?.isConnected) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 4
                && rect.height > 4
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        };
        const sample = () => {
            if (!running) {
                return;
            }
            const activeHost = document.querySelector<HTMLElement>(
                '.workspace-host[data-workspace-active="true"]',
            );
            const viewport = activeHost?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
            const chassis = activeHost?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
            const visibleSidebars = Array.from(document.querySelectorAll<HTMLElement>('.sidebar-wrapper'))
                .filter(isVisible)
                .map((wrapper): IVisibleSidebarSample => {
                    const host = wrapper.closest<HTMLElement>('.workspace-host');
                    return {
                        ownerTabId: host?.dataset.workspaceTabId ?? null,
                        ownsActiveHost: host === activeHost,
                        text: wrapper.textContent?.trim().slice(0, 120) ?? '',
                    };
                });
            frames.push({
                activeTabId: activeHost?.dataset.workspaceTabId ?? null,
                elapsedMs: Math.round(performance.now() - startedAt),
                openSurfacePhase: viewport?.dataset.openSurfacePhase ?? null,
                openSurfacePresentation: chassis?.dataset.openSurfacePresentation ?? null,
                totalPages: Number(
                    (window as {__evbTestApi?: {getActiveToolbarSnapshot?: () => {totalPages?: number} | null}})
                        .__evbTestApi?.getActiveToolbarSnapshot?.()?.totalPages ?? 0,
                ) || null,
                visibleSidebars,
            });
        };
        probeWindow.__evbOpenGenerationProbe = {
            frames,
            stop: () => {
                running = false;
                window.clearInterval(sampleTimer);
            },
        };
        sampleTimer = window.setInterval(sample, 16);
    });
}

async function stopOpenGenerationProbe(session: IElectronE2ESession) {
    return evaluateInPage(session.page, () => {
        const probeWindow = window as Window & IFitProbeWindow;
        const probe = probeWindow.__evbOpenGenerationProbe;
        probe?.stop();
        probeWindow.__evbOpenGenerationProbe = undefined;
        return probe?.frames ?? [];
    });
}

/**
 * `committed` also requires the chassis render/viewport fences to name the
 * anchor page, which only a navigation command mints. After free scrolling the
 * page is owned semantically rather than by a committed fence, so those rounds
 * settle on `semantic`.
 */
type TFitSettleMode = 'committed' | 'semantic';

async function alternateFitAndAssertConvergence(
    session: IElectronE2ESession,
    anchorPage: number,
    rounds: number,
    settleMode: TFitSettleMode = 'committed',
) {
    const observations: Array<{
        chassisCurrentPage: number | null;
        committedPage: number | null;
        mode: 'width' | 'height';
        mostVisiblePage: number | null;
        round: number;
        toolbarPage: number | null;
    }> = [];
    for (let round = 0; round < rounds; round += 1) {
        const mode = round % 2 === 0 ? 'height' : 'width';
        const command = mode === 'height' ? 'handleFitHeight' : 'handleFitWidth';
        await requireWorkspaceCommand(session.page, command);
        try {
            await (settleMode === 'committed'
                ? waitForFitSettlement(session, anchorPage)
                : waitForSemanticPageAuthority(session, anchorPage));
        } catch (error) {
            console.info(`[standard-pdf-fit-settle-failure] ${JSON.stringify({
                anchorPage,
                authority: await readViewerAuthorityState(session),
                command,
                observations,
                round,
                trace: await readPdfRenderTrace(session, 120),
            })}`);
            throw error;
        }
        const authority = await readViewerAuthorityState(session);
        const toolbar = await getWorkspaceToolbarSnapshot(session.page);
        observations.push({
            chassisCurrentPage: authority.chassisCurrentPage,
            committedPage: authority.committedPage,
            mode,
            mostVisiblePage: authority.mostVisiblePage,
            round,
            toolbarPage: toolbar?.currentPage ?? null,
        });
    }
    return observations;
}

interface IMixedGeometryObservation {
    viewport: {
        clientWidth: number;
        scrollWidth: number;
        scrollTop: number;
    } | null;
    zoom: string | null;
}

/** Reads the rendered surface used by the mixed-size geometry replay. */
async function readMixedGeometry(session: IElectronE2ESession): Promise<IMixedGeometryObservation> {
    return evaluateInPage(session.page, () => {
        const activeHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const viewport = activeHost?.querySelector<HTMLElement>(
            '[data-document-viewer-chassis-viewport], .document-viewer-viewport, #pdf-viewer',
        ) ?? null;
        const zoom = Array.from(document.querySelectorAll<HTMLElement>(
            '.zoom-controls-display-value, .zoom-controls-display',
        )).find((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        })?.textContent?.trim() ?? null;

        return {
            viewport: viewport
                ? {
                    clientWidth: viewport.clientWidth,
                    scrollWidth: viewport.scrollWidth,
                    scrollTop: viewport.scrollTop,
                }
                : null,
            zoom,
        };
    });
}

async function clickFitWidthWithTrustedInput(session: IElectronE2ESession) {
    const displayPoint = await evaluateInPage(session.page, () => {
        const display = Array.from(document.querySelectorAll<HTMLElement>(
            '.zoom-controls-display',
        )).find((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden';
        });
        if (!display) {
            return null;
        }
        const rect = display.getBoundingClientRect();
        return {
            x: Math.round(rect.left + (rect.width / 2)),
            y: Math.round(rect.top + (rect.height / 2)),
        };
    });
    if (!displayPoint) {
        throw new Error('Visible zoom display was not found before Fit Width input');
    }

    await session.page.mouse.click(displayPoint.x, displayPoint.y);
    await waitForFunctionInPage(session.page, () => Array.from(
        document.querySelectorAll<HTMLButtonElement>('button.zoom-toggle-btn'),
    ).some((button) => {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        return /Fit Width/iu.test(button.textContent ?? '')
            && rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
    }), {timeout: SETTLE_TIMEOUT_MS});

    const fitPoint = await evaluateInPage(session.page, () => {
        const fitButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button.zoom-toggle-btn'))
            .find((button) => {
                const rect = button.getBoundingClientRect();
                const style = window.getComputedStyle(button);
                return /Fit Width/iu.test(button.textContent ?? '')
                    && rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
        if (!fitButton) {
            return null;
        }
        const rect = fitButton.getBoundingClientRect();
        return {
            x: Math.round(rect.left + (rect.width / 2)),
            y: Math.round(rect.top + (rect.height / 2)),
        };
    });
    if (!fitPoint) {
        throw new Error('Visible Fit Width option was not found after opening the zoom menu');
    }

    await session.page.mouse.click(fitPoint.x, fitPoint.y);
    await waitForFunctionInPage(session.page, () => (
        (window as {__evbTestApi?: {getActiveToolbarSnapshot?: () => {zoomMode?: string} | null}})
            .__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-width'
    ), {timeout: SETTLE_TIMEOUT_MS});
    await waitForAnimationFrames(session.page, 4);
}

describe('standard PDF.js fit-mode continuity', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-standard-pdf-fit-${Date.now()}`,
        timeoutMs: 180_000,
    });

    it('keeps page, viewport authority, and toolbar converged across repeated fit changes', async () => {
        const session = sessionFixture.getSession();
        await session.page.setViewport({
            deviceScaleFactor: 1,
            height: 900,
            width: 1_440,
        });

        const deepPdfPath = await createMultiPageTextFixturePdf(
            `standard-pdf-fit-deep-${Date.now()}.pdf`,
            DEEP_PDF_PAGE_COUNT,
        );
        expect(statSync(deepPdfPath).size).toBeLessThan(PDF_NATIVE_OPENING_PREVIEW_MIN_BYTES);

        // The trace has to be armed before the open is claimed: the phases that
        // decide the first-useful-pixel time all run before the first canvas.
        await enablePdfRenderTrace(session);
        await installCommittedSurfaceSampler(session.page);
        // The sampler is an animation-frame loop inside the page. These tests
        // share one Electron session, so an open that fails or times out here
        // would otherwise leave it sampling for the rest of the file and
        // compete with every test that follows.
        let openTrace: ICommittedSurfaceTrace = {
            errors: [],
            frames: [],
        };
        try {
            await openPdfInApp(session.page, deepPdfPath, OPEN_TIMEOUT_MS);
            await waitForPdfLoaded(session.page, OPEN_TIMEOUT_MS);
            await waitForCommittedSurfaceSamples(session.page, {
                kind: 'committed-canvas',
                minimumSamples: 12,
            });
        } finally {
            openTrace = await stopCommittedSurfaceSampler(session.page);
        }
        const openTiming = summarizeCommittedSurfaceTiming(openTrace);
        const openPhaseLedger = await readOpenPhaseLedger(session);
        console.info(`[standard-pdf-open] ${JSON.stringify(openTiming)}`);
        // The phase ledger is the answer to "which part of the open was slow?".
        // Printed on every run so a budget miss arrives with its own cause.
        console.info(`[standard-pdf-open-phases] ${JSON.stringify(openPhaseLedger)}`);
        expect(openPhaseLedger.numPages, JSON.stringify(openPhaseLedger)).toBe(DEEP_PDF_PAGE_COUNT);
        // Without the open origin every offset below is measured from whatever
        // happened to be first in the buffer, so the ledger would be fiction.
        expect(openPhaseLedger.routeStartMissing, JSON.stringify(openPhaseLedger)).toBe(false);
        const measuredPhases = new Set(
            openPhaseLedger.phases
                .filter(entry => entry.durationMs !== null)
                .map(entry => entry.phase),
        );
        // Losing a phase measurement is a regression too: a nine-second open is
        // only actionable while the trace still attributes the time.
        for (const phase of REQUIRED_OPEN_PHASES) {
            expect(
                measuredPhases.has(phase),
                `open phase '${phase}' was not measured: ${JSON.stringify(openPhaseLedger)}`,
            ).toBe(true);
        }
        const openViolations = findCommittedSurfaceCausalOpenViolations(openTrace, {
            maxFirstCanvasMs: FIRST_USEFUL_PIXEL_BUDGET_MS,
            maxFirstPageShellMs: FIRST_PAGE_SHELL_BUDGET_MS,
            maxReadyAfterCanvasMs: READY_AFTER_CANVAS_BUDGET_MS,
            requirePageShell: false,
            allowDeferredOpening: true,
        });
        // Asserted at the end of this test: a missed opening budget is a real
        // failure, but it must not hide whether the fit contract below held.
        // The measurement itself is printed above on every run.

        const routing = await readViewerAuthorityState(session);
        expect(routing.hasStandardPdfSurface).toBe(true);
        expect(routing.hasNativePreviewSurface).toBe(false);

        await ensureSidebarOpen(session.page, OPEN_TIMEOUT_MS);
        await goToPageViaToolbar(session.page, DEEP_PAGE);
        await waitForToolbarCurrentPage(session.page, DEEP_PAGE, SETTLE_TIMEOUT_MS);
        await waitForFitSettlement(session, DEEP_PAGE);
        // Reset the buffer so a fit settle failure reports the fit round rather
        // than the opening trace that already served its purpose above.
        await enablePdfRenderTrace(session);

        const sidebarOpenObservations = await alternateFitAndAssertConvergence(session, DEEP_PAGE, 4);
        for (const observation of sidebarOpenObservations) {
            expect(observation, JSON.stringify(sidebarOpenObservations)).toMatchObject({
                chassisCurrentPage: DEEP_PAGE,
                committedPage: DEEP_PAGE,
                mostVisiblePage: DEEP_PAGE,
                toolbarPage: DEEP_PAGE,
            });
        }

        await clickVisibleToolbarButton(session.page, 'Next Page');
        await waitForToolbarCurrentPage(session.page, DEEP_PAGE + 1, SETTLE_TIMEOUT_MS);
        await clickVisibleToolbarButton(session.page, 'Previous Page');
        await waitForToolbarCurrentPage(session.page, DEEP_PAGE, SETTLE_TIMEOUT_MS);
        await waitForFitSettlement(session, DEEP_PAGE);

        // Sidebar closed: presentation must not change the fit contract.
        await requireWorkspaceCommand(session.page, 'handleToggleSidebar');
        await waitForWorkspaceToolbarSnapshot(session.page, {showSidebar: false}, {timeoutMs: SETTLE_TIMEOUT_MS});
        await waitForFunctionInPage(session.page, () => {
            const activeHost = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const sidebar = activeHost?.querySelector<HTMLElement>('.sidebar-wrapper') ?? null;
            return sidebar?.classList.contains('is-closed') === true
                && sidebar.hasAttribute('inert')
                && sidebar.getAttribute('aria-hidden') === 'true'
                && sidebar.getBoundingClientRect().width <= 0.5;
        }, {timeout: SETTLE_TIMEOUT_MS});
        await waitForFitSettlement(session, DEEP_PAGE);

        const sidebarClosedObservations = await alternateFitAndAssertConvergence(session, DEEP_PAGE, 4);
        for (const observation of sidebarClosedObservations) {
            expect(observation, JSON.stringify(sidebarClosedObservations)).toMatchObject({
                chassisCurrentPage: DEEP_PAGE,
                committedPage: DEEP_PAGE,
                mostVisiblePage: DEEP_PAGE,
                toolbarPage: DEEP_PAGE,
            });
        }

        // A physical scroll still owns the viewport. The fit re-anchor must not
        // have made layout-generated and user-generated scroll interchangeable.
        const beforeScroll = await readViewerAuthorityState(session);
        let afterScroll = beforeScroll;
        for (let attempt = 0; attempt < 5 && afterScroll.mostVisiblePage === beforeScroll.mostVisiblePage; attempt += 1) {
            const wheel = await wheelPdfViewportAndWaitForSettlement(session.page, 1_200, SETTLE_TIMEOUT_MS);
            expect(wheel.scrollEventCount).toBeGreaterThan(0);
            await delay(250);
            afterScroll = await readViewerAuthorityState(session);
        }
        console.info(`[standard-pdf-physical-scroll] ${JSON.stringify({
            afterScroll,
            beforeScroll,
        })}`);

        expect(
            afterScroll.mostVisiblePage,
            JSON.stringify({
                afterScroll,
                beforeScroll,
            }),
        ).not.toBe(beforeScroll.mostVisiblePage);
        const scrolledPage = afterScroll.mostVisiblePage!;
        await settleSemanticPageAuthority(session, scrolledPage, 'after-physical-scroll');
        const scrolledAuthority = await readViewerAuthorityState(session);
        const scrolledToolbar = await getWorkspaceToolbarSnapshot(session.page);
        // The wheel, not the last fit command, now decides which page the
        // viewer is on: authority, screen, and toolbar all name the scrolled
        // page while the fit-owned page is left behind.
        expect({
            chassisCurrentPage: scrolledAuthority.chassisCurrentPage,
            mostVisiblePage: scrolledAuthority.mostVisiblePage,
            toolbarPage: scrolledToolbar?.currentPage ?? null,
        }, JSON.stringify({
            beforeScroll,
            scrolledAuthority,
            scrolledToolbar,
        })).toEqual({
            chassisCurrentPage: scrolledPage,
            mostVisiblePage: scrolledPage,
            toolbarPage: scrolledPage,
        });
        // Stale fit authority must be gone: the fits that follow settle on the
        // scrolled page instead of dragging the viewer back to DEEP_PAGE or
        // reinterpreting the old pixel offset against the new page metrics.
        const afterScrollFit = await alternateFitAndAssertConvergence(session, scrolledPage, 2, 'semantic');
        for (const observation of afterScrollFit) {
            expect(observation, JSON.stringify(afterScrollFit)).toMatchObject({
                chassisCurrentPage: scrolledPage,
                mostVisiblePage: scrolledPage,
                toolbarPage: scrolledPage,
            });
        }

        // Pagination continues from the scrolled page, and the command path
        // recommits the viewport there rather than at the pre-scroll page.
        await clickVisibleToolbarButton(session.page, 'Next Page');
        await waitForToolbarCurrentPage(session.page, scrolledPage + 1, SETTLE_TIMEOUT_MS);
        await waitForFitSettlement(session, scrolledPage + 1);
        await clickVisibleToolbarButton(session.page, 'Previous Page');
        await waitForToolbarCurrentPage(session.page, scrolledPage, SETTLE_TIMEOUT_MS);
        await waitForFitSettlement(session, scrolledPage);
        const afterPagination = await readViewerAuthorityState(session);
        expect(afterPagination, JSON.stringify(afterPagination)).toMatchObject({
            chassisCurrentPage: scrolledPage,
            committedPage: scrolledPage,
            mostVisiblePage: scrolledPage,
            toolbarPage: scrolledPage,
        });

        expect(openViolations, JSON.stringify({
            openTiming,
            openViolations,
        })).toEqual([]);
    }, 300_000);

    it('keeps the committed page visible while a fit change replaces its raster', async () => {
        const session = sessionFixture.getSession();
        await session.page.setViewport({
            deviceScaleFactor: 1,
            height: 900,
            width: 1_440,
        });

        const deepPdfPath = await createMultiPageTextFixturePdf(
            `standard-pdf-fit-pixels-${Date.now()}.pdf`,
            DEEP_PDF_PAGE_COUNT,
        );
        await openPdfInApp(session.page, deepPdfPath, OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, OPEN_TIMEOUT_MS);
        await goToPageViaToolbar(session.page, DEEP_PAGE);
        await waitForToolbarCurrentPage(session.page, DEEP_PAGE, SETTLE_TIMEOUT_MS);
        await waitForFitSettlement(session, DEEP_PAGE);

        await enablePdfRenderTrace(session);
        await startFitProbe(session, DEEP_PAGE);
        // The probe samples on a page interval, so it has to be stopped even
        // when an assertion below fails. A leaked sampler keeps running for the
        // rest of the session and competes with the tests that follow.
        let frames: IFitFrameSample[] = [];
        try {
            await waitForAnimationFrames(session.page, 5);
            for (const [
                checkpoint,
                command,
            ] of [
                    [
                        'fit-height',
                        'handleFitHeight',
                    ],
                    [
                        'fit-width',
                        'handleFitWidth',
                    ],
                ] as const) {
                await markFitProbeCheckpoint(session, checkpoint);
                await requireWorkspaceCommand(session.page, command);
                await waitForFitSettlement(session, DEEP_PAGE);
            }
            await markFitProbeCheckpoint(session, 'settled');
            await waitForAnimationFrames(session.page, 5);
        } finally {
            frames = await stopFitProbe(session);
        }

        expect(frames.length).toBeGreaterThan(10);
        const skeletonFrames = frames.filter(frame => frame.anchorSkeletonVisible);
        const uncommittedFrames = frames.filter(frame => frame.anchorCanvasCount === 0);
        const strayPageFrames = frames.filter(frame => (
            frame.topVisiblePage !== null && frame.topVisiblePage !== DEEP_PAGE
        ));
        if (skeletonFrames.length || uncommittedFrames.length || strayPageFrames.length) {
            // A blank page is only actionable with the raster events that say
            // which release emptied the canvas host.
            console.info(`[standard-pdf-fit-raster-trace] ${JSON.stringify(
                await readRawPdfRenderTrace(session, 400),
            )}`);
        }
        expect(skeletonFrames, JSON.stringify(skeletonFrames.slice(0, 8))).toEqual([]);
        expect(uncommittedFrames, JSON.stringify(uncommittedFrames.slice(0, 8))).toEqual([]);
        expect(strayPageFrames, JSON.stringify(strayPageFrames.slice(0, 8))).toEqual([]);
    }, 300_000);

    it('hands the sidebar to the opening document and keeps an invalid open recoverable', async () => {
        const session = sessionFixture.getSession();
        await session.page.setViewport({
            deviceScaleFactor: 1,
            height: 900,
            width: 1_440,
        });

        const priorPdfPath = await createBlankFixturePdf(
            `standard-pdf-prior-${Date.now()}.pdf`,
            PRIOR_PDF_PAGE_COUNT,
        );
        const deepPdfPath = await createMultiPageTextFixturePdf(
            `standard-pdf-open-deep-${Date.now()}.pdf`,
            DEEP_PDF_PAGE_COUNT,
        );

        await openPdfInApp(session.page, priorPdfPath, OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, OPEN_TIMEOUT_MS);
        await ensureSidebarOpen(session.page, OPEN_TIMEOUT_MS);
        await goToPageViaToolbar(session.page, 4);
        await waitForToolbarCurrentPage(session.page, 4, SETTLE_TIMEOUT_MS);

        // Precondition for the handoff: the previous document really is showing
        // its sidebar when the next open is triggered.
        const beforeOpen = await readViewerAuthorityState(session);
        expect(beforeOpen.sidebarVisible, JSON.stringify(beforeOpen)).toBe(true);

        // This is the reported case: a second open claimed while a document is
        // already mounted. Measure it by phase too, because the report timed
        // this open, not a cold one.
        await enablePdfRenderTrace(session);
        await startOpenGenerationProbe(session);
        // Same contract as the fit probe: the sampler is a page interval, so it
        // is stopped even if the open never reaches the state asserted below.
        let openFrames: IOpenGenerationFrame[] = [];
        try {
            await triggerOpenPathInApp(session.page, deepPdfPath, OPEN_TIMEOUT_MS);
            await waitForFunctionInPage(session.page, (expectedTotal: number) => (
                (window as {__evbTestApi?: {getActiveToolbarSnapshot?: () => {totalPages?: number} | null}})
                    .__evbTestApi?.getActiveToolbarSnapshot?.()?.totalPages === expectedTotal
            ), {timeout: OPEN_TIMEOUT_MS}, DEEP_PDF_PAGE_COUNT);
            await waitForPdfLoaded(session.page, OPEN_TIMEOUT_MS);
            await waitForFitSettlement(session, 1);
            await waitForAnimationFrames(session.page, 5);
        } finally {
            openFrames = await stopOpenGenerationProbe(session);
        }
        const secondOpenPhaseLedger = await readOpenPhaseLedger(session);
        console.info(`[standard-pdf-second-open-phases] ${JSON.stringify(secondOpenPhaseLedger)}`);
        expect(secondOpenPhaseLedger.numPages, JSON.stringify(secondOpenPhaseLedger))
            .toBe(DEEP_PDF_PAGE_COUNT);
        expect(secondOpenPhaseLedger.routeStartMissing, JSON.stringify(secondOpenPhaseLedger)).toBe(false);

        expect(openFrames.length).toBeGreaterThan(10);
        // Phase breakdown for the open: when each open-surface phase was first
        // observed, measured from the moment the open was triggered. This is
        // what says whether a slow open is spent before geometry, between
        // geometry and the first canvas, or after it.
        const phaseFirstObservedMs: Record<string, number> = {};
        for (const frame of openFrames) {
            if (frame.openSurfacePhase !== null && !(frame.openSurfacePhase in phaseFirstObservedMs)) {
                phaseFirstObservedMs[frame.openSurfacePhase] = frame.elapsedMs;
            }
        }
        console.info(`[standard-pdf-open-generation] ${JSON.stringify({
            frameCount: openFrames.length,
            phaseFirstObservedMs,
            phases: [...new Set(openFrames.map(frame => frame.openSurfacePhase))],
            sampleSpanMs: openFrames.at(-1)?.elapsedMs ?? 0,
            sidebarFrames: openFrames
                .filter(frame => frame.visibleSidebars.length > 0)
                .slice(0, 6),
        })}`);
        const transitionPhases = new Set([
            'pending',
            'geometry-committed',
            'canvas-committed',
            'viewport-committed',
        ]);
        // The reported defect: the previous document's outline stayed on screen
        // under the new tab's title. A sidebar that does not belong to the host
        // the workspace is presenting mixes two document identities, whatever
        // the open surface is doing.
        const foreignSidebarFrames = openFrames.filter(frame => (
            frame.visibleSidebars.some(sidebar => !sidebar.ownsActiveHost)
        ));
        expect(foreignSidebarFrames, JSON.stringify(foreignSidebarFrames.slice(0, 8))).toEqual([]);
        // And no sidebar at all - not even the claiming document's own - may be
        // presented before that document owns a committed visual surface.
        const staleSidebarFrames = openFrames.filter(frame => (
            frame.openSurfacePhase !== null
            && transitionPhases.has(frame.openSurfacePhase)
            && frame.visibleSidebars.length > 0
        ));
        expect(staleSidebarFrames, JSON.stringify(staleSidebarFrames.slice(0, 8))).toEqual([]);

        // The new document owns its own sidebar preference. Opening it must
        // leave the sidebar usable rather than wedged behind a stale claim.
        await ensureSidebarOpen(session.page, OPEN_TIMEOUT_MS);

        await goToPageViaToolbar(session.page, DEEP_PAGE);
        await waitForToolbarCurrentPage(session.page, DEEP_PAGE, SETTLE_TIMEOUT_MS);
        try {
            await waitForFitSettlement(session, DEEP_PAGE);
        } catch (error) {
            throw new Error(`The deep page never settled: ${JSON.stringify({
                authority: await readViewerAuthorityState(session),
                chassis: await session.page.evaluate(() => ({...document.querySelector<HTMLElement>(
                    '.editor-pane.is-active .document-viewer-chassis',
                )?.dataset})),
                trace: await readRawPdfRenderTrace(session, 120),
            })}`, {cause: error});
        }

        // An invalid staged open must leave the document the user already had
        // exactly where they left it. The app stages an open into a tab of its
        // own, so the rejected file must not take the previous tab, its page,
        // or its sidebar with it.
        const beforeInvalid = await readViewerAuthorityState(session);
        const documentTabId = beforeInvalid.activeTabId;
        expect(documentTabId).not.toBeNull();
        const invalidPath = createCorruptPdfFixture(`standard-pdf-invalid-${Date.now()}.pdf`);
        const invalidOpenOutcome = await openPathAndAwaitRouteOutcome(session, invalidPath);
        expect(invalidOpenOutcome.available, JSON.stringify(invalidOpenOutcome)).toBe(true);
        await waitForNoWorkspaceOpening(session);
        await waitForAnimationFrames(session.page, 5);

        // Whichever way the file was refused, the open it claimed is accounted
        // for by phase rather than left as an open-ended span.
        const invalidRouteSpan = await readOpenRouteCapabilitySpan(session, invalidPath);
        expect(invalidRouteSpan, JSON.stringify(invalidRouteSpan)).toMatchObject({
            ended: true,
            started: true,
        });
        expect(invalidRouteSpan.elapsedMs, JSON.stringify(invalidRouteSpan)).not.toBeNull();

        const tabsAfterInvalid = await readWorkspaceTabState(session);
        expect(tabsAfterInvalid.tabIds, JSON.stringify(tabsAfterInvalid)).toContain(documentTabId);
        await activateWorkspaceTabById(session, documentTabId!);
        await waitForFitSettlement(session, DEEP_PAGE);
        const preserved = await readDocumentHostState(session, documentTabId);
        console.info(`[standard-pdf-invalid-open] ${JSON.stringify({
            beforeInvalid,
            invalidOpenOutcome,
            invalidRouteSpan,
            preserved,
            tabsAfterInvalid,
        })}`);
        expect(preserved, JSON.stringify(preserved)).toMatchObject({
            committedPage: DEEP_PAGE,
            hostActive: true,
            mostVisiblePage: DEEP_PAGE,
            sidebarVisible: true,
            toolbarPage: DEEP_PAGE,
            totalPages: DEEP_PDF_PAGE_COUNT,
        });
    }, 300_000);

    it('preserves the page across rapid fit changes, a non-default scale, and keyboard paging', async () => {
        const session = sessionFixture.getSession();
        await session.page.setViewport({
            deviceScaleFactor: 1,
            height: 900,
            width: 1_440,
        });

        const deepPdfPath = await createMultiPageTextFixturePdf(
            `standard-pdf-fit-scale-${Date.now()}.pdf`,
            DEEP_PDF_PAGE_COUNT,
        );
        await openPdfInApp(session.page, deepPdfPath, OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, OPEN_TIMEOUT_MS);
        await goToPageViaToolbar(session.page, DEEP_PAGE);
        await waitForToolbarCurrentPage(session.page, DEEP_PAGE, SETTLE_TIMEOUT_MS);
        await waitForFitSettlement(session, DEEP_PAGE);
        await enablePdfRenderTrace(session);

        // Rapid fit changes: the reported alternation needs no scrolling and no
        // pause between commands, so nothing here waits for a round to settle.
        // Superseded rounds must retire without leaving their own anchor behind.
        for (const command of [
            'handleFitHeight',
            'handleFitWidth',
            'handleFitHeight',
            'handleFitWidth',
        ] as const) {
            await requireWorkspaceCommand(session.page, command);
        }
        await waitForFitSettlement(session, DEEP_PAGE);
        const afterRapid = await readViewerAuthorityState(session);
        const rapidToolbar = await getWorkspaceToolbarSnapshot(session.page);
        expect({
            ...afterRapid,
            toolbarPage: rapidToolbar?.currentPage ?? null,
        }, JSON.stringify({
            afterRapid,
            rapidToolbar,
            trace: await readPdfRenderTrace(session, 60),
        })).toMatchObject({
            chassisCurrentPage: DEEP_PAGE,
            committedPage: DEEP_PAGE,
            mostVisiblePage: DEEP_PAGE,
            toolbarPage: DEEP_PAGE,
        });

        // Non-default scale: the report alternated between fit scales of 190%
        // and 117%, so the contract has to hold when the pre-fit scale is a
        // user-chosen zoom rather than either fit's own scale.
        const fitZoom = rapidToolbar?.effectiveZoom ?? 0;
        expect(fitZoom).toBeGreaterThan(0);
        for (let step = 0; step < 4; step += 1) {
            await requireWorkspaceCommand(session.page, 'handleZoomIn');
            await delay(200);
        }
        await waitForFunctionInPage(session.page, () => (
            (window as {__evbTestApi?: {getActiveToolbarSnapshot?: () => {zoomMode?: string} | null}})
                .__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'custom'
        ), {timeout: SETTLE_TIMEOUT_MS});
        await settleSemanticPageAuthority(session, DEEP_PAGE, 'after-custom-zoom');
        const zoomedToolbar = await getWorkspaceToolbarSnapshot(session.page);
        console.info(`[standard-pdf-non-default-scale] ${JSON.stringify({
            fitZoom,
            zoomedToolbar,
        })}`);
        expect(zoomedToolbar?.zoomMode).toBe('custom');
        expect(
            zoomedToolbar?.effectiveZoom ?? 0,
            JSON.stringify({
                fitZoom,
                zoomedToolbar,
            }),
        ).toBeGreaterThan(fitZoom);
        // Zoom is not navigation either: the page the user was reading has to
        // survive the scale change that precedes the fit commands.
        expect(zoomedToolbar?.currentPage).toBe(DEEP_PAGE);

        // Fit width is still the active fit mode, so this command changes only
        // the zoom mode. That path never mints a fit viewport intent, and its
        // geometry replacement has to keep the page on its own.
        await requireWorkspaceCommand(session.page, 'handleFitWidth');
        await waitForFunctionInPage(session.page, () => (
            (window as {__evbTestApi?: {getActiveToolbarSnapshot?: () => {zoomMode?: string} | null}})
                .__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-width'
        ), {timeout: SETTLE_TIMEOUT_MS});
        await settleSemanticPageAuthority(session, DEEP_PAGE, 'after-zoom-mode-only-fit');
        const afterZoomModeOnlyFit = await readViewerAuthorityState(session);
        const zoomModeOnlyToolbar = await getWorkspaceToolbarSnapshot(session.page);
        expect({
            chassisCurrentPage: afterZoomModeOnlyFit.chassisCurrentPage,
            mostVisiblePage: afterZoomModeOnlyFit.mostVisiblePage,
            toolbarPage: zoomModeOnlyToolbar?.currentPage ?? null,
        }, JSON.stringify({
            afterZoomModeOnlyFit,
            trace: await readPdfRenderTrace(session, 60),
            zoomModeOnlyToolbar,
        })).toEqual({
            chassisCurrentPage: DEEP_PAGE,
            mostVisiblePage: DEEP_PAGE,
            toolbarPage: DEEP_PAGE,
        });

        const nonDefaultScaleObservations = await alternateFitAndAssertConvergence(session, DEEP_PAGE, 4);
        for (const observation of nonDefaultScaleObservations) {
            expect(observation, JSON.stringify(nonDefaultScaleObservations)).toMatchObject({
                chassisCurrentPage: DEEP_PAGE,
                committedPage: DEEP_PAGE,
                mostVisiblePage: DEEP_PAGE,
                toolbarPage: DEEP_PAGE,
            });
        }
        const afterFitFromZoom = await getWorkspaceToolbarSnapshot(session.page);
        // The last round was fit-width, so the fit command reclaimed the zoom
        // mode from the custom scale instead of leaving a stale 190%.
        expect(afterFitFromZoom?.zoomMode).toBe('fit-width');

        // Keyboard paging reads the same semantic page authority the toolbar
        // does. If a fit change had left that authority trailing the rendered
        // page, PageDown would step from the wrong page.
        await evaluateInPage(session.page, () => {
            const active = document.activeElement;
            if (active instanceof HTMLElement) {
                active.blur();
            }
        });
        await session.page.keyboard.press('PageDown');
        await waitForToolbarCurrentPage(session.page, DEEP_PAGE + 1, SETTLE_TIMEOUT_MS);
        await waitForFitSettlement(session, DEEP_PAGE + 1);
        await session.page.keyboard.press('PageUp');
        await waitForToolbarCurrentPage(session.page, DEEP_PAGE, SETTLE_TIMEOUT_MS);
        await waitForFitSettlement(session, DEEP_PAGE);

        // A fit change made from a keyboard-owned page keeps that page, and
        // keyboard paging still steps from it afterwards.
        const afterKeyboardFit = await alternateFitAndAssertConvergence(session, DEEP_PAGE, 2);
        for (const observation of afterKeyboardFit) {
            expect(observation, JSON.stringify(afterKeyboardFit)).toMatchObject({
                chassisCurrentPage: DEEP_PAGE,
                committedPage: DEEP_PAGE,
                mostVisiblePage: DEEP_PAGE,
                toolbarPage: DEEP_PAGE,
            });
        }
        await session.page.keyboard.press('PageDown');
        await waitForToolbarCurrentPage(session.page, DEEP_PAGE + 1, SETTLE_TIMEOUT_MS);
        await waitForFitSettlement(session, DEEP_PAGE + 1);
        const afterKeyboardPaging = await readViewerAuthorityState(session);
        const keyboardToolbar = await getWorkspaceToolbarSnapshot(session.page);
        expect({
            ...afterKeyboardPaging,
            toolbarPage: keyboardToolbar?.currentPage ?? null,
        }, JSON.stringify({
            afterKeyboardPaging,
            keyboardToolbar,
        })).toMatchObject({
            chassisCurrentPage: DEEP_PAGE + 1,
            committedPage: DEEP_PAGE + 1,
            mostVisiblePage: DEEP_PAGE + 1,
            toolbarPage: DEEP_PAGE + 1,
        });
    }, 300_000);

    it('keeps the native opening preview on the settled document-wide Fit Width', async () => {
        const session = sessionFixture.getSession();
        const mixedWidthPdfPath = await createNativeMixedWidthFixturePdf(
            `standard-pdf-native-fit-width-${Date.now()}.pdf`,
        );
        await enablePdfRenderTrace(session);
        await installNativePdfOpeningSampler(session.page);
        let frames: Awaited<ReturnType<typeof stopNativePdfOpeningSampler>> = [];
        try {
            await openNativePdfPreviewInApp(session.page, mixedWidthPdfPath, OPEN_TIMEOUT_MS);
            await waitForPdfLoaded(session.page, OPEN_TIMEOUT_MS);
            await waitForAnimationFrames(session.page, 5);
        } finally {
            frames = await stopNativePdfOpeningSampler(session.page);
        }
        const trace = await evaluateInPage(session.page, () => {
            const traceWindow = window as Window & IPdfRenderTraceWindow;
            return (traceWindow.__getPdfRenderTrace?.() ?? traceWindow.__pdfRenderTraceBuffer ?? [])
                .filter(entry => entry.event.startsWith('pdf-open-native-preview'));
        });
        const documentWideReconciliation = trace.find(entry => (
            entry.event === 'pdf-open-native-preview-fit-width-reconciled'
            && entry.payload.previousWidth !== entry.payload.nextWidth
        ));
        expect(documentWideReconciliation, JSON.stringify(trace)).toBeDefined();
        assertNativeOpeningFitWidthIsSettled(frames);
    }, 180_000);

    it('keeps mixed-size jumps and continuous Fit Width geometry user-visible', async () => {
        const session = sessionFixture.getSession();
        const mixedPdfPath = await createMixedSize66FixturePdf(
            `standard-pdf-fit-mixed-66-${Date.now()}.pdf`,
        );
        const rotatedPdfPath = await createRotated90FixturePdf(
            `standard-pdf-fit-rotated-90-${Date.now()}.pdf`,
        );

        await openPdfInApp(session.page, mixedPdfPath, OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, OPEN_TIMEOUT_MS);

        // This is a real page-field click, keyboard entry, and Enter. The
        // visible page is checked separately from the toolbar so a stale
        // counter cannot make the jump appear to pass.
        await goToPageViaToolbar(session.page, 33);
        await waitForToolbarCurrentPage(session.page, 33, SETTLE_TIMEOUT_MS);

        const jumpVisiblePages = await readViewportPageObservation(session.page);
        const jumpIndicator = await readToolbarPageIndicator(session.page);
        expect(jumpVisiblePages.pages, JSON.stringify(jumpVisiblePages)).toEqual(
            expect.arrayContaining([expect.objectContaining({page: 33})]),
        );
        expect(jumpIndicator.renderedPage, JSON.stringify(jumpIndicator)).toBe(33);

        // Fit Width is selected through the visible zoom menu. The wheel
        // below is sent only after the menu action has settled, matching the
        // user sequence that exposed the mixed-width overflow.
        await goToPageViaToolbar(session.page, 1);
        await waitForToolbarCurrentPage(session.page, 1, SETTLE_TIMEOUT_MS);
        await clickFitWidthWithTrustedInput(session);
        const beforeScroll = await readMixedGeometry(session);
        const beforeVisiblePages = await readViewportPageObservation(session.page);
        expect(beforeVisiblePages.pages.length, JSON.stringify(beforeVisiblePages)).toBeGreaterThan(0);
        expect(beforeScroll.viewport, JSON.stringify(beforeScroll)).not.toBeNull();
        expect(beforeScroll.zoom, JSON.stringify(beforeScroll)).not.toBeNull();
        if (!beforeScroll.viewport) {
            return;
        }
        expect(
            Math.max(0, beforeScroll.viewport.scrollWidth - beforeScroll.viewport.clientWidth),
            JSON.stringify(beforeScroll),
        ).toBeLessThanOrEqual(1);

        const viewportPoint = await evaluateInPage(session.page, () => {
            const activeHost = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
            ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const viewport = activeHost?.querySelector<HTMLElement>(
                '[data-document-viewer-chassis-viewport], .document-viewer-viewport, #pdf-viewer',
            ) ?? null;
            if (!viewport) {
                return null;
            }
            const rect = viewport.getBoundingClientRect();
            return {
                x: Math.round(rect.left + (rect.width / 2)),
                y: Math.round(rect.top + (rect.height / 2)),
            };
        });
        expect(viewportPoint).not.toBeNull();
        if (!viewportPoint) {
            return;
        }
        await session.page.mouse.move(viewportPoint.x, viewportPoint.y);
        await session.page.mouse.wheel({deltaY: 12_000});
        await delay(2_500);

        const afterScroll = await readMixedGeometry(session);
        const afterVisiblePages = await readViewportPageObservation(session.page);
        expect(afterVisiblePages.pages.length, JSON.stringify(afterVisiblePages)).toBeGreaterThan(0);
        expect(afterScroll.viewport, JSON.stringify(afterScroll)).not.toBeNull();
        expect(afterScroll.zoom, JSON.stringify(afterScroll)).toBe(beforeScroll.zoom);
        if (!afterScroll.viewport) {
            return;
        }
        expect(
            afterScroll.viewport.scrollTop,
            JSON.stringify({
                afterScroll,
                beforeScroll,
            }),
        ).toBeGreaterThan(beforeScroll.viewport.scrollTop);
        expect(
            Math.max(0, afterScroll.viewport.scrollWidth - afterScroll.viewport.clientWidth),
            JSON.stringify(afterScroll),
        ).toBeLessThanOrEqual(1);

        // Fit Width remains active while opening the rotated document. Its
        // first committed geometry must already have no horizontal range.
        await openPdfInApp(session.page, rotatedPdfPath, OPEN_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, OPEN_TIMEOUT_MS);
        await waitForFunctionInPage(session.page, () => (
            (window as {__evbTestApi?: {getActiveToolbarSnapshot?: () => {zoomMode?: string} | null}})
                .__evbTestApi?.getActiveToolbarSnapshot?.()?.zoomMode === 'fit-width'
        ), {timeout: SETTLE_TIMEOUT_MS});
        await waitForAnimationFrames(session.page, 4);
        const rotatedGeometry = await readMixedGeometry(session);
        const rotatedVisiblePages = await readViewportPageObservation(session.page);
        expect(rotatedVisiblePages.pages.length, JSON.stringify(rotatedVisiblePages)).toBeGreaterThan(0);
        expect(rotatedGeometry.viewport, JSON.stringify(rotatedGeometry)).not.toBeNull();
        if (!rotatedGeometry.viewport) {
            return;
        }
        expect(
            Math.max(0, rotatedGeometry.viewport.scrollWidth - rotatedGeometry.viewport.clientWidth),
            JSON.stringify(rotatedGeometry),
        ).toBeLessThanOrEqual(1);
    }, 180_000);
});
