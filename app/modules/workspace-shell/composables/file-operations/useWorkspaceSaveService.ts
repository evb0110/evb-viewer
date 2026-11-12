import type { Ref } from 'vue';
import type {TDocumentCommitReceipt} from '@app/types/workspaceExpose';
import {crashCheckpointBeforeSaveKey} from '@app/modules/workspace-shell/checkpoint/useWorkspaceCrashCheckpoint';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TRequestId } from '@contracts/shared';
import type { ExpectedOutcome } from '@contracts/diagnostics/failureReceipt';
import {getFailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {isFailurePresentation} from '@app/composables/useFailureToast';
import type {
    IPdfOptimizeOptions,
    IPdfOptimizeResult,
} from '@contracts/electronApiDocuments';
import {
    getDocumentMutationErrorPayload,
    isStaleRevisionError,
} from '@contracts/documentMutationErrors';
import type {
    IPdfViewerSaveTransactionResult,
    INativePdfMutationProjection,
} from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { toPdfDateString } from '@app/utils/pdfDate';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import {committedAffectedPageIndices} from '@app/modules/pdf-viewer/public';
import type {
    TWorkspaceFailureSurface,
    TWorkspaceSaveFailureReason,
} from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import { useWorkspaceFailureSurface } from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import type {
    ISaveCompletionPolicy,
    TWorkspaceSaveAbort,
    TWorkspaceSaveExecutionResult,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionResult';
import {
    abortReasonForPersistResult,
    notSavedAfterWrite,
    notSavedBeforeWrite,
    workingCopySaveResult,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionResult';
import {unencryptedSaveNoticeGate} from '@app/modules/workspace-shell/composables/file-operations/unencryptedSaveNoticeGate';
import {
    nowMs,
    timedSavePhase,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveTiming';
import {
    captureBaseline,
    collectDirtyState,
    isSaveAsRequest,
    resolveOperationKind,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveState';
import {
    buildSaveTransactionRequest,
    completeSuccessfulSaveState,
    createPageMutationWriterSave,
    createRecoverySnapshot as createRecoverySnapshotForService,
    createReloadWaiter,
    createWorkspaceSavePlan,
    getNativeSaveTransactionOptions,
    getCompletionBaseline,
    getSaveMode,
    isTargetCurrent,
    withReloadWaiter,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionSupport';
import type {
    IWorkspaceSaveDependencies,
    IWorkspaceSaveTarget,
    TWorkspaceSavePlan,
    TWorkspaceSaveRequest,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionSupport';
export {
    buildSaveTransactionRequest,
    createWorkspaceSavePlan,
    getSaveFlow,
    getSaveMode,
    requiresNativePathBackedSave,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionSupport';
export type {
    IWorkspaceSaveDependencies,
    IWorkspaceSaveBaseline,
    IWorkspaceSaveDirtyState,
    IWorkspaceSaveTarget,
    IWorkspaceSerializedSaveBody,
    TWorkspaceSavePlan,
    TWorkspaceSaveRequest,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionSupport';

const SLOW_SAVE_TOTAL_WARN_MS = 10_000;

type TSingleWriterSaveTransaction = IPdfViewerSaveTransactionResult & {
    /** False when a parse of some pages cannot replace the store; nothing changed. */
    replaceFromDocument?: (result: IPdfAnnotationParseResult, deletedReplyRefs?: readonly string[]) => boolean;
    affectedPageIndices?: readonly number[];
};

async function validateWorkingCopy(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveFailureReason | null> {
    const expectedWorkingPath = plan.target.expectedWorkingPath;
    if (!expectedWorkingPath) {
        return 'persist-rejected';
    }
    if (deps.document.workingCopyPath.value !== expectedWorkingPath) {
        return 'document-changed';
    }
    const validation = await timedSavePhase(
        'validate-pdf-path',
        () => deps.persistence.validatePdfPath(expectedWorkingPath),
        result => ({
            isValid: result.isValid,
            warningCount: result.warnings.length,
            errorCount: result.errors.length,
        }),
    );
    if (!validation.isValid) {
        BrowserLogger.warn('workspace', 'Save aborted because PDF validation failed', {
            errors: validation.errors,
            warnings: validation.warnings,
        });
        return 'validation-rejected';
    }
    if (!isTargetCurrent(plan, deps)) {
        return 'document-changed';
    }
    deps.failureSurface?.reportSaveValidationLimitation(validation);
    return null;
}

async function executeWorkingCopySave(
    plan: Extract<TWorkspaceSavePlan, {kind: 'serialized'}>,
    deps: IWorkspaceSaveDependencies,
    completion: Partial<ISaveCompletionPolicy> = {},
): Promise<TWorkspaceSaveExecutionResult> {
    const reloadWaiter = createReloadWaiter(plan.body, deps);
    return withReloadWaiter(reloadWaiter, async () => {
        const validationFailure = await validateWorkingCopy(plan, deps);
        if (validationFailure) {
            return notSavedBeforeWrite(validationFailure, plan.target.expectedRevisionToken, reloadWaiter);
        }
        const opts = {
            preserveLoadedSource: plan.body.preserveLoadedSource,
            saveMode: getSaveMode(plan),
            expectedWorkingPath: plan.target.expectedWorkingPath,
            expectedDocumentRevisionToken: plan.target.expectedRevisionToken,
        };
        const persisted = plan.destination === 'save-as'
            ? await timedSavePhase(
                'persist-save_as-working-copy',
                () => deps.persistence.saveAs(undefined, {
                    ...opts,
                    optimizeLossless: plan.request.kind === 'save-as'
                        && plan.request.optimizeLossless,
                }),
            )
            : await timedSavePhase(
                'persist-save-working-copy',
                () => deps.persistence.saveWorkingCopy(opts),
            );
        return workingCopySaveResult(persisted, reloadWaiter, completion);
    });
}

async function executeNativeWorkingCopySave(
    plan: Extract<TWorkspaceSavePlan, {kind: 'native-working-copy'}>,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    const reloadWaiter = deps.lifecycle.preparePostSaveReload?.() ?? null;
    return withReloadWaiter(reloadWaiter, async () => {
        if (
            !plan.target.expectedWorkingPath
            || !isTargetCurrent(plan, deps)
        ) {
            return notSavedBeforeWrite('document-changed', plan.target.expectedRevisionToken, reloadWaiter);
        }
        const persist = plan.operation === 'repair'
            ? deps.persistence.repairWorkingCopy
            : deps.persistence.optimizeWorkingCopy;
        if (!persist) {
            return notSavedBeforeWrite('capability-unavailable', plan.target.expectedRevisionToken, reloadWaiter);
        }
        const persisted = await timedSavePhase(
            `persist-save-native-working-copy-${plan.operation}`,
            () => persist({
                saveMode: getSaveMode(plan),
                expectedWorkingPath: plan.target.expectedWorkingPath,
                expectedDocumentRevisionToken: plan.target.expectedRevisionToken,
            }),
        );
        return workingCopySaveResult(persisted, reloadWaiter);
    });
}

async function persistNativeMutationProjection(
    plan: Extract<TWorkspaceSavePlan, {kind: 'native-mutation' | 'native-repair'}>,
    projection: INativePdfMutationProjection,
    deps: IWorkspaceSaveDependencies,
    verifyPathBeforeExpose?: (path: TDocumentRef, knownSize: number) => Promise<void>,
    assertBeforeExpose?: () => Promise<void> | void,
    workingCopyOnly = false,
) {
    if (!isTargetCurrent(plan, deps) || !plan.target.expectedWorkingPath) {
        return null;
    }
    const opts = {
        saveMode: getSaveMode(plan),
        preserveLoadedSource: true,
        expectedWorkingPath: plan.target.expectedWorkingPath,
        expectedDocumentRevisionToken: plan.target.expectedRevisionToken,
        modifiedAt: toPdfDateString(new Date()),
        ...(workingCopyOnly ? {workingCopyOnly: true as const} : {}),
        ...(plan.request.kind === 'save-as' && plan.request.optimizeLossless ? {optimizeLossless: true} : {}),
        ...(verifyPathBeforeExpose ? {verifyPathBeforeExpose} : {}),
        ...(assertBeforeExpose ? {assertBeforeExpose} : {}),
    };
    const placedImageGeometryUpdates = projection.placedImageGeometryUpdates ?? [];
    const mutations = placedImageGeometryUpdates.length > 0
        && projection.mutations.placedImageGeometryUpdates === undefined
        ? {
            ...projection.mutations,
            placedImageGeometryUpdates,
        }
        : projection.mutations;
    return timedSavePhase(
        projection.phase,
        () => deps.persistence.trySavePdfNativeMutations(mutations, opts),
    );
}

async function executeNativeMutationSave(
    plan: Extract<TWorkspaceSavePlan, {kind: 'native-mutation'}>,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    const saveTransaction = await deps.pdf.runSaveTransaction(
        buildSaveTransactionRequest(
            plan,
            deps,
            plan.serializedFallback,
            {allowNativeMutationPlan: true},
        ),
    ) as TSingleWriterSaveTransaction;
    const projection = saveTransaction.nativeMutationProjection;
    if (!projection && saveTransaction.verifiedUnchangedWorkingCopy === true) {
        await saveTransaction.assertAnnotationSaveCurrent?.();
        const result = await executeWorkingCopySave({
            ...plan,
            kind: 'serialized',
            destination: plan.request.kind === 'save-as' ? 'save-as' : 'original',
            body: {
                ...plan.serializedFallback,
                source: 'working-copy',
                preserveLoadedSource: true,
            },
        }, deps, {markAnnotationStateSaved: true});
        if (result.status === 'saved') {
            saveTransaction.commitAnnotationSave?.();
        }
        return result;
    }
    if (!projection) {
        BrowserLogger.warn('workspace', 'Native PDF save had no mutation projection', {
            failure: saveTransaction.nativeRequiredFailure ?? null,
            annotationPlan: saveTransaction.annotationSavePlan,
        });
        return notSavedBeforeWrite('native-save-required', plan.target.expectedRevisionToken, null);
    }

    if (Object.keys(projection.mutations).length === 0 && !projection.placedImageGeometryUpdates?.length) {
        return notSavedBeforeWrite('native-save-required', plan.target.expectedRevisionToken, null);
    }

    let persisted = await persistNativeMutationProjection(
        plan,
        projection,
        deps,
        saveTransaction.verifyAnnotationSavePath,
        saveTransaction.assertAnnotationSaveCurrent,
    );
    if (persisted?.nativeRefusalCode === 'too-large') {
        return notSavedBeforeWrite('too-large-for-edit', plan.target.expectedRevisionToken, null);
    }
    if (!persisted) {
        return notSavedBeforeWrite('native-save-required', plan.target.expectedRevisionToken, null);
    }
    if (!persisted.success) {
        // As for an ordinary save: persistence ran and may have written the file.
        return workingCopySaveResult(persisted, null);
    }
    const materializedIdentityBindings = persisted.materializedIdentityBindings;
    const deleteEffects = persisted.annotationDeleteEffects;
    if (plan.request.kind === 'save-as' && !persisted.didSaveAs) {
        const currentRevisionToken = deps.document.revisionToken.value;
        const saveAsPersisted = await timedSavePhase(
            'persist-save_as-native-writer-output',
            () => deps.persistence.saveAs(undefined, {
                saveMode: 'save_as_rewrite',
                expectedWorkingPath: plan.target.expectedWorkingPath,
                expectedDocumentRevisionToken: currentRevisionToken,
                optimizeLossless: plan.request.kind === 'save-as' && plan.request.optimizeLossless,
            }),
        );
        if (!saveAsPersisted.success) {
            return notSavedAfterWrite(abortReasonForPersistResult(saveAsPersisted), null, saveAsPersisted.failure);
        }
        persisted = saveAsPersisted;
    }
    saveTransaction.commitAnnotationSave?.(
        persisted.materializedIdentityBindings ?? materializedIdentityBindings,
    );
    // A layer may be marked clean only if this save carried its edits; the
    // published mutations hold a key for each kind.
    const {
        bookmarks, pageLabels, ...annotationEdits
    } = projection.mutations;
    const annotationEditsWritten = Object.keys(annotationEdits).length > 0
        || Boolean(projection.placedImageGeometryUpdates?.length);
    const expectedWorkingPath = persisted.didSaveAs ? deps.document.workingCopyPath.value : plan.target.expectedWorkingPath;
    // Bind read-back to the published revision.
    const committedRevisionToken = deps.document.revisionToken.value;
    if (annotationEditsWritten && saveTransaction.replaceFromDocument
        && expectedWorkingPath && committedRevisionToken) {
        const parse = (pageIndices?: number[]) => timedSavePhase(
            'parse-committed-pdf-annotations',
            () => getDocumentWorkingCopyCapability().parsePdfAnnotations(
                expectedWorkingPath,
                {
                    expectedDocumentRevisionToken: committedRevisionToken,
                    ...(pageIndices ? {pageIndices} : {}),
                },
            ),
            () => ({pageCount: pageIndices?.length ?? 'all'}),
        );
        const pageIndices = committedAffectedPageIndices(saveTransaction.affectedPageIndices, projection, deleteEffects);
        const replacedPages = pageIndices !== undefined && await parse(pageIndices).then(
            parsed => saveTransaction.replaceFromDocument!(parsed, deleteEffects?.deletedReplyRefs),
            (error: unknown) => {
                if (isStaleRevisionError(error) || (error instanceof Error && error.name === 'AbortError')) {
                    throw error;
                }
                BrowserLogger.warn('workspace', 'Parsing the saved pages failed; parsing the whole document', {error});
                return false;
            },
        );
        if (!replacedPages) {
            saveTransaction.replaceFromDocument(await parse());
        }
    }

    return {
        status: 'saved',
        persisted,
        serializedChanges: true,
        reloadWaiter: null,
        completion: {
            markAnnotationStateSaved: annotationEditsWritten,
            markBookmarksStateSaved: bookmarks !== undefined,
            markPageLabelsStateSaved: pageLabels !== undefined,
        },
    };
}

async function executeNativeRepairSave(
    plan: Extract<TWorkspaceSavePlan, {kind: 'native-repair'}>,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    const saveTransaction = await deps.pdf.runSaveTransaction(
        buildSaveTransactionRequest(plan, deps, plan.serializedFallback, {allowNativeMutationPlan: true}),
    ) as TSingleWriterSaveTransaction;
    const projection = saveTransaction.nativeMutationProjection;
    if (!projection) {
        return notSavedBeforeWrite('native-save-required', plan.target.expectedRevisionToken, null);
    }
    if (Object.keys(projection.mutations).length === 0 && !projection.placedImageGeometryUpdates?.length) {
        return notSavedBeforeWrite('native-save-required', plan.target.expectedRevisionToken, null);
    }

    const staged = await persistNativeMutationProjection(
        plan,
        projection,
        deps,
        saveTransaction.verifyAnnotationSavePath,
        saveTransaction.assertAnnotationSaveCurrent,
        true,
    );
    if (staged?.nativeRefusalCode === 'too-large') {
        return notSavedBeforeWrite('too-large-for-edit', plan.target.expectedRevisionToken, null);
    }
    if (!staged) {
        return notSavedBeforeWrite('native-save-required', plan.target.expectedRevisionToken, null);
    }
    if (!staged.success) {
        return notSavedAfterWrite(abortReasonForPersistResult(staged), null, staged.failure);
    }

    const repaired = deps.persistence.repairWorkingCopy;
    if (!repaired) {
        return notSavedAfterWrite('capability-unavailable', null);
    }
    const repairedResult = await timedSavePhase(
        'persist-repair-native-staged-working-copy',
        () => repaired({
            saveMode: 'rewrite',
            expectedWorkingPath: plan.target.expectedWorkingPath,
            expectedDocumentRevisionToken: deps.document.revisionToken.value,
        }),
    );
    if (!repairedResult.success) {
        return notSavedAfterWrite(abortReasonForPersistResult(repairedResult), null, repairedResult.failure);
    }

    saveTransaction.commitAnnotationSave?.(staged.materializedIdentityBindings);
    return {
        status: 'saved',
        persisted: repairedResult,
        serializedChanges: true,
        reloadWaiter: null,
        completion: {
            markAnnotationStateSaved: false,
            markBookmarksStateSaved: projection.mutations.bookmarks !== undefined,
            markPageLabelsStateSaved: projection.mutations.pageLabels !== undefined,
        },
    };
}

async function executeOptimizationSave(
    plan: Extract<TWorkspaceSavePlan, {kind: 'optimization'}>,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    const reloadWaiter = deps.lifecycle.preparePostSaveReload?.() ?? null;
    return withReloadWaiter(reloadWaiter, async () => {
        const validationFailure = await validateWorkingCopy(plan, deps);
        if (validationFailure) {
            return notSavedBeforeWrite(validationFailure, plan.target.expectedRevisionToken, reloadWaiter);
        }
        const persist = deps.persistence.optimizeWorkingCopyAsCopy;
        if (!persist) {
            return notSavedBeforeWrite('capability-unavailable', plan.target.expectedRevisionToken, reloadWaiter);
        }
        const persisted = await timedSavePhase(
            'persist-optimize-copy-native-working-copy',
            () => persist(
                plan.request.options,
                plan.request.requestId,
                {
                    saveMode: getSaveMode(plan),
                    expectedWorkingPath: plan.target.expectedWorkingPath,
                    expectedDocumentRevisionToken: plan.target.expectedRevisionToken,
                    ...(plan.request.onResult ? {onResult: plan.request.onResult} : {}),
                    ...(plan.request.preparedOptimize ? {preparedOptimize: plan.request.preparedOptimize} : {}),
                    ...(plan.request.signal ? {signal: plan.request.signal} : {}),
                },
            ),
        );
        return workingCopySaveResult(persisted, reloadWaiter);
    });
}

function executeSavePlan(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    if (plan.kind === 'optimization') {
        return executeOptimizationSave(plan, deps);
    }
    if (plan.kind === 'native-working-copy') {
        return executeNativeWorkingCopySave(plan, deps);
    }
    if (plan.kind === 'native-mutation') {
        return executeNativeMutationSave(plan, deps);
    }
    if (plan.kind === 'native-repair') {
        return executeNativeRepairSave(plan, deps);
    }
    return executeWorkingCopySave(plan, deps);
}

export const useWorkspaceSaveService = (deps: IWorkspaceSaveDependencies) => {
    const failureSurface = deps.failureSurface ?? useWorkspaceFailureSurface();
    const persistCrashCheckpoint = getCurrentInstance() ? inject(crashCheckpointBeforeSaveKey, null) : null;
    const runWithDocumentOperationLease = deps.runWithDocumentOperationLease;
    let saveOperations = 0;
    // A Save shows as saving from its request until it ends, also while the
    // lease holds it behind an earlier one.
    const pendingSaves = new Map<Ref<boolean>, number>();
    function holdIndicator(indicator: Ref<boolean>) {
        pendingSaves.set(indicator, (pendingSaves.get(indicator) ?? 0) + 1);
        indicator.value = true;
        return () => {
            const remaining = (pendingSaves.get(indicator) ?? 1) - 1;
            pendingSaves.set(indicator, remaining);
            indicator.value = remaining > 0;
        };
    }
    // Each optimization owns a signal from its submit on: the workspace going
    // away ends it at any point; once its dirty save is done it is bound to
    // that working copy, and another working copy replacing it ends it too.
    const optimizeRequests = new Map<AbortController, TDocumentRef | null>();
    onScopeDispose(() => optimizeRequests.forEach((_bound, controller) => controller.abort()), true);
    watch(deps.document.workingCopyPath, path => optimizeRequests.forEach((bound, controller) => {
        if (bound !== null && bound !== path) controller.abort();
    }));
    // Set once the lease admits a save; the reading watch reads this, not the indicator.
    const isAnySaveAdmitted = ref(false);
    const acknowledgedUnencryptedSaveSessions = new Set<string>();
    const nativeSaveTransactionOptions = () => getNativeSaveTransactionOptions(deps);
    const createRecoverySnapshot = createRecoverySnapshotForService(
        deps,
        runWithDocumentOperationLease,
    );

    // A save that failed keeps its state until the workspace adopts a different
    // document or a fresh attempt supersedes it, so the status bar cannot
    // present an unsaved document as clean. The session and original path form
    // the document identity. Revision changes also happen during resync and
    // failed writes, so they must not clear the indicator.
    // The reset is synchronous: a queued one could land after the next attempt
    // has already reported its own failure and wipe it.
    watch(
        () => [
            deps.document.sessionKey.value,
            deps.document.originalPath.value,
        ],
        () => failureSurface.clearSaveFailure(),
        {flush: 'sync'},
    );

    async function executeSave(
        request: TWorkspaceSaveRequest,
        queuedTarget: Omit<IWorkspaceSaveTarget, 'expectedRevisionToken'>,
        onCommitted?: TDocumentCommitReceipt,
    ) {
        const releaseIndicator = holdIndicator(isSaveAsRequest(request) ? deps.status.isSavingAs : deps.status.isSaving);
        const queuedTargetIsCurrent = () => (
            deps.document.sessionKey.value === queuedTarget.expectedDocumentSessionKey
            && deps.document.originalPath.value === queuedTarget.expectedOriginalPath
            && deps.document.workingCopyPath.value === queuedTarget.expectedWorkingPath
        );
        saveOperations += 1;
        const operationId = `save-${saveOperations}`;
        failureSurface.clearSaveFailure();
        const startedAtMs = nowMs();
        let saveSucceeded = false;

        /**
         * A save outlives its own document: every failure below is reported
         * after at least one await, by which time the workspace may hold a
         * different file. Paths catch a replacement. They cannot catch a
         * reopen of the same file, so callers that have not written anything
         * yet also pin the revision token they started from; once this save
         * has written, the revision moves by design and cannot be compared.
         */
        function ownsCurrentDocument(expectedRevisionToken?: TDocumentRevisionToken | null) {
            return queuedTargetIsCurrent()
                && (expectedRevisionToken === undefined || deps.document.revisionToken.value === expectedRevisionToken);
        }

        function reportSaveFailureIfCurrent(
            reason: TWorkspaceSaveFailureReason,
            options: {
                detail?: string | null;
                expectedRevisionToken?: TDocumentRevisionToken | null;
                failure?: Parameters<TWorkspaceFailureSurface['reportSaveFailure']>[3];
                diagnostics?: Parameters<TWorkspaceFailureSurface['reportSaveFailure']>[4];
            } = {},
        ) {
            if (request.kind === 'optimize-copy' && reason === 'capability-unavailable') {
                BrowserLogger.warn('workspace', 'Optimization copy is unavailable', {
                    kind: 'expected',
                    code: 'temporarily-unavailable',
                } satisfies ExpectedOutcome);
                return false;
            }
            if (!ownsCurrentDocument(options.expectedRevisionToken)) {
                // The document that failed is gone. Toasting now would blame
                // whatever the user opened next, and the durable failure flag
                // would leave the status bar presenting a clean document as
                // unwritten for the rest of the session.
                BrowserLogger.debug('workspace', 'Dropped a save failure report for a replaced document', {
                    operationId,
                    reason,
                });
                return false;
            }
            return failureSurface.reportSaveFailure(
                operationId,
                reason,
                options.detail,
                options.failure,
                options.diagnostics,
                // The failure surface offers Save As where it can keep the changes elsewhere.
                () => {
                    if (ownsCurrentDocument()) {
                        void save({
                            kind: 'save-as',
                            optimizeLossless: deps.optimizePdfOnSaveAs?.value === true,
                        });
                    }
                },
            );
        }

        /**
         * A dismissed Save As dialog is the one abort the user already knows
         * about. Everything else is matched to the document it belongs to: a
         * pre-write abort touched nothing, so the revision it planned against
         * must still be the open one; a post-write abort has already moved the
         * revision by design, leaving the paths as the only comparable identity.
         */
        function reportSaveAbort(result: TWorkspaceSaveAbort) {
            if (result.reason === 'cancelled') {
                return false;
            }
            return reportSaveFailureIfCurrent(
                result.reason,
                result.origin.phase === 'pre-write'
                    ? {
                        expectedRevisionToken: result.origin.plannedRevisionToken,
                        ...(result.failure === undefined ? {} : {diagnostics: result.failure}),
                    }
                    : result.failure === undefined ? {} : {diagnostics: result.failure},
            );
        }

        const runSave = async () => {
            if (!queuedTargetIsCurrent()) {
                releaseIndicator();
                BrowserLogger.debug(
                    'workspace',
                    'Dropped a queued save after its document lease became stale',
                    {operationId},
                );
                return false;
            }
            // Set once the lease admits this save: a page operation's reload is not this save's.
            isAnySaveAdmitted.value = true;
            try {
                let plan: TWorkspaceSavePlan;
                let result: TWorkspaceSaveExecutionResult;
                try {
                    // Nothing has been written yet, so the revision seen here
                    // still identifies the open document.
                    const revisionBeforeNotes = deps.document.revisionToken.value;
                    if (
                        deps.annotations.openNoteCount.value > 0
                        && !await deps.annotations.persistOpenNotes()
                    ) {
                        reportSaveFailureIfCurrent('note-persistence-failed', {
                            expectedRevisionToken: revisionBeforeNotes,
                            failure: deps.annotations.getNoteFailurePresentation?.(),
                        });
                        return false;
                    }

                    // A nonempty FreeText editor remains outside annotation
                    // storage until PDF.js commits it. Save planning must run
                    // after that commit, otherwise the toolbar can start a save
                    // whose captured dirty state still describes a clean file.
                    await deps.pdf.commitEditorsForSave?.();
                    await persistCrashCheckpoint?.(deps.document.workingCopyPath.value);

                    plan = createWorkspaceSavePlan({
                        request,
                        target: {
                            ...queuedTarget,
                            expectedRevisionToken: deps.document.revisionToken.value,
                        },
                        baseline: captureBaseline(deps),
                        dirtyState: collectDirtyState(deps),
                        hasManagedShapes: deps.shapes.hasManagedShapes(),
                        canPersistNativeWorkingCopy: request.kind === 'repair'
                            ? Boolean(deps.persistence.repairWorkingCopy)
                            : request.kind === 'optimize'
                                ? Boolean(deps.persistence.optimizeWorkingCopy)
                                : false,
                        canPersistNativeRepair: request.kind === 'repair' && Boolean(deps.persistence.repairWorkingCopy),
                    });

                    result = await unencryptedSaveNoticeGate(
                        deps,
                        plan,
                        acknowledgedUnencryptedSaveSessions,
                    ) ?? await executeSavePlan(plan, {
                        ...deps,
                        failureSurface,
                    });
                    if (result.status !== 'saved') {
                        result.reloadWaiter?.cancel();
                        if (result.status === 'failed') throw result.error;
                        reportSaveAbort(result);
                        return false;
                    }
                    isAnySaveAdmitted.value = false;
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') return false;
                    // The revision moved after this save captured it: a conflict,
                    // told once. The user's edits stay unsaved for the next Save.
                    if (isStaleRevisionError(error)) {
                        reportSaveFailureIfCurrent('document-changed');
                        return false;
                    }
                    const failure = isFailurePresentation(error) ? error : getFailureReceipt(error)
                        ?? BrowserLogger.error('workspace', 'Save failed', error, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
                    const detail = isFailurePresentation(error) ? error.description ?? getErrorMessage(error) : getDocumentMutationErrorPayload(error)?.message
                        ?? getErrorMessage(error);
                    reportSaveFailureIfCurrent('unexpected-error', {
                        detail,
                        failure,
                        // Its cause lets an engine limit be told as one.
                        diagnostics: {
                            channel: 'save',
                            operation: 'persist',
                            phase: 'preflight',
                            reason: 'unknown',
                            message: detail,
                            cause: error,
                        },
                    });
                    return false;
                }
                const committedPath = deps.document.workingCopyPath.value;
                const committedRevision = result.persisted.documentRevision?.token;
                // The document still holds the revision this save committed.
                const holdsCommit = () => deps.document.sessionKey.value === queuedTarget.expectedDocumentSessionKey
                    && deps.document.workingCopyPath.value === committedPath && (!committedRevision || deps.document.revisionToken.value === committedRevision);
                try {
                    if (!holdsCommit()) return false;
                    const baseline = getCompletionBaseline(plan, result, deps);
                    await result.reloadWaiter?.promise.catch(error => BrowserLogger.warn('workspace', 'Saved PDF but failed to restore the reloaded view', error));
                    if (!holdsCommit()) return false;
                    completeSuccessfulSaveState(baseline, result.completion, deps);
                    await persistCrashCheckpoint?.(committedPath);
                    if (!holdsCommit()) return false;
                    if (result.persisted.outPath) deps.lifecycle.loadRecentFiles();
                    if (committedRevision) onCommitted?.(committedRevision);
                    saveSucceeded = true;
                    return true;
                } catch (error) {
                    if (!(error instanceof DOMException && error.name === 'AbortError') && holdsCommit()) {
                        failureSurface.reportSaveFailure(operationId, 'recovery-settlement-failed', getErrorMessage(error),
                            getFailureReceipt(error) ?? BrowserLogger.error('workspace', 'PDF saved but recovery settlement failed', error, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'}));
                    }
                    return false;
                }
            } finally {
                const durationMs = Math.round(nowMs() - startedAtMs);
                const log = durationMs >= SLOW_SAVE_TOTAL_WARN_MS
                    ? BrowserLogger.warn
                    : BrowserLogger.debug;
                log('workspace', 'Completed PDF save request', {
                    durationMs,
                    request: request.kind,
                    success: saveSucceeded,
                });
                releaseIndicator();
                isAnySaveAdmitted.value = false;
            }
        };
        return runWithDocumentOperationLease(resolveOperationKind(request), runSave);
    }

    // The document lease is the one queue. The target is captured when the
    // Save is requested and checked when the lease admits it.
    function save(request: TWorkspaceSaveRequest, onCommitted?: TDocumentCommitReceipt) {
        return executeSave(request, {
            expectedDocumentSessionKey: deps.document.sessionKey.value,
            expectedOriginalPath: deps.document.originalPath.value,
            expectedWorkingPath: deps.document.workingCopyPath.value,
        }, onCommitted);
    }

    const canSave = computed(() => failureSurface.hasSaveFailure.value || (deps.hasPendingUnsavedChanges?.value ?? (
        deps.annotations.dirty.value
        || deps.annotations.hasChanges()
        || deps.metadata.pageLabelsDirty.value
        || deps.metadata.bookmarksDirty.value
        || deps.shapes.hasChanges()
    )));
    const saveIfDirty = (onCommitted?: TDocumentCommitReceipt) => (
        deps.hasPendingUnsavedChanges && !canSave.value
            ? Promise.resolve(!failureSurface.hasSaveFailure.value)
            : save({kind: 'save'}, onCommitted)
    );

    return {
        save,
        hasSaveFailure: failureSurface.hasSaveFailure,
        canSave,
        isAnySaving: computed(() => deps.status.isSaving.value || deps.status.isSavingAs.value),
        isAnySaveAdmitted,
        handleSave: saveIfDirty,
        saveForExternalRead: saveIfDirty,
        getNativeSaveTransactionOptions: nativeSaveTransactionOptions,
        createRecoverySnapshot,
        createPageMutationWriterSave: (options: Omit<Parameters<typeof createPageMutationWriterSave>[0], 'save'>) => createPageMutationWriterSave({
            save: deps,
            ...options,
        }),
        handleSaveAs: (optimizeLossless = deps.optimizePdfOnSaveAs?.value === true) => save({
            kind: 'save-as',
            optimizeLossless,
        }),
        handleRepairSave: save.bind(null, {kind: 'repair'}),
        handleOptimizePdfForInteraction: async (onCommitted?: TDocumentCommitReceipt) => (
            (!canSave.value || await saveIfDirty()) && save({kind: 'optimize'}, onCommitted)
        ),
        handleOptimizePdfAsCopy: (
            options: IPdfOptimizeOptions,
            requestId?: TRequestId,
            onResult?: (result: IPdfOptimizeResult) => void,
        ) => {
            // A platform that picks the copy's target itself opens its picker now,
            // before any await, so the click that submitted the dialog reaches it.
            const sessionPath = deps.document.workingCopyPath.value;
            const nameFrom = deps.document.originalPath.value ?? sessionPath;
            const selection = nameFrom ? getDocumentFilesCapability().prepareOptimizePdfAsCopy?.(nameFrom) : undefined;
            const controller = new AbortController();
            optimizeRequests.set(controller, null);
            return (async () => {
                try {
                    const preparedOptimize = selection ? await selection : undefined;
                    // A canceled picker, a workspace that went away or another
                    // document that took over saves nothing.
                    if ((selection && !preparedOptimize) || controller.signal.aborted
                        || deps.document.workingCopyPath.value !== sessionPath) {
                        return false;
                    }
                    if (canSave.value && !await saveIfDirty()) {
                        return false;
                    }
                    if (controller.signal.aborted) {
                        return false;
                    }
                    optimizeRequests.set(controller, deps.document.workingCopyPath.value);
                    return await save({
                        kind: 'optimize-copy',
                        options,
                        ...(requestId === undefined ? {} : {requestId}),
                        ...(onResult === undefined ? {} : {onResult}),
                        ...(preparedOptimize ? {
                            preparedOptimize,
                            signal: controller.signal,
                        } : {}),
                    });
                } finally {
                    optimizeRequests.delete(controller);
                }
            })();
        },
    };
};
