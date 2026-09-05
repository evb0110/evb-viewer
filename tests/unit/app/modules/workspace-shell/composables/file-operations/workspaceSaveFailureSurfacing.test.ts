import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {IPdfNativePlacedImageGeometryUpdate} from '@contracts/electronApiDocuments';
import {
    createDeps,
    createShapeAnnotation,
    expectWorkspaceSaveNotMarked,
    toastAddMock,
    type TPdfNativeMutationSave,
    useWorkspaceSaveServiceForTest,
} from '@tests/unit/app/modules/workspace-shell/composables/file-operations/workspaceSaveServiceFixture';
import {cast} from '@tests/helpers/cast';

type TSaveFixtureDeps = ReturnType<typeof createDeps>['deps'];
type TSaveTransactionResult = Awaited<ReturnType<NonNullable<TSaveFixtureDeps['runSaveTransaction']>>>;

/** The user opened a different file while a save was still running. */
function replaceOpenDocument(deps: TSaveFixtureDeps) {
    deps.originalPath.value = '/tmp/other-source.pdf';
    deps.workingCopyPath.value = '/tmp/other-work.pdf';
    deps.documentRevisionToken.value = requireDocumentRevisionToken('rev-other');
}

/** The same file was reopened, so only the revision token moved. */
function reopenSameDocument(deps: TSaveFixtureDeps) {
    deps.documentRevisionToken.value = requireDocumentRevisionToken('rev-2');
}

