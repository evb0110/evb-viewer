import type {
    ComputedRef, Ref, ShallowRef,
} from 'vue';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {TRequestId} from '@contracts/shared';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeAnnotationIdentityBinding,
    IPdfNativeFreeTextNote,
    IPdfNativeMutationSet,
    IPdfNativePlacedImageGeometryUpdate,
    IPdfNoteGeometryUpdate,
    IPdfNoteTextUpdate,
    IPdfOptimizeOptions,
    IPdfSerializedCommitCallbacks,
} from '@contracts/electronApiDocuments';
import type {TPdfDateString} from '@contracts/pdfDateString';
import type {
    IPdfViewerSaveExpose,
    IPdfViewerSaveTransactionDocumentStructure,
    IPdfViewerSaveTransactionNativeCapabilities,
    IPdfViewerSaveTransactionRequest,
} from '@app/modules/pdf-viewer/public';
import type {
    IPdfPersistResult, IPdfSaveResult,
} from '@app/types/pdfUi';
import type {TDocumentOperationKind} from '@app/types/documentOperationKind';
import type {TWorkspaceFailureSurface} from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import {isNativeDocumentRef} from '@app/utils/documentRef';
import {readDocumentBytes} from '@app/utils/documentBytes';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import {
    consumeNativePdfMutationProjection,
    NativePdfSaveRequiredError,
    type INativePdfSaveTransactionOptions,
} from '@app/modules/workspace-shell/composables/nativePdfMutationArtifact';
import type {
    IPostSaveReloadWaiter,
    ISaveCompletionPolicy,
    TWorkspaceSaveExecutionResult,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionResult';
export type TWorkspaceSaveRequest =
    | {kind: 'save'}
    | {
        kind: 'save-as';
        optimizeLossless: boolean
    }
    | {kind: 'repair'}
    | {kind: 'optimize'}
    | {
        kind: 'optimize-copy';
        options: IPdfOptimizeOptions;
        requestId?: TRequestId
    };

export interface IWorkspaceSaveTarget {
    expectedDocumentSessionKey: string | null;
    expectedOriginalPath: TDocumentRef | null;
    expectedWorkingPath: TDocumentRef | null;
    expectedRevisionToken: TDocumentRevisionToken | null;
}

export interface IWorkspaceSaveBaseline {
    annotations: unknown;
    pageLabels: unknown;
    bookmarks: unknown;
}

export interface IWorkspaceSaveDirtyState {
    annotationDirty: boolean;
    annotationChanges: boolean;
    bookmarks: boolean;
    pageLabels: boolean;
    pendingDeletes: boolean;
    shapes: boolean;
}

export interface IWorkspaceSerializedSaveBody {
    source: 'working-copy';
    forceRewrite: boolean;
    includeManagedShapes: boolean;
    preserveLoadedSource: boolean;
    requiresLargeFileGuard: boolean;
}

interface IWorkspaceSavePlanCommon {
    request: TWorkspaceSaveRequest;
    target: IWorkspaceSaveTarget;
    baseline: IWorkspaceSaveBaseline;
    dirtyState: IWorkspaceSaveDirtyState;
}

export type TWorkspaceSavePlan =
    | (IWorkspaceSavePlanCommon & {
        kind: 'serialized';
        destination: 'original' | 'save-as';
        body: IWorkspaceSerializedSaveBody
    })
    | (IWorkspaceSavePlanCommon & {
        kind: 'native-working-copy';
        request: Extract<TWorkspaceSaveRequest, {kind: 'repair' | 'optimize'}>;
        operation: 'repair' | 'optimize'
    })
    | (IWorkspaceSavePlanCommon & {
        kind: 'native-mutation';
        request: Extract<TWorkspaceSaveRequest, {kind: 'save' | 'save-as'}>;
        serializedFallback: IWorkspaceSerializedSaveBody
    })
    | (IWorkspaceSavePlanCommon & {
        kind: 'native-repair';
        request: Extract<TWorkspaceSaveRequest, {kind: 'repair'}>;
        serializedFallback: IWorkspaceSerializedSaveBody
    })
    | (IWorkspaceSavePlanCommon & {
        kind: 'optimization';
        request: Extract<TWorkspaceSaveRequest, {kind: 'optimize-copy'}>
    });

export function createWorkspaceSavePlan(input: {
    request: TWorkspaceSaveRequest;
    target: IWorkspaceSaveTarget;
    baseline: IWorkspaceSaveBaseline;
    dirtyState: IWorkspaceSaveDirtyState;
    hasManagedShapes: boolean;
    canPersistNativeWorkingCopy: boolean;
    canPersistNativeMutations: boolean;
    canPersistNativeRepair?: boolean;
}): TWorkspaceSavePlan {
    const {
        request, target, baseline, dirtyState,
    } = input;
    const common = {
        request,
        target,
        baseline,
        dirtyState,
    };
    if (request.kind === 'optimize-copy') {
        return {
            ...common,
            kind: 'optimization',
            request,
        };
    }
    const forcedByDirtyState = Object.values(dirtyState).some(Boolean);
    const forceRewrite = request.kind === 'repair' || request.kind === 'optimize';
    const body = {
        source: 'working-copy' as const,
        forceRewrite,
        includeManagedShapes: input.hasManagedShapes && dirtyState.shapes,
        preserveLoadedSource: false,
        requiresLargeFileGuard: forcedByDirtyState || forceRewrite,
    };
    if ((request.kind === 'repair' || request.kind === 'optimize') && !forcedByDirtyState
        && Boolean(target.expectedOriginalPath) && Boolean(target.expectedWorkingPath)
        && input.canPersistNativeWorkingCopy) {
        return {
            ...common,
            kind: 'native-working-copy',
            request,
            operation: request.kind,
        };
    }
    if ((request.kind === 'save' || request.kind === 'save-as') && forcedByDirtyState
        && input.canPersistNativeMutations) {
        return {
            ...common,
            kind: 'native-mutation',
            request,
            serializedFallback: body,
        };
    }
    if (request.kind === 'repair' && forcedByDirtyState && input.canPersistNativeRepair) {
        return {
            ...common,
            kind: 'native-repair',
            request,
            serializedFallback: body,
        };
    }
    return {
        ...common,
        kind: 'serialized',
        destination: request.kind === 'save-as' ? 'save-as' : 'original',
        body,
    };
}

export function getSaveMode(plan: TWorkspaceSavePlan): TPdfSaveMode {
    return plan.request.kind === 'save-as' || plan.request.kind === 'optimize-copy' ? 'save_as_rewrite' : 'rewrite';
}

export function getSaveFlow(plan: TWorkspaceSavePlan): 'save' | 'save_as' {
    return plan.request.kind === 'save-as' || plan.request.kind === 'optimize-copy' ? 'save_as' : 'save';
}

export function requiresNativePathBackedSave(plan: TWorkspaceSavePlan) {
    return isNativeDocumentRef(plan.target.expectedWorkingPath);
}

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
        wasEncrypted?: Ref<boolean>;
    };
    unencryptedSaveNotice?: {
        request: () => Promise<{
            confirmed: boolean;
            dontShowAgain: boolean
        }>;
        suppress: Ref<boolean>;
        updateSuppress: () => void;
        resetSuppress: () => void;
        flushSettings: () => Promise<boolean>;
    };
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
        viewer: Ref<{runSaveTransaction: IPdfViewerSaveExpose['runSaveTransaction']} | null>;
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

