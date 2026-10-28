import type {Ref} from 'vue';
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
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { toPdfDateString } from '@app/utils/pdfDate';
import {getDocumentWorkingCopyCapability} from '@app/utils/platformDocuments';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import {PDF_ANNOTATION_PARSE_MAX_PAGE_INDICES} from '@contracts/pdfAnnotationParseSchemas';
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
    createRecoverySnapshotBytes as createRecoverySnapshotBytesForService,
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
const MAX_STALE_REVISION_SAVE_RETRIES = 2;

type TSingleWriterSaveTransaction = IPdfViewerSaveTransactionResult & {
    /** False when a parse of some pages cannot replace the store; nothing changed. */
    replaceFromDocument?: (result: IPdfAnnotationParseResult) => boolean;
    notePageIndices?: readonly number[];
};

/**
 * The pages to read back after a save: those of the notes it wrote, when it
 * wrote no other annotation. Undefined reads the whole document.
 */
function committedNotePageIndices(
    saveTransaction: TSingleWriterSaveTransaction,
    projection: INativePdfMutationProjection,
) {
    const pageIndices = saveTransaction.notePageIndices;
    const notesOnly = !projection.textBoxes?.length
        && projection.annotationDeletes.length === 0
        && !projection.hasShapeMutations
        && !projection.hasMarkupMutations
        && !projection.placedImageGeometryUpdates?.length
        && !projection.mutations.placedImages?.length;
    return notesOnly && pageIndices?.length && pageIndices.length <= PDF_ANNOTATION_PARSE_MAX_PAGE_INDICES
        ? [...pageIndices]
        : undefined;
}

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
    return isTargetCurrent(plan, deps) ? null : 'document-changed';
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
    if (deps.persistence.trySavePdfNativeMutations) {
        const mutations = placedImageGeometryUpdates.length > 0
            && projection.mutations.placedImageGeometryUpdates === undefined
            ? {
                ...projection.mutations,
                placedImageGeometryUpdates,
            }
            : projection.mutations;
        return timedSavePhase(
            projection.phase,
            () => deps.persistence.trySavePdfNativeMutations!(mutations, opts),
        );
    }
    if (
        projection.hasMetadataMutations
        || projection.hasShapeMutations
        || (projection.mutations.placedImages?.length ?? 0) > 0
        || (projection.textBoxes?.length ?? 0) > 0
        || !deps.persistence.trySaveEmbeddedNoteTextUpdates
    ) {
        return null;
    }
    return timedSavePhase(
        projection.phase,
        () => deps.persistence.trySaveEmbeddedNoteTextUpdates!(
            projection.noteTextUpdates,
            {
                ...opts,
                ...(projection.noteGeometryUpdates?.length
                    ? {geometryUpdates: projection.noteGeometryUpdates}
                    : {}),
                ...(projection.freeTextNotes.length
                    ? {freeTextNotes: projection.freeTextNotes}
                    : {}),
                ...(projection.annotationDeletes.length
                    ? {deletes: projection.annotationDeletes}
                    : {}),
                ...(placedImageGeometryUpdates.length
                    ? {placedImageGeometryUpdates}
                    : {}),
            },
        ),
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
        return {
            ...notSavedBeforeWrite(abortReasonForPersistResult(persisted), plan.target.expectedRevisionToken, null),
            ...(persisted.failure === undefined ? {} : {failure: persisted.failure}),
        };
    }
    const materializedIdentityBindings = persisted.materializedIdentityBindings;
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
    const expectedWorkingPath = persisted.didSaveAs ? deps.document.workingCopyPath.value : plan.target.expectedWorkingPath;
    // Native persistence advances the document revision after publication. The
    // parse belongs to that committed revision, not the pre-write plan token.
    const committedRevisionToken = deps.document.revisionToken.value;
    if (saveTransaction.replaceFromDocument && expectedWorkingPath && committedRevisionToken) {
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
        // A note save rewrites only its notes' pages; the rest of the store
        // already holds what a whole-document parse would read.
        const pageIndices = committedNotePageIndices(saveTransaction, projection);
        if (!pageIndices || !saveTransaction.replaceFromDocument(await parse(pageIndices))) {
            saveTransaction.replaceFromDocument(await parse());
        }
    }
    // A layer may be marked clean only if this save carried its edits. The
    // projection records the edits carried by the published revision.
    const annotationEditsWritten = projection.noteTextUpdates.length > 0
        || (projection.noteGeometryUpdates?.length ?? 0) > 0
        || projection.freeTextNotes.length > 0
        || (projection.textBoxes?.length ?? 0) > 0
        || projection.annotationDeletes.length > 0
        || projection.hasMarkupMutations
        || projection.hasShapeMutations;
    const bookmarkEditsWritten = projection.mutations.bookmarks !== undefined;
    const pageLabelEditsWritten = projection.mutations.pageLabels !== undefined;

    return {
        status: 'saved',
        persisted,
        serializedChanges: true,
        reloadWaiter: null,
        completion: {
            markAnnotationStateSaved: annotationEditsWritten,
            markBookmarksStateSaved: bookmarkEditsWritten,
            markPageLabelsStateSaved: pageLabelEditsWritten,
            allowBookmarksSaveStateRefresh: bookmarkEditsWritten,
            allowPageLabelsSaveStateRefresh: pageLabelEditsWritten,
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
            allowAnnotationSaveStateRefresh: false,
            allowBookmarksSaveStateRefresh: false,
            allowPageLabelsSaveStateRefresh: false,
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
    const runWithDocumentOperationLease = deps.runWithDocumentOperationLease
        ?? runWithoutDocumentOperationLease;
    let saveOperations = 0;
    let saveQueueTail: Promise<void> = Promise.resolve();
    // Set once the lease admits a save; the reading watch reads this, not the indicator.
    const isAnySaveAdmitted = ref(false);
    const acknowledgedUnencryptedSaveSessions = new Set<string>();
    const nativeSaveTransactionOptions = () => getNativeSaveTransactionOptions(deps);
    const createRecoverySnapshotBytes = createRecoverySnapshotBytesForService(
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
    ) {
        const indicator = isSaveAsRequest(request) ? deps.status.isSavingAs : deps.status.isSaving;
        indicator.value = true;
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
                indicator.value = false;
                BrowserLogger.debug(
                    'workspace',
                    'Dropped a queued save after its document lease became stale',
                    {operationId},
                );
                return false;
            }
            // Set once the lease admits this save: a page operation's reload is not this save's.
            isAnySaveAdmitted.value = true;
            let lastPlan: TWorkspaceSavePlan | null = null;
            let result: TWorkspaceSaveExecutionResult | null = null;
            try {
                for (let attempt = 0; attempt <= MAX_STALE_REVISION_SAVE_RETRIES; attempt += 1) {
                    try {
                        // Nothing has been written yet on this attempt, so the
                        // revision seen here still identifies the open document.
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

                        const target: IWorkspaceSaveTarget = {
                            ...queuedTarget,
                            expectedRevisionToken: deps.document.revisionToken.value,
                        };
                        const baseline = captureBaseline(deps);
                        lastPlan = createWorkspaceSavePlan({
                            request,
                            target,
                            baseline,
                            dirtyState: collectDirtyState(deps),
                            hasManagedShapes: deps.shapes.hasManagedShapes(),
                            canPersistNativeWorkingCopy: request.kind === 'repair'
                                ? Boolean(deps.persistence.repairWorkingCopy)
                                : request.kind === 'optimize'
                                    ? Boolean(deps.persistence.optimizeWorkingCopy)
                                    : false,
                            canPersistNativeMutations: Boolean(
                                deps.persistence.trySavePdfNativeMutations
                            ?? deps.persistence.trySaveEmbeddedNoteTextUpdates,
                            ),
                            canPersistNativeRepair: request.kind === 'repair'
                            && Boolean(deps.persistence.repairWorkingCopy)
                            && Boolean(deps.persistence.trySavePdfNativeMutations),
                        });

                        const unencryptedSaveAbort = await unencryptedSaveNoticeGate(
                            deps,
                            lastPlan,
                            acknowledgedUnencryptedSaveSessions,
                        );
                        result = unencryptedSaveAbort ?? await executeSavePlan(lastPlan, deps);
                        if (result.status !== 'saved') {
                            result.reloadWaiter?.cancel();
                            if (result.status === 'failed') throw result.error;
                            reportSaveAbort(result);
                            return false;
                        }
                        isAnySaveAdmitted.value = false;
                        break;
                    } catch (error) {
                        if (error instanceof DOMException && error.name === 'AbortError') return false;
                        if (
                            isStaleRevisionError(error)
                            && attempt < MAX_STALE_REVISION_SAVE_RETRIES
                        ) {
                            BrowserLogger.debug(
                                'workspace',
                                'Retrying save after stale document revision',
                                {
                                    attempt: attempt + 1,
                                    maxRetries: MAX_STALE_REVISION_SAVE_RETRIES,
                                },
                            );
                            continue;
                        }
                        const failure = isFailurePresentation(error) ? error : getFailureReceipt(error)
                            ?? BrowserLogger.error('workspace', 'Save failed', error, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
                        const detail = isFailurePresentation(error) ? error.description ?? getErrorMessage(error) : getDocumentMutationErrorPayload(error)?.message
                            ?? getErrorMessage(error);
                        reportSaveFailureIfCurrent('unexpected-error', {
                            detail,
                            failure,
                        });
                        return false;
                    }
                }
                if (!lastPlan || result?.status !== 'saved') return false;
                const committedPath = deps.document.workingCopyPath.value;
                const committedRevision = deps.document.revisionToken.value;
                try {
                    if (deps.document.sessionKey.value !== queuedTarget.expectedDocumentSessionKey) return false;
                    const baseline = getCompletionBaseline(lastPlan, result, deps);
                    await result.reloadWaiter?.promise.catch(error => BrowserLogger.warn('workspace', 'Saved PDF but failed to restore the reloaded view', error));
                    if (deps.document.sessionKey.value !== queuedTarget.expectedDocumentSessionKey
                        || deps.document.workingCopyPath.value !== committedPath
                        || deps.document.revisionToken.value !== committedRevision) return false;
                    completeSuccessfulSaveState(baseline, result.completion, deps);
                    await persistCrashCheckpoint?.(committedPath);
                    if (deps.document.sessionKey.value !== queuedTarget.expectedDocumentSessionKey
                        || deps.document.workingCopyPath.value !== committedPath
                        || deps.document.revisionToken.value !== committedRevision) return false;
                    if (result.persisted.outPath) deps.lifecycle.loadRecentFiles();
                    saveSucceeded = true;
                    return true;
                } catch (error) {
                    if (!(error instanceof DOMException && error.name === 'AbortError')
                        && deps.document.sessionKey.value === queuedTarget.expectedDocumentSessionKey
                        && deps.document.workingCopyPath.value === committedPath
                        && deps.document.revisionToken.value === committedRevision) {
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
                indicator.value = false;
                isAnySaveAdmitted.value = false;
            }
        };
        return runWithDocumentOperationLease(resolveOperationKind(request), runSave);
    }

    function save(request: TWorkspaceSaveRequest) {
        const queuedTarget: Omit<IWorkspaceSaveTarget, 'expectedRevisionToken'> = {
            expectedDocumentSessionKey: deps.document.sessionKey.value,
            expectedOriginalPath: deps.document.originalPath.value,
            expectedWorkingPath: deps.document.workingCopyPath.value,
        };
        const execute = () => executeSave(request, queuedTarget);
        const result = saveQueueTail.then(execute, execute);
        saveQueueTail = result.then(() => undefined, () => undefined);
        return result;
    }

    const canSave = computed(() => failureSurface.hasSaveFailure.value || (deps.hasPendingUnsavedChanges?.value ?? (
        deps.hasUnsavedChanges?.() ?? (
            deps.annotations.dirty.value
            || deps.annotations.hasChanges()
            || deps.metadata.pageLabelsDirty.value
            || deps.metadata.bookmarksDirty.value
            || deps.shapes.hasChanges()
        )
    )));
    const isAnySaving = computed(() => deps.status.isSaving.value || deps.status.isSavingAs.value);
    const saveIfDirty = () => (
        deps.hasPendingUnsavedChanges || deps.hasUnsavedChanges
            ? canSave.value ? save({kind: 'save'}) : Promise.resolve(!failureSurface.hasSaveFailure.value)
            : save({kind: 'save'})
    );

    return {
        save,
        hasSaveFailure: failureSurface.hasSaveFailure,
        canSave,
        isAnySaving,
        isAnySaveAdmitted,
        handleSave: saveIfDirty,
        saveForExternalRead: saveIfDirty,
        getNativeSaveTransactionOptions: nativeSaveTransactionOptions,
        createRecoverySnapshotBytes,
        createPageMutationWriterSave: (options: {
            currentPage: Readonly<Ref<number>>;
            waitForPdfReload: (page: number) => Promise<unknown>;
            loadPdfFromPath?: (path: TDocumentRef, options?: {markDirty?: boolean}) => Promise<unknown>;
        }) => createPageMutationWriterSave({
            save: deps,
            ...options,
            getNativeSaveTransactionOptions: nativeSaveTransactionOptions,
        }),
        handleSaveAs: (optimizeLossless = deps.optimizePdfOnSaveAs?.value === true) => save({
            kind: 'save-as',
            optimizeLossless,
        }),
        handleRepairSave: () => save({kind: 'repair'}),
        handleOptimizePdfForInteraction: async () => {
            if (canSave.value && !await saveIfDirty()) {
                return false;
            }
            return save({kind: 'optimize'});
        },
        handleOptimizePdfAsCopy: (
            options: IPdfOptimizeOptions,
            requestId?: TRequestId,
            onResult?: (result: IPdfOptimizeResult) => void,
        ) => {
            const request = {
                kind: 'optimize-copy' as const,
                options,
                ...(requestId === undefined ? {} : {requestId}),
                ...(onResult === undefined ? {} : {onResult}),
            };
            return canSave.value
                ? saveIfDirty().then(saved => saved ? save(request) : false)
                : save(request);
        },
    };
};
