import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';
import type * as TViMockOriginalModule2 from '@electron/utils/abort';

import {
    existsSync,
    mkdtempSync,
    rmSync,
} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';

import {
    beginPdfAnnotationIndex,
    cancelPdfAnnotationIndex,
    readPdfAnnotationIndexChunk,
    releasePdfAnnotationIndex,
} from '@electron/features/documents/main/pdfAnnotationIndex';

const mocks = vi.hoisted(() => ({
    assertWorkingCopyRevisionCurrent: vi.fn(),
    cancelNativeCommandGroup: vi.fn(),
    createLogger: vi.fn(),
    getAppTempDir: vi.fn(),
    getPdfNativeToolPaths: vi.fn(),
    getWorkingCopyRevision: vi.fn(),
    isNativePageOpsDisabled: vi.fn(),
    runWithWorkingCopyReadBacking: vi.fn(),
    registerMainOperation: vi.fn(),
    registerNativePdfSenderCleanup: vi.fn(),
    resolveExistingReadablePdfPath: vi.fn(),
    resolveNativePageOpsPath: vi.fn(),
    runNativeToolCommand: vi.fn(),
}));

vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyRevisionCurrent: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
    getWorkingCopyRevision: (...args: unknown[]) => mocks.getWorkingCopyRevision(...args),
}));
vi.mock('@electron/features/documents/main/documentFilePathResolution', () => ({resolveExistingReadablePdfPath: (...args: unknown[]) => mocks.resolveExistingReadablePdfPath(...args)}));
vi.mock('@electron/file-access/runWithWorkingCopyReadBacking', () => ({runWithWorkingCopyReadBacking: (...args: unknown[]) => mocks.runWithWorkingCopyReadBacking(...args)}));
vi.mock('@electron/features/page-ops/main/nativePageOpsPath', () => ({
    isNativePageOpsDisabled: (...args: unknown[]) => mocks.isNativePageOpsDisabled(...args),
    resolveNativePageOpsPath: (...args: unknown[]) => mocks.resolveNativePageOpsPath(...args),
}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: (...args: unknown[]) => mocks.getPdfNativeToolPaths(...args),
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({cancelNativeCommandGroup: (...args: unknown[]) => mocks.cancelNativeCommandGroup(...args)}));
vi.mock('@electron/operation-lifecycle/mainOperationLifecycle', () => ({registerMainOperation: (...args: unknown[]) => mocks.registerMainOperation(...args)}));
vi.mock('@electron/features/documents/main/nativePdfPreview', () => ({registerNativePdfSenderCleanup: (...args: unknown[]) => mocks.registerNativePdfSenderCleanup(...args)}));
vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: (...args: unknown[]) => mocks.getAppTempDir(...args)}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: (...args: unknown[]) => mocks.createLogger(...args)}));
vi.mock('@electron/utils/abort', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    abortErrorFromSignal: (signal: AbortSignal) => signal.reason instanceof Error
        ? signal.reason
        : new Error('aborted'),
}));

const revisionToken = requireDocumentRevisionToken('drt1:annotation-index-test');
const context = {senderId: 7};

function createSidecar() {
    const header = JSON.stringify({
        format: 'evb-pdf-annotation-name-index',
        schemaVersion: 1,
        pageCount: 2,
        chunkBytes: 4 * 1024 * 1024,
    });
    const firstChunk = JSON.stringify({
        chunkIndex: 0,
        entries: [{
            pageIndex: 0,
            objectNumber: 11,
            generationNumber: 0,
            subtype: 'Text',
            name: 'first-note',
            popupRef: null,
            parentRef: {
                objectNumber: 12,
                generationNumber: 0,
            },
        }],
    });
    const secondChunk = JSON.stringify({
        chunkIndex: 1,
        entries: [{
            pageIndex: 1,
            objectNumber: 21,
            generationNumber: 0,
            subtype: 'Link',
            name: null,
            popupRef: null,
            parentRef: null,
        }],
    });
    return `${header}\n${firstChunk}\n${secondChunk}\n`;
}

