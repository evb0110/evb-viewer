import type { Ref } from 'vue';
import { usePageOperations } from '@app/composables/pdf/usePageOperations';

interface IPdfViewerForPageOps {invalidatePages: (pages: number[]) => void;}

export interface IPageOpsHandlersDeps {
    workingCopyPath: Ref<string | null>;
    totalPages: Ref<number>;
    selectedThumbnailPages: Ref<number[]>;
    setSelectedThumbnailPages: (pages: number[]) => void;
    invalidateThumbnailPages: (pages: number[]) => void;
    pdfViewerRef: Ref<IPdfViewerForPageOps | null>;
    pageContextMenu: Ref<{
        visible: boolean;
        pages: number[] 
    }>;
    closePageContextMenu: () => void;
    onExportPages: (pages: number[]) => void;
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
        selectedThumbnailPages,
        setSelectedThumbnailPages,
        invalidateThumbnailPages,
        pdfViewerRef,
        pageContextMenu,
        closePageContextMenu,
        onExportPages,
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

    function handlePageContextMenuExport() {
        const pages = pageContextMenu.value.pages;
        closePageContextMenu();
        onExportPages([...pages]);
    }

    function handlePageRotate(pages: number[], angle: 90 | 180 | 270) {
        invalidateThumbnailPages([...pages]);
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
        if (totalPages.value <= 0) {
            return;
        }
        const allPages = Array.from({ length: totalPages.value }, (_, index) => index + 1);
        setSelectedThumbnailPages(allPages);
    }

    function handlePageContextMenuInvertSelection() {
        closePageContextMenu();
        if (totalPages.value <= 0) {
            return;
        }
        const currentSet = new Set(selectedThumbnailPages.value);
        const inverted: number[] = [];
        for (let page = 1; page <= totalPages.value; page += 1) {
            if (!currentSet.has(page)) {
                inverted.push(page);
            }
        }
        setSelectedThumbnailPages(inverted);
    }

    return {
        isPageOperationInProgress,
        pageOpsDelete,
        pageOpsExtract,
        pageOpsInsert,
        pageOpsReorder,
        handlePageContextMenuDelete,
        handlePageContextMenuExtract,
        handlePageContextMenuExport,
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
