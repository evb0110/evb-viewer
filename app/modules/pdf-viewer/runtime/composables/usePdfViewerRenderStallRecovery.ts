import { getErrorMessage } from '@app/utils/error';
import type {
    ComputedRef,
    Ref,
} from 'vue';
import {clamp} from 'es-toolkit/math';
import {BrowserLogger} from '@app/utils/browserLogger';
import type {TPdfSource} from '@app/types/pdfUi';
import type {IPageRenderStallPayload} from '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer';
import type {IPdfRenderSupervisor} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';

interface IUsePdfViewerRenderStallRecoveryOptions {
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    isAnySaving?: Ref<boolean> | undefined;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<{
        start: number;
        end: number
    }>;
    viewerContainer: Ref<HTMLElement | null>;
    summarizeViewerMetricsForLog: (container: HTMLElement | null) => unknown;
    cancelInFlightPageRenders?: (() => Promise<void> | void) | undefined;
    renderVisiblePages: (
        range: {
            start: number;
            end: number
        },
        options?: {
            preserveRenderedPages?: boolean;
            forceRerender?: boolean;
            bufferOverride?: number;
        },
    ) => Promise<void>;
    scheduleReload: (isReload?: boolean) => void;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
}

/** A bounded heartbeat recovery boundary for a page render that stopped making progress. */
export const usePdfViewerRenderStallRecovery = (options: IUsePdfViewerRenderStallRecoveryOptions) => {
    let pendingInvalidation: number[] | null = null;
    const trippedPages = new Set<number>();

    function resetRenderStallRecoveryState() {
        pendingInvalidation = null;
        trippedPages.clear();
    }

    function invalidatePages(pages: number[]) {
        pendingInvalidation = [...new Set([
            ...(pendingInvalidation ?? []),
            ...pages,
        ])];
    }

    function consumePendingInvalidation() {
        const pages = pendingInvalidation;
        pendingInvalidation = null;
        return pages;
    }

    function handlePageRenderStall(payload: IPageRenderStallPayload) {
        if (!options.src.value || options.isLoading.value || options.isAnySaving?.value) {
            return;
        }
        const upperBound = Math.max(1, options.numPages.value || payload.pageNumber);
        const page = clamp(payload.pageNumber, 1, upperBound);
        if (trippedPages.has(page)) {
            return;
        }
        trippedPages.add(page);
        invalidatePages([page]);
        void options.cancelInFlightPageRenders?.();
        BrowserLogger.warn('pdf-renderer', 'PDF render heartbeat circuit breaker tripped', {
            page,
            stage: payload.stage,
            timeoutMs: payload.timeoutMs,
            currentPage: options.currentPage.value,
            visibleRange: options.visibleRange.value,
            viewer: options.summarizeViewerMetricsForLog(options.viewerContainer.value),
        });
        const range = {
            start: page,
            end: page,
        };
        void options.renderVisiblePages(range, {
            preserveRenderedPages: true,
            forceRerender: true,
            bufferOverride: 0,
        }).then(() => {
            trippedPages.delete(page);
        }).catch((error: unknown) => {
            BrowserLogger.warn('pdf-renderer', 'PDF render heartbeat recovery failed; reloading source', {
                page,
                error: getErrorMessage(error),
            });
            options.scheduleReload(true);
        });
    }

    return {
        clearRenderStallRecoveryTimer: () => undefined,
        resetRenderStallRecoveryState,
        invalidatePages,
        consumePendingInvalidation,
        handlePageRenderStall,
    };
};
