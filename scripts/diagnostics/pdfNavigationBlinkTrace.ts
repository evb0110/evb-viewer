import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import type { IDiagnosticFrameCaptureResult } from '@scripts/diagnostics/diagnosticFrameCapture';
import {goToPageViaToolbar} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    getWorkspaceToolbarSnapshot,
    installWorkspaceExposeProbe,
    type IWorkspaceExposeProbeWindow,
    waitForWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    type IPdfDiagnosticsContext,
    runPdfDiagnosticScenario,
} from '@scripts/diagnostics/runPdfDiagnosticScenario';
import {
    assertPdfNavigationBlinkTraceSummary,
    MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX,
} from '@scripts/diagnostics/assertPdfNavigationBlinkTraceSummary';
import {
    type IPdfNavigationBlinkTraceOptions,
    readOptions,
    resolveVideoDirectory,
} from '@scripts/diagnostics/pdfNavigationBlinkTraceOptions';

export {
    readOptions,
    resolveVideoDirectory,
} from '@scripts/diagnostics/pdfNavigationBlinkTraceOptions';

const POST_CLICK_INTERMEDIATE_VISUAL_GRACE_MS = 80;

interface ITraceSummary {
    bodyCanvasReadyAtMs: number | null;
    bodyVisualReadyAtMs: number | null;
    blankSampleCount: number;
    finalTargetPage: number | null;
    frameAnalysis: IFrameAnalysisSummary;
    firstBlankSample: unknown;
    firstCenteredBlankSample: unknown;
    firstCenteredBlankAfterClickSample: unknown;
    firstIntermediateVisualAfterClickSample: unknown;
    firstLatePostClickSwapSample: unknown;
    firstNonFinalPagedCommitAfterFinalRequest: unknown;
    firstNonFinalWorkspacePageAcceptAfterFinalRequest: unknown;
    firstOutgoingVisualGeometryMismatchSample: unknown;
    firstSkeletonAfterVisualSample: unknown;
    firstTranslucentSkeletonCanvasOverlapSample: unknown;
    firstSkeletonVisualOverlapSample: unknown;
    firstTargetCanvasRegressionSample: unknown;
    firstTargetFeedbackGeometryMismatchSample: unknown;
    firstToolbarAheadOfBodySample: unknown;
    finalRequestTraceAtMs: number | null;
    intermediateVisualAfterClickSampleCount: number;
    lastClickAtMs: number | null;
    latePostClickSwapCount: number;
    maxBlankRunMs: number;
    maxCenteredBlankAfterClickRunMs: number;
    maxCenteredBlankRunMs: number;
    maxIntermediateVisualAfterClickRunMs: number;
    maxToolbarBodyLagMs: number;
    nonFinalPagedCommitAfterFinalRequestCount: number;
    nonFinalWorkspacePageAcceptAfterFinalRequestCount: number;
    outgoingPage: number | null;
    outgoingVisualGeometryBaselineFound: boolean;
    outgoingVisualGeometryHeightDeltaPx: number;
    outgoingVisualGeometrySampleCount: number;
    outgoingVisualGeometryWidthDeltaPx: number;
    postReadyUnstableSampleCount: number;
    rasterSchedulerSnapshots: unknown[];
    skeletonAfterVisualSampleCount: number;
    skeletonSampleCount: number;
    translucentSkeletonCanvasOverlapSampleCount: number;
    skeletonVisualOverlapSampleCount: number;
    targetCanvasRegressionSampleCount: number;
    targetFeedbackHeightDeltaPx: number;
    targetFeedbackGeometrySampleCount: number;
    targetFeedbackWidthDeltaPx: number;
    toolbarAheadOfBodySampleCount: number;
    toolbarPages: number[];
    workspaceGoToPages: number[];
    pagedTargets: number[];
}

interface IPageSampleGeometry {
    width: number;
    height: number;
}

export interface IFrameAnalysisSummary {
    canvasObservedAtMs: number | null;
    firstSkeletonAfterCanvasAtMs: number | null;
    skeletonAfterCanvasObserved: boolean;
    skeletonAfterCanvasPages: number[];
}

