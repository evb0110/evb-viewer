import type {
    ComputedRef,
    Ref,
} from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IWorkspaceRestoreTrackerLike } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';

interface IPageTransitionHistoryEntry {
    at: number;
    page: number;
}

interface IUseDocumentWorkspaceRestoreStateOptions {
    tabId: string;
    workspaceRestoreTracker: IWorkspaceRestoreTrackerLike;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<unknown>;
    isResizingSidebar: Ref<boolean>;
    isLoading: Ref<boolean>;
    continuousScroll: Ref<boolean>;
    fitMode: Ref<unknown>;
    viewMode: Ref<unknown>;
    zoom: Ref<number>;
    documentViewerRef: Ref<{ getViewerContainer?: () => HTMLElement | null; } | null>;
    initFromStorage: () => void;
    cleanupSidebarResizeListeners: () => void;
    currentPageTransitionHistory: Ref<IPageTransitionHistoryEntry[]>;
}

type TWorkspaceViewControlSnapshot = readonly [unknown, unknown, boolean, number];

/**
 * A workspace mount's restore state and navigation diagnostics: whether a
 * cross-window transfer is still restoring into this tab, plus the page,
 * sidebar and view-control traces that explain navigation reports.
 */
export const useDocumentWorkspaceRestoreState = (options: IUseDocumentWorkspaceRestoreStateOptions): {isExternallyRestoring: ComputedRef<boolean>} => {
    const isExternallyRestoring = computed(() => options.workspaceRestoreTracker.has(options.tabId));

    function pushPageTransitionHistory(entry: IPageTransitionHistoryEntry, now: number) {
        const history = options.currentPageTransitionHistory.value;
        history.push(entry);

        let writeIndex = 0;
        for (const candidate of history) {
            if (now - candidate.at <= 2000) {
                history[writeIndex] = candidate;
                writeIndex += 1;
            }
        }

        const keepFrom = Math.max(0, writeIndex - 8);
        if (keepFrom > 0) {
            history.copyWithin(0, keepFrom, writeIndex);
            writeIndex -= keepFrom;
        }
        history.length = writeIndex;
    }

    onMounted(() => {
        options.initFromStorage();
    });

    watch(options.showSidebar, (next, previous) => {
        if (next === previous) {
            return;
        }
        const viewer = options.documentViewerRef.value?.getViewerContainer?.() ?? null;
        BrowserLogger.diagnostic('pdf-nav', `[workspace-sidebar] ${previous ? 'open' : 'closed'} -> ${next ? 'open' : 'closed'}`, {
            previous,
            next,
            currentPage: options.currentPage.value,
            sidebarTab: options.sidebarTab.value,
            isResizingSidebar: options.isResizingSidebar.value,
            totalPages: options.totalPages.value,
            isLoading: options.isLoading.value,
            viewerScrollTop: viewer ? Math.round(viewer.scrollTop) : null,
        });
    });

    watch(options.currentPage, (next, previous) => {
        if (next === previous) {
            return;
        }
        const viewer = options.documentViewerRef.value?.getViewerContainer?.() ?? null;
        BrowserLogger.diagnostic('pdf-nav', `[workspace-page-ref] ${previous}->${next}`, {
            previous,
            next,
            sidebarOpen: options.showSidebar.value,
            sidebarTab: options.sidebarTab.value,
            isLoading: options.isLoading.value,
            continuousScroll: options.continuousScroll.value,
            fitMode: options.fitMode.value,
            viewMode: options.viewMode.value,
            zoom: options.zoom.value,
            viewerScrollTop: viewer ? Math.round(viewer.scrollTop) : null,
            viewerScrollLeft: viewer ? Math.round(viewer.scrollLeft) : null,
        });

        const now = Date.now();
        pushPageTransitionHistory({
            page: next,
            at: now,
        }, now);

        const history: IPageTransitionHistoryEntry[] = options.currentPageTransitionHistory.value;
        if (history.length >= 3) {
            const last = history[history.length - 1];
            const mid = history[history.length - 2];
            const first = history[history.length - 3];
            if (!last || !mid || !first) {
                return;
            }
            const isBounce = first.page === last.page && first.page !== mid.page;
            if (isBounce) {
                BrowserLogger.diagnostic('pdf-nav', `[workspace-page-bounce] detected ${first.page}->${mid.page}->${last.page}`, {
                    history: history.map((entry) => ({
                        page: entry.page,
                        dtMs: now - entry.at,
                    })),
                    sidebarOpen: options.showSidebar.value,
                    sidebarTab: options.sidebarTab.value,
                    isResizingSidebar: options.isResizingSidebar.value,
                    fitMode: options.fitMode.value,
                    viewMode: options.viewMode.value,
                    continuousScroll: options.continuousScroll.value,
                    zoom: options.zoom.value,
                });
            }
        }
    });

    watch(
        () => [
            options.fitMode.value,
            options.viewMode.value,
            options.continuousScroll.value,
            options.zoom.value,
        ] as const,
        (nextSnapshot: TWorkspaceViewControlSnapshot, previousSnapshot: TWorkspaceViewControlSnapshot) => {
            const nextFit = nextSnapshot[0];
            const nextViewMode = nextSnapshot[1];
            const nextContinuous = nextSnapshot[2];
            const nextZoom = nextSnapshot[3];
            const prevFit = previousSnapshot[0];
            const prevViewMode = previousSnapshot[1];
            const prevContinuous = previousSnapshot[2];
            const prevZoom = previousSnapshot[3];

            if (
                nextFit === prevFit
                && nextViewMode === prevViewMode
                && nextContinuous === prevContinuous
                && nextZoom === prevZoom
            ) {
                return;
            }
            BrowserLogger.diagnostic('pdf-nav', 'DocumentWorkspace view controls changed', {
                fitMode: {
                    previous: prevFit,
                    next: nextFit,
                },
                viewMode: {
                    previous: prevViewMode,
                    next: nextViewMode,
                },
                continuousScroll: {
                    previous: prevContinuous,
                    next: nextContinuous,
                },
                zoom: {
                    previous: prevZoom,
                    next: nextZoom,
                },
                currentPage: options.currentPage.value,
                sidebarOpen: options.showSidebar.value,
            });
        },
    );

    onUnmounted(() => {
        options.cleanupSidebarResizeListeners();
    });

    return {isExternallyRestoring};
};
