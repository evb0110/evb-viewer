import type { Ref } from 'vue';
import type { usePageContextMenu } from '@app/modules/pdf-viewer/public';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { useWorkspaceViewerShellState } from '@app/modules/workspace-shell/composables/useWorkspaceViewerShellState';
import type { useWorkspaceSearchSidebar } from '@app/modules/workspace-shell/composables/useWorkspaceSearchSidebar';
import type { useWorkspaceViewState } from '@app/modules/workspace-shell/composables/useWorkspaceViewState';
import type { IWorkspaceOpenRequest } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';

export type TViewShellState = ReturnType<typeof useWorkspaceViewerShellState>;

/** What a mounted view lends its document's commands while its tab is in use. */
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
        | 'dragMode'
        | 'showSidebar'
        | 'sidebarTab'
        | 'selectedThumbnailPages'
        | 'setSelectedThumbnailPages'
        | 'selectedPageSelection'
        | 'setSelectedPageSelection'
        | 'requestThumbnailInvalidation'
        | 'closeAllDropdowns'
        | 'openDropdown'>;
    search: Pick<ReturnType<typeof useWorkspaceSearchSidebar>, 'resetSearchCache' | 'closeSearch'>;
    navigation: Pick<ReturnType<typeof useWorkspaceViewState>, 'canUndo' | 'canRedo'>;
    pageContextMenu: ReturnType<typeof usePageContextMenu>;
    closeAnnotationContextMenu: () => void;
}

/**
 * The views that show one document, and the one in use: the view whose tab
 * was last active. The document's commands run in that view; its metadata is
 * read from a view that has the document loaded.
 */
export const createDocumentViews = () => {
    const viewPorts = shallowRef(new Map<string, IDocumentViewPort>());
    const commandTabId = ref<string | null>(null);
    const commandView = computed(() => (
        (commandTabId.value === null ? undefined : viewPorts.value.get(commandTabId.value))
        ?? viewPorts.value.values().next().value
        ?? null
    ));
    // Views that are not mounted leave nothing to command; reads fall back and
    // writes are dropped rather than landing in a detached viewPort.
    function commandViewRef<T>(read: (port: IDocumentViewPort) => Ref<T>, fallback: T) {
        return computed<T>({
            get: () => {
                const port = commandView.value;
                return port ? read(port).value : fallback;
            },
            set: (value) => {
                const port = commandView.value;
                if (port) {
                    read(port).value = value;
                }
            },
        });
    }
    /** Lends the document a mounted view; the returned function takes it back. */
    function attachView(port: IDocumentViewPort) {
        viewPorts.value = new Map(viewPorts.value).set(port.tabId, port);
        const stopActiveWatch = watch(port.isActive, (active) => {
            if (active) {
                commandTabId.value = port.tabId;
            }
        }, {immediate: true});
        return () => {
            stopActiveWatch();
            if (viewPorts.value.get(port.tabId) !== port) {
                return;
            }
            const next = new Map(viewPorts.value);
            next.delete(port.tabId);
            viewPorts.value = next;
        };
    }
    // Metadata is read from a view that has the document loaded, the one in
    // use first: a view still loading its PDF.js document shows the same one.
    const loadedView = computed(() => (
        commandView.value?.view.pdfDocument.value
            ? commandView.value
            : [...viewPorts.value.values()].find(port => port.view.pdfDocument.value) ?? commandView.value
    ));

    function closeAnnotationContextMenus() {
        for (const port of viewPorts.value.values()) {
            port.closeAnnotationContextMenu();
        }
    }

    return {
        viewPorts,
        closeAnnotationContextMenus,
        commandTabId: computed(() => commandTabId.value),
        commandView,
        commandViewRef,
        attachView,
        loadedView,
    };
};

export type TDocumentViews = ReturnType<typeof createDocumentViews>;
