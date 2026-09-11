import type * as TViMockOriginalModule from '@electron/file-access/originalPathSaveWitness';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createHash} from 'node:crypto';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireEpochMs} from '@contracts/timestamps';
import {
    requireJobId,
    requireRequestId,
} from '@contracts/shared';
import type * as WorkingCopyStore from '@electron/file-access/workingCopyStore';

const mocks = vi.hoisted(() => ({
    clearWorkingCopySearchArtifacts: vi.fn(),
    copyFile: vi.fn(),
    cp: vi.fn(),
    createReadStream: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn<(path: string, senderId?: number) => Promise<boolean>>(),
    getWorkingCopyOriginalPath: vi.fn(),
    lstat: vi.fn(),
    lstatSync: vi.fn<(path: string) => { isSymbolicLink: () => boolean; }>(),
    open: vi.fn(),
    originalPathSaveBaseMatches: vi.fn(),
    prepareOcrCatalogV4Generation: vi.fn(),
    publishPreparedOcrCatalogV4: vi.fn(),
    realpath: vi.fn<(path: string) => Promise<string>>(),
    realpathSync: vi.fn<(path: string) => string>(),
    readFile: vi.fn(),
    rebindDocumentTextCatalogRevision: vi.fn(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    removeResultFile: vi.fn(),
    rename: vi.fn(),
    resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(),
    resolveAllowedWritePath: vi.fn<(path: string) => Promise<string | null>>(),
    rollbackPreparedOcrCatalogV4: vi.fn(),
    rm: vi.fn(),
    transitionWorkingCopyContentRevision: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn(),
}));

vi.mock('fs', () => {
    const realpathSync = Object.assign(
        (path: string) => mocks.realpathSync(path),
        {native: (path: string) => mocks.realpathSync(path)},
    );
    return {
        constants: {
            COPYFILE_FICLONE: 2,
            COPYFILE_FICLONE_FORCE: 4,
        },
        createReadStream: (...args: unknown[]) => mocks.createReadStream(...args),
        lstatSync: (path: string) => mocks.lstatSync(path),
        realpathSync,
    };
});

vi.mock('fs/promises', () => ({
    copyFile: mocks.copyFile,
    cp: mocks.cp,
    lstat: mocks.lstat,
    open: mocks.open,
    realpath: mocks.realpath,
    readFile: mocks.readFile,
    rename: mocks.rename,
    rm: mocks.rm,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));

vi.mock('@electron/utils/pathValidator', () => ({
    resolveAllowedReadPath: mocks.resolveAllowedReadPath,
    resolveAllowedWritePath: mocks.resolveAllowedWritePath,
}));

vi.mock('@electron/features/ocr/worker/indexWriterV4', () => ({
    getOcrCatalogV4PreparedDescriptorPath: (resultPath: string) => `${resultPath}.ocr-v4-prepared.json`,
    prepareOcrCatalogV4Generation: mocks.prepareOcrCatalogV4Generation,
    publishPreparedOcrCatalogV4: mocks.publishPreparedOcrCatalogV4,
    rollbackPreparedOcrCatalogV4: mocks.rollbackPreparedOcrCatalogV4,
}));

vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory}));

vi.mock('@electron/file-access/workingCopyStore', async importOriginal => ({
    ...await importOriginal<typeof WorkingCopyStore>(),
    getWorkingCopyBackingEntry: () => ({backing: 'materialized'}),
    getWorkingCopyOriginalPath: mocks.getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation: mocks.refreshWorkingCopyOriginalFileExpectation,
}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({ensureWorkingCopyMaterialized: async (path: string) => ({physicalWorkingCopyPath: path})}));

vi.mock('@electron/file-access/documentRevisionStore', () => ({
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    transitionWorkingCopyContentRevision: (...args: unknown[]) => mocks.transitionWorkingCopyContentRevision(...args),
}));
vi.mock('@electron/file-access/workingCopyMutationQueue', () => ({
    clearWorkingCopySearchArtifacts: (...args: unknown[]) => mocks.clearWorkingCopySearchArtifacts(...args),
    enqueueWorkingCopyMutation: async (_path: string, mutation: () => Promise<unknown>) => mutation(),
}));
vi.mock('@electron/file-access/documentMutationGuards', () => ({
    assertQueuedWorkingCopyMutationPreconditions: vi.fn(),
    assertWorkingCopyMutationAllowed: vi.fn(),
    normalizeExpectedDocumentRevisionToken: (options?: { expectedDocumentRevisionToken?: string | null; } | null) =>
        options?.expectedDocumentRevisionToken?.trim() ?? null,
}));

vi.mock('@electron/file-access/originalPathSaveWitness', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    originalPathSaveBaseMatches: mocks.originalPathSaveBaseMatches,
}));

vi.mock('@electron/features/ocr/main/documentTextCatalog', () => ({rebindDocumentTextCatalogRevision: (...args: unknown[]) => mocks.rebindDocumentTextCatalogRevision(...args)}));

