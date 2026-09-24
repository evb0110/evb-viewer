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
import type { FailureReceipt } from '@contracts/diagnostics/failureReceipt';
import { waitUntilIdle } from '@app/utils/asyncHelpers';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useFailureToast } from '@app/composables/useFailureToast';
import { dirtyTabCloseConfirmationKey } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import type { TDirtyTabCloseConfirmation } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import { getErrorMessage } from '@app/utils/error';
import { getDocumentPickerCapability } from '@app/utils/platformDocuments';
import { didOpenDocument } from '@app/types/documentOpenOutcome';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { IWorkspaceOpenRequest } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import {
    describeDocumentTarget,
    describeOpenResult,
} from '@app/modules/workspace-shell/document-sessions/describeDocumentTarget';

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
    tabId?: string;
    requestDirtyTabCloseConfirmation?: TDirtyTabCloseConfirmation;
    pdfSrc: Ref<TPdfSource | null>;
    hasDocument: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isHistoryBusy: Ref<boolean>;
    isExportingDocx: Ref<boolean>;
    isAnyAnnotationNoteSaving: Ref<boolean>;
    isDocumentOperationInProgress?: Ref<boolean> | ComputedRef<boolean>;
    hasSaveFailure?: Ref<boolean> | ComputedRef<boolean>;
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
    /** Runs one open as the tab controller's transaction, which ends when the viewer presents it. */
    runDocumentOpen: (request: IWorkspaceOpenRequest, run: () => Promise<boolean>) => Promise<boolean>;
}

