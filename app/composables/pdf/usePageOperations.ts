import {
    ref,
    type Ref,
} from 'vue';
import { getElectronAPI } from '@app/utils/electron';

type TPageOpsRotation = 90 | 180 | 270;

export const usePageOperations = (deps: {
    workingCopyPath: Ref<string | null>;
    loadPdfFromData: (data: Uint8Array, opts?: {
        pushHistory?: boolean;
        persistWorkingCopy?: boolean;
    }) => Promise<void>;
    clearOcrCache: (path: string) => void;
    resetSearchCache: () => void;
}) => {
    const {
        workingCopyPath,
        loadPdfFromData,
        clearOcrCache,
        resetSearchCache,
    } = deps;

    const isOperationInProgress = ref(false);
    const error = ref<string | null>(null);

    function invalidateCaches() {
        if (workingCopyPath.value) {
            clearOcrCache(workingCopyPath.value);
        }
        resetSearchCache();
    }

    async function deletePages(pages: number[], totalPages: number) {
        if (!workingCopyPath.value || pages.length === 0) {
            return false;
        }
        if (pages.length >= totalPages) {
            error.value = 'Cannot delete all pages from the document';
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.delete(workingCopyPath.value, [...pages], totalPages);
            if (result.success && result.pdfData) {
                invalidateCaches();
                await loadPdfFromData(new Uint8Array(result.pdfData), {
                    pushHistory: true,
                    persistWorkingCopy: false,
                });
                return true;
            }
            return false;
        } catch (e) {
            console.error('[pageOps] deletePages failed:', e);
            error.value = e instanceof Error ? e.message : 'Failed to delete pages';
            return false;
        } finally {
            isOperationInProgress.value = false;
        }
    }

    async function extractPages(pages: number[]) {
        if (!workingCopyPath.value || pages.length === 0) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.extract(workingCopyPath.value, [...pages]);
            return result.success && !result.canceled;
        } catch (e) {
            console.error('[pageOps] extractPages failed:', e);
            error.value = e instanceof Error ? e.message : 'Failed to extract pages';
            return false;
        } finally {
            isOperationInProgress.value = false;
        }
    }

    async function rotatePages(pages: number[], angle: TPageOpsRotation) {
        if (!workingCopyPath.value || pages.length === 0) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.rotate(workingCopyPath.value, [...pages], angle);
            if (result.success && result.pdfData) {
                invalidateCaches();
                await loadPdfFromData(new Uint8Array(result.pdfData), {
                    pushHistory: true,
                    persistWorkingCopy: false,
                });
                return true;
            }
            return false;
        } catch (e) {
            console.error('[pageOps] rotatePages failed:', e);
            error.value = e instanceof Error ? e.message : 'Failed to rotate pages';
            return false;
        } finally {
            isOperationInProgress.value = false;
        }
    }

    async function insertPages(totalPages: number, afterPage: number) {
        if (!workingCopyPath.value) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.insert(workingCopyPath.value, totalPages, afterPage);
            if (result.success && result.pdfData) {
                invalidateCaches();
                await loadPdfFromData(new Uint8Array(result.pdfData), {
                    pushHistory: true,
                    persistWorkingCopy: false,
                });
                return true;
            }
            return false;
        } catch (e) {
            console.error('[pageOps] insertPages failed:', e);
            error.value = e instanceof Error ? e.message : 'Failed to insert pages';
            return false;
        } finally {
            isOperationInProgress.value = false;
        }
    }

    async function reorderPages(newOrder: number[]) {
        if (!workingCopyPath.value || newOrder.length === 0) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.reorder(workingCopyPath.value, [...newOrder]);
            if (result.success && result.pdfData) {
                invalidateCaches();
                await loadPdfFromData(new Uint8Array(result.pdfData), {
                    pushHistory: true,
                    persistWorkingCopy: false,
                });
                return true;
            }
            return false;
        } catch (e) {
            console.error('[pageOps] reorderPages failed:', e);
            error.value = e instanceof Error ? e.message : 'Failed to reorder pages';
            return false;
        } finally {
            isOperationInProgress.value = false;
        }
    }

    return {
        isOperationInProgress,
        error,
        deletePages,
        extractPages,
        rotatePages,
        insertPages,
        reorderPages,
    };
};
