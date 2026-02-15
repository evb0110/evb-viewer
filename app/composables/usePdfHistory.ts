import {
    nextTick,
    ref,
    type Ref,
} from 'vue';
import { until } from '@vueuse/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const PDF_RELOAD_TIMEOUT_MS = 8000;

export const usePdfHistory = (deps: {
    pdfDocument: Ref<PDFDocumentProxy | null>;
    pdfViewerRef: Ref<{
        scrollToPage: (page: number) => void;
        undoAnnotation: () => void;
        redoAnnotation: () => void 
    } | null>;
    currentPage: Ref<number>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    canUndo: Ref<boolean>;
    canRedo: Ref<boolean>;
    isAnnotationUndoContext: Ref<boolean>;
    workingCopyPath: Ref<string | null>;
    resetSearchCache: () => void;
    clearOcrCache: (path: string) => void;
    undo: () => Promise<boolean>;
    redo: () => Promise<boolean>;
}) => {
    const {
        pdfDocument,
        pdfViewerRef,
        currentPage,
        isAnySaving,
        isHistoryBusy,
        canUndo,
        canRedo,
        isAnnotationUndoContext,
        workingCopyPath,
        resetSearchCache,
        clearOcrCache,
        undo,
        redo,
    } = deps;

    /**
     * Starts watching for a PDF document instance swap and resolves when
     * the reload completes (or times out). A cancel path is exposed so
     * undo/redo no-op operations can tear the watcher down immediately.
     */
    function createPdfReloadWaiter(pageToRestore: number) {
        const initialDoc = pdfDocument.value;
        const isCancelled = ref(false);

        const promise = until(() => ({
            doc: pdfDocument.value,
            cancelled: isCancelled.value,
        }))
            .toMatch(({
                doc,
                cancelled,
            }) => cancelled || Boolean(doc && doc !== initialDoc), {timeout: PDF_RELOAD_TIMEOUT_MS})
            .then(async ({
                doc,
                cancelled,
            }) => {
                if (cancelled || !doc || doc === initialDoc) {
                    return;
                }

                resetSearchCache();
                await nextTick();
                pdfViewerRef.value?.scrollToPage(pageToRestore);
            });

        return {
            promise,
            cancel: () => {
                isCancelled.value = true;
            },
        };
    }

    function waitForPdfReload(pageToRestore: number) {
        return createPdfReloadWaiter(pageToRestore).promise;
    }

    async function handleUndo() {
        if (isAnySaving.value || !canUndo.value) {
            return;
        }
        if (isAnnotationUndoContext.value) {
            pdfViewerRef.value?.undoAnnotation();
            return;
        }
        if (isHistoryBusy.value) {
            return;
        }
        isHistoryBusy.value = true;
        try {
            if (workingCopyPath.value) {
                clearOcrCache(workingCopyPath.value);
            }
            const pageToRestore = currentPage.value;
            const reloadWaiter = createPdfReloadWaiter(pageToRestore);
            const didUndo = await undo();
            if (didUndo) {
                await reloadWaiter.promise;
            } else {
                reloadWaiter.cancel();
            }
        } finally {
            isHistoryBusy.value = false;
        }
    }

    async function handleRedo() {
        if (isAnySaving.value || !canRedo.value) {
            return;
        }
        if (isAnnotationUndoContext.value) {
            pdfViewerRef.value?.redoAnnotation();
            return;
        }
        if (isHistoryBusy.value) {
            return;
        }
        isHistoryBusy.value = true;
        try {
            if (workingCopyPath.value) {
                clearOcrCache(workingCopyPath.value);
            }
            const pageToRestore = currentPage.value;
            const reloadWaiter = createPdfReloadWaiter(pageToRestore);
            const didRedo = await redo();
            if (didRedo) {
                await reloadWaiter.promise;
            } else {
                reloadWaiter.cancel();
            }
        } finally {
            isHistoryBusy.value = false;
        }
    }

    return {
        waitForPdfReload,
        handleUndo,
        handleRedo,
    };
};
