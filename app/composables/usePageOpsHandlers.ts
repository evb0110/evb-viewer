import type { Ref } from 'vue';
import { usePageOperations } from '@app/composables/pdf/usePageOperations';

interface ISidebarForPageOps {
    invalidateThumbnailPages: (pages: number[]) => void;
    selectedThumbnailPages: number[];
    selectAllPages: () => void;
    invertPageSelection: () => void;
}

interface IPdfViewerForPageOps {invalidatePages: (pages: number[]) => void;}

export interface IPageOpsHandlersDeps {
    workingCopyPath: Ref<string | null>;
    totalPages: Ref<number>;
    sidebarRef: Ref<ISidebarForPageOps | null>;
    pdfViewerRef: Ref<IPdfViewerForPageOps | null>;
    pageContextMenu: Ref<{
        visible: boolean;
        pages: number[] 
    }>;
    closePageContextMenu: () => void;
    loadPdfFromData: (data: Uint8Array, opts?: {
        pushHistory?: boolean;
        persistWorkingCopy?: boolean;
    }) => Promise<void>;
    clearOcrCache: (path: string) => void;
    resetSearchCache: () => void;
}

export const usePageOpsHandlers = (deps: IPageOpsHandlersDeps) => {
    const {
        workingCopyPath,
        totalPages,
        sidebarRef,
        pdfViewerRef,
        pageContextMenu,
        closePageContextMenu,
        loadPdfFromData,
        clearOcrCache,
        resetSearchCache,
    } = deps;

    const {
        isOperationInProgress: isPageOperationInProgress,
        deletePages: pageOpsDelete,
        extractPages: pageOpsExtract,
        rotatePages: pageOpsRotate,
        insertPages: pageOpsInsert,
        insertFile: pageOpsInsertFile,
        reorderPages: pageOpsReorder,
    } = usePageOperations({
        workingCopyPath,
        loadPdfFromData,
        clearOcrCache: (path: string) => clearOcrCache(path),
        resetSearchCache,
    });

    function handlePageContextMenuDelete() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void pageOpsDelete(pages, totalPages.value);
    }

    function handlePageContextMenuExtract() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void pageOpsExtract(pages);
    }

    function handlePageRotate(pages: number[], angle: 90 | 180 | 270) {
        sidebarRef.value?.invalidateThumbnailPages([...pages]);
        pdfViewerRef.value?.invalidatePages([...pages]);
        return pageOpsRotate(pages, angle);
    }

    function handlePageContextMenuRotateCw() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void handlePageRotate(pages, 90);
    }

    function handlePageContextMenuRotateCcw() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void handlePageRotate(pages, 270);
    }

    function handlePageContextMenuInsertBefore() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void pageOpsInsert(totalPages.value, Math.min(...pages) - 1);
    }

    function handlePageContextMenuInsertAfter() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        void pageOpsInsert(totalPages.value, Math.max(...pages));
    }

    function handlePageFileDrop(payload: {
        afterPage: number;
        filePaths: string[];
    }) {
        void pageOpsInsertFile(totalPages.value, payload.afterPage, payload.filePaths);
    }

    function handlePageContextMenuSelectAll() {
        closePageContextMenu();
        sidebarRef.value?.selectAllPages();
    }

    function handlePageContextMenuInvertSelection() {
        closePageContextMenu();
        sidebarRef.value?.invertPageSelection();
    }

    return {
        isPageOperationInProgress,
        pageOpsDelete,
        pageOpsExtract,
        pageOpsInsert,
        pageOpsReorder,
        handlePageContextMenuDelete,
        handlePageContextMenuExtract,
        handlePageRotate,
        handlePageContextMenuRotateCw,
        handlePageContextMenuRotateCcw,
        handlePageContextMenuInsertBefore,
        handlePageContextMenuInsertAfter,
        handlePageFileDrop,
        handlePageContextMenuSelectAll,
        handlePageContextMenuInvertSelection,
    };
};
