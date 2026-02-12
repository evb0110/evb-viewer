import type { Ref } from 'vue';
import type { IAnnotationNoteWindowState } from '@app/composables/pdf/useAnnotationNoteWindows';
import { waitUntilIdle } from '@app/utils/async-helpers';

export interface IPageFileOperationsDeps {
    pdfSrc: Ref<unknown>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    isExportingDocx: Ref<boolean>;
    isAnyAnnotationNoteSaving: Ref<boolean>;
    annotationNoteWindows: Ref<IAnnotationNoteWindowState[]>;
    annotationDirty: Ref<boolean>;
    isDirty: Ref<boolean>;
    pageLabelsDirty: Ref<boolean>;
    bookmarksDirty: Ref<boolean>;
    hasAnnotationChanges: () => boolean;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    handleSave: () => Promise<void>;
    openFile: () => Promise<void>;
    openFileDirect: (path: string) => Promise<void>;
    closeFile: () => Promise<void>;
    closeAllDropdowns: () => void;
}

export const usePageFileOperations = (deps: IPageFileOperationsDeps) => {
    const {
        pdfSrc,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        annotationNoteWindows,
        annotationDirty,
        isDirty,
        pageLabelsDirty,
        bookmarksDirty,
        hasAnnotationChanges,
        persistAllAnnotationNotes,
        handleSave,
        openFile,
        openFileDirect,
        closeFile,
        closeAllDropdowns,
    } = deps;

    async function waitUntilAllIdle() {
        await waitUntilIdle(() =>
            isAnySaving.value || isHistoryBusy.value || isExportingDocx.value || isAnyAnnotationNoteSaving.value,
        );
    }

    async function ensureCurrentDocumentPersistedBeforeSwitch() {
        if (!pdfSrc.value) {
            return true;
        }

        await waitUntilAllIdle();
        if (isAnySaving.value || isHistoryBusy.value || isExportingDocx.value || isAnyAnnotationNoteSaving.value) {
            return false;
        }

        if (annotationNoteWindows.value.length > 0) {
            const savedAllNotes = await persistAllAnnotationNotes(true);
            if (!savedAllNotes) {
                return false;
            }
        }

        const hasPendingChanges = (
            annotationDirty.value
            || isDirty.value
            || hasAnnotationChanges()
            || pageLabelsDirty.value
            || bookmarksDirty.value
        );
        if (!hasPendingChanges) {
            return true;
        }

        await handleSave();

        return !(
            annotationDirty.value
            || isDirty.value
            || hasAnnotationChanges()
            || pageLabelsDirty.value
            || bookmarksDirty.value
        );
    }

    async function handleOpenFileFromUi() {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return;
        }
        await openFile();
        closeAllDropdowns();
    }

    async function handleOpenFileDirectWithPersist(path: string) {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return;
        }
        await openFileDirect(path);
        closeAllDropdowns();
    }

    async function handleCloseFileFromUi() {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return;
        }
        await closeFile();
        closeAllDropdowns();
    }

    async function openRecentFile(file: { originalPath: string }) {
        await handleOpenFileDirectWithPersist(file.originalPath);
    }

    return {
        handleOpenFileFromUi,
        handleOpenFileDirectWithPersist,
        handleCloseFileFromUi,
        openRecentFile,
    };
};
