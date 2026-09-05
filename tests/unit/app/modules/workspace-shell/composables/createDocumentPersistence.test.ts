import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { createDocumentPersistence } from '@app/modules/workspace-shell/composables/document-session/createDocumentPersistence';
import { createDocumentSessionState } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import { requirePageIndex } from '@contracts/pageNumbers';
import type { IPdfNativeMutationSet } from '@contracts/electronApiDocuments';
import type { TTranslateFn } from '@i18n-app';
import {requireDocumentRevisionToken} from '@contracts';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';

const TEST_DOCUMENT_REVISION_TOKEN = requireDocumentRevisionToken('drt1:test:persistence-base');

const mocks = vi.hoisted(() => {
    const createBroadFacadeTripwire = (method: string, capability = 'document files') => vi.fn(() => {
        throw new Error(`${method} should use the split ${capability} capability`);
    });

    return {
        documentFilesCapability: {
            applyPdfNativeMutationsToWorkingCopy: vi.fn(),
            commitStagedPdfNativeMutations: vi.fn(),
            createManagedTempFileHandle: vi.fn(),
            getDocumentRevision: vi.fn(),
            optimizePdfAsCopy: vi.fn(),
            optimizePdfForInteraction: vi.fn(),
            releaseManagedTempFileHandle: vi.fn(),
            repairPdf: vi.fn(),
            saveFileStructured: vi.fn(),
            savePdfAs: vi.fn(),
            savePdfDataAs: vi.fn(),
            savePdfNativeMutations: vi.fn(),
            savePdfNoteChanges: vi.fn(),
            savePdfNoteTextUpdates: vi.fn(),
            statFile: vi.fn(),
            writeFile: vi.fn(),
        },
        documentWorkingCopyCapability: {
            cleanupFile: vi.fn(),
            createWorkingCopyFromPath: vi.fn(),
        },
        documentsCapability: {
            cleanupFile: createBroadFacadeTripwire('cleanupFile', 'document working-copy'),
            createWorkingCopyFromPath: createBroadFacadeTripwire('createWorkingCopyFromPath', 'document working-copy'),
            optimizePdfAsCopy: createBroadFacadeTripwire('optimizePdfAsCopy'),
            optimizePdfForInteraction: createBroadFacadeTripwire('optimizePdfForInteraction'),
            repairPdf: createBroadFacadeTripwire('repairPdf'),
            saveFileStructured: createBroadFacadeTripwire('saveFileStructured'),
            savePdfAs: createBroadFacadeTripwire('savePdfAs'),
            savePdfNativeMutations: createBroadFacadeTripwire('savePdfNativeMutations'),
            savePdfNoteChanges: createBroadFacadeTripwire('savePdfNoteChanges'),
            savePdfNoteTextUpdates: createBroadFacadeTripwire('savePdfNoteTextUpdates'),
            writeFile: createBroadFacadeTripwire('writeFile'),
        },
        readDocumentBytes: vi.fn(),
        shouldRefreshWorkingCopyAfterSaveAs: vi.fn(),
    };
});

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentFilesCapability: () => mocks.documentFilesCapability,
    getDocumentWorkingCopyCapability: () => mocks.documentWorkingCopyCapability,
    shouldRefreshWorkingCopyAfterSaveAs: mocks.shouldRefreshWorkingCopyAfterSaveAs,
}));
vi.mock('@app/utils/documentBytes', () => ({readDocumentBytes: mocks.readDocumentBytes}));

function createPersistenceHarness(isDesktopRuntime = false) {
    const state = createDocumentSessionState({ isDesktopRuntime: ref(isDesktopRuntime) });
    state.workingCopyPath.value = '/tmp/old-working.pdf';
    state.originalPath.value = '/tmp/original.pdf';
    state.documentRevisionToken.value = TEST_DOCUMENT_REVISION_TOKEN;
    state.isDirty.value = true;

    const deps = {
        deferPdfConformanceProfile: vi.fn(),
        ensureHistoryBaselineForMutation: vi.fn(async () => true),
        getHistoryDebugState: vi.fn(() => ({
            historyLength: 1,
            historyIndex: 0,
            historyCleanIndex: -1,
        })),
        markCurrentHistoryEntryClean: vi.fn(async () => undefined),
        pushHistorySnapshot: vi.fn(async () => true),
        readPdfStateFromPath: vi.fn(async () => ({
            pdfData: new Uint8Array([1]),
            pdfSrc: {
                kind: 'path' as const,
                path: '/tmp/new-working.pdf',
                size: 1,
            },
        })),
        shouldForceSaveAsForWorkingCopy: vi.fn(async () => false),
        t: ((key: string) => key) as TTranslateFn,
        toPdfBlob: vi.fn(() => new Blob()),
    };

    return {
        deps,
        persistence: createDocumentPersistence(state, deps),
        state,
    };
}

