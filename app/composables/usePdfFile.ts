import {
    computed,
    ref,
} from 'vue';

function getElectronAPI() {
    if (typeof window === 'undefined' || !window.electronAPI) {
        throw new Error('Electron API not available');
    }
    return window.electronAPI;
}

export const usePdfFile = () => {
    const pdfSrc = ref<Blob | null>(null);
    const pdfData = ref<Uint8Array | null>(null);
    const filePath = ref<string | null>(null);
    const error = ref<string | null>(null);
    const isDirty = ref(false);

    const fileName = computed(() => filePath.value?.split('/').pop() ?? null);
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

    async function loadPdfFromPath(path: string) {
        const api = getElectronAPI();
        filePath.value = path;
        const buffer = await api.readFile(path);
        const data = new Uint8Array(buffer);
        pdfData.value = data;
        pdfSrc.value = new Blob([data], { type: 'application/pdf' });
        isDirty.value = false;
        await api.setWindowTitle(fileName.value || 'PDF Viewer');
    }

    function loadPdfFromData(data: Uint8Array) {
        pdfData.value = data;
        pdfSrc.value = new Blob([data], { type: 'application/pdf' });
        isDirty.value = true;
    }

    async function saveFile(data: Uint8Array) {
        if (!filePath.value) {
            return false;
        }
        try {
            await getElectronAPI().writeFile(filePath.value, data);
            isDirty.value = false;
            return true;
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to save file';
            return false;
        }
    }

    async function closeFile() {
        pdfSrc.value = null;
        pdfData.value = null;
        filePath.value = null;
        error.value = null;
        isDirty.value = false;
        try {
            await getElectronAPI().setWindowTitle('PDF Viewer');
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
        filePath,
        fileName,
        error,
        isDirty,
        isElectron,
        openFile,
        openFileDirect,
        loadPdfFromData,
        saveFile,
        closeFile,
        markDirty,
    };
};
