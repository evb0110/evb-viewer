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
import { BrowserLogger } from '@app/utils/browser-logger';

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

    async function openFile() {
        error.value = null;
        pendingDjvu.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.openPdfDialog();
            if (!result) {
                return;
            }
            if (result.kind === 'djvu') {
                pendingDjvu.value = result.originalPath;
                return;
            }
            originalPath.value = result.originalPath;
            requiresSaveAsOnFirstSave.value = !!result.isGenerated;
            await loadPdfFromPath(result.workingPath, { markDirty: !!result.isGenerated });
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.open');
        }
    }

    async function openFileDirect(path: string) {
        error.value = null;
        pendingDjvu.value = null;
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
            originalPath.value = result.originalPath;
            requiresSaveAsOnFirstSave.value = !!result.isGenerated;
            await loadPdfFromPath(result.workingPath, { markDirty: !!result.isGenerated });
        } catch (e) {
            error.value = e instanceof Error ? e.message : t('errors.file.open');
        }
    }

    async function openFileDirectBatch(paths: string[]) {
        error.value = null;
        pendingDjvu.value = null;
        try {
            const api = getElectronAPI();
            const result = await api.openPdfDirectBatch(paths);
            if (!result) {
                error.value = t('errors.file.invalid');
                return;
            }
            if (result.kind === 'djvu') {
                pendingDjvu.value = result.originalPath;
                return;
            }
            originalPath.value = result.originalPath;
            requiresSaveAsOnFirstSave.value = !!result.isGenerated;
            await loadPdfFromPath(result.workingPath, { markDirty: !!result.isGenerated });
        } catch (e) {
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
            // M4.3: Clear OCR cache for the previous file before cleanup
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

        workingCopyPath.value = path;  // Path from backend is already the working copy path
        const { size } = await api.statFile(path);

        if (size > MAX_IN_MEMORY_PDF_BYTES) {
            // Large PDFs can't be safely read into memory (and can exceed fs.readFile limits >2GiB).
            pdfData.value = null;
            pdfSrc.value = {
                kind: 'path',
                path,
                size,
            };
        } else {
            const buffer = await api.readFile(path);
            const data = new Uint8Array(buffer);
            pdfData.value = data;
            pdfSrc.value = new Blob([data], { type: 'application/pdf' });
        }

        if (pdfData.value) {
            resetHistory(pdfData.value);
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