export function buildSaveTransactionRequest(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveDependencies,
    body: IWorkspaceSerializedSaveBody,
    options: {allowNativeMutationPlan: boolean},
): IPdfViewerSaveTransactionRequest {
    const documentStructure: IPdfViewerSaveTransactionDocumentStructure = {
        pageLabelsDirty: plan.dirtyState.pageLabels,
        pageLabelRanges: deps.metadata.pageLabelRanges.value,
        bookmarksDirty: plan.dirtyState.bookmarks,
        bookmarkItems: deps.metadata.bookmarkItems.value,
        untitledBookmarkLabel: deps.metadata.untitledBookmarkLabel,
        totalPages: deps.metadata.totalPages.value > 0
            ? deps.metadata.totalPages.value
            : deps.pdf.document.value?.numPages ?? 0,
    };
    const nativeCapabilities: IPdfViewerSaveTransactionNativeCapabilities = {
        hasNativePdfMutationCapability: options.allowNativeMutationPlan
            && Boolean(deps.persistence.trySavePdfNativeMutations ?? deps.persistence.trySaveEmbeddedNoteTextUpdates),
        canPersistNativeMetadataMutations: options.allowNativeMutationPlan
            && Boolean(deps.persistence.trySavePdfNativeMutations),
    };
    return {
        mode: 'persist',
        saveMode: getSaveMode(plan),
        saveFlowMode: getSaveFlow(plan),
        forceWriterSave: false,
        includeManagedShapes: body.includeManagedShapes,
        rewriteShapeState: plan.dirtyState.shapes,
        forceRewrite: body.forceRewrite,
        dirtyState: {
            annotationDirty: plan.dirtyState.annotationDirty,
            hasAnnotationChanges: plan.dirtyState.annotationChanges,
            shapeStateDirty: plan.dirtyState.shapes,
        },
        nativeCapabilities,
        documentStructure,
        source: {getSourcePdfData: deps.pdf.getSourceData},
        workingPath: requiresNativePathBackedSave(plan) ? plan.target.expectedWorkingPath : null,
        requiresManagedShapeBaseline: true,
    };
}

