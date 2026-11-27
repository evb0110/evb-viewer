import type {Ref} from 'vue';

export const useCombinePdfQueue = <T>(options: {
    files: Ref<T[]>;
    isMutationLocked: Ref<boolean>;
    isSupported: (file: File) => boolean;
    toQueueItem: (file: File) => T;
}) => {
    const files = options.files;
    const lastRejectedCount = ref(0);

    function addFiles(fileList: FileList | File[]) {
        if (options.isMutationLocked.value) {
            return;
        }
        const nextFiles = [...files.value];
        let rejected = 0;
        for (const file of Array.from(fileList)) {
            if (!options.isSupported(file)) {
                rejected += 1;
                continue;
            }
            nextFiles.push(options.toQueueItem(file));
        }
        files.value = nextFiles;
        lastRejectedCount.value = rejected;
    }
    function clearFiles() {
        if (options.isMutationLocked.value) {
            return false;
        }
        files.value = [];
        lastRejectedCount.value = 0;
        return true;
    }
    function removeFile(index: number) {
        if (options.isMutationLocked.value) {
            return;
        }
        files.value = files.value.filter((_file, fileIndex) => fileIndex !== index);
    }
    function moveFile(index: number, targetIndex: number) {
        if (options.isMutationLocked.value || targetIndex < 0 || targetIndex >= files.value.length) {
            return false;
        }
        if (index < 0 || index >= files.value.length) {
            files.value = [...files.value];
            return true;
        }
        const item = files.value[index];
        if (!item) {
            files.value = [...files.value];
            return true;
        }
        const withoutItem = files.value.filter((_file, fileIndex) => fileIndex !== index);
        files.value = [...withoutItem.slice(0, targetIndex), item, ...withoutItem.slice(targetIndex)];
        return true;
    }

    return {
        files,
        lastRejectedCount,
        addFiles,
        clearFiles,
        removeFile,
        moveFile,
    };
};