describe('workspace save failure surfacing', () => {
    beforeEach(() => {
        toastAddMock.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('passes projected placed-image geometry to the native persistence owner', async () => {
        const placedImageGeometryUpdates: IPdfNativePlacedImageGeometryUpdate[] = [{
            stableKey: 'placed-image:one',
            annotationId: 'image-one',
            pageIndex: cast<IPdfNativePlacedImageGeometryUpdate['pageIndex']>(0),
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.4,
            rotationDegrees: 0,
        }];
        const trySavePdfNativeMutations: TPdfNativeMutationSave = vi.fn(async () => ({
            success: true,
            outPath: '/tmp/work.pdf',
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const { deps } = createDeps({
            originalPath: ref('/tmp/source.pdf'),
            workingCopyPath: ref('/tmp/work.pdf'),
            annotationDirty: ref(true),
            hasAnnotationChanges: vi.fn(() => true),
            trySavePdfNativeMutations,
            runSaveTransaction: vi.fn(async () => cast<TSaveTransactionResult>({
                source: 'native' as const,
                baseBytes: null,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection: {
                    mutations: {},
                    placedImageGeometryUpdates,
                    noteTextUpdates: [],
                    noteGeometryUpdates: [],
                    freeTextNotes: [],
                    freeTextEditors: [],
                    textBoxes: [],
                    annotationDeletes: [],
                    hasMetadataMutations: false,
                    hasShapeMutations: false,
                    hasMarkupMutations: false,
                    phase: 'persist-native-pdf-mutations',
                },
                fallbackDecision: null,
                annotationSavePlan: null,
            })),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(true);

        expect(deps.runSaveTransaction).toHaveBeenCalled();
        expect(trySavePdfNativeMutations).toHaveBeenCalledWith(
            expect.objectContaining({placedImageGeometryUpdates}),
            expect.objectContaining({expectedWorkingPath: '/tmp/work.pdf'}),
        );
    });

    it('reports a validation rejection instead of returning a silent false', async () => {
        const { deps } = createDeps({validatePdfPath: vi.fn(async () => ({
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['xref table is damaged'],
            warnings: [],
        }))});
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: expect.stringContaining('errors.save.validation'),
        }));
        expect(service.hasSaveFailure.value).toBe(true);
        expectWorkspaceSaveNotMarked(deps);
    });

    it('reports a failed open-note persistence', async () => {
        const { deps } = createDeps({
            annotationDirty: ref(true),
            annotationNoteWindowsCount: ref(1),
            persistAllAnnotationNotes: vi.fn(async () => false),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: expect.stringContaining('errors.save.openNotes'),
        }));
        expect(service.hasSaveFailure.value).toBe(true);
        expect(deps.saveFile).not.toHaveBeenCalled();
    });

    it.each([
        [
            'replaced',
            replaceOpenDocument,
        ],
        [
            'reopened',
            reopenSameDocument,
        ],
    ])('says nothing about a %s document when the notes of the old one failed', async (
        _label,
        changeDocument,
    ) => {
        const { deps } = createDeps({
            annotationDirty: ref(true),
            annotationNoteWindowsCount: ref(1),
        });
        deps.persistAllAnnotationNotes = vi.fn(async () => {
            // The workspace moves on while the notes are still being written.
            changeDocument(deps);
            return false;
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        // A toast would blame the document now on screen, and the durable flag
        // would keep presenting it as unwritten for the rest of the session.
        expect(toastAddMock).not.toHaveBeenCalled();
        expect(service.hasSaveFailure.value).toBe(false);
    });

    it('says nothing about a replaced document when the persist of the old one was refused', async () => {
        const { deps } = createDeps({annotationDirty: ref(true)});
        deps.saveWorkingCopy = vi.fn(async () => {
            replaceOpenDocument(deps);
            return {
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).not.toHaveBeenCalled();
        expect(service.hasSaveFailure.value).toBe(false);
    });

    it('says nothing about a replaced document when the save of the old one threw', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { deps } = createDeps({annotationDirty: ref(true)});
        deps.saveWorkingCopy = vi.fn(async () => {
            replaceOpenDocument(deps);
            throw new Error('disk exploded');
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).not.toHaveBeenCalled();
        expect(service.hasSaveFailure.value).toBe(false);
    });

    it('treats an unavailable optimization-copy capability as an expected refusal', async () => {
        const capture = vi.spyOn(BrowserLogger, 'error');
        const { deps } = createDeps();
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleOptimizePdfAsCopy({preset: 'blackAndWhite'})).resolves.toBe(false);

        expect(capture).not.toHaveBeenCalled();
        expect(toastAddMock).not.toHaveBeenCalled();
        expect(service.hasSaveFailure.value).toBe(false);
    });

    it('reports an optional capability that refuses to persist', async () => {
        const { deps } = createDeps({repairWorkingCopy: vi.fn(async () => ({
            success: false,
            outPath: null,
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }))});
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleRepairSave()).resolves.toBe(false);

        expect(toastAddMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: expect.stringContaining('errors.save.notCompleted'),
        }));
        expect(service.hasSaveFailure.value).toBe(true);
    });

    it('reports a rejected persist result', async () => {
        const { deps } = createDeps({
            annotationDirty: ref(true),
            saveWorkingCopy: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).toHaveBeenCalledOnce();
        expect(service.hasSaveFailure.value).toBe(true);
    });

    it('clears the failure state once a later save succeeds', async () => {
        const validatePdfPath = vi.fn(async () => ({
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['xref table is damaged'],
            warnings: [],
        }));
        const { deps } = createDeps({validatePdfPath});
        const service = useWorkspaceSaveServiceForTest(deps);

        await service.handleSave();
        expect(service.hasSaveFailure.value).toBe(true);

        validatePdfPath.mockResolvedValue({
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        });
        await expect(service.handleSave()).resolves.toBe(true);

        expect(service.hasSaveFailure.value).toBe(false);
    });

    it('says nothing when the user dismisses the Save As dialog', async () => {
        const { deps } = createDeps({saveWorkingCopyAs: vi.fn(async () => ({
            success: false,
            outPath: null,
            saveMode: 'save_as_rewrite' as const,
            didSaveAs: true,
            abortReason: 'cancelled' as const,
        }))});
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSaveAs()).resolves.toBe(false);

        expect(toastAddMock).not.toHaveBeenCalled();
        expect(service.hasSaveFailure.value).toBe(false);
    });

    it('tells the user about a superseded save without marking the new document', async () => {
        const { deps } = createDeps({
            annotationDirty: ref(true),
            saveWorkingCopy: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
                abortReason: 'stale' as const,
            })),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: expect.stringContaining('errors.save.documentChanged'),
        }));
        // The document on screen is no longer the one that failed.
        expect(service.hasSaveFailure.value).toBe(false);
    });

    it('drops the failure once the document it belongs to is replaced', async () => {
        const { deps } = createDeps({validatePdfPath: vi.fn(async () => ({
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['xref table is damaged'],
            warnings: [],
        }))});
        const service = useWorkspaceSaveServiceForTest(deps);

        await service.handleSave();
        expect(service.hasSaveFailure.value).toBe(true);

        deps.originalPath.value = '/tmp/another.pdf';

        // The next document must not inherit a red dot it never earned.
        expect(service.hasSaveFailure.value).toBe(false);
    });

    it.each([
        [
            'replaced',
            replaceOpenDocument,
        ],
        [
            'reopened',
            reopenSameDocument,
        ],
    ])('has nothing armed to lose when the notes fail on a %s document', async (
        _label,
        changeDocument,
    ) => {
        // The note-failure path completes the save before it knows whether it
        // still owns the document, and that completion clears the pending
        // shape adoption. It is harmless only because the flag is armed later,
        // inside plan execution, which this abort never reaches.
        const { deps } = createDeps({
            annotationDirty: ref(true),
            annotationNoteWindowsCount: ref(1),
        });
        deps.persistAllAnnotationNotes = vi.fn(async () => {
            changeDocument(deps);
            return false;
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(deps.preparePersistedShapeStateForSave).not.toHaveBeenCalled();
        expect(deps.markShapeStateSaved).not.toHaveBeenCalled();
    });

    it('drops the failure once the workspace adopts a new revision of the same document', async () => {
        const { deps } = createDeps({validatePdfPath: vi.fn(async () => ({
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['xref table is damaged'],
            warnings: [],
        }))});
        const service = useWorkspaceSaveServiceForTest(deps);

        await service.handleSave();
        expect(service.hasSaveFailure.value).toBe(true);

        // Reopening the file leaves both paths untouched, so the revision is
        // the only thing that says this is no longer the document that failed.
        reopenSameDocument(deps);

        expect(service.hasSaveFailure.value).toBe(false);
    });

    it('keeps the failure for as long as the revision that failed is the open one', async () => {
        const { deps } = createDeps({validatePdfPath: vi.fn(async () => ({
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['xref table is damaged'],
            warnings: [],
        }))});
        const service = useWorkspaceSaveServiceForTest(deps);

        await service.handleSave();
        expect(service.hasSaveFailure.value).toBe(true);

        // Re-announcing the same revision is not an adoption; the status bar
        // still has to present this document as unwritten.
        deps.documentRevisionToken.value = requireDocumentRevisionToken('rev-1');
        expect(service.hasSaveFailure.value).toBe(true);

        await service.handleSave();
        expect(service.hasSaveFailure.value).toBe(true);
    });

    it.each([
        [
            'replaced',
            replaceOpenDocument,
        ],
        [
            'reopened',
            reopenSameDocument,
        ],
    ])('says nothing about a %s document when validation rejected the old one', async (
        _label,
        changeDocument,
    ) => {
        // Validation is the longest pre-write await in a save: nothing has been
        // written when it returns, so the document underneath it can be anything.
        const { deps } = createDeps({validatePdfPath: vi.fn(async () => {
            changeDocument(deps);
            return {
                isValid: false,
                tool: 'qpdf' as const,
                errors: ['xref table is damaged'],
                warnings: [],
            };
        })});
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).not.toHaveBeenCalled();
        expect(service.hasSaveFailure.value).toBe(false);
    });

    it('still reports a validation rejection when the same revision is still open', async () => {
        // The pre-write revision match must not reject a save whose document
        // never moved, or every ordinary validation failure would go silent.
        const { deps } = createDeps({validatePdfPath: vi.fn(async () => ({
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['xref table is damaged'],
            warnings: [],
        }))});
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: expect.stringContaining('errors.save.validation'),
        }));
        expect(service.hasSaveFailure.value).toBe(true);
        expect(deps.documentRevisionToken.value).toBe('rev-1');
    });

    it('still reports a refused persist whose own write moved the revision', async () => {
        // A write moves the revision by design. Matching it after the fact
        // would drop the refusal of the very save that caused the move.
        const { deps } = createDeps({annotationDirty: ref(true)});
        deps.saveWorkingCopy = vi.fn(async () => {
            deps.documentRevisionToken.value = requireDocumentRevisionToken('rev-2');
            return {
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: expect.stringContaining('errors.save.notCompleted'),
        }));
        expect(service.hasSaveFailure.value).toBe(true);
    });

    it('reports a native mutation persistence that refuses to write', async () => {
        const { deps } = createDeps({
            totalPages: ref(2),
            hasShapeChanges: vi.fn(() => true),
            getAllShapes: vi.fn(() => [createShapeAnnotation()]),
            trySavePdfNativeMutations: vi.fn(async () => ({
                success: false,
                outPath: null,
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            })),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: expect.stringContaining('errors.save.notCompleted'),
        }));
        expect(service.hasSaveFailure.value).toBe(true);
        expectWorkspaceSaveNotMarked(deps);
    });

    it('keeps the thrown-save toast unchanged', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { deps } = createDeps({
            annotationDirty: ref(true),
            saveWorkingCopy: vi.fn(() => {
                throw new Error('disk exploded');
            }),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(false);

        expect(toastAddMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            color: 'error',
            title: 'errors.file.save',
            description: expect.stringContaining('disk exploded'),
        }));
        expect(service.hasSaveFailure.value).toBe(true);
    });
});
