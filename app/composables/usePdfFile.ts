import {
    computed,
    ref,
} from 'vue';
import {
    getElectronAPI,
    hasElectronAPI,
} from '@app/utils/electron';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import type { TPdfSource } from '@app/types/pdf';
import type { TOpenFileResult } from '@app/types/electron-api';
import { BrowserLogger } from '@app/utils/browser-logger';

interface IOpenBatchProgressState {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

export const usePdfFile = () => {
    const { t } = useTypedI18n();

    const pdfSrc = ref<TPdfSource | null>(null);
    const pdfData = ref<Uint8Array | null>(null);
    const workingCopyPath = ref<string | null>(null);
    const originalPath = ref<string | null>(null);
    const error = ref<string | null>(null);
    const isDirty = ref(false);
    const history = ref<Uint8Array[]>([]);
    const historyIndex = ref(0);
    const historyCleanIndex = ref(0);
    const requiresSaveAsOnFirstSave = ref(false);
    const MAX_HISTORY = 20;

    const { clearCache: clearOcrCache } = useOcrTextContent();

    const fileName = computed(() => workingCopyPath.value?.split(/[\\/]/).pop() ?? null);
    const isElectron = computed(() => hasElectronAPI());

    const pendingDjvu = ref<string | null>(null);
    const openBatchProgress = ref<IOpenBatchProgressState | null>(null);

    async function pickFileToOpen() {
        const api = getElectronAPI();
        return api.openPdfDialog();
    }

    async function openFile(preSelected?: TOpenFileResult) {
        error.value = null;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        try {
            const result = preSelected ?? await pickFileToOpen();
            if (!result) {
                return;
            }
            if (result.kind === 'djvu') {
                pendingDjvu.value = result.originalPath;
                return;
            }
            await loadPdfFromPath(result.workingPath, { markDirty: !!result.isGenerated });
            originalPath.value = result.originalPath;
            requiresSaveAsOnFirstSave.value = !!result.isGenerated;
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.open');
        }
    }

    async function openFileDirect(path: string) {
        error.value = null;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.openPdfDirect(path);
            if (!result) {
                error.value = t('errors.file.invalid');
                return;
            }
            if (result.kind === 'djvu') {
                pendingDjvu.value = result.originalPath;
                return;
            }
            await loadPdfFromPath(result.workingPath, { markDirty: !!result.isGenerated });
            originalPath.value = result.originalPath;
            requiresSaveAsOnFirstSave.value = !!result.isGenerated;
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.open');
        }
    }

    async function openFileDirectBatch(paths: string[]) {
        error.value = null;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        try {
            const api = getElectronAPI();
            const normalizedPaths = paths
                .map(path => path.trim())
                .filter(path => path.length > 0);

            if (normalizedPaths.length === 0) {
                error.value = t('errors.file.invalid');
                return;
            }

            const requestId = crypto.randomUUID();
            openBatchProgress.value = {
                processed: 0,
                total: normalizedPaths.length,
                percent: 0,
                elapsedMs: 0,
                estimatedRemainingMs: null,
            };

            const stopProgress = api.onOpenPdfDirectBatchProgress((progress) => {
                if (progress.requestId !== requestId) {
                    return;
                }

                openBatchProgress.value = {
                    processed: Math.max(0, progress.processed),
                    total: Math.max(0, progress.total),
                    percent: Math.max(0, Math.min(100, progress.percent)),
                    elapsedMs: Math.max(0, progress.elapsedMs),
                    estimatedRemainingMs: typeof progress.estimatedRemainingMs === 'number'
                        ? Math.max(0, progress.estimatedRemainingMs)
                        : null,
                };
            });

            let result: TOpenFileResult | null = null;
            try {
                result = await api.openPdfDirectBatch(normalizedPaths, requestId);
            } finally {
                stopProgress();
            }

            if (!result) {
                openBatchProgress.value = null;
                error.value = t('errors.file.invalid');
                return;
            }
            if (result.kind === 'djvu') {
                openBatchProgress.value = null;
                pendingDjvu.value = result.originalPath;
                return;
            }
            await loadPdfFromPath(result.workingPath, { markDirty: !!result.isGenerated });
            originalPath.value = result.originalPath;
            requiresSaveAsOnFirstSave.value = !!result.isGenerated;
            openBatchProgress.value = null;
        } catch (e) {
            openBatchProgress.value = null;
            error.value = e instanceof Error ? e.message : t('errors.file.open');
        }
    }