export interface IWorkspaceSaveExecutionSupportDependencies {
    document: {
        sessionKey: {value: string | null};
        originalPath: {value: TDocumentRef | null};
        workingCopyPath: {value: TDocumentRef | null};
    };
    lifecycle: {preparePostSaveReload?: () => IPostSaveReloadWaiter;};
}

export function isTargetCurrent(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveExecutionSupportDependencies,
) {
    return deps.document.sessionKey.value === plan.target.expectedDocumentSessionKey
        && deps.document.originalPath.value === plan.target.expectedOriginalPath
        && deps.document.workingCopyPath.value === plan.target.expectedWorkingPath;
}

export function createReloadWaiter(
    body: IWorkspaceSerializedSaveBody,
    deps: IWorkspaceSaveExecutionSupportDependencies,
) {
    return body.preserveLoadedSource ? null : deps.lifecycle.preparePostSaveReload?.() ?? null;
}

export async function withReloadWaiter<T>(
    reloadWaiter: IPostSaveReloadWaiter | null,
    operation: () => Promise<T>,
) {
    try {
        return await operation();
    } catch (error) {
        reloadWaiter?.cancel();
        throw error;
    }
}

export interface IWorkspaceSaveCompletionDependencies {
    annotations: {
        markSaved: () => void;
        getSaveStateToken?: () => unknown;
    };
    metadata: {
        markPageLabelsSaved: () => void;
        getPageLabelsSaveStateToken?: () => unknown;
        markBookmarksSaved: () => void;
        getBookmarksSaveStateToken?: () => unknown;
    };
    shapes: {markSaved?: (prepared?: unknown) => void;};
}

export function getCompletionBaseline(
    plan: TWorkspaceSavePlan,
    result: Extract<TWorkspaceSaveExecutionResult, {status: 'saved'}>,
    deps: IWorkspaceSaveCompletionDependencies,
): IWorkspaceSaveBaseline {
    if (result.annotationMaterializationBaseline === undefined) {
        result.commitAnnotationSave?.(result.persisted.materializedIdentityBindings);
        return plan.baseline;
    }

    const saveFrontierIsStillCurrent = !deps.annotations.getSaveStateToken
        || Object.is(
            deps.annotations.getSaveStateToken(),
            result.annotationMaterializationBaseline,
        );
    result.commitAnnotationSave?.(result.persisted.materializedIdentityBindings);
    return {
        ...plan.baseline,
        annotations: saveFrontierIsStillCurrent
            ? deps.annotations.getSaveStateToken?.()
            : result.annotationMaterializationBaseline,
    };
}

export function completeSuccessfulSaveState(
    baseline: IWorkspaceSaveBaseline,
    policy: ISaveCompletionPolicy,
    deps: IWorkspaceSaveCompletionDependencies,
    preparedShapeState?: unknown,
) {
    const annotationUnchanged = !deps.annotations.getSaveStateToken
        || Object.is(deps.annotations.getSaveStateToken(), baseline.annotations);
    if (policy.markAnnotationStateSaved
        && (annotationUnchanged || policy.allowAnnotationSaveStateRefresh === true)) {
        deps.annotations.markSaved();
    }

    const pageLabelsUnchanged = !deps.metadata.getPageLabelsSaveStateToken
        || Object.is(deps.metadata.getPageLabelsSaveStateToken(), baseline.pageLabels);
    if (policy.markPageLabelsStateSaved
        && (pageLabelsUnchanged || policy.allowPageLabelsSaveStateRefresh === true)) {
        deps.metadata.markPageLabelsSaved();
    }

    const bookmarksUnchanged = !deps.metadata.getBookmarksSaveStateToken
        || Object.is(deps.metadata.getBookmarksSaveStateToken(), baseline.bookmarks);
    if (policy.markBookmarksStateSaved
        && (bookmarksUnchanged || policy.allowBookmarksSaveStateRefresh === true)) {
        deps.metadata.markBookmarksSaved();
    }

    if (policy.markShapeStateSaved) {
        // The prepared token names the store and save frontier this save primed.
        // Passing it makes the clean mark refusable when a replacement store
        // now owns the viewer.
        deps.shapes.markSaved?.(preparedShapeState);
    }
}