async function installBlinkSampler(page: Page) {
    await installWorkspaceExposeProbe(page);
    await page.evaluate(() => {
        type TBlinkTraceWindow = Window & {
            __evbFindWorkspaceExpose?: (options?: {
                requiredMethods?: string[];
                requireVisible?: boolean;
            }) => {getToolbarSnapshot?: () => {
                currentPage?: number;
                totalPages?: number;
                fitMode?: string;
                zoomMode?: string;
                continuousScroll?: boolean;
                effectiveZoom?: number;
            };} | null;
            __pdfBlinkTrace?: {
                events: unknown[];
                samples: unknown[];
                startedAtMs: number;
            };
            __pdfBlinkTraceRunning?: boolean;
            __pdfBlinkTraceObserver?: MutationObserver;
            __recordPdfBlinkEvent?: (kind: string, payload?: unknown) => void;
            __startPdfBlinkTrace?: () => void;
            __stopPdfBlinkTrace?: () => unknown;
        };
        const traceWindow = window as TBlinkTraceWindow;

        function nowMs() {
            return Math.round((performance.now() - (traceWindow.__pdfBlinkTrace?.startedAtMs ?? performance.now())) * 10) / 10;
        }

        function isVisibleElement(element: HTMLElement) {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0
                && rect.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0;
        }

        function summarizeElement(element: Element | null) {
            if (!(element instanceof HTMLElement)) {
                return null;
            }
            return {
                tagName: element.tagName,
                className: String(element.className),
                text: element.textContent.trim().slice(0, 80),
                page: element.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
            };
        }

        function recordEvent(kind: string, payload: unknown = {}) {
            const trace = traceWindow.__pdfBlinkTrace;
            if (!trace) {
                return;
            }
            trace.events.push({
                kind,
                atMs: nowMs(),
                payload,
            });
        }

        function collectSample() {
            const viewer = document.querySelector<HTMLElement>('#pdf-viewer');
            const viewerRect = viewer?.getBoundingClientRect() ?? {
                top: 0,
                bottom: window.innerHeight,
                left: 0,
                right: window.innerWidth,
                width: window.innerWidth,
                height: window.innerHeight,
            };
            const visibleCurrentPageLabels = Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                .filter(isVisibleElement)
                .map((element) => {
                    const rect = element.getBoundingClientRect();
                    const controls = element.closest<HTMLElement>('.page-controls');
                    const secondary = controls?.querySelector<HTMLElement>('.page-controls-current-secondary') ?? null;
                    return {
                        text: element.textContent.trim(),
                        secondaryText: secondary?.textContent.trim() ?? '',
                        top: Math.round(rect.top),
                        left: Math.round(rect.left),
                    };
                });
            const visiblePages = Array.from(document.querySelectorAll<HTMLElement>('.page_container'))
                .map((container) => {
                    const rect = container.getBoundingClientRect();
                    const skeleton = container.querySelector<HTMLElement>('.document-page-skeleton');
                    const skeletonStyle = skeleton ? window.getComputedStyle(skeleton) : null;
                    const skeletonRect = skeleton?.getBoundingClientRect() ?? null;
                    const canvases = Array.from(container.querySelectorAll<HTMLCanvasElement>('.page_canvas canvas'));
                    const previews = Array.from(container.querySelectorAll<HTMLCanvasElement>('.page_preview canvas'));
                    const pageCanvas = container.querySelector<HTMLElement>('.page_canvas');
                    const rendered = container.classList.contains('page_container--rendered');
                    const previewDrawn = container.classList.contains('page_container--preview-drawn');
                    const canvasSizes = canvases.map(canvas => ({
                        width: canvas.width,
                        height: canvas.height,
                        clientWidth: Math.round(canvas.getBoundingClientRect().width),
                        clientHeight: Math.round(canvas.getBoundingClientRect().height),
                    }));
                    const previewSizes = previews.map(canvas => ({
                        width: canvas.width,
                        height: canvas.height,
                        clientWidth: Math.round(canvas.getBoundingClientRect().width),
                        clientHeight: Math.round(canvas.getBoundingClientRect().height),
                    }));
                    const hasUsableCanvas = rendered && canvasSizes.some(size => size.width > 0 && size.height > 0 && size.clientWidth > 0 && size.clientHeight > 0);
                    const hasUsablePreview = previewDrawn && previewSizes.some(size => size.width > 0 && size.height > 0 && size.clientWidth > 0 && size.clientHeight > 0);
                    const skeletonVisible = Boolean(
                        skeleton
                        && skeletonStyle
                        && skeletonRect
                        && skeletonRect.width > 0
                        && skeletonRect.height > 0
                        && skeletonStyle.display !== 'none'
                        && skeletonStyle.visibility !== 'hidden'
                        && Number(skeletonStyle.opacity || '1') > 0,
                    );
                    const visualReady = hasUsableCanvas || hasUsablePreview;
                    return {
                        page: Number(container.dataset.page) || 0,
                        top: Math.round(rect.top),
                        bottom: Math.round(rect.bottom),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                        className: container.className,
                        rendered,
                        buffered: container.classList.contains('page_container--buffered'),
                        previewDrawn,
                        hasSkeleton: Boolean(skeleton),
                        skeletonVisible,
                        skeletonDisplay: skeletonStyle?.display ?? null,
                        skeletonOpacity: skeletonStyle?.opacity ?? null,
                        hasCanvas: canvases.length > 0,
                        hasPreview: previews.length > 0,
                        hasUsableCanvas,
                        hasUsablePreview,
                        visualReady,
                        canvasCount: canvases.length,
                        previewCount: previews.length,
                        canvasSizes,
                        previewSizes,
                        pageCanvasChildren: pageCanvas?.children.length ?? 0,
                    };
                })
                .filter(pageInfo => pageInfo.bottom >= viewerRect.top && pageInfo.top <= viewerRect.bottom);
            const blankVisiblePages = visiblePages
                .filter(pageInfo => !pageInfo.skeletonVisible && !pageInfo.visualReady)
                .map(pageInfo => pageInfo.page);
            const skeletonPages = visiblePages
                .filter(pageInfo => pageInfo.skeletonVisible)
                .map(pageInfo => pageInfo.page);
            const canvasPages = visiblePages
                .filter(pageInfo => pageInfo.hasUsableCanvas)
                .map(pageInfo => pageInfo.page);
            const previewPages = visiblePages
                .filter(pageInfo => pageInfo.hasUsablePreview)
                .map(pageInfo => pageInfo.page);
            const centerX = Math.round(viewerRect.left + viewerRect.width / 2);
            const centerY = Math.round(viewerRect.top + viewerRect.height / 2);
            const elementAtCenter = summarizeElement(document.elementFromPoint(centerX, centerY));
            const elementsAtCenter = document.elementsFromPoint(centerX, centerY)
                .slice(0, 12)
                .map(summarizeElement);
            const visibleVisualPages = visiblePages
                .filter(pageInfo => pageInfo.visualReady)
                .map(pageInfo => pageInfo.page);
            const centeredElementPage = Number(elementAtCenter?.page ?? Number.NaN);
            const centeredVisualPage = Number.isFinite(centeredElementPage)
                && visibleVisualPages.includes(centeredElementPage)
                ? centeredElementPage
                : visiblePages.find(pageInfo => (
                    pageInfo.visualReady
                    && !pageInfo.buffered
                    && pageInfo.top <= centerY
                    && pageInfo.bottom >= centerY
                ))?.page
                    ?? visiblePages.find(pageInfo => (
                        pageInfo.visualReady
                        && pageInfo.top <= centerY
                        && pageInfo.bottom >= centerY
                    ))?.page
                    ?? visiblePages.find(pageInfo => pageInfo.visualReady)?.page
                    ?? null;
            const bodySignature = visiblePages
                .map(pageInfo => [
                    pageInfo.page,
                    pageInfo.rendered ? 'r' : '-',
                    pageInfo.visualReady ? 'v' : '-',
                    pageInfo.skeletonVisible ? 's' : '-',
                    pageInfo.buffered ? 'b' : '-',
                ].join(''))
                .join('|');
            const workspaceExpose = traceWindow.__evbFindWorkspaceExpose?.({
                requiredMethods: ['getToolbarSnapshot'],
                requireVisible: true,
            }) ?? null;

            return {
                atMs: nowMs(),
                toolbarSnapshot: workspaceExpose?.getToolbarSnapshot?.() ?? null,
                visibleCurrentPageLabels,
                viewer: viewer
                    ? {
                        scrollTop: Math.round(viewer.scrollTop),
                        clientHeight: viewer.clientHeight,
                        scrollHeight: viewer.scrollHeight,
                    }
                    : null,
                visiblePages,
                blankVisiblePages,
                skeletonPages,
                canvasPages,
                previewPages,
                visibleVisualPages,
                centeredVisualPage,
                bodySignature,
                elementAtCenter,
                elementsAtCenter,
            };
        }

        traceWindow.__pdfBlinkTraceObserver?.disconnect();
        traceWindow.__pdfBlinkTrace = {
            events: [],
            samples: [],
            startedAtMs: performance.now(),
        };
        traceWindow.__recordPdfBlinkEvent = recordEvent;

        document.addEventListener('click', (event) => {
            const button = (event.target as Element | null)?.closest('.page-controls button[aria-label]');
            if (!(button instanceof HTMLButtonElement)) {
                return;
            }
            recordEvent('toolbar-button-click', {
                label: button.getAttribute('aria-label'),
                disabled: button.disabled,
                labels: Array.from(document.querySelectorAll<HTMLElement>('.page-controls-current-primary'))
                    .filter(isVisibleElement)
                    .map(element => element.textContent.trim()),
            });
        }, true);

        traceWindow.__pdfBlinkTraceObserver = new MutationObserver((mutations) => {
            const trace = traceWindow.__pdfBlinkTrace;
            if (!trace || trace.events.length > 2_000) {
                return;
            }
            for (const mutation of mutations) {
                const target = mutation.target instanceof HTMLElement ? mutation.target : null;
                const pageContainer = target?.closest('.page_container') as HTMLElement | null;
                const important = pageContainer !== null
                    || Array.from(mutation.addedNodes).some(node => node instanceof HTMLElement && (
                        node.matches('.page_container, .document-page-skeleton, canvas')
                        || node.querySelector('.page_container, .document-page-skeleton, canvas') !== null
                    ))
                    || Array.from(mutation.removedNodes).some(node => node instanceof HTMLElement && (
                        node.matches('.page_container, .document-page-skeleton, canvas')
                        || node.querySelector('.page_container, .document-page-skeleton, canvas') !== null
                    ));
                if (!important) {
                    continue;
                }
                recordEvent('dom-mutation', {
                    type: mutation.type,
                    attributeName: mutation.attributeName,
                    targetClass: target?.className ?? null,
                    targetPage: pageContainer?.dataset.page ?? null,
                    added: mutation.addedNodes.length,
                    removed: mutation.removedNodes.length,
                });
            }
        });
        traceWindow.__pdfBlinkTraceObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: [
                'class',
                'style',
            ],
            childList: true,
            subtree: true,
        });

        function tick() {
            const trace = traceWindow.__pdfBlinkTrace;
            if (!traceWindow.__pdfBlinkTraceRunning || !trace) {
                return;
            }
            trace.samples.push(collectSample());
            window.requestAnimationFrame(tick);
        }

        traceWindow.__startPdfBlinkTrace = () => {
            traceWindow.__pdfBlinkTrace = {
                events: [],
                samples: [],
                startedAtMs: performance.now(),
            };
            traceWindow.__pdfBlinkTraceRunning = true;
            recordEvent('trace-start');
            window.requestAnimationFrame(tick);
        };
        traceWindow.__stopPdfBlinkTrace = () => {
            traceWindow.__pdfBlinkTraceRunning = false;
            recordEvent('trace-stop');
            traceWindow.__pdfBlinkTraceObserver?.disconnect();
            return traceWindow.__pdfBlinkTrace ?? null;
        };
    });
}

