import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IPdfOptimizeOptions } from '@contracts/electronApiDocuments';

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
        requestId?: string;
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
    source: 'live-pdfjs' | 'working-copy';
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
    | IWorkspaceSavePlanCommon & {
        kind: 'serialized';
        destination: 'original' | 'save-as';
        body: IWorkspaceSerializedSaveBody;
    }
    | IWorkspaceSavePlanCommon & {
        kind: 'native-working-copy';
        request: Extract<TWorkspaceSaveRequest, {kind: 'repair' | 'optimize'}>;
        operation: 'repair' | 'optimize';
    }
    | IWorkspaceSavePlanCommon & {
        kind: 'native-mutation';
        request: Extract<TWorkspaceSaveRequest, {kind: 'save' | 'save-as'}>;
        serializedFallback: IWorkspaceSerializedSaveBody;
    }
    | IWorkspaceSavePlanCommon & {
        kind: 'optimization';
        request: Extract<TWorkspaceSaveRequest, {kind: 'optimize-copy'}>;
    };

export function createWorkspaceSavePlan(input: {
    request: TWorkspaceSaveRequest;
    target: IWorkspaceSaveTarget;
    baseline: IWorkspaceSaveBaseline;
    dirtyState: IWorkspaceSaveDirtyState;
    hasManagedShapes: boolean;
    canPersistNativeWorkingCopy: boolean;
    canPersistNativeMutations: boolean;
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
    const shouldSerialize = forcedByDirtyState || forceRewrite;
    const includeManagedShapes = input.hasManagedShapes && dirtyState.shapes;
    const serializedBody: IWorkspaceSerializedSaveBody = {
        source: 'working-copy',
        forceRewrite,
        includeManagedShapes,
        preserveLoadedSource: false,
        requiresLargeFileGuard: shouldSerialize,
    };

    if (
        (request.kind === 'repair' || request.kind === 'optimize')
        && !forcedByDirtyState
        && Boolean(target.expectedOriginalPath)
        && Boolean(target.expectedWorkingPath)
        && input.canPersistNativeWorkingCopy
    ) {
        return {
            ...common,
            kind: 'native-working-copy',
            request,
            operation: request.kind,
        };
    }

    if (
        (request.kind === 'save' || request.kind === 'save-as')
        && forcedByDirtyState
        && input.canPersistNativeMutations
    ) {
        return {
            ...common,
            kind: 'native-mutation',
            request,
            serializedFallback: serializedBody,
        };
    }

    return {
        ...common,
        kind: 'serialized',
        destination: request.kind === 'save-as' ? 'save-as' : 'original',
        body: serializedBody,
    };
}
