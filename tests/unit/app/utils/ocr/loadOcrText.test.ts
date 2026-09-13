import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';

const resolveDocumentTextCatalogMock = vi.hoisted(() => vi.fn());
const resolveDocumentTextCatalogWindowMock = vi.hoisted(() => vi.fn());
const cancelOcrMock = vi.hoisted(() => vi.fn(async () => ({canceled: true})));

const platformApi = createElectronPlatformApiFixture({ocr: {
    cancel: cancelOcrMock,
    resolveDocumentTextCatalog: resolveDocumentTextCatalogMock,
    resolveDocumentTextCatalogWindow: resolveDocumentTextCatalogWindowMock,
}});
vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => platformApi}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: vi.fn()}}));

const {
    loadOcrText,
    prepareDocumentTextCatalogTextPages,
} = await import('@app/utils/ocr/loadOcrText');
const TEST_DOCUMENT_REVISION = 'revision-token';

describe('loadOcrText', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cancelOcrMock.mockResolvedValue({canceled: true});
        resolveDocumentTextCatalogMock.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 17,
            pages: Array.from({length: 17}, (_value, index) => ({
                pageNumber: index + 1,
                text: `Page ${index + 1}`,
                source: 'evb-ocr',
                contentDigest: `digest-${index + 1}`,
            })),
            contentDigest: 'snapshot-digest',
        });
        resolveDocumentTextCatalogWindowMock.mockImplementation(async (
            _path: string,
            documentRevision: string,
            firstPage: number,
            lastPage: number,
            pageCount: number,
        ) => ({
            documentRevision,
            pageCount,
            firstPage,
            lastPage,
            pages: [{
                pageNumber: firstPage,
                text: `Page ${firstPage}`,
                source: 'evb-ocr',
                contentDigest: `digest-${firstPage}`,
            }],
            contentDigest: `window-${firstPage}`,
        }));
    });

    it('reads all canonical pages through the production catalog capability', async () => {
        await expect(loadOcrText(requireDocumentRef('/tmp/work.pdf'), TEST_DOCUMENT_REVISION)).resolves.toContain('Page 17');
        expect(resolveDocumentTextCatalogMock).toHaveBeenCalledWith('/tmp/work.pdf', TEST_DOCUMENT_REVISION);
    });

    it('does not fall back to renderer-side artifacts', async () => {
        resolveDocumentTextCatalogMock.mockResolvedValue({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 1,
            pages: [],
            contentDigest: 'empty',
        });
        await expect(loadOcrText(requireDocumentRef('/tmp/work.pdf'), TEST_DOCUMENT_REVISION)).resolves.toBeNull();
    });

    it('opens only the first bounded window for a lazy 100,001-page DOCX stream', async () => {
        const pageStream = await prepareDocumentTextCatalogTextPages(
            requireDocumentRef('/tmp/work.pdf'),
            TEST_DOCUMENT_REVISION,
            100_001,
        );
        expect(pageStream).not.toBeNull();
        expect(resolveDocumentTextCatalogWindowMock).toHaveBeenCalledTimes(1);
        expect(resolveDocumentTextCatalogWindowMock).toHaveBeenCalledWith(
            requireDocumentRef('/tmp/work.pdf'),
            TEST_DOCUMENT_REVISION,
            1,
            64,
            100_001,
        );

        const iterator = pageStream![Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toMatchObject({
            done: false,
            value: 'Page 1',
        });
        expect(resolveDocumentTextCatalogWindowMock).toHaveBeenCalledTimes(1);
    });

    it('stops waiting for an in-flight catalog window when DOCX export is canceled', async () => {
        const controller = new AbortController();
        let resolveWindow: ((window: {
            documentRevision: string;
            pageCount: number;
            firstPage: number;
            lastPage: number;
            pages: Array<{
                pageNumber: number;
                text: string;
                source: 'evb-ocr';
                contentDigest: string;
            }>;
            contentDigest: string;
        }) => void) | undefined;
        const windowPromise = new Promise<Parameters<NonNullable<typeof resolveWindow>>[0]>(resolve => {
            resolveWindow = resolve;
        });
        resolveDocumentTextCatalogWindowMock.mockReturnValueOnce(windowPromise);

        const preparing = prepareDocumentTextCatalogTextPages(
            requireDocumentRef('/tmp/work.pdf'),
            TEST_DOCUMENT_REVISION,
            100_001,
            controller.signal,
        );
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        await expect(preparing).rejects.toMatchObject({name: 'AbortError'});
        resolveWindow?.({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 100_001,
            firstPage: 1,
            lastPage: 64,
            pages: [{
                pageNumber: 1,
                text: 'Page 1',
                source: 'evb-ocr',
                contentDigest: 'digest-1',
            }],
            contentDigest: 'window-1',
        });
        await windowPromise;
        expect(resolveDocumentTextCatalogWindowMock).toHaveBeenCalledTimes(1);
    });

    it('cancels an in-flight catalog window with the request id sent to the renderer capability', async () => {
        const controller = new AbortController();
        let resolveWindow: ((window: {
            documentRevision: string;
            pageCount: number;
            firstPage: number;
            lastPage: number;
            pages: Array<{
                pageNumber: number;
                text: string;
                source: 'evb-ocr';
                contentDigest: string;
            }>;
            contentDigest: string;
        }) => void) | undefined;
        const windowPromise = new Promise<Parameters<NonNullable<typeof resolveWindow>>[0]>(resolve => {
            resolveWindow = resolve;
        });
        resolveDocumentTextCatalogWindowMock.mockReturnValueOnce(windowPromise);

        const preparing = prepareDocumentTextCatalogTextPages(
            requireDocumentRef('/tmp/work.pdf'),
            TEST_DOCUMENT_REVISION,
            100_001,
            controller.signal,
        );
        await vi.waitFor(() => expect(resolveDocumentTextCatalogWindowMock).toHaveBeenCalledTimes(1));

        const requestId = resolveDocumentTextCatalogWindowMock.mock.calls[0]?.[5];
        expect(typeof requestId).toBe('string');
        expect(resolveDocumentTextCatalogWindowMock).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            TEST_DOCUMENT_REVISION,
            1,
            64,
            100_001,
            requestId,
        );

        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));
        await expect(preparing).rejects.toMatchObject({name: 'AbortError'});
        expect(cancelOcrMock).toHaveBeenCalledTimes(1);
        expect(cancelOcrMock).toHaveBeenCalledWith(requestId);

        resolveWindow?.({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 100_001,
            firstPage: 1,
            lastPage: 64,
            pages: [{
                pageNumber: 1,
                text: 'Page 1',
                source: 'evb-ocr',
                contentDigest: 'digest-1',
            }],
            contentDigest: 'window-1',
        });
        await windowPromise;
    });

    it('cancels the main scalar catalog request by request id', async () => {
        const controller = new AbortController();
        let resolveSnapshot: ((snapshot: {
            documentRevision: string;
            pageCount: number;
            pages: [];
            contentDigest: string;
        }) => void) | undefined;
        const snapshotPromise = new Promise<Parameters<NonNullable<typeof resolveSnapshot>>[0]>(resolve => {
            resolveSnapshot = resolve;
        });
        resolveDocumentTextCatalogMock.mockReturnValueOnce(snapshotPromise);

        const loading = loadOcrText(requireDocumentRef('/tmp/work.pdf'), TEST_DOCUMENT_REVISION, controller.signal);
        await vi.waitFor(() => expect(resolveDocumentTextCatalogMock).toHaveBeenCalledTimes(1));
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        await expect(loading).rejects.toMatchObject({name: 'AbortError'});
        expect(cancelOcrMock).toHaveBeenCalledWith(expect.any(String));
        expect(resolveDocumentTextCatalogMock).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            TEST_DOCUMENT_REVISION,
            undefined,
            expect.any(String),
        );
        resolveSnapshot?.({
            documentRevision: TEST_DOCUMENT_REVISION,
            pageCount: 0,
            pages: [],
            contentDigest: '',
        });
        await snapshotPromise;
    });
});