async function recordTraceEvent(
    page: Page,
    kind: string,
    payload: unknown = {},
) {
    await page.evaluate(([
        eventKind,
        eventPayload,
    ]) => {
        const traceWindow = window as Window & {__recordPdfBlinkEvent?: (kind: string, payload?: unknown) => void;};
        traceWindow.__recordPdfBlinkEvent?.(eventKind as string, eventPayload);
    }, [
        kind,
        payload,
    ]);
}

async function waitForActiveDocumentOpenSettled(page: Page) {
    await installWorkspaceExposeProbe(page);
    await page.evaluate(async () => {
        const testApi = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
        await testApi?.waitForActiveDocumentOpenSettled();
    });
}

async function waitForFitHeightMode(
    page: Page,
    scrollMode: IPdfNavigationBlinkTraceOptions['scrollMode'],
) {
    await page.waitForFunction((continuousScroll) => {
        const snapshot = (window as IWorkspaceExposeProbeWindow).__evbTestApi?.getActiveToolbarSnapshot() ?? null;
        return snapshot?.continuousScroll === continuousScroll
            && snapshot.fitMode === 'height'
            && snapshot.viewMode === 'single';
    }, { timeout: 10_000 }, scrollMode === 'continuous');
}

async function configureFitHeightMode(
    page: Page,
    scrollMode: IPdfNavigationBlinkTraceOptions['scrollMode'],
) {
    await waitForActiveDocumentOpenSettled(page);
    const continuousScroll = scrollMode === 'continuous';

    let lastSnapshot: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const initialSnapshot = await getWorkspaceToolbarSnapshot(page, {requiredMethods: [
            'handleFitHeight',
            'handleViewModeSingle',
        ]}) as { continuousScroll?: boolean } | null;

        if (!initialSnapshot) {
            throw new Error(`Unable to configure fit-height ${scrollMode} mode`);
        }

        await callWorkspaceCommand(page, 'handleViewModeSingle', [], {requiredMethods: [
            'getToolbarSnapshot',
            'handleFitHeight',
        ]});
        await delay(100);
        const singleModeSnapshot = await getWorkspaceToolbarSnapshot(page, {requiredMethods: [
            'handleFitHeight',
            'handleToggleContinuousScroll',
        ]}) as { continuousScroll?: boolean } | null;
        if ((singleModeSnapshot?.continuousScroll ?? initialSnapshot.continuousScroll) !== continuousScroll) {
            await callWorkspaceCommand(page, 'handleToggleContinuousScroll', [], {requiredMethods: [
                'getToolbarSnapshot',
                'handleFitHeight',
                'handleToggleContinuousScroll',
            ]});
        }
        const fitHeightResult = await callWorkspaceCommand(page, 'handleFitHeight', [], {requiredMethods: ['getToolbarSnapshot']});

        if (!fitHeightResult.called) {
            throw new Error(`Unable to configure fit-height ${scrollMode} mode`);
        }
        await delay(300);
        lastSnapshot = await getWorkspaceToolbarSnapshot(page, {requiredMethods: ['getToolbarSnapshot']});
        try {
            await waitForFitHeightMode(page, scrollMode);
            await delay(500);
            return;
        } catch {
            await waitForActiveDocumentOpenSettled(page);
        }
    }

    throw new Error(`Unable to settle into fit-height ${scrollMode} mode: ${JSON.stringify(lastSnapshot)}`);
}

async function goToPageViaWorkspace(
    page: Page,
    pageNumber: number,
) {
    const navigationResult = await callWorkspaceCommand(page, 'handleGoToPage', [pageNumber], {requiredMethods: ['getToolbarSnapshot']});

    if (!navigationResult.called) {
        throw new Error(`Unable to navigate workspace to page ${pageNumber}`);
    }
}

async function waitForToolbarPage(
    page: Page,
    pageNumber: number,
) {
    await waitForWorkspaceToolbarSnapshot(page, {currentPage: pageNumber}, {timeoutMs: 20_000});
}

async function goToStartPage(
    page: Page,
    pageNumber: number,
) {
    await goToPageViaWorkspace(page, pageNumber);
    try {
        await waitForToolbarPage(page, pageNumber);
    } catch {
        await goToPageViaToolbar(page, pageNumber);
    }
}

function uniqueNumbers(values: unknown[]) {
    const result: number[] = [];
    for (const value of values) {
        const numeric = typeof value === 'number' ? value : Number.NaN;
        if (Number.isFinite(numeric) && result.at(-1) !== numeric) {
            result.push(numeric);
        }
    }
    return result;
}

function readFiniteNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRenderTraceAtMs(entry: { payload?: Record<string, unknown>; }) {
    return readFiniteNumber(entry.payload?.traceAtMs);
}

function readRenderTracePage(
    entry: { payload?: Record<string, unknown>; },
    keys: string[],
) {
    for (const key of keys) {
        const value = readFiniteNumber(entry.payload?.[key]);
        if (value !== null) {
            return value;
        }
    }
    return null;
}

function readNumberArray(value: unknown) {
    return Array.isArray(value)
        ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
        : [];
}

function readVisiblePages(sample: Record<string, unknown>) {
    return Array.isArray(sample.visiblePages)
        ? sample.visiblePages.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
        : [];
}

