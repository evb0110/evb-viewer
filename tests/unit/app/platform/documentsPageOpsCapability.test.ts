import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    PDFDocument,
    degrees,
} from 'pdf-lib';
import {
    BROWSER_PAGE_OP_SELECTION_MATERIALIZATION_MAX_PAGES,
    BROWSER_PAGE_OP_MOVE_MAX_PAGES,
    createBrowserPageOpsCapability,
} from '@app/platform/browser-api/createBrowserPageOpsCapability';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';

const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const browserDocumentStoreMock = vi.hoisted(() => ({
    read: vi.fn(),
    stat: vi.fn(),
    assertDocumentRevisionCurrent: vi.fn(async () => {}),
    write: vi.fn(async () => {}),
    createStoredDocument: vi.fn(),
    replaceWithHandleBackedDocument: vi.fn(async () => {}),
    touchRecentFile: vi.fn(async () => {}),
}));
const BrowserPageOpsWorkerUnavailableError = vi.hoisted(() => class extends Error {});
const browserPageOpsWorkerMock = vi.hoisted(() => ({
    canUse: vi.fn(() => false),
    run: vi.fn(),
}));
let pageOpsWasmBytes: Uint8Array;

vi.mock('@app/platform/browser-api/browserYield', () => ({yieldToBrowser: yieldToBrowserMock}));
vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({
    BrowserPageOpsWorkerUnavailableError,
    canUseBrowserPageOpsWorker: () => browserPageOpsWorkerMock.canUse(),
    runBrowserPageOpsWorkerRequest: (...args: unknown[]) => browserPageOpsWorkerMock.run(...args),
}));
vi.mock('@app/platform/browserDocumentStore', () => ({
    BROWSER_DOCUMENT_CHUNK_SIZE: 4 * 1024 * 1024,
    getBrowserDocumentFileName: (ref: string) => ref.split('/').at(-1) ?? 'document.pdf',
    browserDocumentStore: browserDocumentStoreMock,
}));

type TPageOpsOptions = Parameters<typeof createBrowserPageOpsCapability>[0];

function createPageOps(overrides: Partial<TPageOpsOptions> = {}) {
    return createBrowserPageOpsCapability({
        clearSearchCaches: vi.fn(),
        openInputAccept: 'application/pdf',
        pickFiles: vi.fn(),
        buildOpenPdfPickerTypes: vi.fn(),
        createCombinedPdfFromPaths: vi.fn(),
        pickSaveTarget: vi.fn(),
        saveBytesToPickerOrDownload: vi.fn(),
        writeBytesToHandle: vi.fn(),
        ...overrides,
    });
}

