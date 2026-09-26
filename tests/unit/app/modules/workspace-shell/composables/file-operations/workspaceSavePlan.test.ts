import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed, ref,
} from 'vue';
import {createWorkspaceSavePlan} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import type {
    IWorkspaceSaveDependencies,
    IWorkspaceSaveDirtyState,
    TWorkspaceSaveRequest,
} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireRequestId} from '@contracts/shared';
import type {TDocumentOperationKind} from '@app/types/documentOperationKind';
import type {IPdfViewerSaveTransactionResult} from '@app/modules/pdf-viewer/public';
import {
    createDeps,
    useWorkspaceSaveServiceForTest,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceFixture';
import {cast} from '@tests/helpers/cast';

const recoveryMocks = vi.hoisted(() => ({
    consumeNativePdfMutationProjection: vi.fn(),
    readDocumentBytes: vi.fn(),
}));

vi.mock('@app/modules/workspace-shell/composables/nativePdfMutationArtifact', () => ({
    consumeNativePdfMutationProjection: recoveryMocks.consumeNativePdfMutationProjection,
    NativePdfSaveRequiredError: class NativePdfSaveRequiredError extends Error {},
}));
vi.mock('@app/utils/documentBytes', () => ({readDocumentBytes: recoveryMocks.readDocumentBytes}));

const RECOVERY_CLONE_REF = requireDocumentRef('browser://documents/recovery-clone.pdf');
const RECOVERY_PROJECTION = cast<never>({
    canonicalAnnotationProgram: [],
    mutations: {updates: []},
    noteTextUpdates: [],
    freeTextNotes: [],
    freeTextEditors: [],
    annotationDeletes: [],
    hasMetadataMutations: false,
    hasShapeMutations: false,
    hasMarkupMutations: false,
    phase: 'persist-native-pdf-mutations',
});

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
    canPersistNativeMutations?: boolean;
    canPersistNativeRepair?: boolean;
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
        canPersistNativeMutations: options.canPersistNativeMutations ?? false,
        canPersistNativeRepair: options.canPersistNativeRepair ?? false,
    });
}

describe('workspaceSavePlan', () => {
    beforeEach(() => {
        recoveryMocks.consumeNativePdfMutationProjection.mockReset();
        recoveryMocks.readDocumentBytes.mockReset();
    });
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

    it('plans dirty repair and optimize requests as serialized rewrites', () => {
        const plan = buildPlan({
            request: {kind: 'repair'},
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

    it('plans dirty Repair through the staged native repair route when available', () => {
        expect(buildPlan({
            request: {kind: 'repair'},
            dirtyState: dirtyState({bookmarks: true}),
            canPersistNativeWorkingCopy: true,
            canPersistNativeMutations: true,
            canPersistNativeRepair: true,
        })).toMatchObject({
            kind: 'native-repair',
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
            canPersistNativeMutations: true,
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
            canPersistNativeMutations: true,
        }).kind).toBe('native-mutation');
        expect(buildPlan({dirtyState: dirtyState({annotationChanges: true})}).kind).toBe('serialized');
    });

    it('keeps managed shape writes on the native writer path', () => {
        const plan = buildPlan({
            dirtyState: dirtyState({shapes: true}),
            hasManagedShapes: true,
            canPersistNativeMutations: true,
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

    it('creates a detached recovery snapshot without acknowledging the dirty frontier', async () => {
        const assertAnnotationSaveCurrent = vi.fn(async () => undefined);
        const verifyAnnotationSavePath = vi.fn(async () => undefined);
        const commitAnnotationSave = vi.fn();
        const runSaveTransaction = vi.fn(async () => cast<IPdfViewerSaveTransactionResult>({
            source: 'native-mutation-projection' as const,
            nativeMutationProjection: RECOVERY_PROJECTION,
            fallbackDecision: {},
            annotationSavePlan: {},
            assertAnnotationSaveCurrent,
            verifyAnnotationSavePath,
            commitAnnotationSave,
        }));
        const runWithDocumentOperationLease = cast<NonNullable<
            IWorkspaceSaveDependencies['runWithDocumentOperationLease']
        >>(vi.fn(async <T>(
            _kind: TDocumentOperationKind,
            operation: () => Promise<T>,
        ) => operation()));
        recoveryMocks.consumeNativePdfMutationProjection.mockResolvedValue(RECOVERY_CLONE_REF);
        recoveryMocks.readDocumentBytes.mockResolvedValue(Uint8Array.of(4, 5, 6));
        const documentRevisionToken = ref(requireDocumentRevisionToken('revision-1'));
        const {deps} = createDeps({
            annotationDirty: ref(true),
            hasPendingUnsavedChanges: computed(() => true),
            documentRevisionToken,
            workingCopyPath: ref(requireDocumentRef('browser://documents/recovery.pdf')),
            runSaveTransaction,
            pdfViewerRef: ref({runSaveTransaction}),
            runWithDocumentOperationLease,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.createRecoverySnapshotBytes()).resolves.toEqual(Uint8Array.of(4, 5, 6));
        expect(runWithDocumentOperationLease).toHaveBeenCalledWith('recovery-snapshot', expect.any(Function));
        expect(runSaveTransaction).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'snapshot',
            saveFlowMode: 'save',
        }));
        expect(recoveryMocks.consumeNativePdfMutationProjection).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'clone',
            projection: RECOVERY_PROJECTION,
            verifyPathBeforeExpose: verifyAnnotationSavePath,
            assertBeforeExpose: assertAnnotationSaveCurrent,
        }));
        expect(commitAnnotationSave).not.toHaveBeenCalled();
    });

    it('does not serialize a recovery snapshot for a clean document', async () => {
        const runSaveTransaction = vi.fn();
        const {deps} = createDeps({pdfViewerRef: ref({runSaveTransaction})});
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.createRecoverySnapshotBytes()).resolves.toBeNull();
        expect(runSaveTransaction).not.toHaveBeenCalled();
    });

    it('discards a recovery snapshot when the document revision changes during serialization', async () => {
        const documentRevisionToken = ref(requireDocumentRevisionToken('revision-1'));
        const runSaveTransaction = vi.fn(async () => {
            documentRevisionToken.value = requireDocumentRevisionToken('revision-2');
            return cast<IPdfViewerSaveTransactionResult>({
                source: 'native-mutation-projection' as const,
                nativeMutationProjection: RECOVERY_PROJECTION,
                fallbackDecision: {},
                annotationSavePlan: {},
            });
        });
        const {deps} = createDeps({
            annotationDirty: ref(true),
            hasPendingUnsavedChanges: computed(() => true),
            documentRevisionToken,
            runSaveTransaction,
            pdfViewerRef: ref({runSaveTransaction}),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.createRecoverySnapshotBytes()).resolves.toBeNull();
    });
});