function readToolbarPage(sample: Record<string, unknown>) {
    const visibleToolbarPage = readVisibleToolbarPage(sample);
    if (visibleToolbarPage !== null) {
        return visibleToolbarPage;
    }

    const snapshot = sample.toolbarSnapshot as {currentPage?: unknown} | null | undefined;
    return readFiniteNumber(snapshot?.currentPage);
}

function readVisibleToolbarPage(sample: Record<string, unknown>) {
    const labels = Array.isArray(sample.visibleCurrentPageLabels)
        ? sample.visibleCurrentPageLabels
        : [];
    for (const label of labels) {
        if (label === null || typeof label !== 'object') {
            continue;
        }
        const secondaryText = (label as {secondaryText?: unknown}).secondaryText;
        if (typeof secondaryText === 'string') {
            const page = readParenthesizedPositiveInteger(secondaryText)
                ?? readStrictPositiveInteger(secondaryText);
            if (page !== null) {
                return page;
            }
        }
        const text = (label as {text?: unknown}).text;
        if (typeof text !== 'string') {
            continue;
        }
        const page = readStrictPositiveInteger(text);
        if (page !== null) {
            return page;
        }
    }
    return null;
}

function readStrictPositiveInteger(text: string) {
    const trimmed = text.trim();
    if (!/^\d+$/u.test(trimmed)) {
        return null;
    }
    const page = Number.parseInt(trimmed, 10);
    return Number.isFinite(page) && page > 0 ? page : null;
}

function readParenthesizedPositiveInteger(text: string) {
    const match = /^\((\d+)\)$/u.exec(text.trim());
    if (!match?.[1]) {
        return null;
    }
    const page = Number.parseInt(match[1], 10);
    return Number.isFinite(page) && page > 0 ? page : null;
}

function readCenteredVisualPage(sample: Record<string, unknown>) {
    const elementAtCenterPage = readElementAtCenterPage(sample);
    if (elementAtCenterPage !== null && sampleHasVisualForPage(sample, elementAtCenterPage)) {
        return elementAtCenterPage;
    }
    return readFiniteNumber(sample.centeredVisualPage);
}

function readBodySignature(sample: Record<string, unknown>) {
    return typeof sample.bodySignature === 'string' ? sample.bodySignature : '';
}

