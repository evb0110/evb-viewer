import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
    shallowRef,
} from 'vue';
import { useWorkspaceDocumentLifecycleEffects } from '@app/modules/workspace-shell/composables/useWorkspaceDocumentLifecycleEffects';
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import {requireDocumentRevisionToken} from '@contracts';
import { cast } from '@tests/helpers/cast';

const mocks = vi.hoisted(() => ({
    replaceWorkingCopyFromPath: vi.fn(),
    getDocumentRevision: vi.fn(),
    acknowledgeResultFile: vi.fn(),
    warmIndex: vi.fn(),
    toastAdd: vi.fn(),
}));

vi.mock(
    '@app/modules/workspace-shell/composables/useDocumentTransitions',
    () => ({useDocumentTransitions: vi.fn()}),
);
vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => ({
    replaceWorkingCopyFromPath: mocks.replaceWorkingCopyFromPath,
    getDocumentRevision: mocks.getDocumentRevision,
})}));
vi.mock('@app/utils/getOcrCapability', () => ({getOcrCapability: () => ({acknowledgeResultFile: mocks.acknowledgeResultFile})}));
vi.mock('@app/utils/getSearchCapability', () => ({getSearchCapability: () => ({warmIndex: mocks.warmIndex})}));

function createLifecycle(overrides: Record<string, unknown> = {}) {
    const scope = effectScope();
    const result = scope.run(() => useWorkspaceDocumentLifecycleEffects(cast({
        documentRevisionInfo: ref(null),
        documentRevisionToken: ref(requireDocumentRevisionToken('revision-token')),
        currentPage: ref(7),
        totalPages: ref(12),
        workingCopyPath: ref('/tmp/work.pdf'),
        pdfViewerRef: ref(null),
        showSettings: ref(false),
        emitOpenSettings: vi.fn(),
        pdfSrc: ref(null),
        pdfDocument: shallowRef(null),
        isDjvuMode: ref(false),
        djvuSourcePath: ref(null),
        pdfError: ref(null),
        dragMode: ref(false),
        showSidebar: ref(false),
        sidebarTab: ref('thumbnails'),
        annotationTool: ref(null),
        annotationComments: ref([]),
        markAnnotationCommentsLoading: vi.fn(),
        clearAnnotationComments: vi.fn(),
        annotationActiveCommentStableKey: ref(null),
        annotationEditorState: ref(null),
        bookmarkItems: ref([]),
        bookmarksDirty: ref(false),
        bookmarkEditMode: ref(false),
        pageLabels: ref([]),
        pageLabelRanges: ref([]),
        pageLabelsDirty: ref(false),
        resetAnnotationTracking: vi.fn(),
        resetSearchCache: vi.fn(),
        closeSearch: vi.fn(),
        closeAnnotationContextMenu: vi.fn(),
        closePageContextMenu: vi.fn(),
        closeAllAnnotationNotes: vi.fn(),
        loadRecentFiles: vi.fn(),
        consumePreservedSourceReloadMetadata: vi.fn(),
        hasPendingProgrammaticPageNavigation: vi.fn(() => false),
        clearProgrammaticPageNavigation: vi.fn(),
        clearOcrCache: vi.fn(),
        ensureHistoryBaselineForMutation: vi.fn(async () => true),
        reloadWorkingCopyIntoHistory: vi.fn(async () => true),
        waitForPdfReload: vi.fn(async () => undefined),
        ...overrides,
    })));
    return {
        ...result!,
        scope,
    };
}

function ocrPayload(requiresCleanupAck = true) {
    return {
        requestId: 'ocr-1',
        pdfPath: '/tmp/ocr-1-merged.pdf',
        sourceDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token'),
        requiresCleanupAck,
        sourceWorkingCopyPath: '/tmp/work.pdf',
    };
}