describe('createBrowserPageOpsCapability', () => {
    beforeAll(async () => {
        pageOpsWasmBytes = new Uint8Array(await readFile(
            join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'),
        ));
    });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            headers: {get: () => null},
            arrayBuffer: async () => pageOpsWasmBytes.slice().buffer,
        })));
        browserDocumentStoreMock.read.mockReset();
        browserDocumentStoreMock.stat.mockReset();
        browserDocumentStoreMock.assertDocumentRevisionCurrent.mockReset();
        browserDocumentStoreMock.assertDocumentRevisionCurrent.mockResolvedValue(undefined);
        browserDocumentStoreMock.write.mockReset();
        browserDocumentStoreMock.write.mockResolvedValue(undefined);
        browserDocumentStoreMock.createStoredDocument.mockReset();
        browserDocumentStoreMock.replaceWithHandleBackedDocument.mockReset();
        browserDocumentStoreMock.replaceWithHandleBackedDocument.mockResolvedValue(undefined);
        browserDocumentStoreMock.touchRecentFile.mockReset();
        browserDocumentStoreMock.touchRecentFile.mockResolvedValue(undefined);
        browserPageOpsWorkerMock.canUse.mockReset();
        browserPageOpsWorkerMock.canUse.mockReturnValue(false);
        browserPageOpsWorkerMock.run.mockReset();
    });

    it('yields before applying direct multi-page mutations', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage();
        pdfDocument.addPage();
        pdfDocument.addPage();
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const clearSearchCaches = vi.fn();
        const pageOps = createPageOps({clearSearchCaches});

        const result = await pageOps.rotate('browser://documents/work.pdf', [
            1,
            2,
            3,
        ], 3, 90);

        expect(result.success).toBe(true);
        expect(browserDocumentStoreMock.write).toHaveBeenCalledTimes(1);
        expect(clearSearchCaches).toHaveBeenCalledTimes(1);
        expect(yieldToBrowserMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('accepts a browser page-ops PDF at the exact full-read budget', async () => {
        const input = new Uint8Array([1]);
        browserDocumentStoreMock.stat.mockResolvedValue({ size: BROWSER_MAX_FULL_READ_BYTES });
        browserDocumentStoreMock.read.mockResolvedValue(input);
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run.mockResolvedValue({
            data: new Uint8Array([2]),
            pageCount: 1,
        });

        const pageOps = createPageOps({});
        await expect(pageOps.delete('browser://documents/work.pdf', [1], 1)).resolves.toEqual({
            success: true,
            pageCount: 1,
        });

        expect(browserPageOpsWorkerMock.run).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.write).toHaveBeenCalledWith('browser://documents/work.pdf', new Uint8Array([2]));
    });

    it('rejects browser page-ops jobs above the full-read budget before reading the PDF', async () => {
        browserDocumentStoreMock.stat.mockResolvedValue({ size: BROWSER_MAX_FULL_READ_BYTES + 1 });

        const pageOps = createPageOps({});

        await expect(pageOps.delete('browser://documents/work.pdf', [1], 1)).rejects.toThrow(
            'Deleting pages is unavailable in the browser for PDFs larger than 16MB',
        );
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('refuses native page-operation sources instead of using the browser fallback', async () => {
        const pageOps = createPageOps({});

        await expect(pageOps.delete('/tmp/native.pdf', [1], 1)).rejects.toMatchObject({
            name: 'PdfPageOpsCapabilityError',
            code: 'native-unavailable',
            operation: 'Deleting pages',
        });
        expect(browserDocumentStoreMock.stat).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
    });

    it('rejects duplicate page selections instead of silently normalizing them', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage();
        pdfDocument.addPage();
        pdfDocument.addPage();
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const pageOps = createPageOps({});

        await expect(pageOps.delete('browser://documents/work.pdf', [
            2,
            2,
        ], 3)).rejects.toThrow('deletePages: duplicate page number 2');
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('rejects out-of-range page mutations instead of silently dropping them', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage();
        pdfDocument.addPage();
        pdfDocument.addPage();
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const pageOps = createPageOps({});

        await expect(pageOps.rotate('browser://documents/work.pdf', [4], 3, 90)).rejects.toThrow(
            'rotatePages: page number 4 is out of range 1-3',
        );
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('applies the browser materialization cap to dense page selections', async () => {
        const pageOps = createPageOps({});
        const pages = Array.from({length: 10_001}, (_, index) => index + 1);

        await expect(pageOps.rotate(
            'browser://documents/work.pdf',
            pages,
            10_001,
            90,
        )).rejects.toMatchObject({code: 'too-large'});
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
    });

    it('rejects non-permutation reorder payloads instead of partially reordering pages', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage();
        pdfDocument.addPage();
        pdfDocument.addPage();
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const pageOps = createPageOps({});

        await expect(pageOps.reorder('browser://documents/work.pdf', [
            3,
            1,
        ])).rejects.toThrow('reorderPages: missing page 2 in reorder payload');
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('keeps the browser move fallback explicitly bounded while desktop handles large ranges natively', async () => {
        const pageOps = createPageOps({});

        await expect(pageOps.move(
            'browser://documents/work.pdf',
            900_000,
            900_000,
            0,
            BROWSER_PAGE_OP_MOVE_MAX_PAGES + 1,
        )).rejects.toThrow(
            `Moving pages in the browser is limited to ${BROWSER_PAGE_OP_MOVE_MAX_PAGES} pages`,
        );
        expect(browserDocumentStoreMock.stat).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('keeps browser delete-range materialization explicitly bounded', async () => {
        const pageOps = createPageOps({});

        await expect(pageOps.deleteRanges(
            'browser://documents/work.pdf',
            [{
                startPage: 2,
                endPage: BROWSER_PAGE_OP_SELECTION_MATERIALIZATION_MAX_PAGES + 2,
            }],
            BROWSER_PAGE_OP_SELECTION_MATERIALIZATION_MAX_PAGES + 2,
        )).rejects.toThrow(
            `Deleting page ranges in the browser is limited to ${BROWSER_PAGE_OP_SELECTION_MATERIALIZATION_MAX_PAGES} pages`,
        );
        expect(browserDocumentStoreMock.stat).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('uses the worker for crop mutations within the full-read budget', async () => {
        const pdfBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        const workerResult = {
            data: new Uint8Array([
                4,
                5,
                6,
            ]),
            pageCount: 1,
        };
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run.mockResolvedValue(workerResult);

        const clearSearchCaches = vi.fn();
        const pageOps = createPageOps({clearSearchCaches});

        const result = await pageOps.crop('browser://documents/work.pdf', [1], 1, {
            top: 12,
            bottom: 8,
            left: 6,
            right: 4,
        });

        expect(result.success).toBe(true);
        expect(browserDocumentStoreMock.read).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.write).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.write).toHaveBeenCalledWith('browser://documents/work.pdf', workerResult.data);
        expect(browserPageOpsWorkerMock.run).toHaveBeenCalledWith('crop', {
            data: pdfBytes,
            pages: [1],
            margins: {
                top: 12,
                bottom: 8,
                left: 6,
                right: 4,
            },
        });
        expect(clearSearchCaches).toHaveBeenCalledTimes(1);
    });

    it('awaits browser search-cache clearing after a stored page mutation', async () => {
        const pdfBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        browserDocumentStoreMock.stat.mockResolvedValue({size: pdfBytes.byteLength});
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run.mockResolvedValue({
            data: new Uint8Array([4]),
            pageCount: 1,
        });
        const clearGate = Promise.withResolvers<undefined>();
        const pageOps = createPageOps({clearSearchCaches: vi.fn(() => clearGate.promise)});
        let settled = false;
        const operation = pageOps.rotate('browser://documents/work.pdf', [1], 1, 90)
            .finally(() => {
                settled = true;
            });

        await vi.waitFor(() => {
            expect(browserDocumentStoreMock.write).toHaveBeenCalledOnce();
        });
        expect(settled).toBe(false);
        clearGate.resolve(undefined);
        await expect(operation).resolves.toMatchObject({success: true});
    });

    it.each([
        [
            'negative',
            {
                top: -1,
                bottom: 0,
                left: 0,
                right: 0,
            },
        ],
        [
            'non-finite',
            {
                top: Number.POSITIVE_INFINITY,
                bottom: 0,
                left: 0,
                right: 0,
            },
        ],
        [
            'structurally invalid',
            {
                top: 0,
                bottom: 0,
                left: 0,
            },
        ],
    ])('rejects %s crop margins before browser mutation', async (_label, margins) => {
        const pageOps = createPageOps({});

        await expect(pageOps.crop('browser://documents/work.pdf', [1], 1, margins as never))
            .rejects.toThrow('Invalid crop margins');
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('rejects browser crop margins that consume a selected page', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage([
            200,
            100,
        ]);
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({size: pdfBytes.byteLength});
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        const pageOps = createPageOps({});

        await expect(pageOps.crop('browser://documents/work.pdf', [1], 1, {
            top: 0,
            bottom: 0,
            left: 120,
            right: 80,
        })).rejects.toThrow('Crop margins consume page 1');
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('uses the worker for delete and reorder mutations when available', async () => {
        const pdfBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run
            .mockResolvedValueOnce({
                data: new Uint8Array([4]),
                pageCount: 2,
            })
            .mockResolvedValueOnce({
                data: new Uint8Array([5]),
                pageCount: 2,
            });

        const clearSearchCaches = vi.fn();
        const pageOps = createPageOps({clearSearchCaches});

        await expect(pageOps.delete('browser://documents/work.pdf', [2], 3)).resolves.toEqual({
            success: true,
            pageCount: 2,
        });
        await expect(pageOps.reorder('browser://documents/work.pdf', [
            2,
            1,
        ])).resolves.toEqual({
            success: true,
            pageCount: 2,
        });

        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(1, 'deletePages', {
            data: pdfBytes,
            pages: [2],
        });
        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(2, 'reorderPages', {
            data: pdfBytes,
            newOrder: [
                2,
                1,
            ],
        });
        expect(browserDocumentStoreMock.write).toHaveBeenCalledTimes(2);
        expect(clearSearchCaches).toHaveBeenCalledTimes(2);
    });

    it('serializes same working-copy mutations so later reads see earlier writes', async () => {
        let storedBytes = new Uint8Array([1]);
        let releaseFirstWorker: () => void = () => {};
        const firstWorkerGate = new Promise<void>((resolve) => {
            releaseFirstWorker = resolve;
        });
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 1 });
        browserDocumentStoreMock.read.mockImplementation(async () => storedBytes);
        browserDocumentStoreMock.write.mockImplementation(async (...args: unknown[]) => {
            const data = args[1] as Uint8Array<ArrayBuffer>;
            storedBytes = data;
        });
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run
            .mockImplementationOnce(async () => {
                await firstWorkerGate;
                return {
                    data: new Uint8Array([2]),
                    pageCount: 1,
                };
            })
            .mockResolvedValueOnce({
                data: new Uint8Array([3]),
                pageCount: 1,
            });

        const pageOps = createPageOps({});

        const rotatePromise = pageOps.rotate('browser://documents/work.pdf', [1], 1, 90);
        const deletePromise = pageOps.delete('browser://documents/work.pdf', [1], 1);
        await vi.waitFor(() => {
            expect(browserPageOpsWorkerMock.run).toHaveBeenCalledTimes(1);
        });
        releaseFirstWorker();
        await Promise.all([
            rotatePromise,
            deletePromise,
        ]);

        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(1, 'rotate', expect.objectContaining({data: new Uint8Array([1])}));
        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(2, 'deletePages', expect.objectContaining({data: new Uint8Array([2])}));
        expect(storedBytes).toEqual(new Uint8Array([3]));
    });

    it('rejects geometry inspection above the browser full-read budget', async () => {
        const pdfBytes = new Uint8Array([
            7,
            8,
            9,
        ]);
        const geometry = {
            mediaBox: {
                x: 0,
                y: 0,
                width: 300,
                height: 500,
            },
            cropBox: null,
            rotation: 90,
        };
        browserDocumentStoreMock.stat.mockResolvedValue({ size: 120 * 1024 * 1024 });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run.mockResolvedValue(geometry);

        const pageOps = createPageOps({});

        await expect(pageOps.getPageGeometry('browser://documents/work.pdf', 1)).rejects.toThrow(
            'Inspecting page geometry is unavailable in the browser for PDFs larger than 16MB',
        );
        expect(browserPageOpsWorkerMock.run).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
    });

    it('returns crop boxes and rotation when inspecting page geometry directly', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([
            300,
            500,
        ]);
        page.setCropBox(20, 30, 260, 420);
        page.setRotation(degrees(90));
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const pageOps = createPageOps({});

        await expect(pageOps.getPageGeometry('browser://documents/work.pdf', 1)).resolves.toEqual({
            mediaBox: {
                x: 0,
                y: 0,
                width: 300,
                height: 500,
            },
            cropBox: {
                x: 20,
                y: 30,
                width: 260,
                height: 420,
            },
            rotation: 90,
        });
        expect(browserDocumentStoreMock.read).toHaveBeenCalledTimes(1);
    });

    it('returns PDF.js effective crop boxes when direct geometry inspection sees CropBox outside MediaBox', async () => {
        const pdfDocument = await PDFDocument.create();
        const page = pdfDocument.addPage([
            300,
            500,
        ]);
        page.setCropBox(-20, 30, 260, 520);
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);

        const pageOps = createPageOps({});

        await expect(pageOps.getPageGeometry('browser://documents/work.pdf', 1)).resolves.toEqual({
            mediaBox: {
                x: 0,
                y: 0,
                width: 300,
                height: 500,
            },
            cropBox: {
                x: 0,
                y: 30,
                width: 240,
                height: 470,
            },
            rotation: 0,
        });
        expect(browserDocumentStoreMock.read).toHaveBeenCalledTimes(1);
    });

    it('locks in the browser save target before extracting pages and writes to that handle', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage();
        pdfDocument.addPage();
        pdfDocument.addPage();
        const pdfBytes = new Uint8Array(await pdfDocument.save());
        browserDocumentStoreMock.stat.mockResolvedValue({ size: pdfBytes.byteLength });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/extract/work-extract.pdf',
        );

        const pickSaveTarget = vi.fn(async () => ({
            canceled: false,
            fileName: 'work-extract.pdf',
            handle: { name: 'work-extract.pdf' } as FileSystemFileHandle,
        }));
        const saveBytesToPickerOrDownload = vi.fn();
        const writeBytesToHandle = vi.fn(
            async (_handle: FileSystemFileHandle, _data: Uint8Array) => {},
        );

        const pageOps = createPageOps({
            pickSaveTarget,
            saveBytesToPickerOrDownload,
            writeBytesToHandle,
        });

        const result = await pageOps.extract('browser://documents/work.pdf', [
            2,
            3,
        ]);

        expect(result).toEqual({
            success: true,
            destPath: 'browser://documents/extract/work-extract.pdf',
        });
        expect(pickSaveTarget).toHaveBeenCalledWith({
            suggestedName: 'work-extract.pdf',
            pickerTypes: expect.any(Array),
        });
        expect(pickSaveTarget.mock.invocationCallOrder[0]).toBeLessThan(
            browserDocumentStoreMock.read.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(writeBytesToHandle).toHaveBeenCalledTimes(1);
        expect(saveBytesToPickerOrDownload).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledWith(
            'work-extract.pdf',
            expect.any(Uint8Array),
            expect.objectContaining({
                mimeType: 'application/pdf',
                saveKind: 'pdf',
                kind: 'source',
                saveHandle: expect.objectContaining({ name: 'work-extract.pdf' }),
                storageMode: 'handle',
            }),
        );
        expect(browserDocumentStoreMock.replaceWithHandleBackedDocument).toHaveBeenCalledWith(
            'browser://documents/extract/work-extract.pdf',
            expect.objectContaining({
                fileSize: expect.any(Number),
                saveHandle: expect.objectContaining({ name: 'work-extract.pdf' }),
                saveName: 'work-extract.pdf',
            }),
        );
        expect(browserDocumentStoreMock.touchRecentFile).toHaveBeenCalledWith(
            'browser://documents/extract/work-extract.pdf',
        );

        const writeCall = writeBytesToHandle.mock.calls[0];
        expect(writeCall).toBeDefined();
        if (!writeCall) {
            throw new Error('Expected extract to write bytes to the reserved save handle');
        }
        const writtenBytes = writeCall[1];
        expect(writtenBytes).toBeInstanceOf(Uint8Array);
        const extractedPdf = await PDFDocument.load(writtenBytes);
        expect(extractedPdf.getPageCount()).toBe(2);
    });

    it('uses the worker for extract and insert when available', async () => {
        const pdfBytes = new Uint8Array([
            9,
            8,
            7,
        ]);
        const insertionBytes = new Uint8Array([
            6,
            5,
            4,
        ]);
        browserDocumentStoreMock.stat.mockImplementation(async (path: string) => {
            if (path === 'browser://documents/work.pdf') {
                return { size: pdfBytes.byteLength };
            }

            return { size: insertionBytes.byteLength };
        });
        browserDocumentStoreMock.read.mockResolvedValue(pdfBytes);
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/extract/work-extract.pdf',
        );
        browserPageOpsWorkerMock.canUse.mockReturnValue(true);
        browserPageOpsWorkerMock.run
            .mockResolvedValueOnce({
                data: insertionBytes,
                pageCount: 1,
            })
            .mockResolvedValueOnce({
                data: new Uint8Array([
                    3,
                    2,
                    1,
                ]),
                pageCount: 2,
            });

        const pickSaveTarget = vi.fn(async () => ({
            canceled: false,
            fileName: 'work-extract.pdf',
            handle: null,
        }));
        const saveBytesToPickerOrDownload = vi.fn(async () => ({
            canceled: false,
            fileName: 'work-extract.pdf',
            handle: null,
        }));
        const createCombinedPdfFromPaths = vi.fn(async () => insertionBytes);

        const pageOps = createPageOps({
            createCombinedPdfFromPaths,
            pickSaveTarget,
            saveBytesToPickerOrDownload,
        });

        await pageOps.extract('browser://documents/work.pdf', [1]);
        await pageOps.insertFile('browser://documents/work.pdf', 1, 1, ['browser://documents/picked/image.png']);

        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(1, 'extractPages', {
            data: pdfBytes,
            pages: [1],
        });
        expect(browserPageOpsWorkerMock.run).toHaveBeenNthCalledWith(2, 'insertPages', {
            data: pdfBytes,
            insertionData: insertionBytes,
            afterPage: 1,
        });
        expect(createCombinedPdfFromPaths).toHaveBeenCalledWith(
            ['browser://documents/picked/image.png'],
            expect.objectContaining({
                operation: 'page-insert',
                requestId: expect.stringMatching(/^browser-page-op-insert-/u),
            }),
        );
        expect(saveBytesToPickerOrDownload).toHaveBeenCalledTimes(1);
    });

    it('rejects large browser insert jobs when the worker path is unavailable', async () => {
        const destinationPdf = await PDFDocument.create();
        destinationPdf.addPage([
            300,
            500,
        ]);
        const destinationBytes = new Uint8Array(await destinationPdf.save());

        const insertionPdf = await PDFDocument.create();
        insertionPdf.addPage([
            200,
            200,
        ]);
        const insertionBytes = new Uint8Array(await insertionPdf.save());

        browserDocumentStoreMock.stat.mockImplementation(async (path: string) => {
            if (path === 'browser://documents/work.pdf') {
                return { size: BROWSER_MAX_FULL_READ_BYTES + 1 };
            }

            return { size: insertionBytes.byteLength };
        });
        browserDocumentStoreMock.read.mockResolvedValue(destinationBytes);

        const createCombinedPdfFromPaths = vi.fn(async () => insertionBytes);
        const pageOps = createPageOps({createCombinedPdfFromPaths});

        await expect(pageOps.insertFile(
            'browser://documents/work.pdf',
            1,
            1,
            ['browser://documents/picked/image.png'],
        )).rejects.toThrow(
            'Inserting pages is unavailable in the browser for PDFs larger than 16MB',
        );
        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(createCombinedPdfFromPaths).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('rejects browser insert destinations above the full-read budget before planning the working set', async () => {
        browserDocumentStoreMock.stat.mockImplementation(async (path: string) => {
            if (path === 'browser://documents/work.pdf') {
                return { size: BROWSER_MAX_FULL_READ_BYTES + 1 };
            }

            return { size: 1 };
        });

        const createCombinedPdfFromPaths = vi.fn(async () => new Uint8Array([1]));
        const pageOps = createPageOps({createCombinedPdfFromPaths});

        await expect(pageOps.insertFile(
            'browser://documents/work.pdf',
            1,
            1,
            ['browser://documents/picked/insert.pdf'],
        )).rejects.toThrow(
            'Inserting pages is unavailable in the browser for PDFs larger than 16MB',
        );

        expect(browserDocumentStoreMock.read).not.toHaveBeenCalled();
        expect(createCombinedPdfFromPaths).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.write).not.toHaveBeenCalled();
    });

    it('bypasses browser combine when inserting a single PDF source', async () => {
        const destinationPdf = await PDFDocument.create();
        destinationPdf.addPage([
            300,
            500,
        ]);
        const destinationBytes = new Uint8Array(await destinationPdf.save());

        const insertionPdf = await PDFDocument.create();
        insertionPdf.addPage([
            200,
            200,
        ]);
        const insertionBytes = new Uint8Array(await insertionPdf.save());

        browserDocumentStoreMock.stat.mockImplementation(async (path: string) => {
            if (path === 'browser://documents/work.pdf') {
                return { size: destinationBytes.byteLength };
            }

            return { size: insertionBytes.byteLength };
        });
        browserDocumentStoreMock.read.mockImplementation(async (path: string) => (
            path === 'browser://documents/work.pdf' ? destinationBytes : insertionBytes
        ));

        const createCombinedPdfFromPaths = vi.fn(async () => new Uint8Array([9]));
        const pageOps = createPageOps({createCombinedPdfFromPaths});

        const result = await pageOps.insertFile(
            'browser://documents/work.pdf',
            1,
            1,
            ['browser://documents/picked/insert.pdf'],
        );

        expect(result.success).toBe(true);
        expect(createCombinedPdfFromPaths).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.read).toHaveBeenNthCalledWith(1, 'browser://documents/work.pdf');
        expect(browserDocumentStoreMock.read).toHaveBeenNthCalledWith(2, 'browser://documents/picked/insert.pdf');
        expect(browserDocumentStoreMock.write).toHaveBeenCalledTimes(1);
    });
});
