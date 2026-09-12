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
import { requireDocumentRef } from '@contracts/documentRef';
import { requirePageIndex } from '@contracts/pageNumbers';
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
    deps.originalPath.value = requireDocumentRef('/tmp/other-source.pdf');
    deps.workingCopyPath.value = requireDocumentRef('/tmp/other-work.pdf');
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

    it('saves dirty changes before optimizing the PDF for interaction', async () => {
        const saveCalls: string[] = [];
        const annotationDirty = ref(true);
        const hasAnnotationChanges = vi.fn(() => annotationDirty.value);
        const {deps} = createDeps({
            annotationDirty,
            hasAnnotationChanges,
            optimizeWorkingCopy: vi.fn(async () => {
                saveCalls.push('optimize');
                return {
                    success: true,
                    outPath: requireDocumentRef('/tmp/work.pdf'),
                    saveMode: 'rewrite' as const,
                    didSaveAs: false,
                };
            }),
            saveWorkingCopy: vi.fn(async () => {
                saveCalls.push('save');
                annotationDirty.value = false;
                return {
                    success: true,
                    outPath: requireDocumentRef('/tmp/work.pdf'),
                    saveMode: 'rewrite' as const,
                    didSaveAs: false,
                };
            }),
            runSaveTransaction: vi.fn(async () => cast<TSaveTransactionResult>({
                source: 'serialized-rewrite' as const,
                nativeMutationProjection: null,
                fallbackDecision: null,
                annotationSavePlan: null,
            })),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleOptimizePdfForInteraction()).resolves.toBe(true);

        expect(saveCalls).toEqual([
            'save',
            'optimize',
        ]);
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
        const trySavePdfNativeMutations: TPdfNativeMutationSave = vi.fn(async (
            _mutations: Parameters<TPdfNativeMutationSave>[0],
            _options: Parameters<TPdfNativeMutationSave>[1],
        ) => ({
            success: true,
            outPath: requireDocumentRef('/tmp/work.pdf'),
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const { deps } = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            annotationDirty: ref(true),
            hasAnnotationChanges: vi.fn(() => true),
            trySavePdfNativeMutations,
            runSaveTransaction: vi.fn(async () => cast<TSaveTransactionResult>({
                source: 'native' as const,
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

    it('passes native identity bindings to the annotation save commit', async () => {
        const identityBindings = [{
            annotationId: 'note-1',
            pdfRef: '11 0 R',
        }];
        const commitAnnotationSave = vi.fn();
        const trySavePdfNativeMutations: TPdfNativeMutationSave = vi.fn(async () => ({
            success: true,
            outPath: requireDocumentRef('/tmp/work.pdf'),
            saveMode: 'rewrite' as const,
            didSaveAs: false,
            materializedIdentityBindings: identityBindings,
        }));
        const { deps } = createDeps({
            originalPath: ref(requireDocumentRef('/tmp/source.pdf')),
            workingCopyPath: ref(requireDocumentRef('/tmp/work.pdf')),
            annotationDirty: ref(true),
            hasAnnotationChanges: vi.fn(() => true),
            trySavePdfNativeMutations,
            runSaveTransaction: vi.fn(async () => cast<TSaveTransactionResult>({
                source: 'native' as const,
                nativeMutationProjection: {
                    mutations: {updates: []},
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
                commitAnnotationSave,
            })),
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleSave()).resolves.toBe(true);

        expect(commitAnnotationSave).toHaveBeenCalledExactlyOnceWith(identityBindings);
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

    it('stages dirty Repair edits into the working copy before invoking the repair writer', async () => {
        const trySavePdfNativeMutations = vi.fn(async (
            _mutations: unknown,
            options: Parameters<TPdfNativeMutationSave>[1],
        ) => {
            expect(options.workingCopyOnly).toBe(true);
            return {
                success: true,
                outPath: requireDocumentRef('/tmp/work.pdf'),
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const repairWorkingCopy = vi.fn(async (
            options: Parameters<NonNullable<TSaveFixtureDeps['repairWorkingCopy']>>[0],
        ) => {
            expect(options.expectedDocumentRevisionToken).toBe(requireDocumentRevisionToken('rev-1'));
            return {
                success: true,
                outPath: requireDocumentRef('/tmp/source.pdf'),
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const {deps} = createDeps({
            annotationDirty: ref(true),
            pageLabelsDirty: ref(true),
            pageLabelRanges: ref([{
                startPage: 1,
                style: 'D',
                prefix: 'pending-',
                startNumber: 1,
            }]),
            bookmarksDirty: ref(true),
            bookmarkItems: ref([{
                title: 'Pending bookmark',
                pageIndex: requirePageIndex(0),
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }]),
            trySavePdfNativeMutations,
            repairWorkingCopy,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleRepairSave()).resolves.toBe(true);
        expect(trySavePdfNativeMutations).toHaveBeenCalledOnce();
        expect(repairWorkingCopy).toHaveBeenCalledOnce();
        expect(deps.markBookmarksSaved).toHaveBeenCalledOnce();
        expect(deps.markPageLabelsSaved).toHaveBeenCalledOnce();
        expect(deps.saveWorkingCopy).not.toHaveBeenCalled();
        expect(deps.saveWorkingCopyAs).not.toHaveBeenCalled();
    });

    it('keeps dirty Repair edits after the repair writer refuses the staged working copy', async () => {
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: requireDocumentRef('/tmp/work.pdf'),
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const repairWorkingCopy = vi.fn(async () => ({
            success: false,
            outPath: null,
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const {deps} = createDeps({
            annotationDirty: ref(true),
            bookmarksDirty: ref(true),
            bookmarkItems: ref([{
                title: 'Pending bookmark',
                pageIndex: requirePageIndex(0),
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }]),
            trySavePdfNativeMutations,
            repairWorkingCopy,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleRepairSave()).resolves.toBe(false);

        expectWorkspaceSaveNotMarked(deps);
        expect(service.hasSaveFailure.value).toBe(true);
    });

    it('does not acknowledge metadata edited after the Repair frontier was captured', async () => {
        const annotationSaveState = ref('annotation-frontier-before');
        const bookmarkSaveState = ref('bookmark-frontier-before');
        const pageLabelSaveState = ref('page-label-frontier-before');
        const trySavePdfNativeMutations = vi.fn(async () => ({
            success: true,
            outPath: requireDocumentRef('/tmp/work.pdf'),
            saveMode: 'rewrite' as const,
            didSaveAs: false,
        }));
        const repairWorkingCopy = vi.fn(async () => {
            annotationSaveState.value = 'annotation-frontier-after';
            bookmarkSaveState.value = 'bookmark-frontier-after';
            pageLabelSaveState.value = 'page-label-frontier-after';
            return {
                success: true,
                outPath: requireDocumentRef('/tmp/source.pdf'),
                saveMode: 'rewrite' as const,
                didSaveAs: false,
            };
        });
        const {deps} = createDeps({
            annotationDirty: ref(true),
            bookmarksDirty: ref(true),
            pageLabelsDirty: ref(true),
            bookmarkItems: ref([{
                title: 'Pending bookmark',
                pageIndex: requirePageIndex(0),
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }]),
            trySavePdfNativeMutations,
            repairWorkingCopy,
            getAnnotationSaveStateToken: () => annotationSaveState.value,
            getBookmarksSaveStateToken: () => bookmarkSaveState.value,
            getPageLabelsSaveStateToken: () => pageLabelSaveState.value,
        });
        const service = useWorkspaceSaveServiceForTest(deps);

        await expect(service.handleRepairSave()).resolves.toBe(true);

        expect(deps.markAnnotationSaved).not.toHaveBeenCalled();
        expect(deps.markBookmarksSaved).not.toHaveBeenCalled();
        expect(deps.markPageLabelsSaved).not.toHaveBeenCalled();
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

        deps.originalPath.value = requireDocumentRef('/tmp/another.pdf');

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