describe('PDF annotation index main session', () => {
    let tempRoot = '';
    let sidecarText = '';
    let sidecarPath = '';

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-pdf-annotation-index-test-'));
        sidecarText = createSidecar();
        sidecarPath = '';
        mocks.getAppTempDir.mockReturnValue(tempRoot);
        mocks.resolveExistingReadablePdfPath.mockResolvedValue(join(tempRoot, 'working.pdf'));
        mocks.getWorkingCopyRevision.mockResolvedValue({token: revisionToken});
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.runWithWorkingCopyReadBacking.mockImplementation(async (
            path: string,
            operation: (physicalPath: string) => Promise<unknown>,
        ) => operation(path));
        mocks.isNativePageOpsDisabled.mockReturnValue(false);
        mocks.resolveNativePageOpsPath.mockReturnValue('/native/evb-pdf-page-ops');
        mocks.getPdfNativeToolPaths.mockReturnValue({qpdf: '/native/qpdf'});
        mocks.registerNativePdfSenderCleanup.mockReturnValue(() => undefined);
        mocks.createLogger.mockReturnValue({
            debug: vi.fn(),
            warn: vi.fn(),
        });
        mocks.registerMainOperation.mockImplementation(() => ({
            id: 'annotation-index-operation',
            signal: new AbortController().signal,
            complete: vi.fn(),
        }));
        mocks.runNativeToolCommand.mockImplementation(async (_nativePath: string, args: string[]) => {
            const outputIndex = args.indexOf('--output');
            sidecarPath = args[outputIndex + 1]!;
            await writeFile(sidecarPath, sidecarText);
        });
    });

    afterEach(() => {
        if (tempRoot) {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('authorizes the logical path before invoking native indexing', async () => {
        mocks.resolveExistingReadablePdfPath.mockRejectedValueOnce(new Error('not authorized'));

        await expect(beginPdfAnnotationIndex(
            context,
            requireDocumentRef('/outside/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        )).rejects.toThrow('not authorized');
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('rejects a stale source revision before native indexing', async () => {
        mocks.getWorkingCopyRevision.mockResolvedValueOnce({token: requireDocumentRevisionToken('drt1:annotation-index-newer')});

        await expect(beginPdfAnnotationIndex(
            context,
            requireDocumentRef('/tmp/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        )).rejects.toThrow('STALE_REVISION');
        expect(mocks.assertWorkingCopyRevisionCurrent).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('reads bounded page chunks and removes the private sidecar on release', async () => {
        const session = await beginPdfAnnotationIndex(
            context,
            requireDocumentRef('/tmp/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        );
        expect(session).toMatchObject({
            documentRef: '/tmp/document.pdf',
            documentRevisionToken: revisionToken,
            pageCount: 2,
            entryCount: 2,
        });
        const first = await readPdfAnnotationIndexChunk(context, session.sessionId, 0, {chunkBytes: 4 * 1024 * 1024});
        expect(first).toMatchObject({
            offset: 0,
            done: false,
            entries: [{
                pageIndex: 0,
                objectNumber: 11,
                name: 'first-note',
                parentRef: {
                    objectNumber: 12,
                    generationNumber: 0,
                },
            }],
        });
        const second = await readPdfAnnotationIndexChunk(
            context,
            session.sessionId,
            first.nextOffset!,
            {chunkBytes: 4 * 1024 * 1024},
        );
        expect(second).toMatchObject({
            done: true,
            entries: [{
                pageIndex: 1,
                name: null,
            }],
        });
        expect(await releasePdfAnnotationIndex(context, session.sessionId)).toBe(true);
        expect(existsSync(sidecarPath)).toBe(false);
        await expect(readPdfAnnotationIndexChunk(context, session.sessionId, 0))
            .rejects.toThrow('session is not available');
    });

    it('preserves a direct-annotation page marker with reserved object zero', async () => {
        sidecarText = `${JSON.stringify({
            format: 'evb-pdf-annotation-name-index',
            schemaVersion: 1,
            pageCount: 1,
            chunkBytes: 4 * 1024 * 1024,
        })}\n${JSON.stringify({
            chunkIndex: 0,
            entries: [{
                pageIndex: 0,
                objectNumber: 0,
                generationNumber: 0,
                subtype: 'Link',
                name: null,
                popupRef: null,
                parentRef: null,
            }],
        })}\n`;
        const session = await beginPdfAnnotationIndex(
            context,
            requireDocumentRef('/tmp/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        );

        const chunk = await readPdfAnnotationIndexChunk(
            context,
            session.sessionId,
            0,
            {chunkBytes: 4 * 1024 * 1024},
        );
        expect(chunk.entries).toEqual([expect.objectContaining({
            pageIndex: 0,
            objectNumber: 0,
            subtype: 'Link',
        })]);
    });

    it('rejects a requested chunk size smaller than one sidecar line', async () => {
        const session = await beginPdfAnnotationIndex(
            context,
            requireDocumentRef('/tmp/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        );

        await expect(readPdfAnnotationIndexChunk(context, session.sessionId, 0, {chunkBytes: 1}))
            .rejects.toThrow('requires a chunk of at least');
        await releasePdfAnnotationIndex(context, session.sessionId);
    });

    it('invalidates and cleans a sidecar when the source changes after native indexing', async () => {
        mocks.assertWorkingCopyRevisionCurrent
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('stale after indexing'));

        await expect(beginPdfAnnotationIndex(
            context,
            requireDocumentRef('/tmp/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        )).rejects.toThrow('stale after indexing');
        expect(existsSync(sidecarPath)).toBe(false);
    });

    it('cancels a ready session and removes its sidecar', async () => {
        const session = await beginPdfAnnotationIndex(
            context,
            requireDocumentRef('/tmp/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        );

        await expect(cancelPdfAnnotationIndex(context, session.sessionId))
            .resolves.toEqual({canceled: true});
        await releasePdfAnnotationIndex(context, session.sessionId);
        await vi.waitFor(() => expect(existsSync(sidecarPath)).toBe(false));
        await expect(readPdfAnnotationIndexChunk(context, session.sessionId, 0))
            .rejects.toThrow(/session is (?:canceled|not available)/iu);
    });
});