export function getNativeSaveTransactionOptions(
    deps: IWorkspaceSaveDependencies,
): INativePdfSaveTransactionOptions {
    const documentFiles = getDocumentFilesCapability();
    const canStageNativeMutation = (
        typeof documentFiles.releaseManagedTempFileHandle === 'function'
        && typeof documentFiles.applyPdfNativeMutationsToWorkingCopy === 'function'
    );
    const canConsumeNativeMutation = (
        typeof documentFiles.cloneStagedPdfNativeMutationToWorkingCopy === 'function'
        && typeof documentFiles.replaceWorkingCopyFromStagedPdfNativeMutation === 'function'
    );
    return {
        forceWriterSave: false,
        nativeCapabilities: {
            hasNativePdfMutationCapability: canStageNativeMutation,
            canPersistNativeMetadataMutations: canStageNativeMutation && canConsumeNativeMutation,
        },
        dirtyState: {
            annotationDirty: deps.annotations.dirty.value,
            hasAnnotationChanges: deps.annotations.hasChanges(),
            shapeStateDirty: deps.shapes.hasChanges(),
        },
        documentStructure: {
            pageLabelsDirty: deps.metadata.pageLabelsDirty.value,
            pageLabelRanges: deps.metadata.pageLabelRanges.value,
            bookmarksDirty: deps.metadata.bookmarksDirty.value,
            bookmarkItems: deps.metadata.bookmarkItems.value,
            untitledBookmarkLabel: deps.metadata.untitledBookmarkLabel,
            totalPages: deps.metadata.totalPages.value > 0
                ? deps.metadata.totalPages.value
                : (deps.pdf.document.value?.numPages ?? 0),
        },
    };
}

export function createPageMutationWriterSave(deps: {
    save: IWorkspaceSaveDependencies;
    currentPage: Readonly<Ref<number>>;
    waitForPdfReload: (page: number) => Promise<unknown>;
    loadPdfFromPath?: (path: TDocumentRef, options?: {markDirty?: boolean}) => Promise<unknown>;
    getNativeSaveTransactionOptions: () => INativePdfSaveTransactionOptions;
}) {
    return async function saveAnnotationsForPageMutation() {
        const saveDeps = deps.save;
        const hasPendingAnnotations = saveDeps.annotations.dirty.value
            || saveDeps.annotations.hasChanges()
            || saveDeps.annotations.hasPendingDeletes?.() === true;
        if (!hasPendingAnnotations) {
            return true;
        }

        const capturedWorkingCopyPath = saveDeps.document.workingCopyPath.value;
        const viewer = saveDeps.pdf.viewer.value;
        const capturedDocumentRevisionToken = saveDeps.document.revisionToken.value;
        const capturedPage = deps.currentPage.value;
        if (!capturedWorkingCopyPath || !viewer) {
            return false;
        }
        const isCapturedTargetCurrent = (includeRevision = true) => (
            saveDeps.document.workingCopyPath.value === capturedWorkingCopyPath
            && saveDeps.pdf.viewer.value === viewer
            && (!includeRevision || saveDeps.document.revisionToken.value === capturedDocumentRevisionToken)
        );
        const transaction = await viewer.runSaveTransaction({
            mode: 'embedded-mutation',
            saveFlowMode: 'save',
            forceWriterSave: false,
            workingPath: capturedWorkingCopyPath,
            ...deps.getNativeSaveTransactionOptions(),
        });
        if (transaction.nativeRequiredFailure) {
            throw new NativePdfSaveRequiredError(transaction.nativeRequiredFailure);
        }
        const projection = transaction.nativeMutationProjection;
        if (!projection || !isCapturedTargetCurrent()) {
            return false;
        }
        if (!deps.loadPdfFromPath) {
            throw new NativePdfSaveRequiredError({
                code: 'native-save-required',
                phase: 'pre-write',
                reason: 'missing-native-capability',
                detail: 'Native PDF page mutation reload is unavailable',
            });
        }
        await transaction.assertAnnotationSaveCurrent?.();
        let materializedIdentityBindings: readonly IPdfNativeAnnotationIdentityBinding[] = [];
        await consumeNativePdfMutationProjection({
            workingPath: capturedWorkingCopyPath,
            expectedDocumentRevisionToken: capturedDocumentRevisionToken,
            projection,
            operation: 'replace',
            ...(transaction.verifyAnnotationSavePath ? {verifyPathBeforeExpose: transaction.verifyAnnotationSavePath} : {}),
            ...(transaction.assertAnnotationSaveCurrent ? {assertBeforeExpose: transaction.assertAnnotationSaveCurrent} : {}),
            onIdentityBindings: bindings => {
                materializedIdentityBindings = bindings;
            },
        });
        if (!isCapturedTargetCurrent(false)) {
            return false;
        }
        let didCommitAnnotationSave = false;
        if (materializedIdentityBindings.length > 0) {
            transaction.commitAnnotationSave?.(materializedIdentityBindings);
            didCommitAnnotationSave = true;
        }
        const reloadPromise = deps.waitForPdfReload(capturedPage);
        await deps.loadPdfFromPath(capturedWorkingCopyPath, {markDirty: true});
        await reloadPromise;
        if (!isCapturedTargetCurrent(false)) {
            return false;
        }
        if (!didCommitAnnotationSave) transaction.commitAnnotationSave?.(materializedIdentityBindings);
        return true;
    };
}

