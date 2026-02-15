import type { Ref } from 'vue';

interface IWorkspaceFileSwitchDeps {
    workingCopyPath: Ref<string | null>;
    isDjvuMode: Ref<boolean>;
    cleanupDjvuTemp: () => Promise<void>;
    exitDjvuMode: () => void;
    openFile: () => Promise<void>;
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
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
    } = deps;

    async function openFileWithDjvuCleanup() {
        const oldPath = workingCopyPath.value;
        await openFile();
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
        openFileWithDjvuCleanup,
        openFileDirectWithDjvuCleanup,
        openFileDirectBatchWithDjvuCleanup,
        closeFileWithDjvuCleanup,
    };
};
