import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import { usePageSaveOrchestration } from '@app/modules/workspace-shell/composables/usePageSaveOrchestration';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IWorkspaceSaveDependencies} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import { cast } from '@tests/helpers/cast';

const saveMocks = vi.hoisted(() => ({
    capturedDeps: null as unknown,
    handleSave: vi.fn(),
    handleRepairSave: vi.fn(),
    handleOptimizePdfForInteraction: vi.fn(),
    handleOptimizePdfAsCopy: vi.fn(),
    handleSaveAs: vi.fn(),
}));
const platformMocks = vi.hoisted(() => ({statFile: vi.fn()}));

vi.mock(
    '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService',
    () => ({useWorkspaceSaveService: vi.fn((deps: unknown) => {
        saveMocks.capturedDeps = deps;
        return {
            handleSave: saveMocks.handleSave,
            handleRepairSave: saveMocks.handleRepairSave,
            handleOptimizePdfForInteraction: saveMocks.handleOptimizePdfForInteraction,
            handleOptimizePdfAsCopy: saveMocks.handleOptimizePdfAsCopy,
            handleSaveAs: saveMocks.handleSaveAs,
        };
    })}),
);
vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => ({statFile: platformMocks.statFile})}));
vi.mock(
    '@app/modules/pdf-viewer/runtime/composables/pdf/pdfDocumentPersistence',
    () => ({usePdfPlacedImagePersistence: () => ({
        getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
        embedPlacedImageToPage: vi.fn(),
    })}),
);

function createDeps(overrides: Record<string, unknown> = {}) {
    return cast<Parameters<typeof usePageSaveOrchestration>[0]>({
        pdfData: ref(new Uint8Array([1])),
        pdfDocument: shallowRef({numPages: 1} as IPdfDocument),
        pdfViewerRef: ref({
            scrollToPage: vi.fn(),
            runSaveTransaction: vi.fn(),
            getAllShapes: vi.fn(() => []),
        }),
        workingCopyPath: ref('/tmp/document.pdf'),
        originalPath: ref('/tmp/source.pdf'),
        documentSessionKey: ref('document-session-1'),
        documentRevisionToken: ref(null),
        totalPages: ref(1),
        pageLabelsDirty: ref(false),
        pageLabelRanges: ref([]),
        bookmarksDirty: ref(false),
        bookmarkItems: ref([]),
        isSaving: ref(false),
        isSavingAs: ref(false),
        annotationDirty: ref(false),
        annotationNoteWindowsCount: ref(0),
        pendingEmbeddedAnnotationDeleteCount: ref(0),
        hasAnnotationChanges: vi.fn(() => false),
        markAnnotationSaved: vi.fn(),
        markPageLabelsSaved: vi.fn(),
        markBookmarksSaved: vi.fn(),
        isDirty: ref(false),
        hasPendingUnsavedChanges: computed(() => false),
        validatePdfPath: vi.fn(async () => ({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        })),
        saveFile: vi.fn(),
        saveWorkingCopy: vi.fn(),
        saveWorkingCopyAs: vi.fn(),
        persistAllAnnotationNotes: vi.fn(async () => true),
        loadRecentFiles: vi.fn(),
        currentPage: ref(1),
        resetSearchCache: vi.fn(),
        ...overrides,
    });
}