export function createRecoverySnapshotBytes(
    deps: IWorkspaceSaveDependencies,
    runWithDocumentOperationLease: NonNullable<IWorkspaceSaveDependencies['runWithDocumentOperationLease']>,
) {
    async function createRecoverySnapshotBytesUnlocked() {
        const viewer = deps.pdf.viewer.value;
        const capturedWorkingCopyPath = deps.document.workingCopyPath.value;
        const capturedDocumentRevisionToken = deps.document.revisionToken.value;
        const ownsCapturedDocument = () => (
            deps.document.workingCopyPath.value === capturedWorkingCopyPath
            && deps.document.revisionToken.value === capturedDocumentRevisionToken
        );
        if (!viewer || !capturedWorkingCopyPath || deps.hasPendingUnsavedChanges?.value !== true) {
            return null;
        }
        if (isNativeDocumentRef(capturedWorkingCopyPath)) {
            return null;
        }
        if (!await deps.annotations.persistOpenNotes()) {
            throw new Error('Open annotation notes could not be prepared for crash recovery.');
        }
        const shapeStateDirty = deps.shapes.hasChanges();
        const result = await deps.pdf.runSaveTransaction({
            mode: 'snapshot',
            saveMode: 'rewrite',
            saveFlowMode: 'save',
            includeManagedShapes: shapeStateDirty,
            rewriteShapeState: shapeStateDirty,
            forceRewrite: deps.metadata.pageLabelsDirty.value
                || deps.metadata.bookmarksDirty.value
                || shapeStateDirty,
            requiresManagedShapeBaseline: true,
            dirtyState: {
                annotationDirty: deps.annotations.dirty.value,
                hasAnnotationChanges: deps.annotations.hasChanges(),
                shapeStateDirty,
            },
            documentStructure: {
                pageLabelsDirty: deps.metadata.pageLabelsDirty.value,
                pageLabelRanges: deps.metadata.pageLabelRanges.value,
                bookmarksDirty: deps.metadata.bookmarksDirty.value,
                bookmarkItems: deps.metadata.bookmarkItems.value,
                untitledBookmarkLabel: deps.metadata.untitledBookmarkLabel,
                totalPages: deps.metadata.totalPages.value > 0
                    ? deps.metadata.totalPages.value
                    : (deps.pdf.document.value?.numPages ?? 0),
            },
            source: {getSourcePdfData: deps.pdf.getSourceData},
        });
        if (!result.nativeMutationProjection || capturedDocumentRevisionToken === null || !ownsCapturedDocument()) {
            return null;
        }
        const snapshotRef = await consumeNativePdfMutationProjection({
            workingPath: capturedWorkingCopyPath,
            expectedDocumentRevisionToken: capturedDocumentRevisionToken,
            projection: result.nativeMutationProjection,
            operation: 'clone',
            originalPath: deps.document.originalPath.value,
            ...(result.verifyAnnotationSavePath ? {verifyPathBeforeExpose: result.verifyAnnotationSavePath} : {}),
            ...(result.assertAnnotationSaveCurrent ? {assertBeforeExpose: result.assertAnnotationSaveCurrent} : {}),
        });
        if (!snapshotRef || !ownsCapturedDocument()) {
            return null;
        }
        return readDocumentBytes(snapshotRef);
    }
    return () => runWithDocumentOperationLease('recovery-snapshot', createRecoverySnapshotBytesUnlocked);
}
