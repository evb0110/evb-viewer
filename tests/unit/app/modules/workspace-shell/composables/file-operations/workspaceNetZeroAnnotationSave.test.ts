import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {ref} from 'vue';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import type {TDocumentOperationKind} from '@app/types/documentOperationKind';
import {
    createDeps,
    createShapeAnnotation,
    useWorkspaceSaveServiceForTest,
    expectWorkspaceSaveNotMarked,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceFixture';

describe('net-zero annotation save', () => {
    afterEach(() => vi.restoreAllMocks());

    it('saves the unchanged working copy when all newly created annotations were discarded', async () => {
        const {deps} = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            annotationDirty: ref(true),
            canonicalAnnotationComments: ref([]),
            hasAnnotationChanges: vi.fn(() => true),
            trySavePdfNativeMutations: vi.fn(),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(true);
        expect(service.hasSaveFailure.value).toBe(false);
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.trySavePdfNativeMutations).not.toHaveBeenCalled();
        expect(deps.markAnnotationSaved).toHaveBeenCalledOnce();
    });

    it('keeps dirty layers dirty when a serialized plan only publishes the working copy', async () => {
        const {deps} = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            annotationDirty: ref(true),
            hasAnnotationChanges: vi.fn(() => true),
            bookmarksDirty: ref(true),
            pageLabelsDirty: ref(true),
            hasShapeChanges: vi.fn(() => true),
            hasManagedShapes: vi.fn(() => true),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(true);

        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
        expectWorkspaceSaveNotMarked(deps);
        expect(service.canSave.value).toBe(true);
    });

    it('saves from an existing document operation lease without reacquiring it', async () => {
        const leaseKinds: TDocumentOperationKind[] = [];
        const runWithDocumentOperationLease = async <T>(
            kind: TDocumentOperationKind,
            operation: () => Promise<T>,
        ) => {
            leaseKinds.push(kind);
            return operation();
        };
        const {deps} = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            annotationDirty: ref(true),
            canonicalAnnotationComments: ref([]),
            hasAnnotationChanges: vi.fn(() => true),
            trySavePdfNativeMutations: vi.fn(),
            runWithDocumentOperationLease,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(runWithDocumentOperationLease(
            'page-operation',
            () => service.handleSaveWithinDocumentOperationLease(),
        )).resolves.toBe(true);

        expect(leaseKinds).toEqual(['page-operation']);
        expect(deps.saveWorkingCopy).toHaveBeenCalledOnce();
    });

    it('still publishes a Save As copy for a verified empty annotation frontier', async () => {
        const {deps} = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            annotationDirty: ref(true),
            canonicalAnnotationComments: ref([]),
            hasAnnotationChanges: vi.fn(() => true),
            trySavePdfNativeMutations: vi.fn(),
        });
        const service = useWorkspaceSaveServiceForTest(deps);
        await expect(service.handleSaveAs()).resolves.toBe(true);
        expect(deps.saveWorkingCopyAs).toHaveBeenCalledOnce();
        expect(deps.trySavePdfNativeMutations).not.toHaveBeenCalled();
    });

    it('does not accept an empty projection without a captured canonical frontier', async () => {
        const {deps} = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            annotationDirty: ref(true),
            hasAnnotationChanges: vi.fn(() => true),
            trySavePdfNativeMutations: vi.fn(),
        });
        const service = useWorkspaceSaveServiceForTest(deps);
        await expect(service.handleSave()).resolves.toBe(false);
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expectWorkspaceSaveNotMarked(deps);
    });

    it('keeps edits dirty when publishing the unchanged working copy fails', async () => {
        const {deps} = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            annotationDirty: ref(true),
            canonicalAnnotationComments: ref([]),
            hasAnnotationChanges: vi.fn(() => true),
            trySavePdfNativeMutations: vi.fn(),
            saveWorkingCopy: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
        });
        const service = useWorkspaceSaveServiceForTest(deps);
        await expect(service.handleSave()).resolves.toBe(false);
        expectWorkspaceSaveNotMarked(deps);
    });

    it('does not mark a newer annotation edit clean while the working copy is publishing', async () => {
        let annotationToken = 1;
        const {deps} = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            annotationDirty: ref(true),
            canonicalAnnotationComments: ref([]),
            hasAnnotationChanges: vi.fn(() => true),
            getAnnotationSaveStateToken: () => annotationToken,
            trySavePdfNativeMutations: vi.fn(),
            saveWorkingCopy: vi.fn(async () => {
                annotationToken += 1;
                return {
                    success: true,
                    outPath: requireDocumentRef('/tmp/source.pdf'),
                    saveMode: 'rewrite' as const,
                    didSaveAs: false,
                };
            }),
        });
        const service = useWorkspaceSaveServiceForTest(deps);
        await expect(service.handleSave()).resolves.toBe(true);
        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
    });

    it('projects real mutations before publishing Save As instead of copying stale source bytes', async () => {
        const documentRevisionToken = ref(requireDocumentRevisionToken('rev-1'));
        const trySavePdfNativeMutations = vi.fn(async () => {
            documentRevisionToken.value = requireDocumentRevisionToken('rev-after-native-stage');
            return {
                success: true,
                outPath: requireDocumentRef('/tmp/work.pdf'),
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const {deps} = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            documentRevisionToken,
            annotationDirty: ref(true),
            optimizePdfOnSaveAs: ref(true),
            canonicalAnnotationComments: ref([]),
            hasShapeChanges: vi.fn(() => true),
            getAllShapes: vi.fn(() => [createShapeAnnotation()]),
            trySavePdfNativeMutations,
        });
        const service = useWorkspaceSaveServiceForTest(deps);
        await expect(service.handleSaveAs()).resolves.toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({optimizeLossless: true}));
        expect(deps.saveWorkingCopyAs).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopyAs).toHaveBeenCalledWith(undefined, expect.objectContaining({expectedDocumentRevisionToken: requireDocumentRevisionToken('rev-after-native-stage')}));
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
    });

});
