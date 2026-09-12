import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type {
    IPdfPersistResult,
    IPdfSaveResult,
} from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfDateString } from '@contracts/pdfDateString';
import type { TRequestId } from '@contracts/shared';
import type { ExpectedOutcome } from '@contracts/diagnostics/failureReceipt';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNativePlacedImageGeometryUpdate,
    IPdfNoteGeometryUpdate,
    IPdfNoteTextUpdate,
    IPdfOptimizeOptions,
    IPdfSerializedCommitCallbacks,
} from '@contracts/electronApiDocuments';
import {
    getDocumentMutationErrorPayload,
    isStaleRevisionError,
} from '@contracts/documentMutationErrors';
import type {
    IPdfViewerSaveExpose,
    IPdfViewerSaveTransactionResult,
    INativePdfMutationProjection,
} from '@app/modules/pdf-viewer/public';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { toPdfDateString } from '@app/utils/pdfDate';
import {getDocumentWorkingCopyCapability} from '@app/utils/platformDocuments';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import { useAnalytics } from '@app/composables/useAnalytics';
import type {
    TWorkspaceFailureSurface,
    TWorkspaceSaveFailureReason,
} from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import { useWorkspaceFailureSurface } from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import type {
    IPostSaveReloadWaiter,
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
import {
    type IUnencryptedSaveNoticeDependencies,
    unencryptedSaveNoticeGate,
} from '@app/modules/workspace-shell/composables/file-operations/unencryptedSaveNoticeGate';
import {
    buildSaveTransactionRequest,
    createWorkspaceSavePlan,
    getSaveFlow,
    getSaveMode,
    requiresNativePathBackedSave,
    type IWorkspaceSaveTarget,
    type IWorkspaceSerializedSaveBody,
    type TWorkspaceSavePlan,
    type TWorkspaceSaveRequest,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSavePolicy';
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
    completeSuccessfulSaveState,
    createReloadWaiter,
    getCompletionBaseline,
    isTargetCurrent,
    withReloadWaiter,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionSupport';

const SLOW_SAVE_TOTAL_WARN_MS = 10_000;
const MAX_STALE_REVISION_SAVE_RETRIES = 2;

type TSingleWriterSaveTransaction = IPdfViewerSaveTransactionResult & {replaceFromDocument?: (result: IPdfAnnotationParseResult) => void};

export interface IWorkspaceSaveDependencies {
    status: {
        isSaving: Ref<boolean>;
        isSavingAs: Ref<boolean>;
    };
    document: {
        sessionKey: Ref<string | null>;
        workingCopyPath: Ref<TDocumentRef | null>;
        originalPath: Ref<TDocumentRef | null>;
        revisionToken: Ref<TDocumentRevisionToken | null>;
        /** True only when the current document completed a password-protected open. */
        wasEncrypted?: Ref<boolean>;
    };
    /** UI and persistence hooks for the one-time unencrypted-save warning. */
    unencryptedSaveNotice?: IUnencryptedSaveNoticeDependencies;
    hasPendingUnsavedChanges?: ComputedRef<boolean>;
    hasUnsavedChanges?: () => boolean;
    optimizePdfOnSaveAs?: Ref<boolean>;
    annotations: {
        dirty: Ref<boolean>;
        markSaved: () => void;
        getSaveStateToken?: () => unknown;
        hasChanges: () => boolean;
        hasPendingDeletes?: () => boolean;
        openNoteCount: Ref<number>;
        persistOpenNotes: () => Promise<boolean>;
    };
    metadata: {
        totalPages: Ref<number>;
        pageLabelsDirty: Ref<boolean>;
        pageLabelRanges: Ref<IPdfPageLabelRange[]>;
        bookmarksDirty: Ref<boolean>;
        bookmarkItems: Ref<IPdfBookmarkEntry[]>;
        untitledBookmarkLabel: string;
        markPageLabelsSaved: () => void;
        getPageLabelsSaveStateToken?: () => unknown;
        markBookmarksSaved: () => void;
        getBookmarksSaveStateToken?: () => unknown;
    };
    pdf: {
        document: ShallowRef<IPdfDocument | null>;
        commitEditorsForSave?: () => Promise<void>;
        runSaveTransaction: IPdfViewerSaveExpose['runSaveTransaction'];
        getSourceData: () => Promise<Uint8Array | null>;
    };
    shapes: {
        hasChanges: () => boolean;
        hasManagedShapes: () => boolean;
        markSaved?: (prepared?: unknown) => void;
        preparePersistedState?: (data?: Uint8Array) => Promise<unknown>;
        restorePreparedState?: (snapshot: unknown) => Promise<void> | void;
    };
    persistence: {
        validatePdfPath: (path: TDocumentRef) => Promise<IPdfSaveResult['validation']>;
        saveSerialized: (
            data: Uint8Array,
            opts: {
                saveMode: TPdfSaveMode;
                preserveLoadedSource?: boolean;
                expectedWorkingPath?: TDocumentRef | null;
                expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
                changedObjectRefs?: string[];
                commitCallbacks?: IPdfSerializedCommitCallbacks;
            },
        ) => Promise<IPdfPersistResult>;
        saveWorkingCopy: (opts: {
            saveMode: TPdfSaveMode;
            preserveLoadedSource?: boolean;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
        }) => Promise<IPdfPersistResult>;
        saveAs: (
            data: Uint8Array | undefined,
            opts: {
                saveMode: TPdfSaveMode;
                expectedWorkingPath?: TDocumentRef | null;
                expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
                optimizeLossless?: boolean;
                changedObjectRefs?: string[];
                commitCallbacks?: IPdfSerializedCommitCallbacks;
            },
        ) => Promise<IPdfPersistResult>;
        repairWorkingCopy?: (opts: {
            saveMode: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
        }) => Promise<IPdfPersistResult>;
        optimizeWorkingCopy?: (opts: {
            saveMode: TPdfSaveMode;
            expectedWorkingPath?: TDocumentRef | null;
            expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
        }) => Promise<IPdfPersistResult>;
        optimizeWorkingCopyAsCopy?: (
            options: IPdfOptimizeOptions,
            requestId: TRequestId | undefined,
            opts: {
                saveMode: TPdfSaveMode;
                expectedWorkingPath?: TDocumentRef | null;
                expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
            },
        ) => Promise<IPdfPersistResult>;
        trySavePdfNativeMutations?: (
            mutations: IPdfNativeMutationSet,
            opts: {
                saveMode: TPdfSaveMode;
                optimizeLossless?: boolean;
                preserveLoadedSource?: boolean;
                expectedWorkingPath?: TDocumentRef | null;
                expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
                modifiedAt: TPdfDateString;
                workingCopyOnly?: true;
                verifyPathBeforeExpose?: (path: TDocumentRef, knownSize: number) => Promise<void>;
                assertBeforeExpose?: () => Promise<void> | void;
            },
        ) => Promise<IPdfPersistResult | null>;
        trySaveEmbeddedNoteTextUpdates?: (
            updates: IPdfNoteTextUpdate[],
            opts: {
                saveMode: TPdfSaveMode;
                preserveLoadedSource?: boolean;
                expectedWorkingPath?: TDocumentRef | null;
                expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
                modifiedAt: TPdfDateString;
                workingCopyOnly?: true;
                geometryUpdates?: IPdfNoteGeometryUpdate[];
                freeTextNotes?: IPdfNativeFreeTextNote[];
                deletes?: IPdfNativeAnnotationDelete[];
                placedImageGeometryUpdates?: IPdfNativePlacedImageGeometryUpdate[];
            },
        ) => Promise<IPdfPersistResult | null>;
        getWorkingCopySize?: (path: TDocumentRef) => Promise<number | null>;
    };
    lifecycle: {
        loadRecentFiles: () => void;
        preparePostSaveReload?: () => IPostSaveReloadWaiter;
    };
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
    failureSurface?: TWorkspaceFailureSurface;
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

async function executeSerializedBytesSave(
    plan: TWorkspaceSavePlan,
    body: IWorkspaceSerializedSaveBody,
    deps: IWorkspaceSaveDependencies,
    reloadWaiter: IPostSaveReloadWaiter | null,
    createTransaction?: () => Promise<IPdfViewerSaveTransactionResult>,
): Promise<TWorkspaceSaveExecutionResult> {
    const saveTransaction = createTransaction
        ? await createTransaction()
        : await deps.pdf.runSaveTransaction(
            buildSaveTransactionRequest(plan, deps, body, {allowNativeMutationPlan: false}),
        );
    if (requiresNativePathBackedSave(plan)) {
        return notSavedBeforeWrite(
            'native-save-required',
            plan.target.expectedRevisionToken,
            reloadWaiter,
        );
    }
    const finalBytes = saveTransaction.serializedResult?.finalBytes
        ?? saveTransaction.serializedBytes
        ?? saveTransaction.baseBytes;
    if (!finalBytes) {
        return notSavedBeforeWrite('persist-rejected', plan.target.expectedRevisionToken, reloadWaiter);
    }
    if (!isTargetCurrent(plan, deps)) {
        return notSavedBeforeWrite('document-changed', plan.target.expectedRevisionToken, reloadWaiter);
    }

    let preparedShapeStateSnapshot: unknown = null;
    let preparedShapeState: unknown = null;
    try {
        // Priming establishes the persisted shape baseline from the bytes about
        // to be written. When it cannot run — an oversized document, a parse
        // failure, a replaced store — the file is still saved, but nothing here
        // knows the shape layer reached disk. The shapes then stay dirty rather
        // than being declared clean on the strength of a scan that never ran.
        let shapeStateWasPrimed = true;
        if (plan.dirtyState.shapes && deps.shapes.preparePersistedState) {
            preparedShapeStateSnapshot = await deps.shapes.preparePersistedState(finalBytes) ?? null;
            preparedShapeState = preparedShapeStateSnapshot;
            shapeStateWasPrimed = preparedShapeStateSnapshot !== null;
            if (!shapeStateWasPrimed) {
                BrowserLogger.warn(
                    'workspace',
                    'Saved the PDF but could not confirm the managed shape baseline; shape edits stay unsaved',
                    {path: plan.target.expectedWorkingPath},
                );
            }
        }
        const changedObjectRefs = saveTransaction.serializedResult?.changedObjectRefs;
        const commitCallbacks: IPdfSerializedCommitCallbacks = {
            ...(saveTransaction.verifyAnnotationSave
                ? {verifyBytesBeforeCommit: saveTransaction.verifyAnnotationSave}
                : {}),
            ...(saveTransaction.verifyAnnotationSavePath
                ? {verifyPathBeforeCommit: saveTransaction.verifyAnnotationSavePath}
                : {}),
            ...(saveTransaction.assertAnnotationSaveCurrent
                ? {assertBeforeCommit: saveTransaction.assertAnnotationSaveCurrent}
                : {}),
        };
        const persistOptions = {
            saveMode: saveTransaction.serializedResult?.saveMode ?? getSaveMode(plan),
            preserveLoadedSource: body.preserveLoadedSource,
            expectedWorkingPath: plan.target.expectedWorkingPath,
            expectedDocumentRevisionToken: plan.target.expectedRevisionToken,
            ...(changedObjectRefs?.length
                ? {changedObjectRefs: [...changedObjectRefs]}
                : {}),
            ...(Object.keys(commitCallbacks).length
                ? {commitCallbacks}
                : {}),
        };
        const annotationMaterializationBaseline = body.preserveLoadedSource && !reloadWaiter
            ? deps.annotations.getSaveStateToken?.()
            : undefined;
        const persisted = plan.request.kind === 'save-as'
            ? await timedSavePhase(
                'persist-save_as',
                () => deps.persistence.saveAs(finalBytes, {
                    ...persistOptions,
                    optimizeLossless: plan.request.kind === 'save-as'
                        && plan.request.optimizeLossless,
                }),
            )
            : await timedSavePhase(
                'persist-save',
                () => deps.persistence.saveSerialized(finalBytes, persistOptions),
            );
        if (!persisted.success) {
            return notSavedAfterWrite(abortReasonForPersistResult(persisted), reloadWaiter);
        }
        preparedShapeStateSnapshot = null;
        return {
            status: 'saved',
            persisted,
            serializedChanges: true,
            reloadWaiter,
            completion: {
                markAnnotationStateSaved: true,
                markBookmarksStateSaved: true,
                markPageLabelsStateSaved: true,
                markShapeStateSaved: shapeStateWasPrimed,
                preserveLivePdfjsSession: body.preserveLoadedSource && !reloadWaiter,
                resetAnnotationStorage: true,
            },
            ...(preparedShapeState === null ? {} : {preparedShapeState}),
            ...(annotationMaterializationBaseline === undefined
                ? {}
                : {annotationMaterializationBaseline}),
            ...(saveTransaction.commitAnnotationSave
                ? {commitAnnotationSave: saveTransaction.commitAnnotationSave}
                : {}),
        };
    } finally {
        if (preparedShapeStateSnapshot) {
            await deps.shapes.restorePreparedState?.(preparedShapeStateSnapshot);
        }
    }
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
        || projection.freeTextEditors.length > 0
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
            {
                allowNativeMutationPlan: true,
                planOnly: true,
            },
        ),
    ) as TSingleWriterSaveTransaction;
    const nativePathBacked = requiresNativePathBackedSave(plan);
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
            return {
                ...result,
                completion: {
                    ...result.completion,
                    markShapeStateSaved: false,
                    preserveLivePdfjsSession: !result.persisted.didSaveAs,
                },
            };
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

    const placedImageGeometryUpdates = projection.placedImageGeometryUpdates ?? [];
    const nativeMutations = placedImageGeometryUpdates.length > 0
        && projection.mutations.placedImageGeometryUpdates === undefined
        ? {
            ...projection.mutations,
            placedImageGeometryUpdates,
        }
        : projection.mutations;
    const effectiveProjection = nativeMutations === projection.mutations
        ? projection
        : {
            ...projection,
            mutations: nativeMutations,
        };

    if (Object.keys(nativeMutations).length === 0) {
        saveTransaction.commitAnnotationSave?.();
        return {
            status: 'saved',
            persisted: {
                success: true,
                outPath: plan.target.expectedWorkingPath ?? null,
                saveMode: getSaveMode(plan),
                didSaveAs: false,
            },
            serializedChanges: false,
            reloadWaiter: null,
            completion: {
                markAnnotationStateSaved: false,
                markBookmarksStateSaved: false,
                markPageLabelsStateSaved: false,
                allowAnnotationSaveStateRefresh: false,
                allowBookmarksSaveStateRefresh: false,
                allowPageLabelsSaveStateRefresh: false,
                markShapeStateSaved: false,
                preserveLivePdfjsSession: true,
                resetAnnotationStorage: false,
            },
        };
    }

    let persisted: IPdfPersistResult | null;
    try {
        persisted = await persistNativeMutationProjection(
            plan,
            effectiveProjection,
            deps,
            saveTransaction.verifyAnnotationSavePath,
            saveTransaction.assertAnnotationSaveCurrent,
        );
    } catch (error) {
        if (isStaleRevisionError(error)) {
            throw error;
        }
        if (nativePathBacked) {
            BrowserLogger.warn('workspace', 'Native path-backed PDF mutation failed', error);
            return notSavedBeforeWrite(
                'native-save-required',
                plan.target.expectedRevisionToken,
                null,
            );
        }
        throw error;
    }
    if (!persisted) {
        if (nativePathBacked) {
            return notSavedBeforeWrite(
                'native-save-required',
                plan.target.expectedRevisionToken,
                null,
            );
        }
        return notSavedBeforeWrite('native-save-required', plan.target.expectedRevisionToken, null);
    }
    if (!persisted.success) {
        if (
            nativePathBacked
            && persisted.abortReason !== 'stale'
            && persisted.abortReason !== 'cancelled'
        ) {
            return notSavedBeforeWrite(
                'native-save-required',
                plan.target.expectedRevisionToken,
                null,
            );
        }
        return notSavedAfterWrite(abortReasonForPersistResult(persisted), null);
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
            return notSavedAfterWrite(abortReasonForPersistResult(saveAsPersisted), null);
        }
        persisted = saveAsPersisted;
    }
    let preparedShapeStateSnapshot: unknown = null;
    let canMarkShapeStateSaved = !projection.hasShapeMutations;
    if (projection.hasShapeMutations) {
        try {
            if (nativePathBacked) {
                preparedShapeStateSnapshot = await deps.shapes.preparePersistedState?.() ?? null;
            } else {
                const savedBytes = await timedSavePhase(
                    'read-native-shape-saved-bytes',
                    deps.pdf.getSourceData,
                );
                if (savedBytes) {
                    preparedShapeStateSnapshot = await deps.shapes.preparePersistedState?.(savedBytes) ?? null;
                }
            }
            canMarkShapeStateSaved = Boolean(preparedShapeStateSnapshot);
        } catch {
            // Native persistence has already committed. Keep shapes dirty when
            // the saved bytes cannot be reread or prepared for reconciliation.
            preparedShapeStateSnapshot = null;
            canMarkShapeStateSaved = false;
        }
    }
    if (projection.hasShapeMutations && canMarkShapeStateSaved) {
        deps.shapes.markSaved?.(preparedShapeStateSnapshot);
    }
    saveTransaction.commitAnnotationSave?.(
        persisted.materializedIdentityBindings ?? materializedIdentityBindings,
    );
    const expectedWorkingPath = persisted.didSaveAs ? deps.document.workingCopyPath.value : plan.target.expectedWorkingPath;
    // Native persistence advances the document revision after publication. The
    // parse belongs to that committed revision, not the pre-write plan token.
    const committedRevisionToken = deps.document.revisionToken.value;
    if (saveTransaction.replaceFromDocument && expectedWorkingPath && committedRevisionToken) {
        const parsed = await timedSavePhase(
            'parse-committed-pdf-annotations',
            () => getDocumentWorkingCopyCapability().parsePdfAnnotations(
                expectedWorkingPath,
                {expectedDocumentRevisionToken: committedRevisionToken},
            ),
        );
        saveTransaction.replaceFromDocument(parsed);
    }
    const preparedShapeState = preparedShapeStateSnapshot;
    preparedShapeStateSnapshot = null;
    // A layer may be marked clean only if this save carried its edits. The
    // projection is the record of what was actually written, so the same
    // predicate decides both that and whether a token that moved during the
    // write should be refreshed rather than treated as a new edit.
    const annotationEditsWritten = projection.noteTextUpdates.length > 0
        || (projection.noteGeometryUpdates?.length ?? 0) > 0
        || projection.freeTextNotes.length > 0
        || projection.freeTextEditors.length > 0
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
        ...(preparedShapeState === null ? {} : {preparedShapeState}),
        completion: {
            markAnnotationStateSaved: annotationEditsWritten,
            markBookmarksStateSaved: bookmarkEditsWritten,
            markPageLabelsStateSaved: pageLabelEditsWritten,
            allowAnnotationSaveStateRefresh: annotationEditsWritten,
            allowBookmarksSaveStateRefresh: bookmarkEditsWritten,
            allowPageLabelsSaveStateRefresh: pageLabelEditsWritten,
            markShapeStateSaved: canMarkShapeStateSaved,
            preserveLivePdfjsSession: !persisted.didSaveAs,
            resetAnnotationStorage: true,
        },
    };
}