export const usePageFileOperations = (deps: IPageFileOperationsDeps) => {
    const {
        pdfSrc,
        tabId,
        requestDirtyTabCloseConfirmation: requestDirtyTabCloseConfirmationFromDeps,
        hasDocument,
        isAnySaving,
        isHistoryBusy,
        isExportingDocx,
        isAnyAnnotationNoteSaving,
        isDocumentOperationInProgress,
        hasSaveFailure,
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
        runDocumentOpen,
    } = deps;
    const toast = useToast();
    const { t } = useTypedI18n();
    const { presentFailureToast } = useFailureToast();
    const requestDirtyTabCloseConfirmation = requestDirtyTabCloseConfirmationFromDeps
        ?? (getCurrentInstance()
            ? inject(dirtyTabCloseConfirmationKey, null)
            : null);
    const lastOpenOutcome = ref<TPageFileOpenOutcome | null>(null);
    let busyFeedbackToastId: string | number | null = null;
    const pendingDirectOpenRequests = new Map<TDocumentRef, Promise<TPageFileOpenOutcome>>();

    function recordOpenOutcome(outcome: TPageFileOpenOutcome) {
        lastOpenOutcome.value = outcome;
        return outcome;
    }

    // The transaction starts in the command's own call so page commands that
    // follow it queue behind the open instead of reaching an empty viewer.
    async function trackOpen(
        request: IWorkspaceOpenRequest,
        open: () => Promise<TPageFileOpenOutcome>,
    ): Promise<TPageFileOpenOutcome> {
        const result: {outcome: TPageFileOpenOutcome} = {outcome: {status: 'cancelled'}};
        const presented = await runDocumentOpen(request, async () => {
            result.outcome = await open();
            return result.outcome.status === 'opened';
        });
        return presented || result.outcome.status !== 'opened'
            ? result.outcome
            : recordOpenOutcome({status: 'cancelled'});
    }

    type TBusyGateAction = 'close' | 'switch';

    function notifyBusyGate(action: TBusyGateAction) {
        if (busyFeedbackToastId !== null) {
            return;
        }

        const busyToast = toast.add({
            color: 'info',
            title: t('notifications.documentBusyTitle'),
            description: t(action === 'close'
                ? 'notifications.closingAfterPageProcessing'
                : 'notifications.switchingAfterPageProcessing'),
        });
        busyFeedbackToastId = busyToast.id;
    }

    function clearBusyGateFeedback() {
        if (busyFeedbackToastId === null) {
            return;
        }

        toast.remove(busyFeedbackToastId);
        busyFeedbackToastId = null;
    }

    async function waitUntilAllIdle(action?: TBusyGateAction) {
        if (action && hasBusyOperation()) {
            notifyBusyGate(action);
        }

        try {
            return await waitUntilIdle(() =>
                isAnySaving.value
                || isHistoryBusy.value
                || isExportingDocx.value
                || isAnyAnnotationNoteSaving.value
                || (isDocumentOperationInProgress?.value ?? false),
            );
        } finally {
            clearBusyGateFeedback();
        }
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

    function notifySaveFailure(receipt?: FailureReceipt) {
        if (hasSaveFailure?.value) {
            return;
        }

        const failure = receipt ?? BrowserLogger.error(
            RECENT_OPEN_LOG_SECTION,
            'Persistence gate could not complete the save',
            {},
            {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'},
        );
        presentFailureToast({
            failure,
            title: t('errors.file.save'),
            description: t('errors.save.notCompleted'),
        });
    }

    async function persistOpenAnnotationNotes() {
        if (annotationNoteWindows.value.length === 0) {
            return true;
        }

        const savedAllNotes = await persistAllAnnotationNotes();
        if (!savedAllNotes) {
            BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: failed to persist annotation note windows');
            notifySaveFailure();
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
            const saveResult = await handleSave();
            const canProceed = saveResult !== false && !hasPendingPersistenceChanges();
            if (!canProceed) {
                logPendingChangesAfterSave();
                notifySaveFailure();
            }
            return canProceed;
        } catch (saveError) {
            const failure = BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Switch blocked: save before switch threw', {error: getErrorMessage(saveError)}, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
            notifySaveFailure(failure);
            return false;
        }
    }

    async function resolveDirtySwitchDecision() {
        if (!hasPendingPersistenceChanges()) {
            return 'clean' as const;
        }

        if (!tabId || !requestDirtyTabCloseConfirmation) {
            const failure = BrowserLogger.error(
                RECENT_OPEN_LOG_SECTION,
                'Switch blocked: dirty-document decision is unavailable',
                {tabId: tabId ?? null},
                {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'},
            );
            notifySaveFailure(failure);
            return 'cancel' as const;
        }

        try {
            return await requestDirtyTabCloseConfirmation(tabId);
        } catch (decisionError) {
            const failure = BrowserLogger.error(
                RECENT_OPEN_LOG_SECTION,
                'Switch blocked: dirty-document decision failed',
                {
                    error: getErrorMessage(decisionError),
                    tabId,
                },
                {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'},
            );
            notifySaveFailure(failure);
            return 'cancel' as const;
        }
    }

    async function ensureCurrentDocumentPersistedBeforeSwitch() {
        if (!pdfSrc.value) {
            BrowserLogger.debug(RECENT_OPEN_LOG_SECTION, 'Switch allowed: no current document loaded');
            return true;
        }

        logPersistenceGateStart();

        try {
            const settled = await waitUntilAllIdle('switch');
            if (!settled || hasBusyOperation()) {
                BrowserLogger.warn(RECENT_OPEN_LOG_SECTION, 'Switch blocked: workspace remained busy after idle wait', {busyState: getBusyState()});
                notifySaveFailure();
                return false;
            }

            const decision = await resolveDirtySwitchDecision();
            if (decision === 'cancel') {
                return false;
            }
            if (decision === 'discard') {
                return true;
            }
            if (decision === 'save' && !await persistOpenAnnotationNotes()) {
                return false;
            }

            return decision === 'save'
                ? await savePendingChangesBeforeSwitch()
                : true;
        } catch (persistError) {
            const failure = BrowserLogger.error(RECENT_OPEN_LOG_SECTION, 'Switch blocked: persistence gate threw unexpectedly', {error: getErrorMessage(persistError)}, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
            notifySaveFailure(failure);
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

        return trackOpen(describeOpenResult(result), () => runOpenOutcomeDetailed(() => openFile(result)));
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

    async function runOpenFileDirectWithPersistDetailed(path: TDocumentRef) {
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

    function handleOpenFileDirectWithPersistDetailed(path: TDocumentRef) {
        const pending = pendingDirectOpenRequests.get(path);
        if (pending) {
            return pending;
        }

        const request = trackOpen({
            kind: 'open',
            target: describeDocumentTarget(path),
        }, () => runOpenFileDirectWithPersistDetailed(path));
        pendingDirectOpenRequests.set(path, request);
        void request.then(
            () => {
                if (pendingDirectOpenRequests.get(path) === request) {
                    pendingDirectOpenRequests.delete(path);
                }
            },
            () => {
                if (pendingDirectOpenRequests.get(path) === request) {
                    pendingDirectOpenRequests.delete(path);
                }
            },
        );
        return request;
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

    function handleOpenFileWithResultDetailed(result: TOpenFileResult) {
        return trackOpen(describeOpenResult(result), async () => {
            const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
            if (!canProceed) {
                return recordOpenOutcome({
                    status: 'blocked',
                    reason: 'persistence-gate',
                });
            }
            return runOpenOutcomeDetailed(() => openFile(result));
        });
    }

    async function handleOpenFileWithResult(result: TOpenFileResult) {
        return didCompletePageFileOpen(await handleOpenFileWithResultDetailed(result));
    }

    function handleOpenFileDirectBatchWithPersistDetailed(paths: TDocumentRef[]) {
        return trackOpen({
            kind: 'open',
            target: null,
        }, async () => {
            const canProceed = await ensureCurrentDocumentPersistedBeforeSwitch();
            if (!canProceed) {
                return recordOpenOutcome({
                    status: 'blocked',
                    reason: 'persistence-gate',
                });
            }
            return runOpenOutcomeDetailed(() => openFileDirectBatch(paths));
        });
    }

    async function handleOpenFileDirectBatchWithPersist(paths: TDocumentRef[]) {
        return didCompletePageFileOpen(await handleOpenFileDirectBatchWithPersistDetailed(paths));
    }

    async function handleCloseFileFromUi(options: ICloseFileFromUiOptions = {}) {
        const shouldPersist = options.persist ?? false;
        const settled = await waitUntilAllIdle('close');
        if (!settled || hasBusyOperation()) {
            return false;
        }

        if (shouldPersist) {
            try {
                if (!await persistOpenAnnotationNotes() || !await savePendingChangesBeforeSwitch()) {
                    return false;
                }
            } catch (persistError) {
                const failure = BrowserLogger.error(
                    RECENT_OPEN_LOG_SECTION,
                    'Close blocked: persistence before close threw',
                    {error: getErrorMessage(persistError)},
                    {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'},
                );
                notifySaveFailure(failure);
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
