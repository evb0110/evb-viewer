import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

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
import { requireDocumentRef } from '@contracts/documentRef';
import { cast } from '@tests/helpers/cast';

const saveMocks = vi.hoisted(() => ({
    capturedDeps: null as unknown,
    handleSave: vi.fn(),
    handleRepairSave: vi.fn(),
    handleOptimizePdfForInteraction: vi.fn(),
    handleOptimizePdfAsCopy: vi.fn(),
    handleSaveAs: vi.fn(),
    canSave: {value: false},
    isAnySaving: {value: false},
}));
const platformMocks = vi.hoisted(() => ({statFile: vi.fn()}));
// The snapshot transaction returns a mutation projection, never bytes, so the
// recovery path stages the projection as a transient clone and reads it back.
const artifactMocks = vi.hoisted(() => ({
    consumeNativePdfMutationProjection: vi.fn(),
    readDocumentBytes: vi.fn(),
}));

vi.mock('@app/modules/workspace-shell/composables/nativePdfMutationArtifact', () => ({
    consumeNativePdfMutationProjection: artifactMocks.consumeNativePdfMutationProjection,
    NativePdfSaveRequiredError: class NativePdfSaveRequiredError extends Error {},
}));
vi.mock('@app/utils/documentBytes', () => ({readDocumentBytes: artifactMocks.readDocumentBytes}));

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
        };
    })}),
);
vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentFilesCapability: () => ({statFile: platformMocks.statFile}),
}));
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
        platformMocks.statFile.mockResolvedValue({size: 1});
        artifactMocks.consumeNativePdfMutationProjection.mockResolvedValue(RECOVERY_CLONE_REF);
        artifactMocks.readDocumentBytes.mockResolvedValue(Uint8Array.of(4, 5, 6));
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

    it('creates a detached recovery snapshot without acknowledging the dirty save frontier', async () => {
        const assertAnnotationSaveCurrent = vi.fn(async () => undefined);
        const verifyAnnotationSavePath = vi.fn(async () => undefined);
        const commitAnnotationSave = vi.fn();
        const runSaveTransaction = vi.fn(async () => ({
            source: 'native-mutation-projection' as const,
            nativeMutationProjection: RECOVERY_PROJECTION,
            fallbackDecision: {},
            annotationSavePlan: {},
            assertAnnotationSaveCurrent,
            verifyAnnotationSavePath,
            commitAnnotationSave,
        }));
        const runWithDocumentOperationLease = vi.fn(async (_kind, operation: () => Promise<unknown>) => operation());
        const orchestration = usePageSaveOrchestration(createDeps({
            annotationDirty: ref(true),
            hasPendingUnsavedChanges: computed(() => true),
            documentRevisionToken: ref('revision-1' as TDocumentRevisionToken),
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
            requiresManagedShapeBaseline: true,
        }));
        expect(artifactMocks.consumeNativePdfMutationProjection).toHaveBeenCalledWith(expect.objectContaining({
            operation: 'clone',
            projection: RECOVERY_PROJECTION,
            verifyPathBeforeExpose: verifyAnnotationSavePath,
            assertBeforeExpose: assertAnnotationSaveCurrent,
        }));
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
                source: 'native-mutation-projection' as const,
                nativeMutationProjection: RECOVERY_PROJECTION,
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