async function executeNativeRepairSave(
    plan: Extract<TWorkspaceSavePlan, {kind: 'native-repair'}>,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    const saveTransaction = await deps.pdf.runSaveTransaction(
        buildSaveTransactionRequest(plan, deps, plan.serializedFallback, {
            allowNativeMutationPlan: true,
            planOnly: true,
        }),
    ) as TSingleWriterSaveTransaction;
    const projection = saveTransaction.nativeMutationProjection;
    if (!projection) {
        return notSavedBeforeWrite('native-save-required', plan.target.expectedRevisionToken, null);
    }
    const placedImageGeometryUpdates = projection.placedImageGeometryUpdates ?? [];
    const nativeMutations = placedImageGeometryUpdates.length > 0
        && projection.mutations.placedImageGeometryUpdates === undefined
        ? {
            ...projection.mutations,
            placedImageGeometryUpdates,
        }
        : projection.mutations;
    const effectiveProjection = nativeMutations === projection.mutations
        ? projection
        : {
            ...projection,
            mutations: nativeMutations,
        };
    if (Object.keys(nativeMutations).length === 0) {
        return notSavedBeforeWrite('native-save-required', plan.target.expectedRevisionToken, null);
    }

    const staged = await persistNativeMutationProjection(
        plan,
        effectiveProjection,
        deps,
        saveTransaction.verifyAnnotationSavePath,
        saveTransaction.assertAnnotationSaveCurrent,
        true,
    );
    if (!staged) {
        return notSavedBeforeWrite('native-save-required', plan.target.expectedRevisionToken, null);
    }
    if (!staged.success) {
        return notSavedAfterWrite(abortReasonForPersistResult(staged), null);
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
        return notSavedAfterWrite(abortReasonForPersistResult(repairedResult), null);
    }

    saveTransaction.commitAnnotationSave?.(staged.materializedIdentityBindings);
    return {
        status: 'saved',
        persisted: repairedResult,
        serializedChanges: true,
        reloadWaiter: null,
        completion: {
            markAnnotationStateSaved: false,
            markBookmarksStateSaved: false,
            markPageLabelsStateSaved: false,
            allowAnnotationSaveStateRefresh: false,
            allowBookmarksSaveStateRefresh: false,
            allowPageLabelsSaveStateRefresh: false,
            markShapeStateSaved: false,
            preserveLivePdfjsSession: false,
            resetAnnotationStorage: true,
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
                },
            ),
        );
        return workingCopySaveResult(persisted, reloadWaiter);
    });
}

