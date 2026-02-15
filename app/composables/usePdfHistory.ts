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

    /**
     * Starts watching for a PDF document instance swap and resolves when
     * the reload completes (or times out). A cancel path is exposed so
     * undo/redo no-op operations can tear the watcher down immediately.
     */
    function createPdfReloadWaiter(pageToRestore: number) {
        const initialDoc = pdfDocument.value;
        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let unwatch: (() => void) | null = null;

        const promise = new Promise<void>((resolve) => {
            const finish = (onDone?: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (unwatch) {
                    unwatch();
                    unwatch = null;
                }
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

            unwatch = watch(pdfDocument, (doc) => {
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

        return {
            promise,
            cancel: () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (unwatch) {
                    unwatch();
                    unwatch = null;
                }
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
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
