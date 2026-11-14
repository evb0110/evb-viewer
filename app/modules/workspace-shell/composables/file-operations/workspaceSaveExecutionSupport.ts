import type {
    ComputedRef, Ref,
} from 'vue';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {TRequestId} from '@contracts/shared';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type {
    IPdfNativeAnnotationIdentityBinding,
    IPdfNativeMutationSet,
    IPdfOptimizeOptions,
    IPdfOptimizeResult,
    TPreparedPdfOptimizeCopy,
    IPdfSerializedCommitCallbacks,
} from '@contracts/electronApiDocuments';
import type {TPdfDateString} from '@contracts/pdfDateString';
import {
    NativePdfSaveRequiredError,
    type IPdfDocument,
    type IPdfViewerSaveExpose,
    type IPdfViewerSaveTransactionDocumentStructure,
    type IPdfViewerSaveTransactionNativeCapabilities,
    type IPdfViewerNativeMaterializationRequest,
} from '@app/modules/pdf-viewer/public';
import type {
    IPdfPersistResult, IPdfSaveResult,
} from '@app/types/pdfUi';
import type {TDocumentOperationKind} from '@app/types/documentOperationKind';
import type {TWorkspaceFailureSurface} from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import {collectDirtyState} from '@app/modules/workspace-shell/composables/file-operations/workspaceSaveState';
import {isNativeDocumentRef} from '@app/utils/documentRef';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import {
    consumeNativePdfMutationProjection,
    type INativePdfSaveTransactionOptions,
} from '@app/modules/workspace-shell/composables/consumeNativePdfMutationProjection';
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
        requestId?: TRequestId;
        /** Receives what the optimizer did, including a copy it declined to write. */
        onResult?: (result: IPdfOptimizeResult) => void;
        /** The platform's Optimize, bound to the target picked during the user's click. */
        preparedOptimize?: TPreparedPdfOptimizeCopy;
        /** Ends the optimization when its document goes away. */
        signal?: AbortSignal;
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
    /** The metadata values the save writes, acknowledged once it has. */
    writtenPageLabelRanges?: IPdfPageLabelRange[] | undefined;
    writtenBookmarkItems?: IPdfBookmarkEntry[] | undefined;
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
        kind: 'staged-repair';
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
        // Applied OCR/page operations are already represented by the live document.
        // Persisting those bytes does not require replacing its rendered surface.
        preserveLoadedSource: request.kind === 'save' && !forcedByDirtyState
            && Boolean(target.expectedOriginalPath)
            && isNativeDocumentRef(target.expectedWorkingPath),
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
    if ((request.kind === 'save' || request.kind === 'save-as') && forcedByDirtyState) {
        return {
            ...common,
            kind: 'native-mutation',
            request,
            serializedFallback: body,
        };
    }
    if (request.kind === 'repair' && forcedByDirtyState) {
        return {
            ...common,
            kind: 'staged-repair',
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
    optimizePdfOnSaveAs?: Ref<boolean>;
    annotations: {
        dirty: Ref<boolean>;
        markSaved: () => void;
        getSaveStateToken?: () => unknown;
        hasChanges: () => boolean;
        hasPendingDeletes?: () => boolean;
        openNoteCount: Ref<number>;
        persistOpenNotes: () => Promise<boolean>;
        getNoteFailurePresentation?: () => Parameters<TWorkspaceFailureSurface['reportSaveFailure']>[3];
    };
    metadata: {
        totalPages: Readonly<Ref<number>>;
        pageLabelsDirty: Ref<boolean>;
        pageLabelRanges: Ref<IPdfPageLabelRange[]>;
        bookmarksDirty: Ref<boolean>;
        bookmarkItems: Ref<IPdfBookmarkEntry[]>;
        untitledBookmarkLabel: string;
        markPageLabelsSaved: (written?: IPdfPageLabelRange[]) => void;
        getPageLabelsSaveStateToken?: () => unknown;
        markBookmarksSaved: (written?: IPdfBookmarkEntry[]) => void;
        getBookmarksSaveStateToken?: () => unknown;
    };
    pdf: {
        document: Readonly<Ref<IPdfDocument | null>>;
        viewer: Readonly<Ref<{
            runSaveTransaction: IPdfViewerSaveExpose['runSaveTransaction'];
            getAnnotationDirtyEntityCount?: (() => number) | undefined
        } | null>>;
        commitEditorsForSave?: () => Promise<void>;
        runSaveTransaction: IPdfViewerSaveExpose['runSaveTransaction'];
        getSourceData: () => Promise<Uint8Array | null>;
    };
    shapes: {
        hasChanges: () => boolean;
        hasManagedShapes: () => boolean;
    };
    persistence: {
        validatePdfPath: (path: TDocumentRef) => Promise<IPdfSaveResult['validation']>;
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
                onResult?: (result: IPdfOptimizeResult) => void;
                preparedOptimize?: TPreparedPdfOptimizeCopy;
                signal?: AbortSignal;
            },
        ) => Promise<IPdfPersistResult>;
        trySavePdfNativeMutations: (
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
        getWorkingCopySize?: (path: TDocumentRef) => Promise<number | null>;
    };
    lifecycle: {
        loadRecentFiles: () => void;
        preparePostSaveReload?: () => IPostSaveReloadWaiter;
    };
    /** The document lease: the one queue every Save and recovery copy waits in. */
    runWithDocumentOperationLease: <T>(
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
): IPdfViewerNativeMaterializationRequest {
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
        hasNativePdfMutationCapability: options.allowNativeMutationPlan,
        canPersistNativeMetadataMutations: options.allowNativeMutationPlan,
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
        pageLabelsDirty: Readonly<Ref<boolean>>;
        markPageLabelsSaved: (written?: IPdfPageLabelRange[]) => void;
        getPageLabelsSaveStateToken?: () => unknown;
        bookmarksDirty: Readonly<Ref<boolean>>;
        markBookmarksSaved: (written?: IPdfBookmarkEntry[]) => void;
        getBookmarksSaveStateToken?: () => unknown;
    };
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
) {
    const annotationUnchanged = !deps.annotations.getSaveStateToken
        || Object.is(deps.annotations.getSaveStateToken(), baseline.annotations);
    if (policy.markAnnotationStateSaved && annotationUnchanged) {
        deps.annotations.markSaved();
    }

    // A metadata field is acknowledged as the value the save wrote: what the
    // reader shows now is unsaved exactly where it differs from that, whether
    // edited on or back while saving. Without the written value, it is
    // acknowledged only at the revision the save wrote, or once clean again.
    const pageLabelsUnchanged = !deps.metadata.getPageLabelsSaveStateToken
        || Object.is(deps.metadata.getPageLabelsSaveStateToken(), baseline.pageLabels);
    if (policy.markPageLabelsStateSaved && (baseline.writtenPageLabelRanges || pageLabelsUnchanged || !deps.metadata.pageLabelsDirty.value)) {
        deps.metadata.markPageLabelsSaved(baseline.writtenPageLabelRanges);
    }

    const bookmarksUnchanged = !deps.metadata.getBookmarksSaveStateToken
        || Object.is(deps.metadata.getBookmarksSaveStateToken(), baseline.bookmarks);
    if (policy.markBookmarksStateSaved && (baseline.writtenBookmarkItems || bookmarksUnchanged || !deps.metadata.bookmarksDirty.value)) {
        deps.metadata.markBookmarksSaved(baseline.writtenBookmarkItems);
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
    return {
        forceWriterSave: false,
        nativeCapabilities: {
            hasNativePdfMutationCapability: canStageNativeMutation,
            canPersistNativeMetadataMutations: canStageNativeMutation,
        },
        dirtyState: {
            annotationDirty: collectDirtyState(deps).annotationDirty,
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
    /** Waits for the reload in every view, each kept on its own page. */
    waitForPdfReload: () => Promise<unknown>;
    reloadWorkingCopyRevision?: () => Promise<unknown>;
}) {
    return async function saveAnnotationsForPageMutation() {
        const saveDeps = deps.save;
        if (!await saveDeps.annotations.persistOpenNotes()) {
            return false;
        }
        if (!Object.values(collectDirtyState(saveDeps)).some(Boolean)) {
            return true;
        }

        const capturedWorkingCopyPath = saveDeps.document.workingCopyPath.value;
        const viewer = saveDeps.pdf.viewer.value;
        const capturedDocumentRevisionToken = saveDeps.document.revisionToken.value;
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
            ...getNativeSaveTransactionOptions(saveDeps),
        });
        if (transaction.verifiedUnchangedWorkingCopy) return isCapturedTargetCurrent();
        if (transaction.nativeRequiredFailure) throw new NativePdfSaveRequiredError(transaction.nativeRequiredFailure);
        const projection = transaction.nativeMutationProjection;
        if (!projection || !isCapturedTargetCurrent()) {
            return false;
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
        transaction.commitAnnotationSave?.(materializedIdentityBindings);
        const reloadPromise = deps.waitForPdfReload();
        await deps.reloadWorkingCopyRevision?.();
        await reloadPromise;
        return isCapturedTargetCurrent(false);
    };
}