async function executeSavePlan(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveDependencies,
): Promise<TWorkspaceSaveExecutionResult> {
    const reloadState: {current: IPostSaveReloadWaiter | null} = {current: null};
    const getReloadWaiter = () => {
        reloadState.current ??= createReloadWaiter(
            plan.kind === 'native-mutation'
                ? plan.serializedFallback
                : plan.kind === 'serialized'
                    ? plan.body
                    : {
                        source: 'working-copy',
                        forceRewrite: false,
                        includeManagedShapes: false,
                        preserveLoadedSource: false,
                        requiresLargeFileGuard: false,
                    },
            deps,
        );
        return reloadState.current;
    };
    try {
        if (plan.kind === 'optimization') {
            return await executeOptimizationSave(plan, deps);
        }
        if (plan.kind === 'native-working-copy') {
            return await executeNativeWorkingCopySave(plan, deps);
        }
        if (plan.kind === 'native-mutation') {
            return await executeNativeMutationSave(plan, deps);
        }
        if (plan.kind === 'native-repair') {
            return await executeNativeRepairSave(plan, deps);
        }
        if (plan.body.source === 'working-copy') {
            return await executeWorkingCopySave(plan, deps);
        }
        return await executeSerializedBytesSave(plan, plan.body, deps, getReloadWaiter());
    } catch (error) {
        reloadState.current?.cancel();
        throw error;
    }
}

