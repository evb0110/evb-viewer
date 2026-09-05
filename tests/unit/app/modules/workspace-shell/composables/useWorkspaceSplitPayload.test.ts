import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { INativePdfMutationProjection } from '@app/modules/pdf-viewer/public';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import { useWorkspaceSplitPayload } from '@app/modules/workspace-shell/composables/useWorkspaceSplitPayload';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import {TEST_PDF_SAVE_BYTE_ROUTE_DECISION} from '@tests/unit/app/modules/pdf-viewer/runtime/save/testPdfSaveByteRouteDecision';

const mocks = vi.hoisted(() => ({
    createWorkingCopyFromPath: vi.fn(),
    createWorkingCopyFromData: vi.fn(),
    cleanupFile: vi.fn(),
    getDocumentRevision: vi.fn(),
    createManagedTempFileHandle: vi.fn(),
    releaseManagedTempFileHandle: vi.fn(),
    applyPdfNativeMutationsToWorkingCopy: vi.fn(),
    cloneStagedPdfNativeMutationToWorkingCopy: vi.fn(),
    replaceWorkingCopyFromStagedPdfNativeMutation: vi.fn(),
    savePdfData: vi.fn(),
    legacyCreateWorkingCopyFromPath: vi.fn(),
    legacyCreateWorkingCopyFromData: vi.fn(),
    legacyCleanupFile: vi.fn(),
    readDocumentBytes: vi.fn(),
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentWorkingCopyCapability: () => ({
        cleanupFile: mocks.cleanupFile,
        createWorkingCopyFromPath: mocks.createWorkingCopyFromPath,
        createWorkingCopyFromData: mocks.createWorkingCopyFromData,
    }),
    getDocumentFilesCapability: () => ({
        getDocumentRevision: mocks.getDocumentRevision,
        createManagedTempFileHandle: mocks.createManagedTempFileHandle,
        releaseManagedTempFileHandle: mocks.releaseManagedTempFileHandle,
        applyPdfNativeMutationsToWorkingCopy: mocks.applyPdfNativeMutationsToWorkingCopy,
        cloneStagedPdfNativeMutationToWorkingCopy: mocks.cloneStagedPdfNativeMutationToWorkingCopy,
        replaceWorkingCopyFromStagedPdfNativeMutation: mocks.replaceWorkingCopyFromStagedPdfNativeMutation,
        savePdfData: mocks.savePdfData,
    }),
}));

vi.mock('@app/utils/documentBytes', () => ({ readDocumentBytes: mocks.readDocumentBytes }));

type TUseWorkspaceSplitPayloadOptions = Parameters<typeof useWorkspaceSplitPayload>[0];

function pathPdfSource(
    path = '/tmp/working.pdf',
    size = 1024,
): TPdfSource {
    return {
        kind: 'path',
        path,
        size,
    };
}

function installLegacyThrowingMocks() {
    mocks.legacyCreateWorkingCopyFromPath.mockImplementation(() => {
        throw new Error('legacy createWorkingCopyFromPath should not be used');
    });
    mocks.legacyCreateWorkingCopyFromData.mockImplementation(() => {
        throw new Error('legacy createWorkingCopyFromData should not be used');
    });
    mocks.legacyCleanupFile.mockImplementation(() => {
        throw new Error('legacy cleanupFile should not be used');
    });
}

const nativeProjection: INativePdfMutationProjection = {
    canonicalAnnotationProgram: [],
    mutations: {updates: []},
    noteTextUpdates: [],
    freeTextNotes: [],
    freeTextEditors: [],
    annotationDeletes: [],
    hasMetadataMutations: false,
    hasShapeMutations: false,
    hasMarkupMutations: false,
    phase: 'test-native-split',
};

const nativeStagedArtifact: ITypedStagedArtifact = {
    receiptVersion: 1,
    artifactKind: 'pdf',
    path: '/tmp/native-staged.pdf',
    size: 3,
    sha256: 'b'.repeat(64),
    fileIdentity: {
        platform: 'posix',
        deviceId: '1',
        inode: '2',
    },
    validations: {
        qpdfCheck: false,
        tailCheck: true,
        semanticCheck: true,
        semanticScopeSha256: 'c'.repeat(64),
        fsynced: true,
    },
    leaseId: 'staged-lease',
    revision: requireDocumentRevisionToken('split-revision'),
};

