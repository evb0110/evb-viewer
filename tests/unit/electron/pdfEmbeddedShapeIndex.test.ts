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
    beginPdfEmbeddedShapeIndex,
    cancelPdfEmbeddedShapeIndex,
    readPdfEmbeddedShapeIndexChunk,
    releasePdfEmbeddedShapeIndex,
} from '@electron/features/documents/main/pdfEmbeddedShapeIndex';

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

const revisionToken = requireDocumentRevisionToken('drt1:embedded-shape-index-test');
const context = {senderId: 7};

function createSidecar() {
    const header = JSON.stringify({
        format: 'evb-pdf-embedded-shape-index',
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
            stableKey: 'shape-11',
            pdfSubtype: 'Square',
            type: 'rectangle',
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.4,
            x2: null,
            y2: null,
            color: '#ff0000',
            fillColor: '#00ff00',
            opacity: 0.75,
            strokeWidth: 2,
            points: null,
            strokes: null,
            lineStartStyle: null,
            lineEndStyle: null,
            createdAt: 1_704_164_645_000,
            modifiedAt: null,
        }],
    });
    const secondChunk = JSON.stringify({
        chunkIndex: 1,
        entries: [{
            pageIndex: 1,
            objectNumber: 21,
            generationNumber: 0,
            stableKey: null,
            pdfSubtype: 'Line',
            type: 'arrow',
            x: 0.2,
            y: 0.3,
            width: 0.4,
            height: 0.5,
            x2: 0.6,
            y2: 0.8,
            color: '#0000ff',
            fillColor: null,
            opacity: 1,
            strokeWidth: 1,
            points: null,
            strokes: null,
            lineStartStyle: 'none',
            lineEndStyle: 'closedArrow',
            createdAt: null,
            modifiedAt: 1_706_925_906_000,
        }],
    });
    return `${header}\n${firstChunk}\n${secondChunk}\n`;
}

describe('PDF embedded shape index main session', () => {
    let tempRoot = '';
    let sidecarText = '';
    let sidecarPath = '';

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-pdf-embedded-shape-index-test-'));
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
            id: 'embedded-shape-index-operation',
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

        await expect(beginPdfEmbeddedShapeIndex(
            context,
            requireDocumentRef('/outside/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        )).rejects.toThrow('not authorized');
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('rejects a stale source revision before native indexing', async () => {
        mocks.getWorkingCopyRevision.mockResolvedValueOnce({token: requireDocumentRevisionToken('drt1:embedded-shape-index-newer')});

        await expect(beginPdfEmbeddedShapeIndex(
            context,
            requireDocumentRef('/tmp/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        )).rejects.toThrow('STALE_REVISION');
        expect(mocks.assertWorkingCopyRevisionCurrent).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('reads typed page chunks and removes the private sidecar on release', async () => {
        const session = await beginPdfEmbeddedShapeIndex(
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
        const first = await readPdfEmbeddedShapeIndexChunk(context, session.sessionId, 0);
        expect(first).toMatchObject({
            offset: 0,
            done: false,
            entries: [{
                pageIndex: 0,
                objectNumber: 11,
                pdfSubtype: 'Square',
                type: 'rectangle',
                stableKey: 'shape-11',
            }],
        });
        const second = await readPdfEmbeddedShapeIndexChunk(
            context,
            session.sessionId,
            first.nextOffset!,
        );
        expect(second).toMatchObject({
            done: true,
            entries: [{
                pageIndex: 1,
                pdfSubtype: 'Line',
                type: 'arrow',
                lineEndStyle: 'closedArrow',
            }],
        });
        expect(await releasePdfEmbeddedShapeIndex(context, session.sessionId)).toBe(true);
        expect(existsSync(sidecarPath)).toBe(false);
        await expect(readPdfEmbeddedShapeIndexChunk(context, session.sessionId, 0))
            .rejects.toThrow('session is not available');
    });

    it('rejects a requested chunk size smaller than one sidecar line', async () => {
        const session = await beginPdfEmbeddedShapeIndex(
            context,
            requireDocumentRef('/tmp/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        );

        await expect(readPdfEmbeddedShapeIndexChunk(context, session.sessionId, 0, {chunkBytes: 1}))
            .rejects.toThrow('requires a chunk of at least');
        await releasePdfEmbeddedShapeIndex(context, session.sessionId);
    });

    it('invalidates and cleans a sidecar when the source changes after native indexing', async () => {
        mocks.assertWorkingCopyRevisionCurrent
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('stale after indexing'));

        await expect(beginPdfEmbeddedShapeIndex(
            context,
            requireDocumentRef('/tmp/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        )).rejects.toThrow('stale after indexing');
        expect(existsSync(sidecarPath)).toBe(false);
    });

    it('rejects access from a different sender and cancels a ready session', async () => {
        const session = await beginPdfEmbeddedShapeIndex(
            context,
            requireDocumentRef('/tmp/document.pdf'),
            {expectedDocumentRevisionToken: revisionToken},
        );

        await expect(readPdfEmbeddedShapeIndexChunk({senderId: 8}, session.sessionId, 0))
            .rejects.toThrow('belongs to another sender');
        await expect(cancelPdfEmbeddedShapeIndex(context, session.sessionId))
            .resolves.toEqual({canceled: true});
        await vi.waitFor(() => expect(existsSync(sidecarPath)).toBe(false));
        await expect(readPdfEmbeddedShapeIndexChunk(context, session.sessionId, 0))
            .rejects.toThrow(/session is (?:canceled|not available)/iu);
    });
});