function createNativeMarkupMutations(): IPdfNativeMutationSet {
    return {markup: {
        overrides: [],
        hints: [{
            subtype: 'Highlight',
            pageIndex: requirePageIndex(0),
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.2,
            },
            appAnnotationId: 'app-annotation-1',
            annotationId: 'editor-markup-1',
            color: '#ffff00',
            id: 'markup-1',
            source: 'editor',
        }],
    }};
}

const nativeMarkupIdentityBinding = {
    annotationId: 'app-annotation-1',
    pdfRef: '700 0 R',
};

const nativeShapeIdentityBinding = {
    annotationId: 'shape-annotation-1',
    pdfRef: '701 0 R',
};

function createMixedNativeMarkupAndShapeMutations(): IPdfNativeMutationSet {
    return {
        ...createNativeMarkupMutations(),
        shapes: {
            totalPages: 1,
            rewriteShapeState: true,
            shapes: [{
                type: 'rectangle',
                pageIndex: requirePageIndex(0),
                x: 0.2,
                y: 0.3,
                width: 0.2,
                height: 0.1,
                color: '#336699',
                opacity: 0.8,
                strokeWidth: 2,
                stableKey: 'shape-annotation-1',
            }],
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        },
    };
}

function expectBroadFilePersistenceFacadeNotUsed() {
    expect(mocks.documentsCapability.optimizePdfAsCopy).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.optimizePdfForInteraction).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.repairPdf).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.saveFileStructured).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.savePdfAs).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.savePdfNativeMutations).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.savePdfNoteChanges).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.savePdfNoteTextUpdates).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.writeFile).not.toHaveBeenCalled();
}

function expectBroadWorkingCopyFacadeNotUsed() {
    expect(mocks.documentsCapability.cleanupFile).not.toHaveBeenCalled();
    expect(mocks.documentsCapability.createWorkingCopyFromPath).not.toHaveBeenCalled();
}