function createOptions(
    overrides: Partial<TUseWorkspaceSplitPayloadOptions> = {},
): TUseWorkspaceSplitPayloadOptions {
    const options: TUseWorkspaceSplitPayloadOptions = {
        pdfSrc: ref<TPdfSource | null>(pathPdfSource()),
        isDjvuMode: ref(false),
        djvuSourcePath: ref(null),
        currentPage: ref(2),
        totalPages: ref(5),
        fileName: ref('sample.pdf'),
        originalPath: ref('/tmp/original.pdf'),
        workingCopyPath: ref('/tmp/working.pdf'),
        hasPendingTabChanges: ref(false),
        pdfViewerRef: ref(null),
        documentViewerRef: ref(null),
        pdfData: ref<Uint8Array | null>(null),
        openFileWithViewerLifecycle: vi.fn(async (): Promise<TDocumentOpenOutcome> => ({ status: 'cancelled' })),
        waitForPdfReload: vi.fn(async () => {}),
        loadPdfFromPath: vi.fn(async () => {}),
    };

    return {
        ...options,
        ...overrides,
    };
}

describe('useWorkspaceSplitPayload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createWorkingCopyFromPath.mockResolvedValue('/tmp/split-path.pdf');
        mocks.createWorkingCopyFromData.mockResolvedValue('/tmp/split-data.pdf');
        mocks.cleanupFile.mockResolvedValue(undefined);
        mocks.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/split-path.pdf',
            authority: 'electron-working-copy',
            token: requireDocumentRevisionToken('split-revision'),
            contentRevision: 1,
            mintedAt: 1,
        });
        mocks.createManagedTempFileHandle.mockResolvedValue({
            path: '/tmp/working.pdf',
            size: 2,
            sha256: 'a'.repeat(64),
            leaseId: 'base-lease',
            revision: requireDocumentRevisionToken('split-revision'),
        });
        mocks.releaseManagedTempFileHandle.mockResolvedValue(true);
        mocks.applyPdfNativeMutationsToWorkingCopy.mockResolvedValue({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
                errors: [],
                warnings: [],
            },
            stagedOutput: nativeStagedArtifact,
        });
        mocks.cloneStagedPdfNativeMutationToWorkingCopy.mockResolvedValue('/tmp/native-split.pdf');
        mocks.replaceWorkingCopyFromStagedPdfNativeMutation.mockResolvedValue(true);
        mocks.savePdfData.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.readDocumentBytes.mockResolvedValue(new Uint8Array([9]));
        installLegacyThrowingMocks();
    });

    it('uses the split working copy capability for clean working copy snapshots', async () => {
        const { captureSplitPayload } = useWorkspaceSplitPayload(createOptions());

        const payload = await captureSplitPayload();

        expect(payload).toEqual({
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: '/tmp/original.pdf',
            originalBackend: 'electron',
            snapshotPath: '/tmp/split-path.pdf',
            snapshotBackend: 'electron',
            isDirty: false,
            currentPage: 2,
            totalPages: 5,
        });
        expect(mocks.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/working.pdf', '/tmp/original.pdf');
        expect(mocks.createWorkingCopyFromData).not.toHaveBeenCalled();
        expect(mocks.readDocumentBytes).not.toHaveBeenCalled();
        expect(mocks.legacyCreateWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(mocks.legacyCreateWorkingCopyFromData).not.toHaveBeenCalled();
    });

    it('uses the split working copy capability when staging dirty snapshot data', async () => {
        const pdfBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        const { captureSplitPayload } = useWorkspaceSplitPayload(createOptions({
            hasPendingTabChanges: ref(true),
            pdfData: ref(pdfBytes),
            pdfSrc: ref(new Blob([pdfBytes])),
        }));

        const payload = await captureSplitPayload();

        expect(payload).toEqual({
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: '/tmp/original.pdf',
            originalBackend: 'electron',
            snapshotPath: '/tmp/split-data.pdf',
            snapshotBackend: 'electron',
            isDirty: true,
            currentPage: 2,
            totalPages: 5,
        });
        expect(mocks.createWorkingCopyFromData).toHaveBeenCalledWith(
            'sample.pdf',
            pdfBytes,
            '/tmp/original.pdf',
        );
        expect(mocks.createWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(mocks.legacyCreateWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(mocks.legacyCreateWorkingCopyFromData).not.toHaveBeenCalled();
    });

    it('stages a small in-memory split snapshot without a working source path', async () => {
        const pdfBytes = new Uint8Array([
            4,
            5,
            6,
        ]);
        const { captureSplitPayload } = useWorkspaceSplitPayload(createOptions({
            hasPendingTabChanges: ref(true),
            pdfData: ref(pdfBytes),
            workingCopyPath: ref(null),
        }));

        await expect(captureSplitPayload()).resolves.toMatchObject({
            kind: 'pdfSnapshot',
            snapshotPath: '/tmp/split-data.pdf',
            isDirty: true,
        });
        expect(mocks.createWorkingCopyFromData).toHaveBeenCalledWith(
            'sample.pdf',
            pdfBytes,
            '/tmp/original.pdf',
        );
        expect(mocks.createWorkingCopyFromPath).not.toHaveBeenCalled();
    });

    it('serializes dirty split snapshots inside the viewer canonical save transaction', async () => {
        const serializedBytes = Uint8Array.of(7, 8, 9);
        const serializePdfForSave = vi.fn(async () => serializedBytes);
        const runSaveTransaction = vi.fn(async (request) => {
            expect(request).toMatchObject({
                mode: 'snapshot',
                forceWriterSave: true,
                serializeResult: true,
            });
            return {
                source: 'serialized-rewrite' as const,
                baseBytes: Uint8Array.of(1),
                serializedBytes,
                serializedResult: null,
                nativeMutationProjection: null,
                fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
                annotationSavePlan: {
                    route: 'writer-save' as const,
                    expectedCost: 'full-document' as const,
                    reason: 'no-live-pdfjs-annotation-work' as const,
                    unreplayableLiveAnnotationIds: [],
                },
            };
        });
        const { captureSplitPayload } = useWorkspaceSplitPayload(createOptions({
            hasPendingTabChanges: ref(true),
            pdfViewerRef: ref({runSaveTransaction}),
            serializePdfForSave,
            pdfSrc: ref(new Blob([serializedBytes])),
            workingCopyPath: ref(null),
        }));

        await captureSplitPayload();

        expect(runSaveTransaction).toHaveBeenCalledTimes(1);
        expect(mocks.createWorkingCopyFromData).toHaveBeenCalledWith(
            'sample.pdf',
            serializedBytes,
            '/tmp/original.pdf',
        );
    });

    it('rejects a dirty native-path snapshot without reading the working copy', async () => {
        const { captureSplitPayload } = useWorkspaceSplitPayload(createOptions({
            hasPendingTabChanges: ref(true),
            pdfData: ref(null),
            pdfSrc: ref(pathPdfSource('/tmp/working.pdf', 2 * 1024 * 1024 * 1024)),
        }));

        await expect(captureSplitPayload()).rejects.toMatchObject({
            code: 'native-save-required',
            failure: {reason: 'missing-native-projection'},
        });
        expect(mocks.createWorkingCopyFromData).not.toHaveBeenCalled();
        expect(mocks.createWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(mocks.savePdfData).not.toHaveBeenCalled();
        expect(mocks.readDocumentBytes).not.toHaveBeenCalled();
    });

    it('clones a native replayable mutation into a disposable split snapshot without reading bytes', async () => {
        const revision = requireDocumentRevisionToken('split-revision');
        const runSaveTransaction = vi.fn(async (request) => {
            expect(request).toMatchObject({
                mode: 'snapshot',
                saveFlowMode: 'save',
                forceWriterSave: false,
                workingPath: '/tmp/working.pdf',
            });
            expect(request.source).toBeUndefined();
            return {
                source: 'native-mutation-projection' as const,
                baseBytes: null,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection: nativeProjection,
                fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
                annotationSavePlan: TEST_PDF_SAVE_BYTE_ROUTE_DECISION.annotationPlan,
                assertAnnotationSaveCurrent: vi.fn(),
            };
        });
        const {captureSplitPayload} = useWorkspaceSplitPayload(createOptions({
            hasPendingTabChanges: ref(true),
            pdfData: ref(null),
            documentRevisionToken: ref(revision),
            pdfViewerRef: ref({runSaveTransaction}),
            getNativeSaveTransactionOptions: () => ({
                nativeCapabilities: {
                    hasNativePdfMutationCapability: true,
                    canPersistNativeMetadataMutations: true,
                },
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    shapeStateDirty: false,
                },
                documentStructure: {
                    pageLabelsDirty: false,
                    pageLabelRanges: [],
                    bookmarksDirty: false,
                    bookmarkItems: [],
                    untitledBookmarkLabel: 'Untitled',
                    totalPages: 5,
                },
            }),
        }));

        const payload = await captureSplitPayload();

        expect(payload).toMatchObject({
            kind: 'pdfSnapshot',
            snapshotPath: '/tmp/native-split.pdf',
            isDirty: true,
        });
        expect(mocks.createManagedTempFileHandle).not.toHaveBeenCalled();
        expect(mocks.applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledWith(
            '/tmp/working.pdf',
            nativeProjection.mutations,
            expect.any(String),
            {expectedDocumentRevisionToken: revision},
        );
        expect(mocks.cloneStagedPdfNativeMutationToWorkingCopy).toHaveBeenCalledWith(
            nativeStagedArtifact,
            '/tmp/original.pdf',
        );
        expect(mocks.releaseManagedTempFileHandle).not.toHaveBeenCalledWith('base-lease');
        expect(mocks.readDocumentBytes).not.toHaveBeenCalled();
        expect(mocks.createWorkingCopyFromData).not.toHaveBeenCalled();
    });
});
