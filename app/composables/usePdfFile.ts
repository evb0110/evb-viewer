import {
    computed,
    ref,
} from 'vue';
import { getElectronAPI } from '@app/utils/electron';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import type { TPdfSource } from '@app/types/pdf';

export const usePdfFile = () => {
    const pdfSrc = ref<TPdfSource | null>(null);
    const pdfData = ref<Uint8Array | null>(null);
    const workingCopyPath = ref<string | null>(null);
    const error = ref<string | null>(null);
    const isDirty = ref(false);

    const { clearCache: clearOcrCache } = useOcrTextContent();

    const fileName = computed(() => workingCopyPath.value?.split(/[\\/]/).pop() ?? null);
    const isElectron = computed(() => typeof window !== 'undefined' && !!window.electronAPI);

    async function openFile() {
        error.value = null;
        try {
            const api = getElectronAPI();
            const path = await api.openPdfDialog();
            if (!path) {
                return;
            }
            await loadPdfFromPath(path);
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to open file';
        }
    }

    async function openFileDirect(path: string) {
        error.value = null;
        try {
            const api = getElectronAPI();
            const validPath = await api.openPdfDirect(path);
            if (!validPath) {
                error.value = 'Invalid or non-existent PDF file';
                return;
            }
            await loadPdfFromPath(validPath);
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to open file';
        }
    }

    const MAX_IN_MEMORY_PDF_BYTES = 256 * 1024 * 1024;

    async function loadPdfFromPath(path: string, opts?: { markDirty?: boolean }) {
        const api = getElectronAPI();

        // Cleanup previous working copy if opening a different file
        const prevPath = workingCopyPath.value;
        if (prevPath && prevPath !== path) {
            // M4.3: Clear OCR cache for the previous file before cleanup
            clearOcrCache(prevPath);
            try {
                await api.cleanupFile(prevPath);
            } catch {
                // Ignore cleanup errors - old directory may already be gone
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

        isDirty.value = !!opts?.markDirty;
        await api.setWindowTitle(fileName.value || 'PDF Viewer');
    }

    function loadPdfFromData(data: Uint8Array) {
        pdfData.value = data;
        pdfSrc.value = new Blob([data.slice().buffer], { type: 'application/pdf' });
        isDirty.value = true;
    }

    async function saveFile(data: Uint8Array) {
        if (!workingCopyPath.value) {
            return false;
        }
        try {
            const api = getElectronAPI();
            // First update the working copy with latest data
            await api.writeFile(workingCopyPath.value, data);
            // Then save working copy back to original location
            await api.saveFile(workingCopyPath.value);
            isDirty.value = false;
            return true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to save file';
            return false;
        }
    }

    async function saveWorkingCopy() {
        if (!workingCopyPath.value) {
            return false;
        }
        try {
            const api = getElectronAPI();
            await api.saveFile(workingCopyPath.value);
            isDirty.value = false;
            return true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to save file';
            return false;
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
        error.value = null;
        isDirty.value = false;
        try {
            const api = getElectronAPI();
            if (pathToCleanup) {
                await api.cleanupFile(pathToCleanup);
            }
            await api.setWindowTitle('PDF Viewer');
        } catch {
            // Ignore errors when not in Electron
        }
    }

    function markDirty() {
        isDirty.value = true;
    }

    return {
        pdfSrc,
        pdfData,
        workingCopyPath,
        fileName,
        error,
        isDirty,
        isElectron,
        openFile,
        openFileDirect,
        loadPdfFromPath,
        loadPdfFromData,
        saveFile,
        saveWorkingCopy,
        closeFile,
        markDirty,
    };
};
