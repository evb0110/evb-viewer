import type * as TViMockOriginalModule from '@app/utils/platformDocuments';
import type * as TViMockOriginalModule2 from '@app/composables/useTypedI18n';

import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {effectScope} from 'vue';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import type {IDocxExportFileCapability} from '@contracts/docxExport';
import type {
    TDocxParagraphDirection,
    TDocxTextPageSource,
} from '@app/utils/docxStreaming';

type TDocxChunkBuilder = (
    pages: TDocxTextPageSource,
    direction?: TDocxParagraphDirection,
    signal?: AbortSignal,
) => AsyncIterable<Uint8Array>;

const trackMock = vi.hoisted(() => vi.fn());
const toastAddMock = vi.hoisted(() => vi.fn());
const createDocxFromTextAsyncMock = vi.hoisted(() => vi.fn(async () => new Uint8Array([
    1,
    2,
    3,
])));
const createDocxFromTextChunksMock = vi.hoisted(() => vi.fn<TDocxChunkBuilder>(() => (async function* () {
    yield new Uint8Array([
        4,
        5,
        6,
    ]);
})()));
const loadDocumentTextCatalogPagesMock = vi.hoisted(() => vi.fn<() => Promise<Array<{
    pageNumber: number;
    text: string;
}> | null>>(async () => null));
const documentFilesMock = vi.hoisted(() => ({
    saveDocxAs: vi.fn(async () => '/tmp/export.docx'),
    writeDocxFile: vi.fn(async () => {}),
    beginDocxFileStream: vi.fn<IDocxExportFileCapability['beginDocxFileStream']>(async () => ({sessionId: 'docx-session'})),
    writeDocxFileStreamChunk: vi.fn<IDocxExportFileCapability['writeDocxFileStreamChunk']>(async () => true),
    commitDocxFileStream: vi.fn<IDocxExportFileCapability['commitDocxFileStream']>(async () => true),
    cancelDocxFileStream: vi.fn<IDocxExportFileCapability['cancelDocxFileStream']>(async () => true),
}));
const documentWorkingCopyMock = vi.hoisted(() => ({cleanupFile: vi.fn(async () => {})}));
const TEST_DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');
interface IActualDocxStreamingModule {
    resolveDocxParagraphDirection: (text: string, fallbackRtl?: boolean) => boolean;
    createDocxFromTextChunks: (
        pages: Iterable<string> | AsyncIterable<string>,
        direction?: TDocxParagraphDirection,
        signal?: AbortSignal,
    ) => AsyncIterable<Uint8Array>;
    DOCX_STREAM_CHUNK_BYTES: number;
}

vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentFilesCapability: () => documentFilesMock,
    getDocumentWorkingCopyCapability: () => documentWorkingCopyMock,
}));
vi.mock('@app/composables/useAnalytics', () => ({useAnalytics: () => ({track: trackMock})}));
vi.mock('@app/composables/useTypedI18n', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));
vi.mock('@app/utils/ocr/loadOcrText', () => ({loadDocumentTextCatalogPages: loadDocumentTextCatalogPagesMock}));
vi.mock('@app/utils/docx', () => ({createDocxFromTextAsync: createDocxFromTextAsyncMock}));
vi.mock('@app/utils/docxStreaming', async () => {
    const actual = await vi.importActual<IActualDocxStreamingModule>('@app/utils/docxStreaming');
    return {
        ...actual,
        createDocxFromTextChunks: createDocxFromTextChunksMock,
    };
});
vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

beforeEach(() => {
    vi.clearAllMocks();
    loadDocumentTextCatalogPagesMock.mockImplementation(async () => null);
    createDocxFromTextChunksMock.mockImplementation(() => (async function* () {
        yield new Uint8Array([
            1,
            2,
            3,
        ]);
    })());
    documentFilesMock.writeDocxFileStreamChunk.mockImplementation(async () => true);
    documentFilesMock.commitDocxFileStream.mockImplementation(async () => true);
    documentFilesMock.cancelDocxFileStream.mockImplementation(async () => true);
});

