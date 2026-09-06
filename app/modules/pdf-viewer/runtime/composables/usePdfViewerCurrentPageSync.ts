import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { Ref } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import {
    countBy,
    maxBy,
} from 'es-toolkit/array';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getVisiblePageDebugSnapshot } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getVisiblePageDebugSnapshot';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import { isAnchoredCurrentPageSyncSource } from '@app/modules/pdf-viewer/runtime/rerender-strategy/isAnchoredCurrentPageSyncSource';
import type { TZoomInteractionLockOperationId } from '@app/modules/pdf-viewer/runtime/zoom/pdfViewerZoomTypes';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

const CURRENT_PAGE_SYNC_SAMPLE_COUNT = 3;
export { summarizeViewerMetrics };

export interface ICurrentPageSyncOptions {
    source?: string;
    stabilize?: boolean;
    resizeAnchor?: IResizeAnchorContext | null;
    zoomGestureSessionId?: number | undefined;
    zoomLockOperationId?: TZoomInteractionLockOperationId | null;
    transactionId?: number | undefined;
}

export interface IResizeAnchorContext {
    capturedAtMs: number;
    page: number;
    transitionToken: number;
    visibleRange: {
        start: number;
        end: number;
    };
    viewerMetrics: ReturnType<typeof summarizeViewerMetrics>;
    semanticAnchor?: IPdfSemanticAnchor | null;
}

interface IUsePdfViewerCurrentPageSyncOptions {
    viewerContainer: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    currentPage: Ref<number>;
    pdfDocument: Ref<IPdfDocument | null>;
    isLoading: Ref<boolean>;
    getMostVisiblePage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    updateCurrentPage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    emitCurrentPage: (page: number) => void;
    canSyncCurrentPageFromViewport?: ((source: string) => boolean) | undefined;
    commitCurrentPageFromViewport?: ((
        page: number,
        context: {
            fallbackToCurrent: boolean;
            previousPage: number;
            samples: number[] | null;
            source: string;
        },
    ) => boolean) | undefined;
}

