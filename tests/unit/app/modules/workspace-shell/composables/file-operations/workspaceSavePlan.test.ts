import {
    describe,
    expect,
    it,
} from 'vitest';
import {createWorkspaceSavePlan} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import type {
    IWorkspaceSaveDirtyState,
    TWorkspaceSaveRequest,
} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireRequestId} from '@contracts/shared';

const CLEAN_DIRTY_STATE: IWorkspaceSaveDirtyState = {
    annotationChanges: false,
    annotationDirty: false,
    bookmarks: false,
    pageLabels: false,
    pendingDeletes: false,
    shapes: false,
};

function dirtyState(
    overrides: Partial<IWorkspaceSaveDirtyState> = {},
): IWorkspaceSaveDirtyState {
    return {
        ...CLEAN_DIRTY_STATE,
        ...overrides,
    };
}

function buildPlan(options: {
    request?: TWorkspaceSaveRequest;
    dirtyState?: IWorkspaceSaveDirtyState;
    hasManagedShapes?: boolean;
    canPersistNativeWorkingCopy?: boolean;
} = {}) {
    return createWorkspaceSavePlan({
        request: options.request ?? {kind: 'save'},
        target: {
            expectedDocumentSessionKey: 'document-session-1',
            expectedOriginalPath: requireDocumentRef('/tmp/source.pdf'),
            expectedWorkingPath: requireDocumentRef('/tmp/work.pdf'),
            expectedRevisionToken: requireDocumentRevisionToken('rev-1'),
        },
        baseline: {
            annotations: 'annotations-1',
            pageLabels: 'labels-1',
            bookmarks: 'bookmarks-1',
        },
        dirtyState: options.dirtyState ?? CLEAN_DIRTY_STATE,
        hasManagedShapes: options.hasManagedShapes ?? false,
        canPersistNativeWorkingCopy: options.canPersistNativeWorkingCopy ?? false,
    });
}

describe('workspaceSavePlan', () => {
    it('represents clean Save and Save As as working-copy sourced serialized plans', () => {
        const save = buildPlan();
        const saveAs = buildPlan({request: {
            kind: 'save-as',
            optimizeLossless: true,
        }});

        expect(save).toMatchObject({
            kind: 'serialized',
            destination: 'original',
            body: {
                source: 'working-copy',
                requiresLargeFileGuard: false,
                preserveLoadedSource: true,
            },
        });
        expect(saveAs).toMatchObject({
            kind: 'serialized',
            destination: 'save-as',
            body: {
                source: 'working-copy',
                preserveLoadedSource: false,
            },
        });
        expect(saveAs.target).toEqual({
            expectedDocumentSessionKey: 'document-session-1',
            expectedOriginalPath: '/tmp/source.pdf',
            expectedWorkingPath: '/tmp/work.pdf',
            expectedRevisionToken: requireDocumentRevisionToken('rev-1'),
        });
    });

    it.each([
        [
            {kind: 'repair'} as const,
            'repair',
        ],
        [
            {kind: 'optimize'} as const,
            'optimize',
        ],
    ])('plans clean %s through native working-copy persistence', (request, operation) => {
        expect(buildPlan({
            request,
            canPersistNativeWorkingCopy: true,
        })).toMatchObject({
            kind: 'native-working-copy',
            operation,
        });
    });

    it('plans a dirty Optimize as a serialized rewrite', () => {
        const plan = buildPlan({
            request: {kind: 'optimize'},
            dirtyState: dirtyState({annotationDirty: true}),
            canPersistNativeWorkingCopy: true,
        });

        expect(plan).toMatchObject({
            kind: 'serialized',
            destination: 'original',
            body: {
                source: 'working-copy',
                forceRewrite: true,
                requiresLargeFileGuard: true,
                preserveLoadedSource: false,
            },
        });
    });

    it.each([
        true,
        false,
    ])('plans dirty Repair through the staged repair route (native repair writer: %s)', canPersistNativeWorkingCopy => {
        expect(buildPlan({
            request: {kind: 'repair'},
            dirtyState: dirtyState({bookmarks: true}),
            canPersistNativeWorkingCopy,
        })).toMatchObject({
            kind: 'staged-repair',
            request: {kind: 'repair'},
            serializedFallback: {
                source: 'working-copy',
                forceRewrite: true,
            },
        });
    });

    it('plans eligible dirty Save through native mutations with an explicit serialized fallback', () => {
        const plan = buildPlan({
            dirtyState: dirtyState({annotationChanges: true}),
        });

        expect(plan).toMatchObject({
            kind: 'native-mutation',
            serializedFallback: {
                source: 'working-copy',
                requiresLargeFileGuard: true,
            },
        });
    });

    it('routes dirty Save As through the same native writer path', () => {
        expect(buildPlan({
            request: {
                kind: 'save-as',
                optimizeLossless: false,
            },
            dirtyState: dirtyState({annotationChanges: true}),
        }).kind).toBe('native-mutation');
    });

    it('keeps managed shape writes on the native writer path', () => {
        const plan = buildPlan({
            dirtyState: dirtyState({shapes: true}),
            hasManagedShapes: true,
        });

        expect(plan).toMatchObject({kind: 'native-mutation'});
    });

    it('uses the optimization variant only for optimize-copy requests', () => {
        expect(buildPlan({request: {
            kind: 'optimize-copy',
            options: {preset: 'lossless'},
            requestId: requireRequestId('optimize-1'),
        }})).toMatchObject({
            kind: 'optimization',
            request: {
                kind: 'optimize-copy',
                requestId: 'optimize-1',
            },
        });
    });
});
