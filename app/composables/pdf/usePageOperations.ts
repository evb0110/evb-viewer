import {
    ref,
    type Ref,
} from 'vue';
import { getElectronAPI } from '@app/utils/electron';
import { BrowserLogger } from '@app/utils/browser-logger';

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
    const { t } = useTypedI18n();

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
            error.value = t('errors.pageOps.deleteAll');
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
            BrowserLogger.error('page-ops', 'deletePages failed', e);
            error.value = e instanceof Error ? e.message : t('errors.pageOps.delete');
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
            BrowserLogger.error('page-ops', 'extractPages failed', e);
            error.value = e instanceof Error ? e.message : t('errors.pageOps.extract');
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
            BrowserLogger.error('page-ops', 'rotatePages failed', e);
            error.value = e instanceof Error ? e.message : t('errors.pageOps.rotate');
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
            BrowserLogger.error('page-ops', 'insertPages failed', e);
            error.value = e instanceof Error ? e.message : t('errors.pageOps.insert');
            return false;
        } finally {
            isOperationInProgress.value = false;
        }
    }

    async function insertFile(totalPages: number, afterPage: number, sourcePaths: string[]) {
        if (!workingCopyPath.value) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.insertFile(workingCopyPath.value, totalPages, afterPage, sourcePaths);
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
            BrowserLogger.error('page-ops', 'insertFile failed', e);
            error.value = e instanceof Error ? e.message : t('errors.pageOps.insertFile');
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
            BrowserLogger.error('page-ops', 'reorderPages failed', e);
            error.value = e instanceof Error ? e.message : t('errors.pageOps.reorder');
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
        insertFile,
        reorderPages,
    };
};
