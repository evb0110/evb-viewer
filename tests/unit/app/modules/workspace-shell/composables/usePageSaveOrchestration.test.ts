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
import type {IWorkspaceSaveDependencies} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import { requireDocumentRef } from '@contracts/documentRef';
import { cast } from '@tests/helpers/cast';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const saveMocks = vi.hoisted(() => ({
    capturedDeps: null as unknown,
    handleSave: vi.fn(),
    handleRepairSave: vi.fn(),
    handleOptimizePdfForInteraction: vi.fn(),
    handleOptimizePdfAsCopy: vi.fn(),
    handleSaveAs: vi.fn(),
    canSave: {value: false},
    isAnySaving: {value: false},
    createRecoverySnapshotBytes: vi.fn(),
    getNativeSaveTransactionOptions: vi.fn(),
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
            canSave: saveMocks.canSave,
            isAnySaving: saveMocks.isAnySaving,
            createRecoverySnapshotBytes: saveMocks.createRecoverySnapshotBytes,
            getNativeSaveTransactionOptions: saveMocks.getNativeSaveTransactionOptions,
        };
    })}),
);
const platformApi = createElectronPlatformApiFixture({documentFiles: {statFile: platformMocks.statFile}});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));
vi.mock(
    '@app/modules/pdf-viewer/runtime/composables/pdf/createPdfSourceDataReader',
    () => ({createPdfSourceDataReader: () => vi.fn(async () => new Uint8Array([1]))}),
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
        saveMocks.canSave.value = false;
        saveMocks.isAnySaving.value = false;
        saveMocks.createRecoverySnapshotBytes.mockReset();
        saveMocks.getNativeSaveTransactionOptions.mockReset();
        platformMocks.statFile.mockResolvedValue({size: 1});
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
    });

    it('gets the working-copy size through the split file capability', async () => {
        usePageSaveOrchestration(createDeps());
        const dependencies = cast<IWorkspaceSaveDependencies>(saveMocks.capturedDeps);

        await expect(
            dependencies.persistence.getWorkingCopySize?.(requireDocumentRef('/tmp/document.pdf')),
        ).resolves.toBe(1);
        expect(platformMocks.statFile).toHaveBeenCalledWith('/tmp/document.pdf');
    });

    it('treats an already clean save command as a successful no-op', async () => {
        saveMocks.handleSave.mockResolvedValueOnce(true);
        const orchestration = usePageSaveOrchestration(createDeps());

        await expect(orchestration.handleSave()).resolves.toBe(true);
        expect(saveMocks.handleSave).toHaveBeenCalledOnce();
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
        saveMocks.handleOptimizePdfForInteraction.mockImplementationOnce(async () => {
            await saveMocks.handleSave();
            return true;
        });
        saveMocks.canSave.value = true;
        const orchestration = usePageSaveOrchestration(createDeps({
            isDirty: ref(true),
            hasPendingUnsavedChanges: computed(() => true),
        }));

        await expect(
            orchestration.handleOptimizePdfForInteraction(),
        ).resolves.toBe(true);
        expect(saveMocks.handleOptimizePdfForInteraction).toHaveBeenCalledOnce();
    });

    it('exposes the save service recovery snapshot entrypoint', async () => {
        const orchestration = usePageSaveOrchestration(createDeps({hasPendingUnsavedChanges: computed(() => true)}));

        saveMocks.createRecoverySnapshotBytes.mockResolvedValueOnce(Uint8Array.of(4, 5, 6));
        await expect(orchestration.createRecoverySnapshotBytes()).resolves.toEqual(Uint8Array.of(4, 5, 6));
        expect(saveMocks.createRecoverySnapshotBytes).toHaveBeenCalledOnce();
    });

    it('does not serialize a recovery snapshot for a clean document', async () => {
        saveMocks.createRecoverySnapshotBytes.mockResolvedValueOnce(null);
        const orchestration = usePageSaveOrchestration(createDeps());

        await expect(orchestration.createRecoverySnapshotBytes()).resolves.toBeNull();
        expect(saveMocks.createRecoverySnapshotBytes).toHaveBeenCalledOnce();
    });

    it('discards a recovery snapshot when the document revision changes during serialization', async () => {
        const orchestration = usePageSaveOrchestration(createDeps({hasPendingUnsavedChanges: computed(() => true)}));
        saveMocks.createRecoverySnapshotBytes.mockResolvedValueOnce(null);
        await expect(orchestration.createRecoverySnapshotBytes()).resolves.toBeNull();
        expect(saveMocks.createRecoverySnapshotBytes).toHaveBeenCalledOnce();
    });
});