describe('usePageSaveOrchestration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        saveMocks.capturedDeps = null;
        platformMocks.statFile.mockResolvedValue({size: 1});
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
    });

    it('gets the working-copy size through the split file capability', async () => {
        usePageSaveOrchestration(createDeps());
        const dependencies = cast<IWorkspaceSaveDependencies>(saveMocks.capturedDeps);

        await expect(
            dependencies.persistence.getWorkingCopySize?.('/tmp/document.pdf'),
        ).resolves.toBe(1);
        expect(platformMocks.statFile).toHaveBeenCalledWith('/tmp/document.pdf');
    });

    it('treats an already clean save command as a successful no-op', async () => {
        const orchestration = usePageSaveOrchestration(createDeps());

        await expect(orchestration.handleSave()).resolves.toBe(true);
        expect(saveMocks.handleSave).not.toHaveBeenCalled();
    });

    it('exposes the viewer editor commit before workspace save planning', async () => {
        const commitPdfEditorsForSave = vi.fn(async () => undefined);
        usePageSaveOrchestration(createDeps({pdfViewerRef: ref({
            commitPdfEditorsForSave,
            getAllShapes: vi.fn(() => []),
            runSaveTransaction: vi.fn(),
        })}));
        const dependencies = cast<IWorkspaceSaveDependencies>(saveMocks.capturedDeps);

        await dependencies.pdf.commitEditorsForSave?.();

        expect(commitPdfEditorsForSave).toHaveBeenCalledOnce();
    });

    it('saves dirty changes before optimizing the PDF for interaction', async () => {
        saveMocks.handleSave.mockResolvedValueOnce(true);
        saveMocks.handleOptimizePdfForInteraction.mockResolvedValueOnce(true);
        const orchestration = usePageSaveOrchestration(createDeps({
            isDirty: ref(true),
            hasPendingUnsavedChanges: computed(() => true),
        }));

        await expect(
            orchestration.handleOptimizePdfForInteraction(),
        ).resolves.toBe(true);
        expect(saveMocks.handleSave).toHaveBeenCalledOnce();
        expect(saveMocks.handleOptimizePdfForInteraction).toHaveBeenCalledOnce();
        expect(saveMocks.handleSave.mock.invocationCallOrder[0]!)
            .toBeLessThan(
                saveMocks.handleOptimizePdfForInteraction.mock.invocationCallOrder[0]!,
            );
    });

    it('creates a detached recovery snapshot without acknowledging the dirty save frontier', async () => {
        const assertAnnotationSaveCurrent = vi.fn(async () => undefined);
        const verifyAnnotationSave = vi.fn(async () => undefined);
        const commitAnnotationSave = vi.fn();
        const runSaveTransaction = vi.fn(async () => ({
            source: 'serialized-rewrite' as const,
            baseBytes: null,
            serializedBytes: Uint8Array.of(4, 5, 6),
            serializedResult: null,
            nativeMutationProjection: null,
            fallbackDecision: {},
            annotationSavePlan: {},
            assertAnnotationSaveCurrent,
            verifyAnnotationSave,
            commitAnnotationSave,
        }));
        const runWithDocumentOperationLease = vi.fn(async (_kind, operation: () => Promise<unknown>) => operation());
        const orchestration = usePageSaveOrchestration(createDeps({
            annotationDirty: ref(true),
            hasPendingUnsavedChanges: computed(() => true),
            workingCopyPath: ref('browser://documents/recovery.pdf'),
            pdfViewerRef: ref({
                runSaveTransaction,
                getAllShapes: vi.fn(() => []),
            }),
            runWithDocumentOperationLease,
        }));

        await expect(orchestration.createRecoverySnapshotBytes()).resolves.toEqual(Uint8Array.of(4, 5, 6));

        expect(runWithDocumentOperationLease).toHaveBeenCalledWith('recovery-snapshot', expect.any(Function));
        expect(runSaveTransaction).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'snapshot',
            saveFlowMode: 'save',
            serializeResult: true,
        }));
        expect(assertAnnotationSaveCurrent).toHaveBeenCalledOnce();
        expect(verifyAnnotationSave).toHaveBeenCalledWith(Uint8Array.of(4, 5, 6));
        expect(commitAnnotationSave).not.toHaveBeenCalled();
    });

    it('does not serialize a recovery snapshot for a clean document', async () => {
        const runSaveTransaction = vi.fn();
        const orchestration = usePageSaveOrchestration(createDeps({pdfViewerRef: ref({
            runSaveTransaction,
            getAllShapes: vi.fn(() => []),
        })}));

        await expect(orchestration.createRecoverySnapshotBytes()).resolves.toBeNull();
        expect(runSaveTransaction).not.toHaveBeenCalled();
    });

    it('discards a recovery snapshot when the document revision changes during serialization', async () => {
        const documentRevisionToken = ref<TDocumentRevisionToken | null>(
            'revision-1' as TDocumentRevisionToken,
        );
        const runSaveTransaction = vi.fn(async () => {
            documentRevisionToken.value = 'revision-2' as TDocumentRevisionToken;
            return {
                source: 'serialized-rewrite' as const,
                baseBytes: null,
                serializedBytes: Uint8Array.of(4, 5, 6),
                serializedResult: null,
                nativeMutationProjection: null,
                fallbackDecision: {},
                annotationSavePlan: {},
            };
        });
        const orchestration = usePageSaveOrchestration(createDeps({
            annotationDirty: ref(true),
            documentRevisionToken,
            hasPendingUnsavedChanges: computed(() => true),
            pdfViewerRef: ref({
                runSaveTransaction,
                getAllShapes: vi.fn(() => []),
            }),
        }));

        await expect(orchestration.createRecoverySnapshotBytes()).resolves.toBeNull();
    });
});
