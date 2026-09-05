import {
    existsSync,
    mkdtempSync,
    rmSync,
} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {PDF_ANNOTATION_PARSE_MAX_LINE_BYTES} from '@contracts/pdfAnnotationParseTypes';
import {
    beginPdfAnnotationParse,
    cancelPdfAnnotationParse,
    parsePdfAnnotations,
    readPdfAnnotationParseChunk,
    releasePdfAnnotationParse,
} from '@electron/features/documents/main/pdfAnnotationParse';

const mocks = vi.hoisted(() => ({
    assertWorkingCopyRevisionCurrent: vi.fn(),
    cancelNativeCommandGroup: vi.fn(),
    createLogger: vi.fn(),
    getAppTempDir: vi.fn(),
    getPdfNativeToolPaths: vi.fn(),
    getWorkingCopyRevision: vi.fn(),
    isNativePageOpsDisabled: vi.fn(),
    registerMainOperation: vi.fn(),
    registerNativePdfSenderCleanup: vi.fn(),
    resolveExistingReadablePdfPath: vi.fn(),
    resolveNativePageOpsPath: vi.fn(),
    runNativeToolCommand: vi.fn(),
    runWithWorkingCopyReadBacking: vi.fn(),
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
vi.mock('@electron/features/page-ops/public/nativePageOpsPath', () => ({
    isNativePageOpsDisabled: (...args: unknown[]) => mocks.isNativePageOpsDisabled(...args),
    resolveNativePageOpsPath: (...args: unknown[]) => mocks.resolveNativePageOpsPath(...args),
}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: (...args: unknown[]) => mocks.getPdfNativeToolPaths(...args)}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({cancelNativeCommandGroup: (...args: unknown[]) => mocks.cancelNativeCommandGroup(...args)}));
vi.mock('@electron/operation-lifecycle/mainOperationLifecycle', () => ({registerMainOperation: (...args: unknown[]) => mocks.registerMainOperation(...args)}));
vi.mock('@electron/features/documents/main/nativePdfPreview', () => ({registerNativePdfSenderCleanup: (...args: unknown[]) => mocks.registerNativePdfSenderCleanup(...args)}));
vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: (...args: unknown[]) => mocks.getAppTempDir(...args)}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: (...args: unknown[]) => mocks.createLogger(...args)}));
vi.mock('@electron/utils/abort', () => ({abortErrorFromSignal: (signal: AbortSignal) => signal.reason instanceof Error
    ? signal.reason
    : new Error('aborted')}));

const revisionToken = requireDocumentRevisionToken('drt1:annotation-parse-host-test');
const context = {senderId: 7};

function createSidecar() {
    return [
        JSON.stringify({
            format: 'evb-pdf-annotation-parse',
            schemaVersion: 1,
            pageCount: 1,
            chunkBytes: 4 * 1024 * 1024,
        }),
        JSON.stringify({
            chunkIndex: 0,
            entries: [
                {
                    kind: 'text-box',
                    pageIndex: 0,
                    objectNumber: 11,
                    generationNumber: 0,
                    name: 'text-box-11',
                    author: null,
                    createdAt: null,
                    modifiedAt: null,
                    text: 'writer text',
                    rect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.1,
                    },
                    rotation: 0,
                    fontSize: 12,
                    color: '#336699',
                },
                {
                    kind: 'foreign',
                    pageIndex: 0,
                    objectNumber: 12,
                    generationNumber: 0,
                    name: 'link-12',
                    subtype: 'Link',
                    reason: 'Unsupported annotation subtype /Link',
                },
            ],
        }),
    ].join('\n') + '\n';
}