describe('useWorkspaceDocumentLifecycleEffects OCR application', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.replaceWorkingCopyFromPath.mockResolvedValue(true);
        mocks.getDocumentRevision.mockResolvedValue({token: requireDocumentRevisionToken('revision-token')});
        mocks.acknowledgeResultFile.mockResolvedValue({cleaned: true});
        mocks.warmIndex.mockResolvedValue(undefined);
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        vi.stubGlobal('useToast', () => ({add: mocks.toastAdd}));
    });

    it('replaces the working copy with the OCR result under its source revision', async () => {
        const clearOcrCache = vi.fn();
        const resetSearchCache = vi.fn();
        const ensureHistoryBaselineForMutation = vi.fn(async () => true);
        const reloadWorkingCopyIntoHistory = vi.fn(async () => true);
        const waitForPdfReload = vi.fn(async () => undefined);
        const runWithDocumentOperationLease = vi.fn(
            async (_kind: string, operation: () => Promise<unknown>) => operation(),
        );
        const lifecycle = createLifecycle({
            clearOcrCache,
            resetSearchCache,
            ensureHistoryBaselineForMutation,
            reloadWorkingCopyIntoHistory,
            waitForPdfReload,
            runWithDocumentOperationLease,
        });

        await lifecycle.handleOcrComplete(ocrPayload());

        expect(runWithDocumentOperationLease).toHaveBeenCalledWith(
            'ocr-apply',
            expect.any(Function),
        );
        expect(clearOcrCache).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(resetSearchCache).toHaveBeenCalledOnce();
        expect(ensureHistoryBaselineForMutation).toHaveBeenCalledOnce();
        expect(mocks.replaceWorkingCopyFromPath).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            '/tmp/ocr-1-merged.pdf',
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('source-revision-token')},
        );
        expect(waitForPdfReload).toHaveBeenCalledWith(7);
        expect(reloadWorkingCopyIntoHistory).toHaveBeenCalledWith({markDirty: true});
        expect(mocks.acknowledgeResultFile).toHaveBeenCalledWith(
            'ocr-1',
            '/tmp/ocr-1-merged.pdf',
        );
        expect(mocks.warmIndex).toHaveBeenCalledWith('/tmp/work.pdf', {pageCount: 12});
        lifecycle.scope.stop();
    });

    it('releases the OCR lease before waiting for viewer reload settlement', async () => {
        let resolveReload!: () => void;
        let leaseFinished = false;
        const lifecycle = createLifecycle({
            waitForPdfReload: vi.fn(() => new Promise<void>((resolve) => {
                resolveReload = resolve;
            })),
            runWithDocumentOperationLease: vi.fn(
                async (_kind: string, operation: () => Promise<unknown>) => {
                    const result = await operation();
                    leaseFinished = true;
                    return result;
                },
            ),
        });

        const completion = lifecycle.handleOcrComplete(ocrPayload());
        await vi.waitFor(() => {
            expect(leaseFinished).toBe(true);
        });
        expect(mocks.warmIndex).not.toHaveBeenCalled();

        resolveReload();
        await completion;
        expect(mocks.warmIndex).toHaveBeenCalledOnce();
        lifecycle.scope.stop();
    });

    it('reports a failed OCR replacement without acknowledging an unconsumed result', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.replaceWorkingCopyFromPath.mockRejectedValueOnce(new Error('copy failed'));
        const lifecycle = createLifecycle();

        await expect(
            lifecycle.handleOcrComplete(ocrPayload()),
        ).resolves.toBeUndefined();

        expect(mocks.acknowledgeResultFile).not.toHaveBeenCalled();
        expect(mocks.toastAdd).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.ocr.createSearchablePdf',
            description: expect.stringContaining('Error ID:'),
        }));
        lifecycle.scope.stop();
    });

    it('does not replace the working copy when OCR history staging fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const lifecycle = createLifecycle({ensureHistoryBaselineForMutation: vi.fn(async () => false)});

        await lifecycle.handleOcrComplete(ocrPayload());

        expect(mocks.replaceWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(mocks.acknowledgeResultFile).toHaveBeenCalledWith(
            'ocr-1',
            '/tmp/ocr-1-merged.pdf',
        );
        lifecycle.scope.stop();
    });

    it('acknowledges and rejects OCR apply after the document revision advances', async () => {
        mocks.replaceWorkingCopyFromPath.mockRejectedValueOnce(
            createStaleRevisionError({
                documentRef: '/tmp/work.pdf',
                expectedRevision: requireDocumentRevisionToken('source-revision-token'),
                actualRevision: requireDocumentRevisionToken('revision-after-edit'),
            }),
        );
        const lifecycle = createLifecycle();

        await lifecycle.handleOcrComplete(ocrPayload());

        expect(mocks.acknowledgeResultFile).toHaveBeenCalledWith(
            'ocr-1',
            '/tmp/ocr-1-merged.pdf',
        );
        expect(mocks.warmIndex).not.toHaveBeenCalled();
        expect(mocks.toastAdd).toHaveBeenCalledWith(expect.objectContaining({
            color: 'error',
            title: 'errors.ocr.changedReload',
            description: expect.stringContaining('Error ID:'),
        }));
        lifecycle.scope.stop();
    });

    it('does not acknowledge OCR output when cleanup acknowledgement is not required', async () => {
        const lifecycle = createLifecycle();

        await lifecycle.handleOcrComplete(ocrPayload(false));

        expect(mocks.replaceWorkingCopyFromPath).toHaveBeenCalledOnce();
        expect(mocks.acknowledgeResultFile).not.toHaveBeenCalled();
        lifecycle.scope.stop();
    });
});
