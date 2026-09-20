import type { Ref } from 'vue';
import type { IAnalyticsDocumentScope } from '@app/composables/useAnalytics';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import type {
    IDocumentNavigationRequest,
    IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/public';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TPdfViewMode } from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import { bucketPageCount } from '@app/utils/analytics';
import { emitAutomationEvent } from '@app/modules/workspace-shell/automation/automationReadinessEvents';

export interface IWorkspacePageUpdateOutcome {
    accepted: boolean;
    navigationSource: IDocumentNavigationRequest['source'] | null;
}

interface IWorkspaceViewerUpdateOptions {
    analytics: IAnalyticsDocumentScope;
    tabId: string;
    pdfSrc: Ref<TPdfSource | null>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<unknown>;
    isLoading: Ref<boolean>;
    continuousScroll: Ref<boolean>;
    fitMode: Ref<unknown>;
    viewMode: Ref<TPdfViewMode>;
    zoom: Ref<number>;
    viewerRef: Ref<IDocumentViewerExpose | null>;
    openSurface?: IDocumentOpenSurfaceSession | undefined;
}

export function createWorkspaceViewerUpdateHandlers(options: IWorkspaceViewerUpdateOptions) {
    function handleTotalPages(value: number) {
        if (value === 0 && Boolean(options.pdfSrc.value)) {
            return;
        }
        options.totalPages.value = value;
        if (value > 0) options.analytics.merge({
            pageCountBucket: bucketPageCount(value),
            totalPages: value,
        });
    }

    function handleCurrentPage(page: number) {
        const previousPage = options.currentPage.value;
        const viewer = options.viewerRef.value?.getViewerContainer?.() ?? null;
        const shared = {
            previousPage,
            sidebarOpen: options.showSidebar.value,
            sidebarTab: options.sidebarTab.value,
            totalPages: options.totalPages.value,
            isLoading: options.isLoading.value,
            continuousScroll: options.continuousScroll.value,
            fitMode: options.fitMode.value,
            viewMode: options.viewMode.value,
            zoom: options.zoom.value,
            viewerScrollTop: viewer ? Math.round(viewer.scrollTop) : null,
            viewerScrollLeft: viewer ? Math.round(viewer.scrollLeft) : null,
        };
        const ticket = options.openSurface?.navigationTicket.value ?? null;
        const observedPage = options.openSurface?.observeViewportPage(page) ?? page;
        const outcome: IWorkspacePageUpdateOutcome = {
            accepted: true,
            navigationSource: ticket?.request.source ?? null,
        };
        options.currentPage.value = observedPage;
        BrowserLogger.diagnostic('pdf-nav', `[workspace-page-update] viewer->workspace ${previousPage}->${page}`, {
            ...shared,
            nextPage: observedPage,
            changed: observedPage !== previousPage,
        });
        void nextTick().then(() => emitAutomationEvent('navigation-idle', {
            navigationSource: outcome.navigationSource,
            page: observedPage,
            previousPage,
            tabId: options.tabId,
            totalPages: options.totalPages.value,
        }));
    }

    return {
        handleCurrentPage,
        handleTotalPages,
    };
}
