import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPdfOptimizeOptions} from '@contracts/electronApiDocuments';
import type {TRequestId} from '@contracts/shared';
import type {
    IPdfViewerSaveTransactionDocumentStructure,
    IPdfViewerSaveTransactionNativeCapabilities,
    IPdfViewerSaveTransactionRequest,
} from '@app/modules/pdf-viewer/public';
import {isNativeDocumentRef} from '@app/utils/documentRef';

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
        request,
        target,
        baseline,
        dirtyState,
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

export interface IWorkspaceSaveTransactionDependencies {
    metadata: {
        pageLabelRanges: {value: IPdfPageLabelRange[]};
        bookmarkItems: {value: IPdfBookmarkEntry[]};
        untitledBookmarkLabel: string;
        totalPages: {value: number};
    };
    pdf: {
        document: {value: IPdfDocument | null};
        getSourceData: () => Promise<Uint8Array | null>;
    };
    persistence: {
        trySavePdfNativeMutations?: unknown;
        trySaveEmbeddedNoteTextUpdates?: unknown;
    };
}

export function buildSaveTransactionRequest(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveTransactionDependencies,
    body: IWorkspaceSerializedSaveBody,
    options: {allowNativeMutationPlan: boolean;},
): IPdfViewerSaveTransactionRequest {
    const documentStructure: IPdfViewerSaveTransactionDocumentStructure = {
        pageLabelsDirty: plan.dirtyState.pageLabels,
        pageLabelRanges: deps.metadata.pageLabelRanges.value,
        bookmarksDirty: plan.dirtyState.bookmarks,
        bookmarkItems: deps.metadata.bookmarkItems.value,
        untitledBookmarkLabel: deps.metadata.untitledBookmarkLabel,
        totalPages: deps.metadata.totalPages.value > 0 ? deps.metadata.totalPages.value : deps.pdf.document.value?.numPages ?? 0,
    };
    const nativeCapabilities: IPdfViewerSaveTransactionNativeCapabilities = {
        hasNativePdfMutationCapability: options.allowNativeMutationPlan && Boolean(deps.persistence.trySavePdfNativeMutations ?? deps.persistence.trySaveEmbeddedNoteTextUpdates),
        canPersistNativeMetadataMutations: options.allowNativeMutationPlan && Boolean(deps.persistence.trySavePdfNativeMutations),
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
