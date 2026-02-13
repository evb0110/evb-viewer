import {
    watch,
    nextTick,
    type Ref,
} from 'vue';
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

    function waitForPdfReload(pageToRestore: number) {
        return new Promise<void>((resolve) => {
            const initialDoc = pdfDocument.value;
            let settled = false;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;

            const finish = (onDone?: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                unwatch();
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                if (onDone) {
                    onDone();
                } else {
                    resolve();
                }
            };

            const unwatch = watch(pdfDocument, (doc) => {
                if (!doc || doc === initialDoc) {
                    return;
                }
                finish(() => {
                    resetSearchCache();
                    void nextTick(() => {
                        pdfViewerRef.value?.scrollToPage(pageToRestore);
                        resolve();
                    });
                });
            });

            timeoutId = setTimeout(() => {
                finish();
            }, PDF_RELOAD_TIMEOUT_MS);
        });
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
            const restorePromise = waitForPdfReload(pageToRestore);
            const didUndo = await undo();
            if (didUndo) {
                await restorePromise;
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
            const restorePromise = waitForPdfReload(pageToRestore);
            const didRedo = await redo();
            if (didRedo) {
                await restorePromise;
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
