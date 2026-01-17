import { ref } from 'vue';
import type { IRecentFile } from '@app/types/shared';

// Shared state across all composable instances
const recentFiles = ref<IRecentFile[]>([]);
const isLoading = ref(false);
const error = ref<string | null>(null);

export const useRecentFiles = () => {

    async function loadRecentFiles() {
        if (!window.electronAPI) {
            return;
        }

        isLoading.value = true;
        error.value = null;
        try {
            recentFiles.value = await window.electronAPI.recentFiles.get();
        } catch (e) {
            error.value = e instanceof Error ? e.message : 'Failed to load recent files';
        } finally {
            isLoading.value = false;
        }
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
