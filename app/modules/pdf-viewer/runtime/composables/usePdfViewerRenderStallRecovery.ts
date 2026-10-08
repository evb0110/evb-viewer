import type {
    ComputedRef,
    Ref,
} from 'vue';
import {clamp} from 'es-toolkit/math';
import {BrowserLogger} from '@app/utils/browserLogger';
import type {TPdfSource} from '@app/types/pdfUi';
import type {IPageRenderStallPayload} from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';

interface IUsePdfViewerRenderStallRecoveryOptions {
    src: ComputedRef<TPdfSource | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number
    }>;
    viewerContainer: Ref<HTMLElement | null>;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => unknown;
}

/**
 * Reports a page render that made no progress for its stall window.
 *
 * The raster scheduler that owns the render has already cancelled that one
 * task; it retries the page with backoff while the page is still wanted and
 * reports the final outcome. Recovery here used to cancel every render in the
 * viewport and start a replacement pass, which made the scheduler's retry
 * stale and could settle without pixels, leaving the page blank for good.
 */
export const usePdfViewerRenderStallRecovery = (options: IUsePdfViewerRenderStallRecoveryOptions) => {
    let pendingInvalidation: number[] | null = null;

    function resetRenderStallRecoveryState() {
        pendingInvalidation = null;
    }

    function invalidatePages(pages: number[]) {
        pendingInvalidation = [...new Set([
            ...(pendingInvalidation ?? []),
            ...pages,
        ])];
    }

    function handlePageRenderStall(payload: IPageRenderStallPayload) {
        if (!options.src.value) {
            return;
        }
        const upperBound = Math.max(1, options.numPages.value || payload.pageNumber);
        BrowserLogger.warn('pdf-renderer', 'PDF page render made no progress; the scheduler retries it', {
            page: clamp(payload.pageNumber, 1, upperBound),
            stage: payload.stage,
            timeoutMs: payload.timeoutMs,
            currentPage: options.currentPage.value,
            visibleRange: options.visibleRange.value,
            viewer: options.summarizeViewerMetricsForLog(options.viewerContainer.value),
        });
    }

    return {
        resetRenderStallRecoveryState,
        invalidatePages,
        handlePageRenderStall,
    };
};
