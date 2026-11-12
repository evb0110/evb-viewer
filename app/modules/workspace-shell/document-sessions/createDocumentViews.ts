import type { Ref } from 'vue';
import {
    getPageIdentityDeltaNextPageCount,
    mapPageNumberThroughPageIdentityDelta,
    type IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    createPdfReloadWaiter,
    resolvePdfReloadPage,
    type usePageContextMenu,
} from '@app/modules/pdf-viewer/public';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { useWorkspaceViewerShellState } from '@app/modules/workspace-shell/composables/useWorkspaceViewerShellState';
import type { useWorkspaceSearchSidebar } from '@app/modules/workspace-shell/composables/useWorkspaceSearchSidebar';
import type {
    IWorkspaceDocumentController,
    IWorkspaceOpenRequest,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import {
    finishOpeningReader,
    followOpeningReader,
} from '@app/modules/workspace-shell/document-sessions/recentReadingView';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TAnnotationTool } from '@app/types/annotations';

export type TViewShellState = ReturnType<typeof useWorkspaceViewerShellState>;

/** What a mounted view lends its document: its parts the document resets or keeps in place. */
export interface IDocumentViewPort {
    tabId: string;
    isActive: Readonly<Ref<boolean>>;
    openSurface: IDocumentOpenSurfaceSession;
    runDocumentOpen: (request: IWorkspaceOpenRequest, run: () => Promise<boolean>) => Promise<boolean>;
    emitOpenInNewTab: (result: TDocumentRef | TOpenFileResult) => void;
    /** Gives this view a document of its own and runs the open in its new workspace. */
    detachAndOpen: (open: (workspace: IWorkspaceExpose) => Promise<boolean>) => Promise<void>;
    view: Pick<TViewShellState,
        | 'pdfViewerRef'
        | 'documentViewerRef'
        | 'pdfDocument'
        | 'totalPages'
        | 'currentPage'
        | 'showSidebar'
        | 'selectedThumbnailPages'
        | 'setSelectedThumbnailPages'
        | 'selectedPageSelection'
        | 'setSelectedPageSelection'
        | 'requestThumbnailInvalidation'
        | 'closeAllDropdowns'
        | 'openDropdown'>;
    search: Pick<ReturnType<typeof useWorkspaceSearchSidebar>, 'resetSearchCache' | 'closeSearch' | 'adoptPageRotation'>;
    pageContextMenu: Pick<ReturnType<typeof usePageContextMenu>, 'closePageContextMenu'>;
    closeAnnotationContextMenu: () => void;
    annotationTool: Ref<TAnnotationTool>;
}

/**
 * The mounted views that show one document. None of them is the document's:
 * an operation that needs a view's page or selection gets it from its caller,
 * and what the document does to its views it does to each of them.
 */