describe('PDF annotation parse main session', () => {
    let tempRoot = '';
    let sidecarPath = '';
    let sidecarText = '';

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-pdf-annotation-parse-test-'));
        sidecarPath = '';
        sidecarText = createSidecar();
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
            id: 'annotation-parse-operation',
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

    it('runs parse-annotations with deterministic metadata and streams typed entries', async () => {
        const session = await beginPdfAnnotationParse(
            context,
            '/logical/working.pdf',
            {expectedDocumentRevisionToken: revisionToken},
        );
        expect(session).toMatchObject({
            documentRef: '/logical/working.pdf',
            documentRevisionToken: revisionToken,
            pageCount: 1,
            entryCount: 2,
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                'parse-annotations',
                '--input',
                join(tempRoot, 'working.pdf'),
                '--output',
                sidecarPath,
                '--qpdf',
                '/native/qpdf',
                '--modified-at',
                'D:19700101000000Z',
            ]),
            expect.objectContaining({
                timeoutMs: 30 * 60 * 1_000,
                signal: expect.any(AbortSignal),
            }),
        );

        const chunk = await readPdfAnnotationParseChunk(context, session.sessionId, 0);
        expect(chunk).toMatchObject({
            offset: 0,
            done: true,
            entries: [
                {
                    kind: 'text-box',
                    name: 'text-box-11',
                    text: 'writer text',
                },
                {
                    kind: 'foreign',
                    subtype: 'Link',
                },
            ],
        });
        expect(await releasePdfAnnotationParse(context, session.sessionId)).toBe(true);
        expect(existsSync(sidecarPath)).toBe(false);
    });

    it('returns editable entities and inert foreign records from the one-shot capability', async () => {
        await expect(parsePdfAnnotations(
            context,
            '/logical/working.pdf',
            {expectedDocumentRevisionToken: revisionToken},
        )).resolves.toEqual({
            documentRevisionToken: revisionToken,
            pageCount: 1,
            entities: [expect.objectContaining({
                kind: 'text-box',
                name: 'text-box-11',
            })],
            foreign: [expect.objectContaining({
                kind: 'foreign',
                subtype: 'Link',
            })],
        });
        expect(existsSync(sidecarPath)).toBe(false);
    });

    it('rejects a malformed sidecar and removes its temporary directory', async () => {
        sidecarText = `${JSON.stringify({
            format: 'evb-pdf-annotation-parse',
            schemaVersion: 1,
            pageCount: 1,
            chunkBytes: 4 * 1024 * 1024,
        })}\nnot-json\n`;

        await expect(beginPdfAnnotationParse(
            context,
            '/logical/working.pdf',
            {expectedDocumentRevisionToken: revisionToken},
        )).rejects.toThrow(/invalid JSON/iu);
        expect(sidecarPath).not.toBe('');
        expect(existsSync(sidecarPath)).toBe(false);
        const sidecarDirectory = dirname(sidecarPath);
        expect(existsSync(sidecarDirectory)).toBe(false);
    });

    it('rejects oversized and out-of-order sidecar lines before exposing a session', async () => {
        sidecarText = `${JSON.stringify({
            format: 'evb-pdf-annotation-parse',
            schemaVersion: 1,
            pageCount: 1,
            chunkBytes: 4 * 1024 * 1024,
        })}\n${'x'.repeat(PDF_ANNOTATION_PARSE_MAX_LINE_BYTES)}\n`;
        await expect(beginPdfAnnotationParse(
            context,
            '/logical/working.pdf',
            {expectedDocumentRevisionToken: revisionToken},
        )).rejects.toThrow(/line exceeds/iu);
        expect(existsSync(sidecarPath)).toBe(false);

        sidecarText = createSidecar().replace('"chunkIndex":0', '"chunkIndex":1');
        await expect(beginPdfAnnotationParse(
            context,
            '/logical/working.pdf',
            {expectedDocumentRevisionToken: revisionToken},
        )).rejects.toThrow(/out of order/iu);
        expect(existsSync(sidecarPath)).toBe(false);
    });

    it('fences revision drift and sender ownership before exposing chunks', async () => {
        const session = await beginPdfAnnotationParse(
            context,
            '/logical/working.pdf',
            {expectedDocumentRevisionToken: revisionToken},
        );
        await expect(readPdfAnnotationParseChunk(
            {senderId: 8},
            session.sessionId,
            0,
        )).rejects.toThrow(/another sender/iu);

        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(new Error('STALE_REVISION'));
        await expect(readPdfAnnotationParseChunk(
            context,
            session.sessionId,
            0,
        )).rejects.toThrow('STALE_REVISION');

        await expect(cancelPdfAnnotationParse(
            context,
            session.sessionId,
        )).resolves.toEqual({canceled: true});
        await expect(readPdfAnnotationParseChunk(context, session.sessionId, 0))
            .rejects.toThrow(/session is not available|session is canceled/iu);
        expect(mocks.cancelNativeCommandGroup).toHaveBeenCalled();
        await releasePdfAnnotationParse(context, session.sessionId);
        await vi.waitFor(() => expect(existsSync(sidecarPath)).toBe(false));
    });

    it('rejects revision changes after native output before returning the session', async () => {
        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(new Error('STALE_REVISION'));

        await expect(beginPdfAnnotationParse(
            context,
            '/logical/working.pdf',
            {expectedDocumentRevisionToken: revisionToken},
        )).rejects.toThrow('STALE_REVISION');
        expect(existsSync(sidecarPath)).toBe(false);
    });
});
