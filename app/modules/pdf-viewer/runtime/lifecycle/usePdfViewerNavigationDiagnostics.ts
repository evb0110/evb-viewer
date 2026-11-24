import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TPdfViewMode } from '@app/types/pdfContracts';
import type { IPageRange } from '@app/types/pdfUi';
import type { IPdfRasterSchedulerSnapshot } from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import { BrowserLogger } from '@app/utils/browserLogger';
import { logPdfNav } from '@app/utils/logPdfNav';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';


interface IUsePdfViewerNavigationDiagnosticsOptions {
    currentPage: Ref<number>;
    visibleRange: Ref<IPageRange>;
    isLoading: Ref<boolean>;
    continuousScroll: ComputedRef<boolean>;
    fitMode: ComputedRef<string>;
    viewMode: ComputedRef<TPdfViewMode>;
    zoom: ComputedRef<number>;
    navigationAnchorWindow: ComputedRef<unknown>;
    virtualizedContinuousMode: ComputedRef<boolean>;
    virtualWindowStart: ComputedRef<number>;
    virtualWindowEnd: ComputedRef<number>;
    searchNavigationTargetPage: Ref<number | null>;
    searchNavigationState: Ref<string>;
    getRasterSchedulerSnapshot: () => IPdfRasterSchedulerSnapshot | null;
    summarizeViewerStateForLog: () => unknown;
}

type TNavigationDiagnosticSnapshot = readonly [boolean, number, number, number, number, number, number | null, string];
type TViewerDiagnosticSnapshot = readonly [number, number, number, boolean];

export const usePdfViewerNavigationDiagnostics = (options: IUsePdfViewerNavigationDiagnosticsOptions) => {
    watch(
        () => [
            !!options.navigationAnchorWindow.value,
            options.virtualWindowStart.value,
            options.virtualWindowEnd.value,
            options.currentPage.value,
            options.visibleRange.value.start,
            options.visibleRange.value.end,
            options.searchNavigationTargetPage.value,
            options.searchNavigationState.value,
        ] as const,
        (snapshot: TNavigationDiagnosticSnapshot) => {
            const anchored = snapshot[0];
            const start = snapshot[1];
            const end = snapshot[2];
            const page = snapshot[3];
            const visibleStart = snapshot[4];
            const visibleEnd = snapshot[5];
            const searchAnchorPage = snapshot[6];
            const searchNavigationState = snapshot[7];

            if (!options.virtualizedContinuousMode.value) {
                return;
            }
            if (searchNavigationState === 'idle') {
                return;
            }

            logPdfNav(
                `[PDF-NAV] virtualWindow anchored=${anchored}`
                + ` start=${start} end=${end} currentPage=${page}`
                + ` visibleRange=${visibleStart}-${visibleEnd}`
                + ` searchAnchor=${searchAnchorPage ?? 'none'}`
                + ` searchState=${searchNavigationState}`,
            );
        },
    );

    watch(options.currentPage, (next, previous) => {
        if (next === previous) {
            return;
        }
        BrowserLogger.diagnostic('pdf-nav', `[viewer-current-page-ref] ${previous}->${next}`, {
            previous,
            next,
            isLoading: options.isLoading.value,
            continuousScroll: options.continuousScroll.value,
            fitMode: options.fitMode.value,
            viewMode: options.viewMode.value,
            zoom: options.zoom.value,
            visibleRange: {
                start: options.visibleRange.value.start,
                end: options.visibleRange.value.end,
            },
            viewer: options.summarizeViewerStateForLog(),
        });
    });

    watch(
        () => [
            options.visibleRange.value.start,
            options.visibleRange.value.end,
        ] as const,
        (nextSnapshot, previousSnapshot) => {
            const nextStart = nextSnapshot[0];
            const nextEnd = nextSnapshot[1];
            const prevStart = previousSnapshot[0];
            const prevEnd = previousSnapshot[1];

            if (nextStart === prevStart && nextEnd === prevEnd) {
                return;
            }
            BrowserLogger.diagnostic('pdf-nav', `[viewer-visible-range] ${prevStart}-${prevEnd} -> ${nextStart}-${nextEnd}`, {
                previous: {
                    start: prevStart,
                    end: prevEnd,
                },
                next: {
                    start: nextStart,
                    end: nextEnd,
                },
                currentPage: options.currentPage.value,
                isLoading: options.isLoading.value,
                continuousScroll: options.continuousScroll.value,
                viewer: options.summarizeViewerStateForLog(),
            });
        },
    );

    watch(
        () => [
            options.currentPage.value,
            options.visibleRange.value.start,
            options.visibleRange.value.end,
            options.isLoading.value,
        ] as const,
        (snapshot: TViewerDiagnosticSnapshot, previous?: TViewerDiagnosticSnapshot) => {
            if (
                previous
                && snapshot[0] === previous[0]
                && snapshot[1] === previous[1]
                && snapshot[2] === previous[2]
                && snapshot[3] === previous[3]
            ) {
                return;
            }
            logPdfRenderTrace('raster-scheduler-snapshot', () => ({
                currentPage: snapshot[0],
                visibleRange: {
                    start: snapshot[1],
                    end: snapshot[2],
                },
                scheduler: options.getRasterSchedulerSnapshot(),
            }));
        },
        {immediate: true},
    );
};