    const MAX_IN_MEMORY_PDF_BYTES = 256 * 1024 * 1024;

    function resetHistory(snapshot: Uint8Array | null) {
        if (snapshot) {
            history.value = [snapshot.slice()];
            historyIndex.value = 0;
            historyCleanIndex.value = 0;
        } else {
            history.value = [];
            historyIndex.value = 0;
            historyCleanIndex.value = 0;
        }
    }

    function syncDirtyFromHistory() {
        if (history.value.length > 0) {
            isDirty.value = historyIndex.value !== historyCleanIndex.value;
        }
    }

    async function loadPdfFromPath(path: string, opts?: { markDirty?: boolean }) {
        const api = getElectronAPI();

        // Cleanup previous working copy if opening a different file
        const prevPath = workingCopyPath.value;
        if (prevPath && prevPath !== path) {
            clearOcrCache(prevPath);
            try {
                await api.cleanupFile(prevPath);
            } catch (cleanupError) {
                BrowserLogger.warn('pdf-file', 'Failed to cleanup previous working copy', {
                    path: prevPath,
                    error: cleanupError,
                });
            }
        }

        // Verify and read file BEFORE committing any reactive state.
        // This prevents an inconsistent UI where the tab shows metadata
        // (filename, dirty dot) but the content area shows the empty state
        // because pdfSrc was never set due to a failed read.
        const { size } = await api.statFile(path);

        let newPdfData: Uint8Array | null;
        let newPdfSrc: TPdfSource;

        if (size > MAX_IN_MEMORY_PDF_BYTES) {
            newPdfData = null;
            newPdfSrc = {
                kind: 'path',
                path,
                size, 
            };
        } else {
            const buffer = await api.readFile(path);
            const data = new Uint8Array(buffer);
            newPdfData = data;
            newPdfSrc = new Blob([data], { type: 'application/pdf' });
        }

        // All async operations succeeded — commit state atomically
        workingCopyPath.value = path;
        pdfData.value = newPdfData;
        pdfSrc.value = newPdfSrc;

        if (newPdfData) {
            resetHistory(newPdfData);
            syncDirtyFromHistory();
        } else {
            resetHistory(null);
        }

        isDirty.value = !!opts?.markDirty;
    }

    function pushHistorySnapshot(snapshot: Uint8Array) {
        if (history.value.length === 0) {
            resetHistory(snapshot);
            syncDirtyFromHistory();
            return;
        }

        const truncated = history.value.slice(0, historyIndex.value + 1);
        truncated.push(snapshot.slice());

        let offset = 0;
        let nextHistory = truncated;
        if (nextHistory.length > MAX_HISTORY) {
            offset = nextHistory.length - MAX_HISTORY;
            nextHistory = nextHistory.slice(offset);
        }

        history.value = nextHistory;
        historyIndex.value = history.value.length - 1;
        historyCleanIndex.value = Math.max(0, historyCleanIndex.value - offset);
        syncDirtyFromHistory();
    }

    async function applySnapshot(snapshot: Uint8Array, persist = false) {
        pdfData.value = snapshot;
        pdfSrc.value = new Blob([snapshot.slice().buffer], { type: 'application/pdf' });

        if (persist && workingCopyPath.value) {
            const api = getElectronAPI();
            await api.writeFile(workingCopyPath.value, snapshot);
        }
    }

    async function loadPdfFromData(data: Uint8Array, opts?: {
        pushHistory?: boolean;
        persistWorkingCopy?: boolean 
    }) {
        const snapshot = data.slice();
        await applySnapshot(snapshot, opts?.persistWorkingCopy ?? false);

        if (opts?.pushHistory !== false) {
            pushHistorySnapshot(snapshot);
        } else {
            isDirty.value = true;
        }
    }