export const createDocumentViews = (controller: IWorkspaceDocumentController) => {
    const viewPorts = shallowRef(new Map<string, IDocumentViewPort>());
    const ports = () => [...viewPorts.value.values()];

    /** Lends the document a mounted view; the returned function takes it back. */
    function attachView(port: IDocumentViewPort) {
        viewPorts.value = new Map(viewPorts.value).set(port.tabId, port);
        return () => {
            if (viewPorts.value.get(port.tabId) !== port) {
                return;
            }
            const next = new Map(viewPorts.value);
            next.delete(port.tabId);
            viewPorts.value = next;
        };
    }

    // Only PDF documents link views; a DjVu document, and the document a
    // moved or restored tab opens, has at most one.
    const soleView = computed(() => (viewPorts.value.size === 1 ? ports()[0]! : null));

    // An open runs in the view that starts it, whose lifecycle claims its
    // surface; without one, the document runs it alone. A normal open starts
    // where its reader left it, unless they move first.
    async function runDocumentOpen(port: IDocumentViewPort | null, request: IWorkspaceOpenRequest, run: () => Promise<boolean>) {
        if (!port) {
            return controller.runOpen(request, run);
        }
        const workspace = controller.getView(port.tabId)?.mountedWorkspace.value;
        const opening = request.kind === 'open' && !request.carriesView && workspace
            ? followOpeningReader(controller, port.openSurface, workspace)
            : null;
        try {
            return await port.runDocumentOpen(request, run);
        } finally {
            if (opening) {
                finishOpeningReader(controller, opening);
            }
        }
    }

    // The viewers share the document's PDF session and annotation store, so
    // what one of them answers about the document every one would: the first
    // mounted, not the focused, serves.
    const pdfViewer = computed(() => ports().map(port => port.view.pdfViewerRef.value).find(viewer => viewer) ?? null);
    // The PDF.js document the views present, and its page count. The session
    // drops its document when a reload starts; the views present the previous
    // one until the next is ready, and that is the document's state meanwhile.
    const presentedPdfDocument = computed(() => ports().map(port => port.view.pdfDocument.value).find(document => document) ?? null);
    const reportedPageCount = computed(() => Math.max(0, ...ports().map(port => port.view.totalPages.value)));

    /**
     * Waits for a reload of the document in one view, which returns to `page`
     * once it shows the new bytes, unless its reader moved meanwhile.
     */
    function prepareViewReload(port: IDocumentViewPort, page: number, restoreScroll = true) {
        return createPdfReloadWaiter({
            pdfDocument: port.view.pdfDocument,
            pdfViewerRef: port.view.pdfViewerRef,
            openSurface: port.openSurface,
            resetSearchCache: port.search.resetSearchCache,
            pageToRestore: resolvePdfReloadPage(page),
            restoreScroll,
        });
    }

    /**
     * Waits for a reload of the document in every view; each keeps its own
     * page, moved through `mapPage` when the reload changes the pages (T4).
     */
    function prepareReload(mapPage: (page: number) => number = page => page, restoreScroll = true) {
        const waiters = ports().map(port => prepareViewReload(port, mapPage(port.view.currentPage.value), restoreScroll));
        return {
            promise: Promise.all(waiters.map(waiter => waiter.promise)).then(() => undefined),
            cancel: () => waiters.forEach(waiter => waiter.cancel()),
        };
    }

    // Remap the current reading position, never a position captured at edit time.
    function mapPageIdentity(delta: IPageIdentityDelta) {
        const nextCount = getPageIdentityDeltaNextPageCount(delta);
        const map = (page: number) => mapPageNumberThroughPageIdentityDelta(delta, requirePageNumber(page))
            ?? Math.max(1, Math.min(page, nextCount ?? page));
        for (const record of controller.views.value.values()) {
            if (viewPorts.value.has(record.tabId)) {
                // Its mounted viewer carries its own semantic anchor through
                // the swap and reports the page it lands on.
                continue;
            }
            const page = map(record.viewState.value.currentPage ?? record.toolbarSnapshot.value.currentPage);
            const anchor = record.readingAnchor.value;
            record.applyViewState({
                ...record.viewState.value,
                currentPage: page,
            }, anchor && {
                ...anchor,
                page: mapPageNumberThroughPageIdentityDelta(delta, requirePageNumber(anchor.page)) ?? page,
            });
            record.publishToolbarSnapshot({
                ...record.toolbarSnapshot.value,
                currentPage: page,
                totalPages: nextCount ?? record.toolbarSnapshot.value.totalPages,
            });
        }
    }

    return {
        viewPorts,
        attachView,
        soleView,
        runDocumentOpen,
        pdfViewer,
        presentedPdfDocument,
        reportedPageCount,
        prepareViewReload,
        prepareReload,
        mapPageIdentity,
        forEachView: (apply: (port: IDocumentViewPort) => void) => ports().forEach(apply),
    };
};

export type TDocumentViews = ReturnType<typeof createDocumentViews>;