describe('useDocxExport', () => {
    it('uses the async docx builder without cleaning filesystem output paths', async () => {
        const callOrder: string[] = [];
        documentFilesMock.saveDocxAs.mockImplementationOnce(async () => {
            callOrder.push('save');
            return '/tmp/export.docx';
        });
        loadDocumentTextCatalogPagesMock.mockImplementationOnce(async () => {
            callOrder.push('loadCatalog');
            return [{
                pageNumber: 1,
                text: 'catalog text',
            }];
        });
        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: requireDocumentRef('/tmp/work.pdf'),
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as IPdfDocument,
            selectedLanguages: ['heb'],
        });

        expect(result).toBe(true);
        expect(callOrder).toEqual([
            'save',
            'loadCatalog',
        ]);
        expect(loadDocumentTextCatalogPagesMock).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            TEST_DOCUMENT_REVISION,
            undefined,
            expect.any(AbortSignal),
        );
        expect(createDocxFromTextChunksMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(Function),
            expect.any(AbortSignal),
        );
        const direction = createDocxFromTextChunksMock.mock.calls[0]?.[1];
        expect(typeof direction).toBe('function');
        expect((direction as ((text: string) => boolean))('אבג 123')).toBe(true);
        expect((direction as ((text: string) => boolean))('Latin 123')).toBe(false);
        expect(documentFilesMock.saveDocxAs).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(documentFilesMock.beginDocxFileStream).toHaveBeenCalledWith('/tmp/export.docx');
        expect(documentFilesMock.writeDocxFileStreamChunk).toHaveBeenCalled();
        expect(documentFilesMock.commitDocxFileStream).toHaveBeenCalledWith('docx-session');
        expect(documentFilesMock.writeDocxFile).not.toHaveBeenCalled();
        expect(documentWorkingCopyMock.cleanupFile).not.toHaveBeenCalled();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'success',
            title: expect.any(String),
            description: expect.any(String),
        }));
        expect(trackMock).toHaveBeenCalledWith('export_completed', expect.objectContaining({
            format: 'docx',
            hasRtl: true,
            selectedLanguageCount: 1,
            status: 'success',
        }));
    });

    it('streams desktop DOCX output beyond the legacy budgets in bounded chunks', async () => {
        const {
            createDocxFromTextChunks: actualCreateDocxFromTextChunks,
            DOCX_STREAM_CHUNK_BYTES,
        } = await vi.importActual<IActualDocxStreamingModule>('@app/utils/docxStreaming');
        const chunks: Uint8Array[] = [];
        createDocxFromTextChunksMock.mockImplementationOnce(actualCreateDocxFromTextChunks);
        documentFilesMock.writeDocxFileStreamChunk.mockImplementation(async (_session, chunk) => {
            expect(chunk.byteLength).toBeLessThanOrEqual(DOCX_STREAM_CHUNK_BYTES);
            chunks.push(chunk);
            return true;
        });
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce(
            Array.from({length: 4}, (_, index) => ({
                pageNumber: index + 1,
                text: 'x'.repeat(1024 * 1024),
            })),
        );

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();
        const result = await exportState.exportDocx({
            workingCopyPath: requireDocumentRef('/tmp/work.pdf'),
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as IPdfDocument,
        });

        expect(result).toBe(true);
        expect(chunks.length).toBeGreaterThan(4);
        expect(documentFilesMock.writeDocxFile).not.toHaveBeenCalled();
        expect(documentFilesMock.beginDocxFileStream).toHaveBeenCalledOnce();
    });

    it('cancels and reports a rejected chunk acknowledgement', async () => {
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce([{
            pageNumber: 1,
            text: 'catalog text',
        }]);
        documentFilesMock.writeDocxFileStreamChunk.mockResolvedValueOnce(false);
        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const result = await useDocxExport().exportDocx({
            workingCopyPath: requireDocumentRef('/tmp/work.pdf'),
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as IPdfDocument,
        });
        expect(result).toBe(false);
        expect(documentFilesMock.cancelDocxFileStream).toHaveBeenCalledWith('docx-session');
        expect(documentFilesMock.commitDocxFileStream).not.toHaveBeenCalled();
    });

    it('does not commit an empty DOCX stream', async () => {
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce([{
            pageNumber: 1,
            text: 'catalog text',
        }]);
        createDocxFromTextChunksMock.mockImplementationOnce(async function* () {});
        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const result = await useDocxExport().exportDocx({
            workingCopyPath: requireDocumentRef('/tmp/work.pdf'),
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as IPdfDocument,
        });
        expect(result).toBe(false);
        expect(documentFilesMock.cancelDocxFileStream).toHaveBeenCalledWith('docx-session');
        expect(documentFilesMock.commitDocxFileStream).not.toHaveBeenCalled();
    });

    it('reports success when cancellation arrives after commit accepted publication', async () => {
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce([{
            pageNumber: 1,
            text: 'catalog text',
        }]);
        const {useDocxExport} = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();
        documentFilesMock.commitDocxFileStream.mockImplementationOnce(async () => {
            exportState.cancelDocxExport();
            return true;
        });
        const result = await exportState.exportDocx({
            workingCopyPath: requireDocumentRef('/tmp/work.pdf'),
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as IPdfDocument,
        });
        expect(result).toBe(true);
        expect(documentFilesMock.cancelDocxFileStream).toHaveBeenCalledWith('docx-session');
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({color: 'success'}));
    });

    it('does not cleanup filesystem output paths when no DOCX text is available', async () => {
        documentFilesMock.saveDocxAs.mockResolvedValueOnce('/tmp/empty.docx');
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce(null);

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: requireDocumentRef('/tmp/work.pdf'),
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as IPdfDocument,
        });

        expect(result).toBe(false);
        expect(exportState.docxExportError.value).toBe('errors.ocr.noText');
        expect(documentFilesMock.writeDocxFile).not.toHaveBeenCalled();
        expect(documentFilesMock.writeDocxFileStreamChunk).not.toHaveBeenCalled();
        expect(documentWorkingCopyMock.cleanupFile).not.toHaveBeenCalled();
        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('cleans up browser output refs when no DOCX text is available', async () => {
        documentFilesMock.saveDocxAs.mockResolvedValueOnce('browser://documents/output/empty.docx');
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce(null);

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: requireDocumentRef('browser://documents/working/work.pdf'),
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as IPdfDocument,
        });

        expect(result).toBe(false);
        expect(documentFilesMock.writeDocxFile).not.toHaveBeenCalled();
        expect(documentFilesMock.beginDocxFileStream).not.toHaveBeenCalled();
        expect(documentWorkingCopyMock.cleanupFile).toHaveBeenCalledWith('browser://documents/output/empty.docx');
    });

    it('cleans up a browser output ref when cancellation lands after Save As', async () => {
        const outputPath = 'browser://documents/output/canceled.docx';
        documentFilesMock.saveDocxAs.mockResolvedValueOnce(outputPath);

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();
        const exportPromise = exportState.exportDocx({
            workingCopyPath: requireDocumentRef('browser://documents/working/work.pdf'),
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as IPdfDocument,
        });
        exportState.cancelDocxExport();

        await expect(exportPromise).resolves.toBe(false);
        expect(documentWorkingCopyMock.cleanupFile).toHaveBeenCalledWith(outputPath);
        expect(toastAddMock).not.toHaveBeenCalled();
        expect(trackMock).not.toHaveBeenCalled();
    });

    it('cancels an active renderer export without reporting success', async () => {
        let resolveWriteStarted: (() => void) | undefined;
        const writeStarted = new Promise<void>(resolve => {
            resolveWriteStarted = resolve;
        });
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce([{
            pageNumber: 1,
            text: 'catalog text',
        }]);
        documentFilesMock.writeDocxFileStreamChunk.mockImplementationOnce(async () => {
            resolveWriteStarted?.();
            await new Promise<void>(resolve => {
                documentFilesMock.cancelDocxFileStream.mockImplementationOnce(async () => {
                    resolve();
                    return true;
                });
            });
            return true;
        });

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();
        const exportPromise = exportState.exportDocx({
            workingCopyPath: requireDocumentRef('/tmp/work.pdf'),
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as IPdfDocument,
        });

        await writeStarted;
        expect(exportState.isExportingDocx.value).toBe(true);
        exportState.cancelDocxExport();

        await expect(exportPromise).resolves.toBe(false);
        expect(exportState.isExportingDocx.value).toBe(false);
        expect(exportState.docxExportError.value).toBeNull();
        expect(documentFilesMock.cancelDocxFileStream).toHaveBeenCalledWith('docx-session');
        expect(toastAddMock).not.toHaveBeenCalled();
        expect(trackMock).not.toHaveBeenCalled();
    });

    it('aborts an active export when its owning scope is disposed', async () => {
        let resolveWriteStarted: (() => void) | undefined;
        const writeStarted = new Promise<void>(resolve => {
            resolveWriteStarted = resolve;
        });
        loadDocumentTextCatalogPagesMock.mockResolvedValueOnce([{
            pageNumber: 1,
            text: 'catalog text',
        }]);
        documentFilesMock.writeDocxFileStreamChunk.mockImplementationOnce(async () => {
            resolveWriteStarted?.();
            await new Promise<void>(resolve => {
                documentFilesMock.cancelDocxFileStream.mockImplementationOnce(async () => {
                    resolve();
                    return true;
                });
            });
            return true;
        });

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const scope = effectScope();
        const exportState = scope.run(() => useDocxExport());
        if (!exportState) {
            throw new Error('Failed to create DOCX export scope');
        }
        const exportPromise = exportState.exportDocx({
            workingCopyPath: requireDocumentRef('/tmp/work.pdf'),
            documentRevisionToken: TEST_DOCUMENT_REVISION,
            pdfDocument: {} as IPdfDocument,
        });

        await writeStarted;
        scope.stop();

        await expect(exportPromise).resolves.toBe(false);
        expect(exportState.isExportingDocx.value).toBe(false);
        expect(exportState.docxExportError.value).toBeNull();
        expect(toastAddMock).not.toHaveBeenCalled();
        expect(trackMock).not.toHaveBeenCalled();
    });
});
