import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { IAnnotationNoteWindowViewModel } from '@app/types/annotationNoteWindow';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { ICloseFileFromUiOptions } from '@app/types/workspaceExpose';
import type { TPdfSource } from '@app/types/pdfUi';
import type { IRecentFile } from '@contracts/shared';
import { waitUntilIdle } from '@app/utils/asyncHelpers';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { getDocumentPickerCapability } from '@app/utils/platformDocuments';
import { didOpenDocument } from '@app/types/documentOpenOutcome';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';

const RECENT_OPEN_LOG_SECTION = 'recent-open';

type TPageFileOpenOutcome =
    | TDocumentOpenOutcome
    | {
        status: 'blocked';
        reason: 'persistence-gate';
    }
    | {
        status: 'opened-in-new-tab';
        result: TOpenFileResult;
    };

function didCompletePageFileOpen(outcome: TPageFileOpenOutcome) {
    return outcome.status === 'opened'
        || outcome.status === 'opened-in-new-tab';
}

export interface IPageFileOperationsDeps {
    pdfSrc: Ref<TPdfSource | null>;
    hasDocument: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    isExportingDocx: Ref<boolean>;
    isAnyAnnotationNoteSaving: Ref<boolean>;
    isDocumentOperationInProgress?: Ref<boolean> | ComputedRef<boolean>;
    annotationNoteWindows: Ref<IAnnotationNoteWindowViewModel[]>;
    hasPendingUnsavedChanges: ComputedRef<boolean>;
    annotationDirty: Ref<boolean>;
    isDirty: Ref<boolean>;
    recoveryDirtyBaseline?: Ref<boolean>;
    pageLabelsDirty: Ref<boolean>;
    bookmarksDirty: Ref<boolean>;
    persistAllAnnotationNotes: () => Promise<boolean>;
    handleSave: () => Promise<unknown>;
    pickFileToOpen: () => Promise<TOpenFileResult | null>;
    openFile: (preSelected?: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    openFileDirect: (path: TDocumentRef) => Promise<TDocumentOpenOutcome>;
    openFileDirectBatch: (paths: TDocumentRef[]) => Promise<TDocumentOpenOutcome>;
    closeFile: () => void | Promise<void>;
    closeAllDropdowns: () => void;
    emitOpenInNewTab: (pathOrResult: TDocumentRef | TOpenFileResult) => void;
}

export const usePageFileOperations = (deps: IPageFileOperationsDeps) => {
    const {
        pdfSrc,
        hasDocument,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        isDocumentOperationInProgress,
        annotationNoteWindows,
        hasPendingUnsavedChanges,
        annotationDirty,
        isDirty,
        recoveryDirtyBaseline,
        pageLabelsDirty,
        bookmarksDirty,
        persistAllAnnotationNotes,
        handleSave,
        pickFileToOpen,
        openFile,
        openFileDirect,
        openFileDirectBatch,
        closeFile,
        closeAllDropdowns,
        emitOpenInNewTab,
    } = deps;
    const lastOpenOutcome = ref<TPageFileOpenOutcome | null>(null);

    function recordOpenOutcome(outcome: TPageFileOpenOutcome) {
        lastOpenOutcome.value = outcome;
        return outcome;
    }

    async function waitUntilAllIdle() {
        await waitUntilIdle(() =>
            isAnySaving.value
            || isHistoryBusy.value
            || isExportingDocx.value
            || isAnyAnnotationNoteSaving.value
            || (isDocumentOperationInProgress?.value ?? false),
        );
    }

    function getBusyState() {
        return {
            isAnySaving: isAnySaving.value,
            isHistoryBusy: isHistoryBusy.value,
            isExportingDocx: isExportingDocx.value,
            isAnyAnnotationNoteSaving: isAnyAnnotationNoteSaving.value,
            isDocumentOperationInProgress: isDocumentOperationInProgress?.value ?? false,
        };
    }

    function hasBusyOperation() {
        return isAnySaving.value
            || isHistoryBusy.value
            || isExportingDocx.value
            || isAnyAnnotationNoteSaving.value
            || (isDocumentOperationInProgress?.value ?? false);
    }

    function hasPendingPersistenceChanges() {
        return hasPendingUnsavedChanges.value;
    }

    function logPersistenceGateStart() {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Ensuring document is persisted before switch', {
            busyState: getBusyState(),
            annotationNoteWindows: annotationNoteWindows.value.length,
            annotationDirty: annotationDirty.value,
            isDirty: isDirty.value,
            pageLabelsDirty: pageLabelsDirty.value,
            bookmarksDirty: bookmarksDirty.value,
        });
    }

    function logPendingChangesAfterSave() {
        BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: pending changes remain after save attempt', {
            annotationDirty: annotationDirty.value,
            isDirty: isDirty.value,
            pageLabelsDirty: pageLabelsDirty.value,
            bookmarksDirty: bookmarksDirty.value,
        });
    }

    async function persistOpenAnnotationNotes() {
        if (annotationNoteWindows.value.length === 0) {
            return true;
        }

        const savedAllNotes = await persistAllAnnotationNotes();
        if (!savedAllNotes) {
            BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: failed to persist annotation note windows');
        }
        return savedAllNotes;
    }

    async function savePendingChangesBeforeSwitch() {
        if (!hasPendingPersistenceChanges()) {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Switch allowed: no pending changes');
            return true;
        }

        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Pending changes detected, triggering save before switch');
        try {
            await handleSave();
        } catch (saveError) {
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Switch blocked: save before switch threw', {error: getErrorMessage(saveError)}, {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            });
            return false;
        }

        const canProceed = !hasPendingPersistenceChanges();
        if (!canProceed) {
            logPendingChangesAfterSave();
        }
        return canProceed;
    }

    async function ensureCurrentDocumentPersistedBeforeSwitch() {
        if (!pdfSrc.value) {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Switch allowed: no current document loaded');
            return true;
        }

        logPersistenceGateStart();

        try {
            await waitUntilAllIdle();
            if (hasBusyOperation()) {
                BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: workspace remained busy after idle wait', {busyState: getBusyState()});
                return false;
            }

            if (!await persistOpenAnnotationNotes()) {
                return false;
            }

            return await savePendingChangesBeforeSwitch();
        } catch (persistError) {
            BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Switch blocked: persistence gate threw unexpectedly', {error: getErrorMessage(persistError)}, {
                code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                context: {},
            });
            return false;
        }
    }

    async function runPickerWithPersistenceDetailed(
        pick: () => Promise<TOpenFileResult | null>,
        options: { openGeneratedInNewTab: boolean },
    ) {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return recordOpenOutcome({
                status: 'blocked',
                reason: 'persistence-gate',
            });
        }

        const result = await pick();
        if (!result) {
            return recordOpenOutcome({ status: 'cancelled' });
        }

        if (
            options.openGeneratedInNewTab
            && result.kind === 'pdf'
            && result.isGenerated
            && hasDocument.value
        ) {
            emitOpenInNewTab(result);
            closeAllDropdowns();
            return recordOpenOutcome({
                status: 'opened-in-new-tab',
                result,
            });
        }

        return runOpenOutcomeDetailed(() => openFile(result));
    }

    async function runPickerWithPersistence(
        pick: () => Promise<TOpenFileResult | null>,
        options: { openGeneratedInNewTab: boolean },
    ) {
        return didCompletePageFileOpen(await runPickerWithPersistenceDetailed(pick, options));
    }

    async function handleOpenFileFromUiDetailed() {
        return runPickerWithPersistenceDetailed(pickFileToOpen, { openGeneratedInNewTab: true });
    }

    async function handleOpenFileFromUi() {
        return didCompletePageFileOpen(await handleOpenFileFromUiDetailed());
    }

    async function pickCombineFiles() {
        return getDocumentPickerCapability().openCombineDialog();
    }

    async function handleCombineImages() {
        return runPickerWithPersistence(pickCombineFiles, { openGeneratedInNewTab: true });
    }

    async function handleCombineImagesDetailed() {
        return runPickerWithPersistenceDetailed(pickCombineFiles, { openGeneratedInNewTab: true });
    }

    async function pickFolderToOpen() {
        return getDocumentPickerCapability().openFolderDialog();
    }

    async function handleOpenFolderFromUi() {
        return runPickerWithPersistence(pickFolderToOpen, { openGeneratedInNewTab: true });
    }

    async function handleOpenFolderFromUiDetailed() {
        return runPickerWithPersistenceDetailed(pickFolderToOpen, { openGeneratedInNewTab: true });
    }

    async function handleOpenFileDirectWithPersistDetailed(path: TDocumentRef) {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'handleOpenFileDirectWithPersist called', {
            path,
            hadDocumentBeforeOpen: Boolean(pdfSrc.value),
            busyState: getBusyState(),
        });

        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Open path aborted by persistence gate', { path });
            return recordOpenOutcome({
                status: 'blocked',
                reason: 'persistence-gate',
            });
        }
        let outcome = await openFileDirect(path);
        if (outcome.status === 'stale' && !pdfSrc.value) {
            BrowserLogger.info(RECENT_OPEN_LOG_SECTION, 'Retrying stale direct open once before returning to empty state', { path });
            outcome = await openFileDirect(path);
        }
        const opened = didOpenDocument(outcome);
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openFileDirect resolved', {
            path,
            status: outcome.status,
            hasDocumentAfterDirectOpen: Boolean(pdfSrc.value),
        });

        if (!opened) {
            BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Open path finished without an active document', {
                path,
                status: outcome.status,
                error: outcome.status === 'failed' ? outcome.error : undefined,
            });
            return recordOpenOutcome(outcome);
        }
        closeAllDropdowns();
        return recordOpenOutcome(outcome);
    }

    async function handleOpenFileDirectWithPersist(path: TDocumentRef) {
        return didCompletePageFileOpen(await handleOpenFileDirectWithPersistDetailed(path));
    }

    async function runOpenOutcomeDetailed(open: () => Promise<TDocumentOpenOutcome>) {
        const outcome = await open();
        if (
            outcome.status === 'opened'
            && outcome.result.kind === 'pdf'
            && outcome.result.recoveryDirtyBaseline === true
        ) {
            if (recoveryDirtyBaseline) {
                recoveryDirtyBaseline.value = true;
            }
            isDirty.value = true;
        }
        const opened = didOpenDocument(outcome);
        if (opened) {
            closeAllDropdowns();
        }
        return recordOpenOutcome(outcome);
    }

    async function handleOpenFileWithResultDetailed(result: TOpenFileResult) {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return recordOpenOutcome({
                status: 'blocked',
                reason: 'persistence-gate',
            });
        }
        return runOpenOutcomeDetailed(() => openFile(result));
    }

    async function handleOpenFileWithResult(result: TOpenFileResult) {
        return didCompletePageFileOpen(await handleOpenFileWithResultDetailed(result));
    }

    async function handleOpenFileDirectBatchWithPersistDetailed(paths: TDocumentRef[]) {
        const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
        if (!canProceed) {
            return recordOpenOutcome({
                status: 'blocked',
                reason: 'persistence-gate',
            });
        }
        return runOpenOutcomeDetailed(() => openFileDirectBatch(paths));
    }

    async function handleOpenFileDirectBatchWithPersist(paths: TDocumentRef[]) {
        return didCompletePageFileOpen(await handleOpenFileDirectBatchWithPersistDetailed(paths));
    }

    async function handleCloseFileFromUi(options: ICloseFileFromUiOptions = {}) {
        const shouldPersist = options.persist ?? true;

        if (shouldPersist) {
            const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
            if (!canProceed) {
                return false;
            }
        } else {
            await waitUntilAllIdle();
            if (hasBusyOperation()) {
                return false;
            }
        }

        options.onCloseCommit?.();
        await closeFile();
        closeAllDropdowns();
        return true;
    }

    async function openRecentFileDetailed(file: IRecentFile) {
        BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'openRecentFile invoked', {path: file.originalPath});

        return handleOpenFileDirectWithPersistDetailed(file.originalPath);
    }

    async function openRecentFile(file: IRecentFile) {
        return didCompletePageFileOpen(await openRecentFileDetailed(file));
    }

    return {
        lastOpenOutcome,
        handleOpenFileFromUiDetailed,
        handleOpenFileFromUi,
        handleOpenFolderFromUiDetailed,
        handleOpenFolderFromUi,
        handleCombineImagesDetailed,
        handleCombineImages,
        handleOpenFileDirectWithPersistDetailed,
        handleOpenFileDirectWithPersist,
        handleOpenFileDirectBatchWithPersistDetailed,
        handleOpenFileDirectBatchWithPersist,
        handleOpenFileWithResultDetailed,
        handleOpenFileWithResult,
        handleCloseFileFromUi,
        openRecentFileDetailed,
        openRecentFile,
    };
};
