import { ref } from 'vue';
import type { IRecentFile } from '@app/types/shared';

// Vite HMR types (not exposed by Nuxt's type system)
declare global {
    interface ImportMeta {
        hot?: {
            data?: Record<string, unknown>;
            dispose: (callback: (data: Record<string, unknown>) => void) => void;
        };
    }
}

// Shared state across all composable instances
const recentFiles = ref<IRecentFile[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);

// Deduplication: track in-flight load promise
let loadPromise: Promise<void> | null = null;

export const useRecentFiles = () => {

    async function loadRecentFiles() {
        if (!window.electronAPI) {
            return;
        }

        // Deduplicate: if already loading, return existing promise
        if (loadPromise) {
            return loadPromise;
        }

        loadPromise = (async () => {
            isLoading.value = true;
            error.value = null;
            try {
                recentFiles.value = await window.electronAPI.recentFiles.get();
            } catch (e) {
                error.value = e instanceof Error ? e.message : 'Failed to load recent files';
            } finally {
                isLoading.value = false;
                loadPromise = null;
            }
        })();

        return loadPromise;
    }

    async function openRecentFile(file: IRecentFile) {
        if (!window.electronAPI) {
            return;
        }

        error.value = null;
        try {
            await window.electronAPI.openPdfDirect(file.originalPath);
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to open file';
        }
    }

    async function removeRecentFile(file: IRecentFile) {
        if (!window.electronAPI) {
            return;
        }

        error.value = null;
        try {
            await window.electronAPI.recentFiles.remove(file.originalPath);
            await loadRecentFiles();
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to remove file';
        }
    }

    async function clearRecentFiles() {
        if (!window.electronAPI) {
            return;
        }

        error.value = null;
        try {
            await window.electronAPI.recentFiles.clear();
            recentFiles.value = [];
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to clear recent files';
        }
    }

    return {
        recentFiles,
        isLoading,
        error,
        loadRecentFiles,
        openRecentFile,
        removeRecentFile,
        clearRecentFiles,
    };
};

// HMR support: preserve and restore state across hot updates
if (import.meta.hot) {
    // Save current state before the module is replaced
    import.meta.hot.dispose((data) => {
        data.recentFiles = recentFiles.value;
        data.isLoading = isLoading.value;
        data.error = error.value;
    });

    // Restore state from previous module version
    const hmrData = import.meta.hot.data;
    if (hmrData?.recentFiles) {
        recentFiles.value = hmrData.recentFiles as IRecentFile[];
        isLoading.value = (hmrData.isLoading as boolean) ?? false;
        error.value = (hmrData.error as string | null) ?? null;
    }
}