function readElementAtCenterPage(sample: Record<string, unknown>) {
    const elementAtCenter = sample.elementAtCenter as {page?: unknown} | null | undefined;
    const page = elementAtCenter?.page;
    if (typeof page === 'number') {
        return Number.isFinite(page) ? page : null;
    }
    if (typeof page === 'string') {
        const parsed = Number.parseInt(page, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function readPageInfoForPage(sample: Record<string, unknown>, page: number) {
    return readVisiblePages(sample).find(pageInfo => readFiniteNumber(pageInfo.page) === page) ?? null;
}

function readCenteredPageInfo(sample: Record<string, unknown>) {
    const elementAtCenterPage = readElementAtCenterPage(sample);
    if (elementAtCenterPage !== null) {
        return readPageInfoForPage(sample, elementAtCenterPage);
    }
    return null;
}

function sampleHasVisualForPage(sample: Record<string, unknown>, page: number) {
    return readVisiblePages(sample).some(pageInfo => (
        readFiniteNumber(pageInfo.page) === page
        && pageInfo.visualReady === true
    ));
}

function sampleHasSkeletonForPage(sample: Record<string, unknown>, page: number) {
    return readVisiblePages(sample).some(pageInfo => (
        readFiniteNumber(pageInfo.page) === page
        && pageInfo.skeletonVisible === true
    ));
}

function sampleHasFeedbackForPage(sample: Record<string, unknown>, page: number) {
    return sampleHasVisualForPage(sample, page)
        || sampleHasSkeletonForPage(sample, page);
}

function sampleHasCanvasForPage(sample: Record<string, unknown>, page: number) {
    return readVisiblePages(sample).some(pageInfo => (
        readFiniteNumber(pageInfo.page) === page
        && pageInfo.hasUsableCanvas === true
    ));
}

function sampleHasCenteredVisualForPage(sample: Record<string, unknown>, page: number) {
    return readCenteredVisualPage(sample) === page
        && sampleHasVisualForPage(sample, page);
}

function sampleHasCenteredCanvasForPage(sample: Record<string, unknown>, page: number) {
    return readCenteredVisualPage(sample) === page
        && sampleHasCanvasForPage(sample, page);
}

function sampleHasCenteredVisualReadyPage(sample: Record<string, unknown>) {
    const centeredVisualPage = readCenteredVisualPage(sample);
    return centeredVisualPage !== null
        && sampleHasVisualForPage(sample, centeredVisualPage)
        ? centeredVisualPage
        : null;
}

function sampleHasCenteredBlank(sample: Record<string, unknown>) {
    const centeredPageInfo = readCenteredPageInfo(sample);
    if (centeredPageInfo) {
        return centeredPageInfo.visualReady !== true && centeredPageInfo.skeletonVisible !== true;
    }
    return readCenteredVisualPage(sample) === null
        && readNumberArray(sample.blankVisiblePages).length > 0;
}

function summarizeSampleRuns(
    samples: Array<Record<string, unknown>>,
    match: (sample: Record<string, unknown>) => unknown | null | false,
    options: {
        minimumAtMs?: number;
        skipInvalidTimes?: boolean;
    } = {},
) {
    let firstSample: Record<string, unknown> | null = null;
    let maxRunMs = 0;
    let sampleCount = 0;
    let runKey: unknown = null;
    let runStartAtMs: number | null = null;
    let runLastAtMs: number | null = null;

    function flushRun() {
        if (runStartAtMs !== null && runLastAtMs !== null) {
            maxRunMs = Math.max(maxRunMs, runLastAtMs - runStartAtMs);
        }
        runKey = null;
        runStartAtMs = null;
        runLastAtMs = null;
    }

    for (const sample of samples) {
        const sampleAtMs = readFiniteNumber(sample.atMs);
        if (sampleAtMs === null && options.skipInvalidTimes) {
            continue;
        }
        const atMs = sampleAtMs ?? 0;
        if (atMs < (options.minimumAtMs ?? Number.NEGATIVE_INFINITY)) {
            continue;
        }
        const key = match(sample);
        if (key === null || key === false) {
            flushRun();
            continue;
        }
        sampleCount += 1;
        firstSample ??= sample;
        if (runStartAtMs === null || !Object.is(runKey, key)) {
            flushRun();
            runKey = key;
            runStartAtMs = atMs;
        }
        runLastAtMs = atMs;
    }
    flushRun();

    return {
        firstSample,
        maxRunMs,
        sampleCount,
    };
}

function readPageInfoGeometry(pageInfo: Record<string, unknown>) {
    const width = readFiniteNumber(pageInfo.width);
    const height = readFiniteNumber(pageInfo.height);
    if (width === null || height === null) {
        return null;
    }

    return {
        width,
        height,
    };
}

function sampleHasNonBufferedFeedbackForPage(sample: Record<string, unknown>, page: number) {
    const pageInfo = readPageInfoForPage(sample, page);
    return pageInfo !== null
        && pageInfo.buffered !== true
        && (
            pageInfo.skeletonVisible === true
            || pageInfo.visualReady === true
        );
}

function getTargetFeedbackGeometrySummary(options: {
    finalTargetPage: number | null;
    samples: Array<Record<string, unknown>>;
}) {
    const {
        finalTargetPage,
        samples,
    } = options;
    if (finalTargetPage === null) {
        return {
            firstMismatchSample: null,
            maxHeightDeltaPx: 0,
            maxWidthDeltaPx: 0,
            sampleCount: 0,
        };
    }

    const feedbackSamples = samples.filter(sample =>
        sampleHasNonBufferedFeedbackForPage(sample, finalTargetPage),
    );
    const geometries = feedbackSamples
        .map(sample => readPageInfoForPage(sample, finalTargetPage))
        .map(pageInfo => pageInfo ? readPageInfoGeometry(pageInfo) : null)
        .filter((geometry): geometry is IPageSampleGeometry => geometry !== null);
    if (geometries.length === 0) {
        return {
            firstMismatchSample: null,
            maxHeightDeltaPx: 0,
            maxWidthDeltaPx: 0,
            sampleCount: 0,
        };
    }

    const finalGeometry = geometries.at(-1)!;
    let maxHeightDeltaPx = 0;
    let maxWidthDeltaPx = 0;
    let firstMismatchSample: Record<string, unknown> | null = null;
    for (const sample of feedbackSamples) {
        const pageInfo = readPageInfoForPage(sample, finalTargetPage);
        const geometry = pageInfo ? readPageInfoGeometry(pageInfo) : null;
        if (geometry === null) {
            continue;
        }
        const heightDelta = Math.abs(geometry.height - finalGeometry.height);
        const widthDelta = Math.abs(geometry.width - finalGeometry.width);
        maxHeightDeltaPx = Math.max(maxHeightDeltaPx, heightDelta);
        maxWidthDeltaPx = Math.max(maxWidthDeltaPx, widthDelta);
        if (
            firstMismatchSample === null
            && (
                heightDelta > MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX
                || widthDelta > MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX
            )
        ) {
            firstMismatchSample = sample;
        }
    }

    return {
        firstMismatchSample,
        maxHeightDeltaPx,
        maxWidthDeltaPx,
        sampleCount: feedbackSamples.length,
    };
}

function getOutgoingVisualGeometrySummary(options: {
    clickAtMs: number | null;
    finalTargetPage: number | null;
    samples: Array<Record<string, unknown>>;
}) {
    if (options.clickAtMs === null || options.finalTargetPage === null) {
        return {
            baselineFound: false,
            firstMismatchSample: null,
            maxHeightDeltaPx: 0,
            maxWidthDeltaPx: 0,
            outgoingPage: null,
            sampleCount: 0,
        };
    }

    // Outgoing deltas use the last pre-click visual as their baseline. Target
    // feedback instead compares every sample with its final geometry.
    const baselineSample = options.samples.findLast((sample) => {
        const atMs = readFiniteNumber(sample.atMs);
        const centeredPage = readCenteredVisualPage(sample);
        return atMs !== null
            && atMs <= options.clickAtMs!
            && centeredPage !== null
            && centeredPage !== options.finalTargetPage
            && sampleHasVisualForPage(sample, centeredPage);
    }) ?? null;
    const outgoingPage = baselineSample ? readCenteredVisualPage(baselineSample) : null;
    const baselinePageInfo = outgoingPage === null || baselineSample === null
        ? null
        : readPageInfoForPage(baselineSample, outgoingPage);
    const baselineGeometry = baselinePageInfo ? readPageInfoGeometry(baselinePageInfo) : null;
    if (outgoingPage === null || baselineGeometry === null) {
        return {
            baselineFound: false,
            firstMismatchSample: null,
            maxHeightDeltaPx: 0,
            maxWidthDeltaPx: 0,
            outgoingPage,
            sampleCount: 0,
        };
    }

    let firstMismatchSample: Record<string, unknown> | null = null;
    let maxHeightDeltaPx = 0;
    let maxWidthDeltaPx = 0;
    let sampleCount = 0;
    for (const sample of options.samples) {
        const atMs = readFiniteNumber(sample.atMs);
        if (atMs === null || atMs <= options.clickAtMs) {
            continue;
        }
        if (sampleHasCenteredVisualForPage(sample, options.finalTargetPage)) {
            break;
        }
        if (!sampleHasCenteredVisualForPage(sample, outgoingPage)) {
            continue;
        }
        const pageInfo = readPageInfoForPage(sample, outgoingPage);
        const geometry = pageInfo ? readPageInfoGeometry(pageInfo) : null;
        if (geometry === null) {
            continue;
        }
        sampleCount += 1;
        const heightDelta = Math.abs(geometry.height - baselineGeometry.height);
        const widthDelta = Math.abs(geometry.width - baselineGeometry.width);
        maxHeightDeltaPx = Math.max(maxHeightDeltaPx, heightDelta);
        maxWidthDeltaPx = Math.max(maxWidthDeltaPx, widthDelta);
        if (
            firstMismatchSample === null
            && (
                heightDelta > MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX
                || widthDelta > MAX_ASSERTED_TARGET_FEEDBACK_GEOMETRY_DELTA_PX
            )
        ) {
            firstMismatchSample = sample;
        }
    }

    return {
        baselineFound: true,
        firstMismatchSample,
        maxHeightDeltaPx,
        maxWidthDeltaPx,
        outgoingPage,
        sampleCount,
    };
}

function sampleHasCenteredSkeleton(sample: Record<string, unknown>) {
    const centeredPageInfo = readCenteredPageInfo(sample);
    return centeredPageInfo?.skeletonVisible === true;
}

function readTargetBodySignature(sample: Record<string, unknown>, targetPage: number | null) {
    if (targetPage === null) {
        return readBodySignature(sample);
    }
    const targetPageInfo = readPageInfoForPage(sample, targetPage);
    const centeredPage = readCenteredVisualPage(sample) ?? readElementAtCenterPage(sample) ?? 'none';
    if (!targetPageInfo) {
        return `center:${centeredPage}|target:missing`;
    }
    return [
        `center:${centeredPage}`,
        `target:${targetPage}`,
        targetPageInfo.rendered === true ? 'r' : '-',
        targetPageInfo.visualReady === true ? 'v' : '-',
        targetPageInfo.hasUsableCanvas === true ? 'c' : '-',
        targetPageInfo.hasUsablePreview === true ? 'p' : '-',
        targetPageInfo.skeletonVisible === true ? 's' : '-',
        targetPageInfo.buffered === true ? 'b' : '-',
    ].join('');
}

function sampleHasSkeletonVisualOverlap(sample: Record<string, unknown>) {
    return readVisiblePages(sample).some(pageInfo => (
        pageInfo.skeletonVisible === true
        && pageInfo.visualReady === true
    ));
}

function pageInfoHasVisibleCanvasElement(pageInfo: Record<string, unknown>) {
    const canvasSizes = Array.isArray(pageInfo.canvasSizes)
        ? pageInfo.canvasSizes
        : [];
    return canvasSizes.some((size) => {
        if (!size || typeof size !== 'object') {
            return false;
        }
        const canvasSize = size as Record<string, unknown>;
        const width = readFiniteNumber(canvasSize.width) ?? 0;
        const height = readFiniteNumber(canvasSize.height) ?? 0;
        const clientWidth = readFiniteNumber(canvasSize.clientWidth) ?? 0;
        const clientHeight = readFiniteNumber(canvasSize.clientHeight) ?? 0;
        return width > 0
            && height > 0
            && clientWidth > 0
            && clientHeight > 0;
    });
}

function sampleHasTranslucentSkeletonCanvasOverlap(sample: Record<string, unknown>) {
    return readVisiblePages(sample).some((pageInfo) => {
        const skeletonOpacity = Number(pageInfo.skeletonOpacity ?? '1');
        return pageInfo.skeletonVisible === true
            && Number.isFinite(skeletonOpacity)
            && skeletonOpacity < 0.99
            && pageInfoHasVisibleCanvasElement(pageInfo);
    });
}

function sampleHasSkeletonAfterVisual(
    sample: Record<string, unknown>,
    pagesSeenWithVisual: Set<number>,
) {
    return readVisiblePages(sample).some(pageInfo => {
        const page = readFiniteNumber(pageInfo.page);
        return page !== null
            && pagesSeenWithVisual.has(page)
            && pageInfo.skeletonVisible === true;
    });
}

function getLastEventAtMs(
    events: unknown[],
    kinds: string[],
) {
    let lastAtMs: number | null = null;
    for (const event of events) {
        if (event === null || typeof event !== 'object') {
            continue;
        }
        const entry = event as {
            atMs?: unknown;
            kind?: unknown;
        };
        if (typeof entry.kind !== 'string' || !kinds.includes(entry.kind)) {
            continue;
        }
        const atMs = readFiniteNumber(entry.atMs);
        if (atMs !== null) {
            lastAtMs = atMs;
        }
    }
    return lastAtMs;
}

function getFinalRequestTraceAtMs(
    renderTrace: Array<{
        event?: string;
        payload?: Record<string, unknown>;
    }>,
    finalTargetPage: number | null,
) {
    if (finalTargetPage === null) {
        return null;
    }

    let lastTraceAtMs: number | null = null;
    for (const entry of renderTrace) {
        if (
            entry.event !== 'workspace-go-to-page'
            && entry.event !== 'workspace-programmatic-page-navigation-begin'
        ) {
            continue;
        }
        const page = readRenderTracePage(entry, [
            'targetPage',
            'page',
        ]);
        const traceAtMs = readRenderTraceAtMs(entry);
        if (page === finalTargetPage && traceAtMs !== null) {
            lastTraceAtMs = traceAtMs;
        }
    }
    return lastTraceAtMs;
}

function getNonFinalRenderTraceEventsAfterFinalRequest(
    renderTrace: Array<{
        event?: string;
        payload?: Record<string, unknown>;
    }>,
    options: {
        event: string;
        finalRequestTraceAtMs: number | null;
        finalTargetPage: number | null;
        pageKeys: string[];
    },
) {
    if (options.finalRequestTraceAtMs === null || options.finalTargetPage === null) {
        return [];
    }
    const finalRequestTraceAtMs = options.finalRequestTraceAtMs;
    const finalTargetPage = options.finalTargetPage;

    return renderTrace.filter((entry) => {
        if (entry.event !== options.event) {
            return false;
        }
        const traceAtMs = readRenderTraceAtMs(entry);
        const page = readRenderTracePage(entry, options.pageKeys);
        return traceAtMs !== null
            && traceAtMs > finalRequestTraceAtMs
            && page !== null
            && page !== finalTargetPage;
    });
}

export function analyzeTraceFrames(samples: Array<Record<string, unknown>>): IFrameAnalysisSummary {
    let canvasObservedAtMs: number | null = null;
    let firstSkeletonAfterCanvasAtMs: number | null = null;
    const skeletonAfterCanvasPages = new Set<number>();

    for (const sample of samples) {
        const atMs = typeof sample.atMs === 'number' ? sample.atMs : 0;
        const canvasPages = Array.isArray(sample.canvasPages) ? sample.canvasPages : [];
        const skeletonPages = Array.isArray(sample.skeletonPages) ? sample.skeletonPages : [];

        if (canvasObservedAtMs !== null && skeletonPages.length > 0) {
            firstSkeletonAfterCanvasAtMs ??= atMs;
            for (const page of skeletonPages) {
                if (typeof page === 'number' && Number.isFinite(page)) {
                    skeletonAfterCanvasPages.add(page);
                }
            }
        }

        if (canvasObservedAtMs === null && canvasPages.length > 0) {
            canvasObservedAtMs = atMs;
        }
    }

    return {
        canvasObservedAtMs,
        firstSkeletonAfterCanvasAtMs,
        skeletonAfterCanvasObserved: firstSkeletonAfterCanvasAtMs !== null,
        skeletonAfterCanvasPages: Array.from(skeletonAfterCanvasPages),
    };
}

export function summarizeTrace(payload: {
    trace: {
        events?: unknown[];
        samples?: Array<Record<string, unknown>>;
    };
    renderTrace: Array<{
        event?: string;
        payload?: Record<string, unknown>;
    }>;
}): ITraceSummary {
    const samples = payload.trace.samples ?? [];
    const blankSamples = samples.filter(sample => Array.isArray(sample.blankVisiblePages) && sample.blankVisiblePages.length > 0);
    const skeletonSamples = samples.filter(sample => Array.isArray(sample.skeletonPages) && sample.skeletonPages.length > 0);
    const skeletonVisualOverlapSamples = samples.filter(sampleHasSkeletonVisualOverlap);
    const translucentSkeletonCanvasOverlapSamples = samples.filter(sampleHasTranslucentSkeletonCanvasOverlap);
    const maxBlankRunMs = summarizeSampleRuns(
        samples,
        sample => Array.isArray(sample.blankVisiblePages) && sample.blankVisiblePages.length > 0,
    ).maxRunMs;
    const maxCenteredBlankRunMs = summarizeSampleRuns(
        samples,
        sample => sampleHasCenteredBlank(sample),
    ).maxRunMs;

    const toolbarPages = uniqueNumbers(samples.map(sample => {
        return readToolbarPage(sample);
    }));
    const workspaceGoToPages = uniqueNumbers(payload.renderTrace
        .filter(entry => entry.event === 'workspace-go-to-page')
        .map(entry => entry.payload?.targetPage));
    const pagedTargets = uniqueNumbers(payload.renderTrace
        .filter(entry => entry.event === 'single-page-set-paged-target')
        .map(entry => entry.payload?.targetPage));
    const rasterSchedulerSnapshots = payload.renderTrace
        .filter(entry => entry.event === 'raster-scheduler-snapshot')
        .map(entry => entry.payload?.scheduler)
        .filter(snapshot => (
            typeof snapshot === 'object' && snapshot !== null
        ));
    const finalTargetPage = workspaceGoToPages.at(-1) ?? toolbarPages.at(-1) ?? pagedTargets.at(-1) ?? null;
    const lastClickAtMs = getLastEventAtMs(payload.trace.events ?? [], ['toolbar-button-click'])
        ?? getLastEventAtMs(payload.trace.events ?? [], ['after-next-click']);
    const centeredBlankAfterClick = lastClickAtMs === null
        ? {
            firstSample: null,
            maxRunMs: 0,
        }
        : summarizeSampleRuns(
            samples,
            sample => sampleHasCenteredBlank(sample),
            {
                minimumAtMs: lastClickAtMs + POST_CLICK_INTERMEDIATE_VISUAL_GRACE_MS,
                skipInvalidTimes: true,
            },
        );
    const finalRequestTraceAtMs = getFinalRequestTraceAtMs(payload.renderTrace, finalTargetPage);
    const nonFinalPagedCommitsAfterFinalRequest = getNonFinalRenderTraceEventsAfterFinalRequest(
        payload.renderTrace,
        {
            event: 'single-page-paged-target-committed',
            finalRequestTraceAtMs,
            finalTargetPage,
            pageKeys: ['targetPage'],
        },
    );
    const nonFinalWorkspacePageAcceptsAfterFinalRequest = getNonFinalRenderTraceEventsAfterFinalRequest(
        payload.renderTrace,
        {
            event: 'workspace-viewer-current-page-update-accepted',
            finalRequestTraceAtMs,
            finalTargetPage,
            pageKeys: ['page'],
        },
    );
    const intermediateVisualAfterClick = finalTargetPage === null || lastClickAtMs === null
        ? {
            firstSample: null,
            maxRunMs: 0,
            sampleCount: 0,
        }
        : summarizeSampleRuns(
            samples,
            (sample) => {
                const page = sampleHasCenteredVisualReadyPage(sample);
                return page !== null && page !== finalTargetPage ? page : null;
            },
            {
                minimumAtMs: lastClickAtMs + POST_CLICK_INTERMEDIATE_VISUAL_GRACE_MS,
                skipInvalidTimes: true,
            },
        );
    const bodyVisualReadySample = finalTargetPage === null
        ? null
        : samples.find(sample => sampleHasCenteredVisualForPage(sample, finalTargetPage)) ?? null;
    const bodyVisualReadyAtMs = bodyVisualReadySample
        ? readFiniteNumber(bodyVisualReadySample.atMs)
        : null;
    const bodyCanvasReadySample = finalTargetPage === null
        ? null
        : samples.find(sample => sampleHasCenteredCanvasForPage(sample, finalTargetPage)) ?? null;
    const bodyCanvasReadyAtMs = bodyCanvasReadySample
        ? readFiniteNumber(bodyCanvasReadySample.atMs)
        : null;

    const toolbarAheadOfBodySamples = samples.filter(sample => {
        const toolbarPage = readToolbarPage(sample);
        return toolbarPage !== null
            && !sampleHasFeedbackForPage(sample, toolbarPage);
    });

    const maxToolbarBodyLagMs = summarizeSampleRuns(samples, (sample) => {
        const toolbarPage = readToolbarPage(sample);
        return toolbarPage !== null && !sampleHasFeedbackForPage(sample, toolbarPage);
    }).maxRunMs;

    const pagesSeenWithVisual = new Set<number>();
    const skeletonAfterVisualSamples: Array<Record<string, unknown>> = [];
    for (const sample of samples) {
        if (sampleHasSkeletonAfterVisual(sample, pagesSeenWithVisual)) {
            skeletonAfterVisualSamples.push(sample);
        }
        for (const pageInfo of readVisiblePages(sample)) {
            const page = readFiniteNumber(pageInfo.page);
            if (page !== null && pageInfo.visualReady === true) {
                pagesSeenWithVisual.add(page);
            }
        }
    }

    const postReadySamples = bodyVisualReadyAtMs === null
        ? []
        : samples.filter(sample => (readFiniteNumber(sample.atMs) ?? 0) > bodyVisualReadyAtMs + 100);
    const postReadyUnstableSamples = postReadySamples.filter(sample => {
        const centeredVisualPage = readCenteredVisualPage(sample);
        const hasCenteredFinalTarget = finalTargetPage !== null && centeredVisualPage === finalTargetPage;
        return (
            (
                !hasCenteredFinalTarget
                && sampleHasCenteredBlank(sample)
            )
            || sampleHasCenteredSkeleton(sample)
            || (
                finalTargetPage !== null
                && centeredVisualPage !== null
                && centeredVisualPage !== finalTargetPage
            )
        );
    });
    const targetCanvasRegressionSamples = finalTargetPage === null || bodyCanvasReadyAtMs === null
        ? []
        : samples.filter(sample => {
            const atMs = readFiniteNumber(sample.atMs) ?? 0;
            return atMs > bodyCanvasReadyAtMs + 100
                && readCenteredVisualPage(sample) === finalTargetPage
                && !sampleHasCanvasForPage(sample, finalTargetPage);
        });
    const targetFeedbackGeometry = getTargetFeedbackGeometrySummary({
        finalTargetPage,
        samples,
    });
    const outgoingVisualGeometry = getOutgoingVisualGeometrySummary({
        clickAtMs: lastClickAtMs,
        finalTargetPage,
        samples,
    });
    let latePostClickSwapCount = 0;
    let previousPostReadySignature: string | null = null;
    let firstLatePostClickSwapSample: Record<string, unknown> | null = null;
    for (const sample of postReadySamples) {
        const signature = readTargetBodySignature(sample, finalTargetPage);
        if (
            previousPostReadySignature !== null
            && signature.length > 0
            && signature !== previousPostReadySignature
            && (lastClickAtMs === null || (readFiniteNumber(sample.atMs) ?? 0) > lastClickAtMs)
        ) {
            latePostClickSwapCount += 1;
            firstLatePostClickSwapSample ??= sample;
        }
        if (signature.length > 0) {
            previousPostReadySignature = signature;
        }
    }

    return {
        bodyCanvasReadyAtMs,
        bodyVisualReadyAtMs,
        blankSampleCount: blankSamples.length,
        finalTargetPage,
        frameAnalysis: analyzeTraceFrames(samples),
        firstBlankSample: blankSamples[0] ?? null,
        firstCenteredBlankSample: samples.find(sampleHasCenteredBlank) ?? null,
        firstCenteredBlankAfterClickSample: centeredBlankAfterClick.firstSample,
        firstIntermediateVisualAfterClickSample: intermediateVisualAfterClick.firstSample,
        firstLatePostClickSwapSample,
        firstNonFinalPagedCommitAfterFinalRequest: nonFinalPagedCommitsAfterFinalRequest[0] ?? null,
        firstNonFinalWorkspacePageAcceptAfterFinalRequest: nonFinalWorkspacePageAcceptsAfterFinalRequest[0] ?? null,
        firstOutgoingVisualGeometryMismatchSample: outgoingVisualGeometry.firstMismatchSample,
        firstSkeletonAfterVisualSample: skeletonAfterVisualSamples[0] ?? null,
        firstTranslucentSkeletonCanvasOverlapSample: translucentSkeletonCanvasOverlapSamples[0] ?? null,
        firstSkeletonVisualOverlapSample: skeletonVisualOverlapSamples[0] ?? null,
        firstTargetCanvasRegressionSample: targetCanvasRegressionSamples[0] ?? null,
        firstTargetFeedbackGeometryMismatchSample: targetFeedbackGeometry.firstMismatchSample,
        firstToolbarAheadOfBodySample: toolbarAheadOfBodySamples[0] ?? null,
        finalRequestTraceAtMs,
        intermediateVisualAfterClickSampleCount: intermediateVisualAfterClick.sampleCount,
        lastClickAtMs,
        latePostClickSwapCount,
        maxBlankRunMs,
        maxCenteredBlankAfterClickRunMs: centeredBlankAfterClick.maxRunMs,
        maxCenteredBlankRunMs,
        maxIntermediateVisualAfterClickRunMs: intermediateVisualAfterClick.maxRunMs,
        maxToolbarBodyLagMs,
        nonFinalPagedCommitAfterFinalRequestCount: nonFinalPagedCommitsAfterFinalRequest.length,
        nonFinalWorkspacePageAcceptAfterFinalRequestCount: nonFinalWorkspacePageAcceptsAfterFinalRequest.length,
        outgoingPage: outgoingVisualGeometry.outgoingPage,
        outgoingVisualGeometryBaselineFound: outgoingVisualGeometry.baselineFound,
        outgoingVisualGeometryHeightDeltaPx: outgoingVisualGeometry.maxHeightDeltaPx,
        outgoingVisualGeometrySampleCount: outgoingVisualGeometry.sampleCount,
        outgoingVisualGeometryWidthDeltaPx: outgoingVisualGeometry.maxWidthDeltaPx,
        postReadyUnstableSampleCount: postReadyUnstableSamples.length,
        rasterSchedulerSnapshots,
        skeletonAfterVisualSampleCount: skeletonAfterVisualSamples.length,
        skeletonSampleCount: skeletonSamples.length,
        translucentSkeletonCanvasOverlapSampleCount: translucentSkeletonCanvasOverlapSamples.length,
        skeletonVisualOverlapSampleCount: skeletonVisualOverlapSamples.length,
        targetCanvasRegressionSampleCount: targetCanvasRegressionSamples.length,
        targetFeedbackHeightDeltaPx: targetFeedbackGeometry.maxHeightDeltaPx,
        targetFeedbackGeometrySampleCount: targetFeedbackGeometry.sampleCount,
        targetFeedbackWidthDeltaPx: targetFeedbackGeometry.maxWidthDeltaPx,
        toolbarAheadOfBodySampleCount: toolbarAheadOfBodySamples.length,
        toolbarPages,
        workspaceGoToPages,
        pagedTargets,
    };
}

function createVideoCapturePayload(videoCapture: IDiagnosticFrameCaptureResult | null) {
    if (!videoCapture) {
        return {
            enabled: false,
            artifactPaths: null,
            capture: null,
        };
    }

    return {
        enabled: true,
        artifactPaths: {
            contactSheet: videoCapture.contactSheetPath,
            framesDir: videoCapture.framesDir,
            mp4: videoCapture.mp4Path,
            outDir: videoCapture.outDir,
        },
        capture: videoCapture,
    };
}

export function createPdfNavigationBlinkScenario(options = readOptions()) {
    const outPath = resolve(process.cwd(), options.out);
    return {
        name: 'pdf-blink-trace',
        pdfPath: options.pdf,
        fixtureError: `PDF navigation blink trace fixture not found: ${options.pdf}`,
        openTimeoutMs: 120_000,
        diagnostics: {
            navigation: true,
            render: true,
        },
        prepare: async ({page}: IPdfDiagnosticsContext) => {
            await page.setViewport({
                deviceScaleFactor: options.viewportDeviceScaleFactor,
                height: options.viewportHeight,
                width: options.viewportWidth,
            });
        },
        run: async (context: IPdfDiagnosticsContext) => {
            const { page } = context;
            await installBlinkSampler(page);
            await configureFitHeightMode(page, options.scrollMode);
            await goToStartPage(page, options.startPage);
            await configureFitHeightMode(page, options.scrollMode);
            await waitForToolbarPage(page, options.startPage);
            const observedScrollMode = await page.evaluate(() =>
                (window as IWorkspaceExposeProbeWindow).__evbTestApi?.getActiveToolbarSnapshot()?.continuousScroll === true
                    ? 'continuous' : 'paged');
            if (options.waitForStartCanvas) {
                await context.navigation.waitForPageCanvas(options.startPage);
            }

            const videoRecorder = options.video
                ? await context.capture.start({
                    fps: options.videoFps,
                    outDir: resolveVideoDirectory(options),
                })
                : null;
            await page.evaluate(() => {
                const traceWindow = window as Window & { __startPdfBlinkTrace?: () => void; };
                traceWindow.__startPdfBlinkTrace?.();
            });
            await recordTraceEvent(page, 'scenario-start', {
                options,
                wallTimeMs: Date.now(),
            });
            await delay(options.preClickWaitMs);
            const toolbarButtonLabel = options.direction === 'previous' ? 'Previous Page' : 'Next Page';
            for (let index = 0; index < options.clicks; index += 1) {
                await recordTraceEvent(page, 'before-next-click', { index });
                const clickResult = await context.navigation.clickToolbarButton(toolbarButtonLabel);
                await recordTraceEvent(page, 'after-next-click', {
                    index,
                    clickResult,
                });
                await delay(options.clickDelayMs);
            }
            await recordTraceEvent(page, 'click-burst-end', {
                clicks: options.clicks,
                wallTimeMs: Date.now(),
            });
            await delay(options.settleMs);
            const trace = await page.evaluate(() => {
                const traceWindow = window as Window & { __stopPdfBlinkTrace?: () => unknown; };
                return traceWindow.__stopPdfBlinkTrace?.() ?? null;
            });
            const videoCapture = videoRecorder ? await videoRecorder.stop() : null;
            const navLog = await context.trace.collectNavigation();
            const renderTrace = await context.trace.collectRender() as Array<{
                event?: string;
                payload?: Record<string, unknown>;
            }>;
            const payload = {
                createdAt: new Date().toISOString(),
                configuration: {
                    requestedScrollMode: options.scrollMode,
                    observedScrollMode,
                },
                options,
                trace,
                navLog,
                renderTrace,
                video: createVideoCapturePayload(videoCapture),
                summary: summarizeTrace({
                    trace: trace ?? {},
                    renderTrace,
                }),
            };
            context.artifacts.writeJson(outPath, payload);
            console.log(`Wrote ${outPath}`);
            console.log(JSON.stringify(payload.summary, null, 2));
            if (options.assert) {
                assertPdfNavigationBlinkTraceSummary(payload.summary);
            }
        },
    };
}

const main = () => runPdfDiagnosticScenario(createPdfNavigationBlinkScenario());

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main();
}