    async function saveFile(data: Uint8Array) {
        if (!workingCopyPath.value) {
            return false;
        }
        try {
            if (requiresSaveAsOnFirstSave.value) {
                const savedPath = await saveWorkingCopyAs(data);
                return Boolean(savedPath);
            }

            const api = getElectronAPI();
            // First update the working copy with latest data
            await api.writeFile(workingCopyPath.value, data);
            // Then save working copy back to original location
            await api.saveFile(workingCopyPath.value);
            isDirty.value = false;
            historyCleanIndex.value = historyIndex.value;
            syncDirtyFromHistory();
            return true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.save');
            return false;
        }
    }

    async function saveWorkingCopy() {
        if (!workingCopyPath.value) {
            return false;
        }
        try {
            if (requiresSaveAsOnFirstSave.value) {
                const savedPath = await saveWorkingCopyAs();
                return Boolean(savedPath);
            }

            const api = getElectronAPI();
            await api.saveFile(workingCopyPath.value);
            isDirty.value = false;
            historyCleanIndex.value = historyIndex.value;
            syncDirtyFromHistory();
            return true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.save');
            return false;
        }
    }

    async function saveWorkingCopyAs(data?: Uint8Array) {
        if (!workingCopyPath.value) {
            return null;
        }
        try {
            const api = getElectronAPI();
            if (data) {
                await api.writeFile(workingCopyPath.value, data);
            }
            const savedPath = await api.savePdfAs(workingCopyPath.value);
            if (savedPath) {
                originalPath.value = savedPath;
                requiresSaveAsOnFirstSave.value = false;
                isDirty.value = false;
                historyCleanIndex.value = historyIndex.value;
                syncDirtyFromHistory();
            }
            return savedPath;
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.save');
            return null;
        }
    }

    async function closeFile() {
        const pathToCleanup = workingCopyPath.value;

        // M4.3: Clear OCR cache for the current file before closing
        if (pathToCleanup) {
            clearOcrCache(pathToCleanup);
        }

        pdfSrc.value = null;
        pdfData.value = null;
        workingCopyPath.value = null;
        originalPath.value = null;
        error.value = null;
        isDirty.value = false;
        pendingDjvu.value = null;
        openBatchProgress.value = null;
        requiresSaveAsOnFirstSave.value = false;
        resetHistory(null);
        if (pathToCleanup && hasElectronAPI()) {
            const api = getElectronAPI();
            try {
                await api.cleanupFile(pathToCleanup);
            } catch (cleanupError) {
                BrowserLogger.warn('pdf-file', 'Failed to cleanup closed working copy', {
                    path: pathToCleanup,
                    error: cleanupError,
                });
            }
        }
    }

    function markDirty() {
        isDirty.value = true;
    }

    const canUndo = computed(() => history.value.length > 0 && historyIndex.value > 0);
    const canRedo = computed(() => history.value.length > 0 && historyIndex.value < history.value.length - 1);

    async function undo() {
        if (!canUndo.value) {
            return false;
        }
        historyIndex.value -= 1;
        const snapshot = history.value[historyIndex.value];
        if (snapshot) {
            await applySnapshot(snapshot, true);
        }
        syncDirtyFromHistory();
        return true;
    }

    async function redo() {
        if (!canRedo.value) {
            return false;
        }
        historyIndex.value += 1;
        const snapshot = history.value[historyIndex.value];
        if (snapshot) {
            await applySnapshot(snapshot, true);
        }
        syncDirtyFromHistory();
        return true;
    }

    return {
        pdfSrc,
        pdfData,
        workingCopyPath,
        originalPath,
        fileName,
        error,
        isDirty,
        isElectron,
        pendingDjvu,
        openBatchProgress,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        loadPdfFromPath,
        loadPdfFromData,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        closeFile,
        markDirty,
        canUndo,
        canRedo,
        undo,
        redo,
    };
};