vi.mock('@electron/file-access/docxExportPaths', () => ({consumeAllowedDocxWritePath: vi.fn(() => true)}));

const { createPendingResultFileStore } = await import('@electron/features/ocr/main/createPendingResultFileStore');
const { handleReplaceWorkingCopyFromPath } = await import('@electron/features/documents/main/documentFileWriteHandlers');
const { writeOcrIndexes } = await import('@electron/ocr/worker/writeOcrIndexes');

type TPendingResultFileStore = ReturnType<typeof createPendingResultFileStore>;

describe('OCR replacement ownership path aliases', () => {
    const ownerContext = {senderId: 42};
    const otherContext = {senderId: 43};
    const workingCopyPath = '/var/folders/app/T/evb-viewer/pdf-work-1/book.pdf';
    const resolvedWorkingCopyPath = '/private/var/folders/app/T/evb-viewer/pdf-work-1/book.pdf';
    const rendererOcrPath = '/var/folders/app/T/evb-viewer/ocr-1-merged.pdf';
    const canonicalOcrPath = '/private/var/folders/app/T/evb-viewer/ocr-1-merged.pdf';
    const resultBytes = Buffer.from('verified OCR result bytes');
    const resultSha256 = createHash('sha256').update(resultBytes).digest('hex');
    const sourceRevisionToken = 'revision-before-ocr' as TDocumentRevisionToken;
    let previousForcedCloneResult: string | undefined;
    let store: TPendingResultFileStore | null = null;

    beforeEach(() => {
        previousForcedCloneResult = process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'success';
        vi.clearAllMocks();
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.cp.mockResolvedValue(undefined);
        mocks.createReadStream.mockReturnValue((async function* () {
            yield resultBytes;
        })());
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.getWorkingCopyOriginalPath.mockReturnValue(null);
        mocks.lstat.mockRejectedValue(Object.assign(new Error('missing'), {code: 'ENOENT'}));
        mocks.lstatSync.mockReturnValue({isSymbolicLink: () => false});
        mocks.open.mockResolvedValue({
            close: vi.fn(async () => undefined),
            sync: vi.fn(async () => undefined),
            writeFile: mocks.writeFile,
        });
        mocks.originalPathSaveBaseMatches.mockResolvedValue(true);
        mocks.prepareOcrCatalogV4Generation.mockResolvedValue({});
        mocks.publishPreparedOcrCatalogV4.mockResolvedValue({});
        mocks.realpath.mockImplementation(async (path: string) => path.replace(
            /^\/var\/folders\//u,
            '/private/var/folders/',
        ));
        mocks.realpathSync.mockImplementation((path: string) => path.replace(
            /^\/var\/folders\//u,
            '/private/var/folders/',
        ));
        mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), {code: 'ENOENT'}));
        mocks.rebindDocumentTextCatalogRevision.mockResolvedValue(undefined);
        mocks.refreshWorkingCopyOriginalFileExpectation.mockReturnValue(undefined);
        mocks.markWorkingCopyContentChanged.mockResolvedValue(undefined);
        mocks.removeResultFile.mockResolvedValue(true);
        mocks.rename.mockResolvedValue(undefined);
        mocks.resolveAllowedReadPath.mockResolvedValue(canonicalOcrPath);
        mocks.resolveAllowedWritePath.mockResolvedValue(resolvedWorkingCopyPath);
        mocks.rm.mockResolvedValue(undefined);
        mocks.rollbackPreparedOcrCatalogV4.mockResolvedValue(false);
        mocks.transitionWorkingCopyContentRevision.mockImplementation(async (
            _path: string,
            _reason: string,
            mutation: (revision: {token: string}) => Promise<void>,
        ) => {
            await mutation({token: 'revision-after-ocr'});
            return {token: 'revision-after-ocr'};
        });
        mocks.unlink.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);

        store = createPendingResultFileStore({
            logger: {
                debug: vi.fn(),
                error: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
            },
            removeResultFile: mocks.removeResultFile,
            ttlMs: 60_000,
        });
    });

    afterEach(async () => {
        if (previousForcedCloneResult === undefined) {
            delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        } else {
            process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = previousForcedCloneResult;
        }
        await store?.shutdown();
        store = null;
    });

    it('stages the prepared v4 descriptor with canonical worker paths', async () => {
        mocks.lstat.mockResolvedValue({isSymbolicLink: () => false});
        await expect(writeOcrIndexes({
            sourcePdfPath: workingCopyPath,
            stagedResultPdfPath: rendererOcrPath,
            resultIdentity: resultSha256,
            documentRevision: {
                version: 1,
                token: sourceRevisionToken,
                documentRef: requireDocumentRef(workingCopyPath),
                authority: 'electron-working-copy',
                contentRevision: 1,
                mintedAt: requireEpochMs(1),
            },
            ocrPageData: [{
                pageNumber: 1,
                text: 'recognized page',
                words: [],
                imageWidth: 1_200,
                imageHeight: 1_600,
            }],
            successfulPageCount: 1,
            pageCount: 1,
            allLanguages: ['eng'],
            effectiveRenderDpi: 300,
            signal: new AbortController().signal,
            tempDir: '/var/folders/app/T',
            log: vi.fn(),
        })).resolves.toEqual([]);

        expect(mocks.realpath).toHaveBeenCalledWith(workingCopyPath);
        expect(mocks.realpath).toHaveBeenCalledWith(rendererOcrPath);
        expect(mocks.prepareOcrCatalogV4Generation).toHaveBeenCalledWith(expect.objectContaining({
            catalogRoot: `${resolvedWorkingCopyPath}.ocr`,
            resultPath: canonicalOcrPath,
        }));
    });

    it('applies a prepared v4 result when the allowed working path uses the macOS /var alias', async () => {
        const descriptorPath = `${canonicalOcrPath}.ocr-v4-prepared.json`;
        const descriptor = {
            version: 1,
            catalogId: '00000000-0000-4000-8000-000000000001',
            catalogRoot: `${resolvedWorkingCopyPath}.ocr`,
            sourceRootGeneration: null,
            sourceRootRevisionToken: null,
            stagedGeneration: 1,
            pageCount: 1,
            resultPath: canonicalOcrPath,
            resultIdentity: resultSha256,
            createdAt: '2026-08-28T00:00:00.000Z',
        };
        mocks.resolveAllowedWritePath.mockImplementation(async (path: string) => path);
        mocks.lstat.mockImplementation(async (path: string) => {
            if (path === descriptorPath) {
                return {
                    isFile: () => true,
                    isSymbolicLink: () => false,
                };
            }
            throw Object.assign(new Error('missing'), {code: 'ENOENT'});
        });
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path === descriptorPath) {
                return JSON.stringify(descriptor);
            }
            throw Object.assign(new Error('missing'), {code: 'ENOENT'});
        });
        store?.track(requireJobId('42:ocr-1'), requireRequestId('ocr-1'), 42, requireDocumentRef(resolvedWorkingCopyPath), sourceRevisionToken, rendererOcrPath, resultSha256, true);

        await expect(handleReplaceWorkingCopyFromPath(
            ownerContext,
            workingCopyPath,
            rendererOcrPath,
            {expectedDocumentRevisionToken: sourceRevisionToken},
        )).resolves.toBe(true);

        expect(mocks.resolveAllowedWritePath).toHaveBeenNthCalledWith(1, workingCopyPath);
        expect(mocks.resolveAllowedWritePath).toHaveBeenNthCalledWith(2, resolvedWorkingCopyPath);
        expect(mocks.publishPreparedOcrCatalogV4).toHaveBeenCalledWith(expect.objectContaining({
            catalogRoot: `${resolvedWorkingCopyPath}.ocr`,
            resultPath: canonicalOcrPath,
        }));
    });

    it('allows the owning renderer to replace from a macOS /var alias but rejects other renderers', async () => {
        store?.track(requireJobId('42:ocr-1'), requireRequestId('ocr-1'), 42, requireDocumentRef(resolvedWorkingCopyPath), sourceRevisionToken, rendererOcrPath, resultSha256, true);

        await expect(handleReplaceWorkingCopyFromPath(
            ownerContext,
            workingCopyPath,
            rendererOcrPath,
            {expectedDocumentRevisionToken: sourceRevisionToken},
        )).resolves.toBe(true);

        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalledWith(
            resolvedWorkingCopyPath,
            'ocr-apply',
            expect.any(Function),
            ownerContext.senderId,
        );
        expect(mocks.rebindDocumentTextCatalogRevision).toHaveBeenCalledWith(
            resolvedWorkingCopyPath,
            sourceRevisionToken,
            'revision-after-ocr',
        );

        expect(mocks.copyFile).toHaveBeenNthCalledWith(
            2,
            canonicalOcrPath,
            expect.stringMatching(/\/private\/var\/folders\/app\/T\/evb-viewer\/pdf-work-1\/\.[^/]+\.tmp$/u),
        );
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/\/private\/var\/folders\/app\/T\/evb-viewer\/pdf-work-1\/\.[^/]+\.tmp$/u),
            resolvedWorkingCopyPath,
        );

        mocks.copyFile.mockClear();
        mocks.rename.mockClear();

        await expect(handleReplaceWorkingCopyFromPath(
            otherContext,
            workingCopyPath,
            rendererOcrPath,
            {expectedDocumentRevisionToken: sourceRevisionToken},
        )).rejects.toThrow('OCR result is already claimed by another document owner');

        expect(mocks.copyFile).not.toHaveBeenCalled();
        expect(mocks.rename).not.toHaveBeenCalled();
    });
});
