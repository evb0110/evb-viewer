import type { Ref } from 'vue';
import type { TOpenFileResult } from '@app/types/electron-api';

interface IWorkspaceFileSwitchDeps {
    workingCopyPath: Ref<string | null>;
    isDjvuMode: Ref<boolean>;
    cleanupDjvuTemp: () => Promise<void>;
    exitDjvuMode: () => void;
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    openFile: (preSelected?: TOpenFileResult) => Promise<void>;
    openFileDirect: (path: string) => Promise<void>;
    openFileDirectBatch: (paths: string[]) => Promise<void>;
    closeFile: () => Promise<void>;
}

export const useWorkspaceFileSwitch = (deps: IWorkspaceFileSwitchDeps) => {
    const {
        workingCopyPath,
        isDjvuMode,
        cleanupDjvuTemp,
        exitDjvuMode,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
    } = deps;

    async function pickFileToOpenWithDjvuCleanup() {
        return pickFileToOpen();
    }

    async function openFileWithDjvuCleanup(preSelected?: TOpenFileResult) {
        const oldPath = workingCopyPath.value;
        await openFile(preSelected);
        if (isDjvuMode.value && workingCopyPath.value !== oldPath) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
    }

    async function openFileDirectWithDjvuCleanup(path: string) {
        const oldPath = workingCopyPath.value;
        await openFileDirect(path);
        if (isDjvuMode.value && workingCopyPath.value !== oldPath) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
    }

    async function openFileDirectBatchWithDjvuCleanup(paths: string[]) {
        const oldPath = workingCopyPath.value;
        await openFileDirectBatch(paths);
        if (isDjvuMode.value && workingCopyPath.value !== oldPath) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
    }

    async function closeFileWithDjvuCleanup() {
        if (isDjvuMode.value) {
            await cleanupDjvuTemp();
            exitDjvuMode();
        }
        await closeFile();
    }

    return {
        pickFileToOpenWithDjvuCleanup,
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
    };
};