async function completeWorkspaceSave(
    plan: TWorkspaceSavePlan | null,
    result: TWorkspaceSaveExecutionResult,
    deps: IWorkspaceSaveDependencies,
) {
    if (!plan || result.status !== 'saved') {
        BrowserLogger.warn('workspace', 'Workspace save did not commit', {
            planKind: plan?.kind ?? null,
            status: result.status,
            ...(result.status === 'not-saved' ? {
                reason: result.reason,
                phase: result.origin.phase,
            } : {}),
        });
        result.reloadWaiter?.cancel();
        return false;
    }

    const baseline = getCompletionBaseline(plan, result, deps);
    if (!result.reloadWaiter) {
        completeSuccessfulSaveState(baseline, result.completion, deps, result.preparedShapeState);
    } else {
        await result.reloadWaiter.promise.catch((error) => {
            BrowserLogger.warn('workspace', 'Saved PDF but failed to restore the reloaded view', error);
        }).finally(() => {
            completeSuccessfulSaveState(baseline, result.completion, deps, result.preparedShapeState);
        });
    }
    if (result.persisted.outPath) {
        deps.lifecycle.loadRecentFiles();
    }
    return true;
}

export const useWorkspaceSaveService = (deps: IWorkspaceSaveDependencies) => {
    const analytics = useAnalytics();
    const failureSurface = deps.failureSurface ?? useWorkspaceFailureSurface();
    const runWithDocumentOperationLease = deps.runWithDocumentOperationLease
        ?? runWithoutDocumentOperationLease;
    let saveOperations = 0;
    let saveQueueTail: Promise<void> = Promise.resolve();
    const acknowledgedUnencryptedSaveSessions = new Set<string>();

    // A save that failed keeps its state until the workspace adopts a different
    // document or a fresh attempt supersedes it, so the status bar cannot
    // present an unsaved document as clean. The revision belongs in the key
    // beside the paths: reopening the same file leaves both paths untouched,
    // and the reopened document has not earned the previous one's red dot.
    // The reset is synchronous: a queued one could land after the next attempt
    // has already reported its own failure and wipe it.
    watch(
        () => [
            deps.document.originalPath.value,
            deps.document.workingCopyPath.value,
            deps.document.revisionToken.value,
        ],
        () => failureSurface.clearSaveFailure(),
        {flush: 'sync'},
    );

    async function executeSave(
        request: TWorkspaceSaveRequest,
        queuedTarget: Omit<IWorkspaceSaveTarget, 'expectedRevisionToken'>,
        options: {withinDocumentOperationLease?: boolean} = {},
    ) {
        const queuedTargetIsCurrent = () => (
            deps.document.sessionKey.value === queuedTarget.expectedDocumentSessionKey
            && deps.document.originalPath.value === queuedTarget.expectedOriginalPath
            && deps.document.workingCopyPath.value === queuedTarget.expectedWorkingPath
        );
        if (!queuedTargetIsCurrent()) {
            BrowserLogger.debug('workspace', 'Dropped a queued save for a replaced document');
            return false;
        }
        saveOperations += 1;
        const operationId = `save-${saveOperations}`;
        failureSurface.clearSaveFailure();
        const startedAtMs = nowMs();
        const saveAs = isSaveAsRequest(request);
        const indicator = saveAs
            ? deps.status.isSavingAs
            : deps.status.isSaving;
        const expectedOriginalPath = queuedTarget.expectedOriginalPath;
        const expectedWorkingPath = queuedTarget.expectedWorkingPath;
        let saveSucceeded = false;
        indicator.value = true;

        /**
         * A save outlives its own document: every failure below is reported
         * after at least one await, by which time the workspace may hold a
         * different file. Paths catch a replacement. They cannot catch a
         * reopen of the same file, so callers that have not written anything
         * yet also pin the revision token they started from; once this save
         * has written, the revision moves by design and cannot be compared.
         */
        function ownsCurrentDocument(expectedRevisionToken?: TDocumentRevisionToken | null) {
            if (
                deps.document.sessionKey.value !== queuedTarget.expectedDocumentSessionKey
                || deps.document.originalPath.value !== expectedOriginalPath
                || deps.document.workingCopyPath.value !== expectedWorkingPath
            ) {
                return false;
            }
            return expectedRevisionToken === undefined
                || deps.document.revisionToken.value === expectedRevisionToken;
        }

        function reportSaveFailureIfCurrent(
            reason: TWorkspaceSaveFailureReason,
            options: {
                detail?: string | null;
                expectedRevisionToken?: TDocumentRevisionToken | null;
                failure?: Parameters<TWorkspaceFailureSurface['reportSaveFailure']>[3];
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
            return failureSurface.reportSaveFailure(operationId, reason, options.detail, options.failure);
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
                    ? {expectedRevisionToken: result.origin.plannedRevisionToken}
                    : {},
            );
        }

        const runSave = async () => {
            if (!queuedTargetIsCurrent()) {
                BrowserLogger.debug(
                    'workspace',
                    'Dropped a queued save after its document lease became stale',
                    {operationId},
                );
                return false;
            }
            let lastPlan: TWorkspaceSavePlan | null = null;
            try {
                for (let attempt = 0; attempt <= MAX_STALE_REVISION_SAVE_RETRIES; attempt += 1) {
                    // Nothing has been written yet on this attempt, so the
                    // revision seen here still identifies the open document.
                    const revisionBeforeNotes = deps.document.revisionToken.value;
                    if (
                        deps.annotations.openNoteCount.value > 0
                        && !await deps.annotations.persistOpenNotes()
                    ) {
                        BrowserLogger.warn('workspace', 'Save aborted because annotation note persistence failed');
                        const noteFailure = notSavedBeforeWrite(
                            'note-persistence-failed',
                            revisionBeforeNotes,
                            null,
                        );
                        const completed = await completeWorkspaceSave(null, noteFailure, deps);
                        reportSaveAbort(noteFailure);
                        return completed;
                    }

                    // A nonempty FreeText editor remains outside annotation
                    // storage until PDF.js commits it. Save planning must run
                    // after that commit, otherwise the toolbar can start a save
                    // whose captured dirty state still describes a clean file.
                    await deps.pdf.commitEditorsForSave?.();

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
                    if (unencryptedSaveAbort) {
                        indicator.value = false;
                        saveSucceeded = await completeWorkspaceSave(
                            lastPlan,
                            unencryptedSaveAbort,
                            deps,
                        );
                        reportSaveAbort(unencryptedSaveAbort);
                        return saveSucceeded;
                    }

                    try {
                        const result = await executeSavePlan(lastPlan, deps);
                        indicator.value = false;
                        saveSucceeded = await completeWorkspaceSave(lastPlan, result, deps);
                        if (saveSucceeded && result.status === 'saved') {
                            analytics.track('save_completed', {
                                didSaveAs: result.persisted.didSaveAs,
                                mode: getSaveFlow(lastPlan),
                                saveMode: result.persisted.saveMode,
                                serializedChanges: result.serializedChanges,
                            });
                        }
                        if (result.status === 'not-saved') {
                            reportSaveAbort(result);
                        }
                        return saveSucceeded;
                    } catch (error) {
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
                        await completeWorkspaceSave(
                            lastPlan,
                            {
                                status: 'failed',
                                error,
                                reloadWaiter: null,
                            },
                            deps,
                        );
                        const failure = BrowserLogger.error('workspace', 'Save failed', error, {
                            code: 'RENDERER_WORKSPACE_OPERATION_FAILED',
                            context: {},
                        });
                        const detail = getDocumentMutationErrorPayload(error)?.message
                            ?? getErrorMessage(error);
                        reportSaveFailureIfCurrent('unexpected-error', {
                            detail,
                            failure,
                        });
                        return false;
                    }
                }
                return false;
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
            }
        };
        return options.withinDocumentOperationLease
            ? runSave()
            : runWithDocumentOperationLease(resolveOperationKind(request), runSave);
    }

    function save(
        request: TWorkspaceSaveRequest,
        options: {withinDocumentOperationLease?: boolean} = {},
    ) {
        const queuedTarget: Omit<IWorkspaceSaveTarget, 'expectedRevisionToken'> = {
            expectedDocumentSessionKey: deps.document.sessionKey.value,
            expectedOriginalPath: deps.document.originalPath.value,
            expectedWorkingPath: deps.document.workingCopyPath.value,
        };
        const execute = () => executeSave(request, queuedTarget, options);
        const result = saveQueueTail.then(execute, execute);
        saveQueueTail = result.then(() => undefined, () => undefined);
        return result;
    }

    const canSave = computed(() => deps.hasPendingUnsavedChanges?.value ?? (
        deps.hasUnsavedChanges?.() ?? (
            deps.annotations.dirty.value
            || deps.annotations.hasChanges()
            || deps.metadata.pageLabelsDirty.value
            || deps.metadata.bookmarksDirty.value
            || deps.shapes.hasChanges()
        )
    ));
    const isAnySaving = computed(() => deps.status.isSaving.value || deps.status.isSavingAs.value);
    const saveIfDirty = (options: {withinDocumentOperationLease?: boolean} = {}) => (
        deps.hasPendingUnsavedChanges || deps.hasUnsavedChanges
            ? canSave.value ? save({kind: 'save'}, options) : Promise.resolve(true)
            : save({kind: 'save'}, options)
    );

    return {
        save,
        hasSaveFailure: failureSurface.hasSaveFailure,
        canSave,
        isAnySaving,
        handleSave: saveIfDirty,
        handleSaveWithinDocumentOperationLease: () => saveIfDirty({withinDocumentOperationLease: true}),
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
        ) => canSave.value
            ? saveIfDirty().then(saved => saved ? save({
                kind: 'optimize-copy',
                options,
                ...(requestId === undefined ? {} : {requestId}),
            }) : false)
            : save({
                kind: 'optimize-copy',
                options,
                ...(requestId === undefined ? {} : {requestId}),
            }),
    };
};
