import {
    ref,
    type Ref,
} from 'vue';
import { getElectronAPI } from '@app/utils/electron';
import { BrowserLogger } from '@app/utils/browser-logger';

type TPageOpsRotation = 90 | 180 | 270;

export const usePageOperations = (deps: {
    workingCopyPath: Ref<string | null>;
    loadPdfFromPath: (path: string, opts?: { markDirty?: boolean }) => Promise<void>;
    clearOcrCache: (path: string) => void;
    resetSearchCache: () => void;
}) => {
    const { t } = useTypedI18n();

    const {
        workingCopyPath,
        loadPdfFromPath,
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
        const path = workingCopyPath.value;
        if (!path || pages.length === 0) {
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
            const result = await api.pageOps.delete(path, [...pages], totalPages);
            if (result.success) {
                invalidateCaches();
                await loadPdfFromPath(path, { markDirty: true });
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
        const path = workingCopyPath.value;
        if (!path || pages.length === 0) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.extract(path, [...pages]);
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
        const path = workingCopyPath.value;
        if (!path || pages.length === 0) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.rotate(path, [...pages], angle);
            if (result.success) {
                invalidateCaches();
                await loadPdfFromPath(path, { markDirty: true });
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
        const path = workingCopyPath.value;
        if (!path) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.insert(path, totalPages, afterPage);
            if (result.success) {
                invalidateCaches();
                await loadPdfFromPath(path, { markDirty: true });
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
        const path = workingCopyPath.value;
        if (!path) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.insertFile(path, totalPages, afterPage, sourcePaths);
            if (result.success) {
                invalidateCaches();
                await loadPdfFromPath(path, { markDirty: true });
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
        const path = workingCopyPath.value;
        if (!path || newOrder.length === 0) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.pageOps.reorder(path, [...newOrder]);
            if (result.success) {
                invalidateCaches();
                await loadPdfFromPath(path, { markDirty: true });
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