describe('createDocumentPersistence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const validPdfResult = {
            isValid: true,
            tool: 'native' as const,
            errors: [],
            warnings: [],
        };
        Object.assign(mocks.documentFilesCapability, {
            applyPdfNativeMutationsToWorkingCopy: vi.fn(),
            commitStagedPdfNativeMutations: vi.fn(),
            savePdfNativeMutations: vi.fn(),
            savePdfNoteChanges: vi.fn(),
            savePdfNoteTextUpdates: vi.fn(),
        });
        mocks.documentFilesCapability.optimizePdfAsCopy.mockResolvedValue({
            path: '/tmp/optimized.pdf',
            validation: null,
            preset: 'lossless',
            originalBytes: 100,
            optimizedBytes: 90,
            pageCount: 1,
        });
        mocks.documentFilesCapability.optimizePdfForInteraction.mockResolvedValue(validPdfResult);
        mocks.documentFilesCapability.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/old-working.pdf',
            token: requireDocumentRevisionToken('drt1:test:persistence-after-save'),
            contentRevision: 2,
            authority: 'electron-working-copy',
            mintedAt: 2,
        });
        mocks.documentFilesCapability.statFile.mockResolvedValue({
            size: 3,
            modifiedAt: 2,
        });
        mocks.documentFilesCapability.releaseManagedTempFileHandle.mockResolvedValue(true);
        mocks.documentFilesCapability.createManagedTempFileHandle.mockResolvedValue({
            path: '/tmp/old-working.pdf',
            size: 3,
            sha256: 'c'.repeat(64),
            leaseId: 'working-copy-expectation-lease',
            revision: TEST_DOCUMENT_REVISION_TOKEN,
        });
        mocks.documentFilesCapability.repairPdf.mockResolvedValue(validPdfResult);
        mocks.documentFilesCapability.saveFileStructured.mockResolvedValue({
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: true,
            validation: null,
        });
        mocks.documentFilesCapability.savePdfAs.mockResolvedValue('/tmp/saved.pdf');
        mocks.documentFilesCapability.savePdfDataAs.mockResolvedValue({
            path: '/tmp/saved.pdf',
            validation: validPdfResult,
        });
        mocks.documentFilesCapability.savePdfNativeMutations.mockResolvedValue({
            applied: true,
            validation: validPdfResult,
        });
        const stagedOutput = {
            path: '/tmp/staged-native.pdf',
            size: 3,
            sha256: 'a'.repeat(64),
            leaseId: 'staged-native-lease',
            revision: TEST_DOCUMENT_REVISION_TOKEN,
        };
        mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy.mockResolvedValue({
            applied: true,
            validation: validPdfResult,
            stagedOutput,
        });
        mocks.documentFilesCapability.commitStagedPdfNativeMutations.mockResolvedValue({
            applied: true,
            validation: validPdfResult,
        });
        mocks.readDocumentBytes.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mocks.documentFilesCapability.savePdfNoteChanges.mockResolvedValue({
            applied: true,
            validation: validPdfResult,
        });
        mocks.documentFilesCapability.savePdfNoteTextUpdates.mockResolvedValue({
            applied: true,
            validation: validPdfResult,
        });
        mocks.documentFilesCapability.writeFile.mockResolvedValue(true);
        mocks.documentWorkingCopyCapability.cleanupFile.mockResolvedValue(undefined);
        mocks.documentWorkingCopyCapability.createWorkingCopyFromPath.mockResolvedValue('/tmp/new-working.pdf');
        mocks.shouldRefreshWorkingCopyAfterSaveAs.mockReturnValue(true);
    });

    it('persists silent PDF data through the split file IO capability', async () => {
        const {
            deps,
            persistence,
            state,
        } = createPersistenceHarness();
        const data = new Uint8Array([
            7,
            8,
            9,
        ]);

        const result = await persistence.persistPdfDataSilently(data);

        expect(result).toBe(true);
        expect(mocks.documentFilesCapability.writeFile).toHaveBeenCalledWith('/tmp/old-working.pdf', new Uint8Array([
            7,
            8,
            9,
        ]), {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN});
        expect(mocks.documentFilesCapability.writeFile.mock.calls[0]?.[1]).not.toBe(data);
        expect(deps.pushHistorySnapshot).toHaveBeenCalledWith(new Uint8Array([
            7,
            8,
            9,
        ]), { reuseSnapshot: true });
        expect(state.pdfData.value).toEqual(new Uint8Array([
            7,
            8,
            9,
        ]));
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('does not write silent PDF data when mutation baseline staging fails', async () => {
        const {
            deps,
            persistence,
            state,
        } = createPersistenceHarness();
        const before = new Uint8Array([1]);
        state.pdfData.value = before;
        deps.ensureHistoryBaselineForMutation.mockResolvedValue(false);

        await expect(persistence.persistPdfDataSilently(new Uint8Array([2]))).resolves.toBe(false);

        expect(mocks.documentFilesCapability.writeFile).not.toHaveBeenCalled();
        expect(deps.pushHistorySnapshot).not.toHaveBeenCalled();
        expect(state.pdfData.value).toBe(before);
    });

    it('saves the working copy through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();

        const result = await persistence.saveWorkingCopy();

        expect(result.success).toBe(true);
        expect(mocks.documentFilesCapability.saveFileStructured).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('keeps the working copy dirty when a browser save is canceled', async () => {
        const {
            deps,
            persistence,
            state,
        } = createPersistenceHarness();
        mocks.documentFilesCapability.saveFileStructured.mockResolvedValueOnce({
            ok: false,
            reason: 'user-canceled',
            externalWriteCommitted: false,
            validation: null,
        });

        const result = await persistence.saveWorkingCopy();

        expect(result.success).toBe(false);
        expect(state.isDirty.value).toBe(true);
        expect(deps.markCurrentHistoryEntryClean).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.saveFileStructured).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('repairs the working copy through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();

        const result = await persistence.repairWorkingCopy();

        expect(result.success).toBe(true);
        expect(mocks.documentFilesCapability.repairPdf).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('optimizes the working copy through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();

        const result = await persistence.optimizeWorkingCopy();

        expect(result.success).toBe(true);
        expect(mocks.documentFilesCapability.optimizePdfForInteraction).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('optimizes a working-copy copy through the split file IO capability', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        const options = { preset: 'lossless' as const };

        const result = await persistence.optimizeWorkingCopyAsCopy(options, 'optimize-1');

        expect(result.success).toBe(true);
        expect(result.outPath).toBe('/tmp/optimized.pdf');
        expect(state.originalPath.value).toBe('/tmp/optimized.pdf');
        expect(mocks.documentFilesCapability.optimizePdfAsCopy).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            options,
            'optimize-1',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentWorkingCopyCapability.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/optimized.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledWith('/tmp/old-working.pdf');
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('cleans a stale optimized-copy working copy through the split working-copy capability', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        mocks.documentWorkingCopyCapability.createWorkingCopyFromPath.mockImplementationOnce(async () => {
            state.workingCopyPath.value = '/tmp/replaced-working.pdf';
            return '/tmp/new-working.pdf';
        });

        const result = await persistence.optimizeWorkingCopyAsCopy({ preset: 'lossless' }, 'optimize-stale');

        expect(result.success).toBe(false);
        expect(state.originalPath.value).toBe('/tmp/original.pdf');
        expect(state.workingCopyPath.value).toBe('/tmp/replaced-working.pdf');
        expect(mocks.documentFilesCapability.optimizePdfAsCopy).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            { preset: 'lossless' },
            'optimize-stale',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentWorkingCopyCapability.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/optimized.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledWith('/tmp/new-working.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledTimes(1);
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('keeps Save As successful when old working-copy cleanup fails', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        mocks.documentWorkingCopyCapability.cleanupFile.mockRejectedValueOnce(new Error('cleanup failed'));

        const result = await persistence.saveWorkingCopyAs();

        expect(result.success).toBe(true);
        expect(result.outPath).toBe('/tmp/saved.pdf');
        expect(state.originalPath.value).toBe('/tmp/saved.pdf');
        expect(state.workingCopyPath.value).toBe('/tmp/new-working.pdf');
        expect(mocks.documentFilesCapability.savePdfAs).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            undefined,
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentWorkingCopyCapability.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/saved.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledWith('/tmp/old-working.pdf');
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('cleans a stale Save As working copy through the split working-copy capability', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        mocks.documentWorkingCopyCapability.createWorkingCopyFromPath.mockImplementationOnce(async () => {
            state.workingCopyPath.value = '/tmp/replaced-working.pdf';
            return '/tmp/new-working.pdf';
        });

        const result = await persistence.saveWorkingCopyAs();

        expect(result.success).toBe(false);
        expect(state.originalPath.value).toBe('/tmp/original.pdf');
        expect(state.workingCopyPath.value).toBe('/tmp/replaced-working.pdf');
        expect(mocks.documentFilesCapability.savePdfAs).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            undefined,
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentWorkingCopyCapability.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/saved.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledWith('/tmp/new-working.pdf');
        expect(mocks.documentWorkingCopyCapability.cleanupFile).toHaveBeenCalledTimes(1);
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('saves generic native mutations through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();
        const updates = [{
            objectNumber: 10,
            generationNumber: 0,
            text: 'Updated note text',
        }];
        const mutations = { updates };

        const result = await persistence.trySavePdfNativeMutations(mutations, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            mutations,
            'D:20260628123456+03\'00\'',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.createManagedTempFileHandle).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.commitStagedPdfNativeMutations).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            expect.objectContaining({leaseId: 'staged-native-lease'}),
            {
                expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN,
                changedObjectRefs: ['10 0 R'],
            },
        );
        expect(mocks.documentFilesCapability.savePdfNativeMutations).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.savePdfNoteChanges).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.savePdfNoteTextUpdates).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('verifies the immutable staged native output before exposing it', async () => {
        const { persistence } = createPersistenceHarness();
        const callOrder: string[] = [];
        const verifyPathBeforeExpose = vi.fn(async (path: string, knownSize: number) => {
            callOrder.push('verify');
            expect(path).toBe('/tmp/staged-native.pdf');
            expect(knownSize).toBe(3);
        });
        const assertBeforeExpose = vi.fn(() => {
            callOrder.push('assert');
        });
        mocks.documentFilesCapability.commitStagedPdfNativeMutations.mockImplementationOnce(async () => {
            callOrder.push('commit');
            return {
                applied: true,
                validation: {
                    isValid: true,
                    tool: 'native' as const,
                    errors: [],
                    warnings: [],
                },
            };
        });

        const result = await persistence.trySavePdfNativeMutations({updates: [{
            objectNumber: 10,
            generationNumber: 0,
            text: 'Verified note text',
        }]}, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
            verifyPathBeforeExpose,
            assertBeforeExpose,
        });

        expect(result?.success).toBe(true);
        expect(mocks.readDocumentBytes).not.toHaveBeenCalled();
        expect(callOrder).toEqual([
            'verify',
            'assert',
            'commit',
        ]);
    });

    it('uses native mutation postconditions instead of reopening a large staged PDF in PDF.js', async () => {
        const { persistence } = createPersistenceHarness();
        const verifyPathBeforeExpose = vi.fn(async () => undefined);
        const assertBeforeExpose = vi.fn(async () => undefined);
        mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy.mockResolvedValueOnce({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
                errors: [],
                warnings: [],
            },
            nativeMutationPostconditionsVerified: true,
            stagedOutput: {
                path: '/tmp/large-staged-native.pdf',
                size: (2 * 1024 * 1024 * 1024) + 1,
                sha256: 'b'.repeat(64),
                leaseId: 'large-staged-native-lease',
                revision: TEST_DOCUMENT_REVISION_TOKEN,
            },
        });

        const result = await persistence.trySavePdfNativeMutations({freeTextNotes: [{
            pageIndex: requirePageIndex(0),
            stableKey: 'ann:0:verified-native-note',
            text: 'Verified by native postconditions',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.03,
                height: 0.03,
            },
        }]}, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
            verifyPathBeforeExpose,
            assertBeforeExpose,
        });

        expect(result?.success).toBe(true);
        expect(verifyPathBeforeExpose).not.toHaveBeenCalled();
        expect(assertBeforeExpose).toHaveBeenCalledOnce();
        expect(mocks.documentFilesCapability.commitStagedPdfNativeMutations).toHaveBeenCalledOnce();
    });

    it.each([
        [
            'missing',
            undefined,
        ],
        [
            'malformed',
            [{
                annotationId: 'app-annotation-1',
                pdfRef: '700R',
            }],
        ],
        [
            'duplicate',
            [
                nativeMarkupIdentityBinding,
                nativeMarkupIdentityBinding,
            ],
        ],
        [
            'unexpected',
            [{
                annotationId: 'other-annotation',
                pdfRef: '700 0 R',
            }],
        ],
    ])('rejects %s native markup identity bindings before staged publication', async (_label, identityBindings) => {
        const { persistence } = createPersistenceHarness();
        mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy.mockResolvedValueOnce({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native' as const,
                errors: [],
                warnings: [],
            },
            nativeMutationPostconditionsVerified: true,
            stagedOutput: {
                path: '/tmp/staged-native.pdf',
                size: 3,
                sha256: 'a'.repeat(64),
                leaseId: 'staged-native-lease',
                revision: TEST_DOCUMENT_REVISION_TOKEN,
            },
            identityBindings,
        });

        await expect(persistence.trySavePdfNativeMutations(createNativeMarkupMutations(), {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
        })).rejects.toThrow();

        expect(mocks.documentFilesCapability.commitStagedPdfNativeMutations).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.releaseManagedTempFileHandle)
            .toHaveBeenCalledWith('staged-native-lease');
    });

    it('commits identity bindings for mixed new markup and shape mutations', async () => {
        const { persistence } = createPersistenceHarness();
        const mutations = createMixedNativeMarkupAndShapeMutations();
        const identityBindings = [
            nativeMarkupIdentityBinding,
            nativeShapeIdentityBinding,
        ];
        mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy.mockResolvedValueOnce({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native' as const,
                errors: [],
                warnings: [],
            },
            nativeMutationPostconditionsVerified: true,
            stagedOutput: {
                path: '/tmp/staged-native.pdf',
                size: 3,
                sha256: 'a'.repeat(64),
                leaseId: 'staged-native-lease',
                revision: TEST_DOCUMENT_REVISION_TOKEN,
            },
            identityBindings,
        });
        mocks.documentFilesCapability.commitStagedPdfNativeMutations.mockResolvedValueOnce({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native' as const,
                errors: [],
                warnings: [],
            },
            identityBindings,
        });

        const result = await persistence.trySavePdfNativeMutations(mutations, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
        });

        expect(result).toMatchObject({
            success: true,
            materializedIdentityBindings: identityBindings,
        });
        expect(mocks.documentFilesCapability.commitStagedPdfNativeMutations).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            expect.objectContaining({leaseId: 'staged-native-lease'}),
            expect.objectContaining({identityBindings}),
        );
    });

    it('rejects native markup identity drift between staging and commit', async () => {
        const { persistence } = createPersistenceHarness();
        mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy.mockResolvedValueOnce({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native' as const,
                errors: [],
                warnings: [],
            },
            nativeMutationPostconditionsVerified: true,
            stagedOutput: {
                path: '/tmp/staged-native.pdf',
                size: 3,
                sha256: 'a'.repeat(64),
                leaseId: 'staged-native-lease',
                revision: TEST_DOCUMENT_REVISION_TOKEN,
            },
            identityBindings: [nativeMarkupIdentityBinding],
        });
        mocks.documentFilesCapability.commitStagedPdfNativeMutations.mockResolvedValueOnce({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native' as const,
                errors: [],
                warnings: [],
            },
            identityBindings: [{
                annotationId: 'app-annotation-1',
                pdfRef: '701 0 R',
            }],
        });

        await expect(persistence.trySavePdfNativeMutations(createNativeMarkupMutations(), {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
        })).rejects.toThrow('changed between staging and commit');

        expect(mocks.documentFilesCapability.commitStagedPdfNativeMutations).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            expect.objectContaining({leaseId: 'staged-native-lease'}),
            expect.objectContaining({identityBindings: [nativeMarkupIdentityBinding]}),
        );
    });

    it('propagates staged commit failures instead of returning the serialized-save fallback signal', async () => {
        const { persistence } = createPersistenceHarness();
        mocks.documentFilesCapability.commitStagedPdfNativeMutations.mockRejectedValueOnce(
            new Error('Staged artifact content changed after staging'),
        );

        await expect(persistence.trySavePdfNativeMutations({updates: [{
            objectNumber: 10,
            generationNumber: 0,
            text: 'Commit boundary failure',
        }]}, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
        })).rejects.toThrow('Staged artifact content changed after staging');

        expect(mocks.documentFilesCapability.commitStagedPdfNativeMutations).toHaveBeenCalledOnce();
    });

    it('releases an unverifiable staged native output without exposing it', async () => {
        const { persistence } = createPersistenceHarness();
        const verifyPathBeforeExpose = vi.fn(async () => {
            throw new Error('semantic verification failed');
        });

        await expect(persistence.trySavePdfNativeMutations({updates: [{
            objectNumber: 10,
            generationNumber: 0,
            text: 'Rejected note text',
        }]}, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
            verifyPathBeforeExpose,
        })).rejects.toThrow('semantic verification failed');

        expect(mocks.documentFilesCapability.releaseManagedTempFileHandle)
            .toHaveBeenCalledWith('staged-native-lease');
        expect(mocks.documentFilesCapability.commitStagedPdfNativeMutations).not.toHaveBeenCalled();
    });

    it('never allocates a renderer byte array for a large staged native artifact', async () => {
        const { persistence } = createPersistenceHarness();
        const largeSize = (2 * 1024 * 1024 * 1024) + 1;
        mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy.mockResolvedValueOnce({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
                errors: [],
                warnings: [],
            },
            stagedOutput: {
                path: '/tmp/large-staged-native.pdf',
                size: largeSize,
                sha256: 'b'.repeat(64),
                leaseId: 'large-staged-native-lease',
                revision: TEST_DOCUMENT_REVISION_TOKEN,
            },
        });
        const callOrder: string[] = [];
        const verifyPathBeforeExpose = vi.fn(async (path: string, knownSize: number) => {
            callOrder.push('verify');
            expect(path).toBe('/tmp/large-staged-native.pdf');
            expect(knownSize).toBe(largeSize);
        });
        mocks.documentFilesCapability.commitStagedPdfNativeMutations.mockImplementationOnce(async () => {
            callOrder.push('commit');
            return {
                applied: true,
                validation: {
                    isValid: true,
                    tool: 'native' as const,
                    errors: [],
                    warnings: [],
                },
            };
        });

        const result = await persistence.trySavePdfNativeMutations({updates: [{
            objectNumber: 10,
            generationNumber: 0,
            text: 'Large verified note text',
        }]}, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
            verifyPathBeforeExpose,
        });

        expect(result?.success).toBe(true);
        expect(mocks.readDocumentBytes).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.createManagedTempFileHandle).not.toHaveBeenCalled();
        expect(callOrder).toEqual([
            'verify',
            'commit',
        ]);
    });

    it('prefers generic native mutations over legacy note-change saves', async () => {
        const { persistence } = createPersistenceHarness();
        const freeTextNotes = [{
            pageIndex: requirePageIndex(0),
            stableKey: 'ann:0:generic-free-text-1',
            text: 'Generic free text note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
        }];
        const mutations = { freeTextNotes };

        const result = await persistence.trySavePdfNativeMutations(mutations, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123526+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(mocks.documentFilesCapability.applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            mutations,
            'D:20260628123526+03\'00\'',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.commitStagedPdfNativeMutations).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            expect.objectContaining({leaseId: 'staged-native-lease'}),
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.savePdfNativeMutations).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.savePdfNoteChanges).not.toHaveBeenCalled();
        expect(mocks.documentFilesCapability.savePdfNoteTextUpdates).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('falls back to legacy note-text native saves through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();
        const updates = [{
            objectNumber: 11,
            generationNumber: 0,
            text: 'Legacy text update',
        }];
        Object.assign(mocks.documentFilesCapability, {
            applyPdfNativeMutationsToWorkingCopy: undefined,
            commitStagedPdfNativeMutations: undefined,
            savePdfNativeMutations: undefined,
        });

        const result = await persistence.trySavePdfNativeMutations({ updates }, {
            saveMode: 'incremental',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123556+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(mocks.documentFilesCapability.savePdfNoteTextUpdates).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            updates,
            'D:20260628123556+03\'00\'',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.savePdfNoteChanges).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('falls back to legacy note-change native saves through the split file IO capability', async () => {
        const { persistence } = createPersistenceHarness();
        const freeTextNotes = [{
            pageIndex: requirePageIndex(0),
            stableKey: 'ann:0:free-text-1',
            text: 'Free text note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
        }];
        const deletes = [{
            pageIndex: requirePageIndex(1),
            objectNumber: 12,
            generationNumber: 0,
        }];
        Object.assign(mocks.documentFilesCapability, {
            applyPdfNativeMutationsToWorkingCopy: undefined,
            commitStagedPdfNativeMutations: undefined,
            savePdfNativeMutations: undefined,
        });

        const result = await persistence.trySavePdfNativeMutations({
            freeTextNotes,
            deletes,
        }, {
            saveMode: 'incremental',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123626+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(mocks.documentFilesCapability.savePdfNoteChanges).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {
                freeTextNotes,
                deletes,
            },
            'D:20260628123626+03\'00\'',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.savePdfNoteTextUpdates).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('does not use legacy note-change saves when a new note needs an identity binding', async () => {
        const { persistence } = createPersistenceHarness();
        const freeTextNotes = [{
            pageIndex: requirePageIndex(0),
            stableKey: 'freetext-new-identity',
            text: 'New free text note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
        }];
        Object.assign(mocks.documentFilesCapability, {
            applyPdfNativeMutationsToWorkingCopy: undefined,
            commitStagedPdfNativeMutations: undefined,
            savePdfNativeMutations: undefined,
        });

        const result = await persistence.trySavePdfNativeMutations({freeTextNotes}, {
            saveMode: 'incremental',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123632+03\'00\'',
        });

        expect(result).toBeNull();
        expect(mocks.documentFilesCapability.savePdfNoteChanges).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('falls back to legacy note-change native saves for imported note geometry', async () => {
        const { persistence } = createPersistenceHarness();
        const geometryUpdates = [{
            objectNumber: 12,
            generationNumber: 0,
            pageIndex: requirePageIndex(1),
            markerRect: {
                left: 0.6,
                top: 0.25,
                width: 0.15,
                height: 0.12,
            },
        }];
        Object.assign(mocks.documentFilesCapability, {
            applyPdfNativeMutationsToWorkingCopy: undefined,
            commitStagedPdfNativeMutations: undefined,
            savePdfNativeMutations: undefined,
        });

        const result = await persistence.trySavePdfNativeMutations({geometryUpdates}, {
            saveMode: 'incremental',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123640+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(mocks.documentFilesCapability.savePdfNoteChanges).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {geometryUpdates},
            'D:20260628123640+03\'00\'',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.documentFilesCapability.savePdfNoteTextUpdates).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('returns null for native mutations when no split native save method is available', async () => {
        const {
            deps,
            persistence,
        } = createPersistenceHarness();
        Object.assign(mocks.documentFilesCapability, {
            applyPdfNativeMutationsToWorkingCopy: undefined,
            commitStagedPdfNativeMutations: undefined,
            savePdfNativeMutations: undefined,
            savePdfNoteChanges: undefined,
            savePdfNoteTextUpdates: undefined,
        });
        const updates = [{
            objectNumber: 12,
            generationNumber: 0,
            text: 'No native route',
        }];

        const result = await persistence.trySavePdfNativeMutations({ updates }, {
            saveMode: 'rewrite',
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123656+03\'00\'',
        });

        expect(result).toBeNull();
        expect(deps.shouldForceSaveAsForWorkingCopy).not.toHaveBeenCalled();
        expectBroadFilePersistenceFacadeNotUsed();
        expectBroadWorkingCopyFacadeNotUsed();
    });

    it('records a fresh reload source without replacing the visible source when preserving the live session', async () => {
        const {
            persistence,
            state,
        } = createPersistenceHarness();
        state.pdfSrc.value = {
            kind: 'path',
            path: '/tmp/old-working.pdf',
            size: 1,
        };

        const result = await persistence.saveFile(new Uint8Array([
            1,
            2,
            3,
        ]), { preserveLoadedSource: true });

        expect(result.success).toBe(true);
        expect(state.pdfSrc.value).toEqual({
            kind: 'path',
            path: '/tmp/old-working.pdf',
            size: 1,
        });
        expect(state.pdfReloadSrc.value).toEqual({
            kind: 'path',
            path: '/tmp/old-working.pdf',
            size: 3,
        });
        expect(state.pdfData.value).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
    });

    it('keeps a browser snapshot above the full-read budget on the path reload branch', async () => {
        const {
            deps,
            persistence,
            state,
        } = createPersistenceHarness();
        const data = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);

        await expect(persistence.saveFile(data, { preserveLoadedSource: true }))
            .resolves.toMatchObject({success: true});

        expect(deps.readPdfStateFromPath).not.toHaveBeenCalled();
        expect(state.pdfData.value).toBeNull();
        expect(state.pdfSrc.value).toBeNull();
        expect(state.pdfReloadSrc.value).toEqual({
            kind: 'path',
            path: '/tmp/old-working.pdf',
            size: 3,
            revision: expect.any(String),
        });
    });

    it('adopts a native save as a revision-bound path without rereading renderer bytes', async () => {
        const {
            deps,
            persistence,
            state,
        } = createPersistenceHarness();
        const liveSource = new Blob([new Uint8Array([
            1,
            2,
            3,
        ])]);
        state.pdfSrc.value = liveSource;
        state.pdfData.value = new Uint8Array([
            1,
            2,
            3,
        ]);
        const nextRevision = requireDocumentRevisionToken('drt1:test:persistence-after-save');

        const result = await persistence.trySavePdfNativeMutations({updates: [{
            objectNumber: 10,
            generationNumber: 0,
            text: 'Updated note text',
        }]}, {
            saveMode: 'rewrite',
            preserveLoadedSource: true,
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(state.pdfSrc.value).toBe(liveSource);
        expect(state.pdfData.value).toBeNull();
        expect(state.pdfReloadSrc.value).toEqual({
            kind: 'path',
            path: '/tmp/old-working.pdf',
            size: 3,
            revision: nextRevision,
        });
        expect(state.documentRevisionToken.value).toBe(nextRevision);
        expect(mocks.readDocumentBytes).not.toHaveBeenCalled();
        expect(deps.readPdfStateFromPath).not.toHaveBeenCalled();
        expect(deps.markCurrentHistoryEntryClean).toHaveBeenCalledWith(null, {
            lazyBaseline: {
                workingPath: '/tmp/old-working.pdf',
                revision: nextRevision,
                size: 3,
            },
            recordSnapshotChange: false,
        });
    });

    it('keeps the active native path source mounted when a native mutation preserves the live session', async () => {
        const {
            deps,
            persistence,
            state,
        } = createPersistenceHarness(true);
        const liveSource = {
            kind: 'path' as const,
            path: '/tmp/old-working.pdf',
            size: 3,
            revision: TEST_DOCUMENT_REVISION_TOKEN,
        };
        state.pdfSrc.value = liveSource;
        state.pdfReloadSrc.value = liveSource;
        const nextRevision = requireDocumentRevisionToken('drt1:test:persistence-after-save');

        const result = await persistence.trySavePdfNativeMutations({updates: [{
            objectNumber: 10,
            generationNumber: 0,
            text: 'Updated note text',
        }]}, {
            saveMode: 'rewrite',
            preserveLoadedSource: true,
            expectedWorkingPath: '/tmp/old-working.pdf',
            modifiedAt: 'D:20260628123456+03\'00\'',
        });

        expect(result?.success).toBe(true);
        expect(state.pdfSrc.value).toBe(liveSource);
        expect(state.pdfReloadSrc.value).toEqual({
            ...liveSource,
            revision: nextRevision,
        });
        expect(state.documentRevisionToken.value).toBe(nextRevision);
        expect(mocks.readDocumentBytes).not.toHaveBeenCalled();
        expect(deps.readPdfStateFromPath).not.toHaveBeenCalled();
        expect(deps.markCurrentHistoryEntryClean).toHaveBeenCalledWith(null, {
            lazyBaseline: {
                workingPath: '/tmp/old-working.pdf',
                revision: nextRevision,
                size: 3,
            },
            recordSnapshotChange: false,
        });
    });

    it('adopts a 2+ GiB desktop path save without reading renderer bytes', async () => {
        const {
            deps,
            persistence,
            state,
        } = createPersistenceHarness(true);
        const largeDocumentSize = (2 * 1024 * 1024 * 1024) + 1;
        const pathSource = {
            kind: 'path' as const,
            path: '/tmp/old-working.pdf',
            size: largeDocumentSize,
            revision: TEST_DOCUMENT_REVISION_TOKEN,
        };
        state.pdfSrc.value = pathSource;
        state.pdfReloadSrc.value = pathSource;
        state.pdfData.value = null;
        const nextRevision = requireDocumentRevisionToken('drt1:test:persistence-after-save');
        mocks.documentFilesCapability.statFile.mockResolvedValueOnce({
            size: largeDocumentSize,
            modifiedAt: 2,
        });

        const result = await persistence.saveWorkingCopy();

        expect(result.success).toBe(true);
        expect(mocks.documentFilesCapability.saveFileStructured).toHaveBeenCalledWith(
            '/tmp/old-working.pdf',
            {expectedDocumentRevisionToken: TEST_DOCUMENT_REVISION_TOKEN},
        );
        expect(mocks.readDocumentBytes).not.toHaveBeenCalled();
        expect(deps.readPdfStateFromPath).not.toHaveBeenCalled();
        expect(state.pdfData.value).toBeNull();
        expect(state.pdfSrc.value).toEqual({
            ...pathSource,
            size: largeDocumentSize,
            revision: nextRevision,
        });
        expect(state.pdfReloadSrc.value).toEqual({
            ...pathSource,
            size: largeDocumentSize,
            revision: nextRevision,
        });
        expect(deps.markCurrentHistoryEntryClean).toHaveBeenCalledWith(null, {
            lazyBaseline: {
                workingPath: '/tmp/old-working.pdf',
                revision: nextRevision,
                size: largeDocumentSize,
            },
            recordSnapshotChange: false,
        });
    });
});