export const usePdfViewerCurrentPageSync = (options: IUsePdfViewerCurrentPageSyncOptions) => {
    const {
        viewerContainer,
        numPages,
        visibleRange,
        currentPage,
        pdfDocument,
        isLoading,
        getMostVisiblePage,
        updateCurrentPage,
        emitCurrentPage,
        canSyncCurrentPageFromViewport,
        commitCurrentPageFromViewport,
    } = options;

    let currentPageSyncRunId = 0;
    let currentPageEmitEventId = 0;

    function invalidateCurrentPageSync() {
        currentPageSyncRunId += 1;
    }

    function isCurrentPageSyncDocumentReady() {
        return Boolean(
            pdfDocument.value
            && !isLoading.value
            && numPages.value > 0,
        );
    }

    function summarizeViewerMetricsForLog(container: HTMLElement | null) {
        return summarizeViewerMetrics(container);
    }

    function summarizeVisiblePageSnapshotForLog(container: HTMLElement | null) {
        if (!container || !isCurrentPageSyncDocumentReady()) {
            return null;
        }
        return getVisiblePageDebugSnapshot(container, numPages.value, 8).map((entry) => ({
            pageNumber: entry.pageNumber,
            visibleHeight: Math.round(entry.visibleHeight),
            pageTop: Math.round(entry.pageTop),
            pageBottom: Math.round(entry.pageBottom),
            pageHeight: Math.round(entry.pageHeight),
        }));
    }

    function buildSyncSummaryLine(
        source: string,
        previous: number,
        next: number,
        changed: boolean,
        fallbackToCurrent: boolean,
        samples: number[] | null,
    ) {
        const sampleText = samples && samples.length > 0
            ? samples.join(',')
            : 'none';
        return `[sync] source=${source} prev=${previous} next=${next}`
            + ` changed=${changed} fallback=${fallbackToCurrent}`
            + ` samples=${sampleText}`
            + ` range=${visibleRange.value.start}-${visibleRange.value.end}`;
    }

    function pickMostFrequentPage(pages: number[]) {
        const counts = countBy(pages, page => page);
        const winner = maxBy(pages, page => counts[page] ?? 0) ?? null;
        return {
            page: winner,
            count: winner === null ? 0 : (counts[winner] ?? 0),
        };
    }

    function emitCurrentPageIfChanged(
        page: number,
        source: string,
        samples: number[] | null,
        fallbackToCurrent: boolean,
        previousPage = currentPage.value,
    ) {
        const previous = previousPage;
        const changed = page !== previous;
        const hasSampleDrift = Boolean(samples && new Set(samples).size > 1);
        const shouldLog = changed || hasSampleDrift || fallbackToCurrent || source.includes('resize');
        const eventId = ++currentPageEmitEventId;
        logPdfRenderTrace('viewport-current-page-sync-resolved', () => ({
            source,
            eventId,
            previousPage: previous,
            nextPage: page,
            changed,
            fallbackToCurrent,
            samples,
            visibleRange: {...visibleRange.value},
        }));

        if (shouldLog) {
            BrowserLogger.diagnostic(
                'pdf-nav',
                `${buildSyncSummaryLine(source, previous, page, changed, fallbackToCurrent, samples)} eventId=${eventId}`,
                () => ({
                    source,
                    eventId,
                    previousPage: previous,
                    nextPage: page,
                    changed,
                    fallbackToCurrent,
                    samples,
                    currentVisibleRange: {
                        start: visibleRange.value.start,
                        end: visibleRange.value.end,
                    },
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                    visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
                    stack: (() => {
                        try {
                            return (new Error('viewport-current-page-sync'))
                                .stack
                                ?.split('\n')
                                .slice(1, 5)
                                .map(entry => entry.trim());
                        } catch {
                            return null;
                        }
                    })(),
                }),
            );
        }

        if (!changed) {
            return;
        }
        if (commitCurrentPageFromViewport) {
            commitCurrentPageFromViewport(page, {
                fallbackToCurrent,
                previousPage: previous,
                samples,
                source,
            });
            return;
        }
        emitCurrentPage(page);
    }

    function canAcceptViewportCurrentPage(source: string) {
        return canSyncCurrentPageFromViewport?.(source) ?? true;
    }

    async function resolveStableCurrentPageFromViewport(syncRunId: number, source: string) {
        const container = viewerContainer.value;
        if (!container || numPages.value <= 0) {
            return null;
        }

        const samples: number[] = [];
        for (
            let sampleIndex = 0;
            sampleIndex < CURRENT_PAGE_SYNC_SAMPLE_COUNT;
            sampleIndex += 1
        ) {
            if (syncRunId !== currentPageSyncRunId || !isCurrentPageSyncDocumentReady()) {
                return null;
            }
            const sampledPage = getMostVisiblePage(container, numPages.value);
            samples.push(sampledPage);
            BrowserLogger.diagnostic(
                'pdf-nav',
                `[sync-sample] source=${source} run=${syncRunId}`
                + ` sample=${sampleIndex + 1}/${CURRENT_PAGE_SYNC_SAMPLE_COUNT}`
                + ` page=${sampledPage}`,
                () => ({
                    source,
                    syncRunId,
                    sampleIndex,
                    sampledPage,
                    currentPage: currentPage.value,
                    visibleRange: {
                        start: visibleRange.value.start,
                        end: visibleRange.value.end,
                    },
                    viewer: summarizeViewerMetricsForLog(container),
                    visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(container),
                }),
            );
            if (sampleIndex + 1 < CURRENT_PAGE_SYNC_SAMPLE_COUNT) {
                await nextTick();
                await waitForVisualFrames();
                if (syncRunId !== currentPageSyncRunId || !isCurrentPageSyncDocumentReady()) {
                    return null;
                }
            }
        }

        const picked = pickMostFrequentPage(samples);
        if (picked.page === null) {
            return null;
        }

        if (picked.count <= 1) {
            return {
                page: currentPage.value,
                samples,
                fallbackToCurrent: true,
            };
        }

        return {
            page: picked.page,
            samples,
            fallbackToCurrent: false,
        };
    }

    async function syncCurrentPageFromViewport(options: ICurrentPageSyncOptions = {}) {
        if (!isCurrentPageSyncDocumentReady()) {
            return;
        }

        const source = options.source ?? 'default';
        if (!canAcceptViewportCurrentPage(source)) {
            return;
        }

        const syncRunId = ++currentPageSyncRunId;
        const resizeAnchor = options.resizeAnchor;
        if (resizeAnchor && isAnchoredCurrentPageSyncSource(source)) {
            if (!canAcceptViewportCurrentPage(source)) {
                return;
            }
            BrowserLogger.diagnostic(
                'pdf-nav',
                `[anchor] fixed current-page sync source=${source}`
                + ` page=${resizeAnchor.page}`
                + ` token=${resizeAnchor.transitionToken}`,
                () => ({
                    source,
                    page: resizeAnchor.page,
                    transitionToken: resizeAnchor.transitionToken,
                    capturedAtMs: resizeAnchor.capturedAtMs,
                    capturedVisibleRange: resizeAnchor.visibleRange,
                    capturedViewerMetrics: resizeAnchor.viewerMetrics,
                    viewer: summarizeViewerMetricsForLog(viewerContainer.value),
                    visiblePageSnapshot: summarizeVisiblePageSnapshotForLog(viewerContainer.value),
                }),
            );
            emitCurrentPageIfChanged(
                resizeAnchor.page,
                `${source}:anchor-fixed`,
                null,
                false,
            );
            return;
        }
        if (options.stabilize) {
            const stablePage = await resolveStableCurrentPageFromViewport(syncRunId, source);
            if (
                !stablePage
                || syncRunId !== currentPageSyncRunId
                || !isCurrentPageSyncDocumentReady()
                || !canAcceptViewportCurrentPage(source)
            ) {
                return;
            }

            emitCurrentPageIfChanged(
                stablePage.page,
                source,
                stablePage.samples,
                stablePage.fallbackToCurrent,
            );
            return;
        }

        const previousPage = currentPage.value;
        if (!canAcceptViewportCurrentPage(source)) {
            return;
        }
        const page = updateCurrentPage(viewerContainer.value, numPages.value);
        emitCurrentPageIfChanged(page, source, null, false, previousPage);
    }

    watch(
        () => [
            pdfDocument.value,
            isLoading.value,
            numPages.value,
        ] as const,
        invalidateCurrentPageSync,
        { flush: 'sync' },
    );

    tryOnScopeDispose(invalidateCurrentPageSync);

    return {
        summarizeViewerMetricsForLog,
        summarizeVisiblePageSnapshotForLog,
        syncCurrentPageFromViewport,
    };
};
