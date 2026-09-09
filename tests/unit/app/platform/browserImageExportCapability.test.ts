import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as UTIFModule from 'utif';
import type * as EsToolkitMathModule from 'es-toolkit/math';
import {requireDocumentRef} from '@contracts/documentRef';
import {
    requirePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';

type TUtifModule = typeof UTIFModule;

const browserDocumentStoreMock = vi.hoisted(() => ({
    cleanupDetachedDocument: vi.fn(async () => true),
    createStoredDocument: vi.fn(),
    replaceWithHandleBackedDocument: vi.fn(),
    touchRecentFile: vi.fn(async () => {}),
}));
const saveBlobToPickerOrDownloadMock = vi.hoisted(() => vi.fn());
const saveBytesToPickerOrDownloadMock = vi.hoisted(() => vi.fn());
const pickSaveTargetMock = vi.hoisted(() => vi.fn());
const writeBytesToHandleMock = vi.hoisted(() => vi.fn(async (
    _handle: FileSystemFileHandle,
    _data: Uint8Array,
) => {}));
const getDocumentMock = vi.hoisted(() => vi.fn());
const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const createDjvuWorkerFromPathMock = vi.hoisted(() => vi.fn());
const utifLoaderState = vi.hoisted(() => ({
    encoderAccess: vi.fn(),
    encoderError: null as Error | null,
    request: vi.fn(),
}));

vi.mock('@app/platform/browserDocumentStore', () => ({
    browserDocumentStore: browserDocumentStoreMock,
    getBrowserDocumentFileName: () => 'sample.pdf',
}));

vi.mock('@app/platform/browser-api/browserYield', () => ({ yieldToBrowser: yieldToBrowserMock }));
vi.mock('@contracts/documentRef', () => ({
    isNativeLegacyDocumentRef: (value: unknown) => typeof value === 'string' && value.startsWith('/'),
    requireDocumentRef: (value: unknown) => value,
}));

vi.mock('@app/platform/browser-api/createDjvuWorkerFromPath', () => ({
    createDjvuWorkerFromPath: (...args: unknown[]) => createDjvuWorkerFromPathMock(...args),
    getDjvuWorkerPageSizes: (worker: {doc: {getPagesSizes: () => {run: () => Promise<unknown>}}}) =>
        worker.doc.getPagesSizes().run(),
}));

vi.mock('utif', async importOriginal => {
    utifLoaderState.request();
    const actual = await importOriginal<TUtifModule>();
    return {
        ...actual,
        default: new Proxy(actual.default, {get(target, property, receiver) {
            if (property === 'ttypes') {
                utifLoaderState.encoderAccess();
            }
            if (property === '_writeIFD' && utifLoaderState.encoderError) {
                return () => {
                    throw utifLoaderState.encoderError;
                };
            }
            return Reflect.get(target, property, receiver);
        }}),
    };
});

vi.mock('@app/platform/browser-api/browserFilePickerAdapter', () => ({
    pickSaveTarget: (...args: unknown[]) => pickSaveTargetMock(...args),
    saveBlobToPickerOrDownload: (...args: unknown[]) => saveBlobToPickerOrDownloadMock(...args),
    saveBytesToPickerOrDownload: (...args: unknown[]) => saveBytesToPickerOrDownloadMock(...args),
    writeBytesToHandle: (handle: FileSystemFileHandle, data: Uint8Array) => writeBytesToHandleMock(handle, data),
}));

vi.mock('@app/platform/browser-api/browserImageExportConfig', () => ({ EXPORT_RENDER_SCALE: 1 }));

vi.mock('@app/platform/browser-api/browserPdfjsDocumentInit', () => ({
    createPdfjsDocumentInitFromBrowserDocument: vi.fn(async () => {
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);
        return {data};
    }),
    getPdfjsLib: vi.fn(async () => ({getDocument: getDocumentMock})),
}));

vi.mock('@app/platform/browser-api/browserFileName', () => ({ ensurePdfExtension: (fileName: string) => fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf` }));

vi.mock('@app/platform/browser-api/browserBytes', () => ({ toUint8Array: (value: Uint8Array | ArrayBuffer) => value instanceof Uint8Array ? value : new Uint8Array(value) }));

const rangeSpy = vi.hoisted(() => vi.fn());

vi.mock('es-toolkit/math', async importOriginal => {
    const actual = await importOriginal<typeof EsToolkitMathModule>();
    return {
        ...actual,
        range: (...args: Parameters<typeof actual.range>) => {
            const result = actual.range(...args);
            rangeSpy(...args);
            return result;
        },
    };
});

const UTIF = await vi.importActual<TUtifModule>('utif');

function createFileSystemWritableFileStream(
    write: FileSystemWritableFileStream['write'] = async (_chunk: FileSystemWriteChunkType) => {},
): FileSystemWritableFileStream {
    const writable = Object.assign(new WritableStream(), {
        abort: vi.fn(async (_reason?: unknown) => {}),
        close: vi.fn(async () => {}),
        seek: vi.fn(async (_position: number) => {}),
        truncate: vi.fn(async (_size: number) => {}),
        write,
    });
    return writable satisfies FileSystemWritableFileStream;
}

function requireUint8ArrayChunk(chunk: FileSystemWriteChunkType): Uint8Array {
    if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('Expected TIFF writer to receive a Uint8Array');
    }
    return chunk;
}

function createFileSystemFileHandle(
    name: string,
    writable: FileSystemWritableFileStream,
): FileSystemFileHandle {
    const handle = {
        kind: 'file',
        name,
        isSameEntry: vi.fn(async (_other: FileSystemHandle) => false),
        getFile: vi.fn(async () => new File([], name)),
        createWritable: vi.fn(async () => writable),
        createSyncAccessHandle: async () => {
            throw new Error('Synchronous access is not part of this file handle fixture');
        },
    } satisfies FileSystemFileHandle;
    return handle;
}

function countTiffDirectories(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = view.getUint32(4, false);
    let count = 0;

    while (offset !== 0) {
        expect(offset + 2).toBeLessThanOrEqual(bytes.byteLength);
        const entryCount = view.getUint16(offset, false);
        const nextPointerOffset = offset + 2 + (entryCount * 12);
        expect(nextPointerOffset + 4).toBeLessThanOrEqual(bytes.byteLength);
        offset = view.getUint32(nextPointerOffset, false);
        count += 1;
        expect(count).toBeLessThan(256);
    }

    return count;
}

function createCanvas() {
    const canvas = {
        width: 0,
        height: 0,
        currentPageNumber: 0,
        getContext: vi.fn(() => ({
            drawImage: vi.fn(),
            getImageData: vi.fn(() => {
                const data = new Uint8ClampedArray([
                    Math.max(0, canvas.currentPageNumber - 1),
                    0,
                    0,
                    255,
                ]);
                return {data};
            }),
        })),
        toBlob: vi.fn((
            callback: (blob: Blob | null) => void,
            type = 'image/png',
        ) => {
            callback(new Blob([new Uint8Array([canvas.currentPageNumber])], {type}));
        }),
    };

    return canvas;
}

/** One page above the published image-export output budget (100,000). */
const OVERSIZED_PAGE_COUNT = 100_001;

function createFakePdfDocument(pageCount: number) {
    return {
        numPages: pageCount,
        destroy: vi.fn(async () => {}),
        getPage: vi.fn(async (pageNumber: number) => ({
            getViewport: vi.fn(() => ({
                width: 1,
                height: 1,
            })),
            render: vi.fn(({ canvas }: { canvas: ReturnType<typeof createCanvas> }) => {
                canvas.currentPageNumber = pageNumber;
                return { promise: Promise.resolve() };
            }),
            cleanup: vi.fn(async () => {}),
        })),
    };
}

describe('createBrowserImageExportCapability', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        utifLoaderState.encoderError = null;
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/output/sample.tiff',
        );
        browserDocumentStoreMock.replaceWithHandleBackedDocument.mockResolvedValue(undefined);
        saveBlobToPickerOrDownloadMock.mockResolvedValue({
            canceled: false,
            fileName: 'page-1.png',
            handle: null,
        });
        saveBytesToPickerOrDownloadMock.mockResolvedValue({
            canceled: false,
            fileName: 'sample.tiff',
            handle: null,
        });
        pickSaveTargetMock.mockImplementation(async (options: {suggestedName: string}) => ({
            canceled: false,
            fileName: options.suggestedName,
            handle: null,
        }));
        const mockDocument = { createElement: (tagName: string) => {
            if (tagName !== 'canvas') {
                throw new Error(`Unexpected element request: ${tagName}`);
            }
            return createCanvas();
        }};
        vi.stubGlobal('document', mockDocument);
    });

    it('does not load UTIF for JPEG or PNG exports', async () => {
        getDocumentMock
            .mockReturnValueOnce({promise: Promise.resolve(createFakePdfDocument(1))})
            .mockReturnValueOnce({promise: Promise.resolve(createFakePdfDocument(1))});
        pickSaveTargetMock
            .mockResolvedValueOnce({
                canceled: false,
                fileName: 'page-001.jpg',
                handle: null,
            })
            .mockResolvedValueOnce({
                canceled: false,
                fileName: 'page-001.png',
                handle: null,
            });
        saveBytesToPickerOrDownloadMock
            .mockResolvedValueOnce({
                canceled: false,
                fileName: 'page-001.jpg',
                handle: null,
            })
            .mockResolvedValueOnce({
                canceled: false,
                fileName: 'page-001.png',
                handle: null,
            });

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        await capability.exportPdfToImages(requireDocumentRef('browser://documents/work/sample.pdf'), [requirePageNumber(1)]);
        await capability.exportPdfToImages(requireDocumentRef('browser://documents/work/sample.pdf'), [requirePageNumber(1)]);

        expect(utifLoaderState.encoderAccess).not.toHaveBeenCalled();
        expect(utifLoaderState.request).not.toHaveBeenCalled();
    });

    it('reserves the first PDF image destination before loading or rendering the PDF', async () => {
        const events: string[] = [];
        let expensiveWorkStarted = false;
        const fakePdfDocument = createFakePdfDocument(1);
        fakePdfDocument.getPage.mockImplementation(async (pageNumber: number) => {
            events.push('render');
            return {
                getViewport: vi.fn(() => ({
                    width: 1,
                    height: 1,
                })),
                render: vi.fn(({canvas}: {canvas: ReturnType<typeof createCanvas>}) => {
                    canvas.currentPageNumber = pageNumber;
                    return {promise: Promise.resolve()};
                }),
                cleanup: vi.fn(async () => {}),
            };
        });
        getDocumentMock.mockImplementation(() => {
            expensiveWorkStarted = true;
            events.push('load');
            return {promise: Promise.resolve(fakePdfDocument)};
        });
        pickSaveTargetMock.mockImplementation(async (options: {suggestedName: string}) => {
            if (expensiveWorkStarted) {
                throw new DOMException('Picker was invoked after PDF loading started', 'SecurityError');
            }
            events.push('picker');
            return {
                canceled: false,
                fileName: options.suggestedName,
                handle: null,
            };
        });

        const {createBrowserImageExportCapability} = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await createBrowserImageExportCapability().exportPdfToImages(
            requireDocumentRef('browser://documents/work/sample.pdf'),
            [requirePageNumber(1)],
        );

        expect(events).toEqual([
            'picker',
            'load',
            'render',
        ]);
    });

    it('shares one UTIF module request across concurrent TIFF exports', async () => {
        getDocumentMock
            .mockReturnValueOnce({promise: Promise.resolve(createFakePdfDocument(1))})
            .mockReturnValueOnce({promise: Promise.resolve(createFakePdfDocument(1))});

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        await Promise.all([
            capability.exportPdfToMultiPageTiff(requireDocumentRef('browser://documents/work/first.pdf')),
            capability.exportPdfToMultiPageTiff(requireDocumentRef('browser://documents/work/second.pdf')),
        ]);

        expect(utifLoaderState.request).toHaveBeenCalledOnce();
        expect(utifLoaderState.encoderAccess).toHaveBeenCalled();
    });

    it('reserves the PDF TIFF destination before loading or collecting descriptors', async () => {
        const events: string[] = [];
        let expensiveWorkStarted = false;
        const fakePdfDocument = createFakePdfDocument(1);
        fakePdfDocument.getPage.mockImplementation(async (pageNumber: number) => {
            events.push('descriptor');
            return {
                getViewport: vi.fn(() => ({
                    width: 1,
                    height: 1,
                })),
                render: vi.fn(({canvas}: {canvas: ReturnType<typeof createCanvas>}) => {
                    canvas.currentPageNumber = pageNumber;
                    return {promise: Promise.resolve()};
                }),
                cleanup: vi.fn(async () => {}),
            };
        });
        getDocumentMock.mockImplementation(() => {
            expensiveWorkStarted = true;
            events.push('load');
            return {promise: Promise.resolve(fakePdfDocument)};
        });
        pickSaveTargetMock.mockImplementation(async (options: {suggestedName: string}) => {
            if (expensiveWorkStarted) {
                throw new DOMException('Picker was invoked after PDF loading started', 'SecurityError');
            }
            events.push('picker');
            return {
                canceled: false,
                fileName: options.suggestedName,
                handle: null,
            };
        });

        const {createBrowserImageExportCapability} = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            requireDocumentRef('browser://documents/work/sample.pdf'),
            [requirePageNumber(1)],
        );

        expect(events.slice(0, 3)).toEqual([
            'picker',
            'load',
            'descriptor',
        ]);
    });

    it('keeps the full browser multi-page TIFF directory chain intact past the legacy UTIF header limit', async () => {
        const fakePdfDocument = createFakePdfDocument(120);
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        const result = await capability.exportPdfToMultiPageTiff(
            requireDocumentRef('browser://documents/work/sample.pdf'),
        );

        expect(utifLoaderState.encoderAccess).toHaveBeenCalled();
        expect(result).toEqual({
            success: true,
            outputPath: 'browser://documents/output/sample.tiff',
            outputPaths: ['browser://documents/output/sample.tiff'],
        });
        expect(saveBytesToPickerOrDownloadMock).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledTimes(1);
        expect(browserDocumentStoreMock.touchRecentFile).toHaveBeenCalledWith(
            'browser://documents/output/sample.tiff',
        );

        const savedBytes = saveBytesToPickerOrDownloadMock.mock.calls[0]?.[0];
        expect(savedBytes).toBeInstanceOf(Uint8Array);
        if (!(savedBytes instanceof Uint8Array)) {
            throw new Error('Expected TIFF export to save raw TIFF bytes');
        }

        expect(countTiffDirectories(savedBytes)).toBe(120);

        const ifds = UTIF.decode(savedBytes);
        expect(ifds).toHaveLength(120);
        expect(ifds[0]?.t273?.[0] ?? 0).toBeGreaterThan(20_000);

        UTIF.decodeImage(savedBytes, ifds[119]!);
        const lastRgba = UTIF.toRGBA8(ifds[119]!);
        expect(Array.from(lastRgba.slice(0, 4))).toEqual([
            119,
            0,
            0,
            255,
        ]);
    });

    it('destroys the PDF.js document when multi-page TIFF descriptor collection fails', async () => {
        const fakePdfDocument = createFakePdfDocument(2);
        fakePdfDocument.getPage.mockRejectedValueOnce(new Error('page failed'));
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        await expect(capability.exportPdfToMultiPageTiff(
            requireDocumentRef('browser://documents/work/sample.pdf'),
            [requirePageNumber(1)],
        )).rejects.toThrow('page failed');

        expect(fakePdfDocument.destroy).toHaveBeenCalledTimes(1);
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
    });

    it('does not load UTIF when multi-page TIFF export is canceled before encoding', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});
        pickSaveTargetMock.mockResolvedValueOnce({
            canceled: true,
            fileName: 'sample.tiff',
            handle: null,
        });

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            requireDocumentRef('browser://documents/work/sample.pdf'),
        )).resolves.toEqual({
            success: false,
            canceled: true,
        });

        expect(utifLoaderState.request).not.toHaveBeenCalled();
        expect(utifLoaderState.encoderAccess).not.toHaveBeenCalled();
        expect(fakePdfDocument.destroy).not.toHaveBeenCalled();
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
    });

    it('destroys the PDF.js document when the TIFF encoder rejects the export', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});
        utifLoaderState.encoderError = new Error('encoder failed');

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            requireDocumentRef('browser://documents/work/sample.pdf'),
        )).rejects.toThrow('encoder failed');

        expect(utifLoaderState.encoderAccess).toHaveBeenCalled();
        expect(fakePdfDocument.destroy).toHaveBeenCalledOnce();
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.createStoredDocument).not.toHaveBeenCalled();
    });

    it('reserves a DjVu image destination before rendering the page', async () => {
        const events: string[] = [];
        let expensiveWorkStarted = false;
        createDjvuWorkerFromPathMock.mockResolvedValue({
            doc: {
                getPagesSizes: () => ({run: async () => [{
                    width: 1,
                    height: 1,
                }]}),
                getPage: () => ({createPngObjectUrl: () => ({run: async () => {
                    expensiveWorkStarted = true;
                    events.push('render');
                    return {url: 'blob:djvu-page'};
                }})}),
            },
            revokeObjectURL: vi.fn(),
            terminate: vi.fn(),
        });
        pickSaveTargetMock.mockImplementation(async (options: {suggestedName: string}) => {
            if (expensiveWorkStarted) {
                throw new DOMException('Picker was invoked after DjVu rendering started', 'SecurityError');
            }
            events.push('picker');
            return {
                canceled: false,
                fileName: options.suggestedName,
                handle: null,
            };
        });
        vi.stubGlobal('fetch', vi.fn(async () => ({
            arrayBuffer: async () => new Uint8Array([1]).buffer,
            ok: true,
        })));
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            close: vi.fn(),
            height: 1,
            width: 1,
        })));

        const {createBrowserImageExportCapability} = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await createBrowserImageExportCapability().exportPdfToImages(
            requireDocumentRef('browser://documents/work/sample.djvu'),
            [requirePageNumber(1)],
            undefined,
            'djvu',
        );

        expect(events).toEqual([
            'picker',
            'render',
        ]);
    });

    it('loads UTIF for DjVu TIFF export and terminates the worker', async () => {
        const terminate = vi.fn();
        const revokeObjectURL = vi.fn();
        createDjvuWorkerFromPathMock.mockResolvedValue({
            doc: {
                getPagesSizes: () => ({run: async () => [{
                    width: 1,
                    height: 1,
                }]}),
                getPage: () => ({createPngObjectUrl: () => ({run: async () => ({url: 'blob:djvu-page'})})}),
            },
            revokeObjectURL,
            terminate,
        });
        vi.stubGlobal('fetch', vi.fn(async () => ({
            arrayBuffer: async () => new Uint8Array([1]).buffer,
            ok: true,
        })));
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            close: vi.fn(),
            height: 1,
            width: 1,
        })));

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            requireDocumentRef('browser://documents/work/sample.djvu'),
            [requirePageNumber(1)],
            undefined,
            'djvu',
        )).resolves.toEqual({
            success: true,
            outputPath: 'browser://documents/output/sample.tiff',
            outputPaths: ['browser://documents/output/sample.tiff'],
        });

        expect(utifLoaderState.encoderAccess).toHaveBeenCalled();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:djvu-page');
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('streams all-pages DjVu TIFF decoding one page at a time through a file handle', async () => {
        const pageCount = 256;
        const pageSizes = Array.from({length: pageCount}, () => ({
            width: 1,
            height: 1,
        }));
        const terminate = vi.fn();
        const revokeObjectURL = vi.fn();
        const getPage = vi.fn((pageNumber: number) => ({createPngObjectUrl: () => ({run: async () => ({url: `blob:djvu-page-${pageNumber}`})})}));
        createDjvuWorkerFromPathMock.mockResolvedValue({
            doc: {
                getPagesSizes: () => ({run: async () => pageSizes}),
                getPage,
            },
            revokeObjectURL,
            terminate,
        });

        const writableWrites: Uint8Array[] = [];
        const writable = createFileSystemWritableFileStream(vi.fn(async (chunk: FileSystemWriteChunkType) => {
            const chunkBytes = requireUint8ArrayChunk(chunk);
            writableWrites.push(chunkBytes);
            if (chunkBytes.byteLength === 4) {
                pendingDecodedPages -= 1;
            }
        }));
        const typedHandle = createFileSystemFileHandle('sample.tiff', writable);
        pickSaveTargetMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'sample.tiff',
            handle: typedHandle,
        });

        let currentPageNumber = 0;
        let pendingDecodedPages = 0;
        let maximumPendingDecodedPages = 0;
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            currentPageNumber = Number.parseInt(url.split('-').at(-1) ?? '0', 10);
            return {
                arrayBuffer: async () => new Uint8Array([currentPageNumber]).buffer,
                ok: true,
            };
        }));
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            close: vi.fn(),
            height: 1,
            width: 1,
        })));
        vi.stubGlobal('document', {createElement: (tagName: string) => {
            if (tagName !== 'canvas') {
                throw new Error(`Unexpected element request: ${tagName}`);
            }
            const canvas = {
                width: 0,
                height: 0,
                getContext: vi.fn(() => ({
                    drawImage: vi.fn(),
                    getImageData: vi.fn(() => {
                        pendingDecodedPages += 1;
                        maximumPendingDecodedPages = Math.max(
                            maximumPendingDecodedPages,
                            pendingDecodedPages,
                        );
                        return {data: new Uint8ClampedArray([
                            currentPageNumber & 0xff,
                            currentPageNumber >> 8,
                            0,
                            255,
                        ])};
                    }),
                })),
            };
            return canvas;
        }});

        const {createBrowserImageExportCapability} = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            requireDocumentRef('browser://documents/work/sample.djvu'),
            undefined,
            undefined,
            'djvu',
        )).resolves.toMatchObject({success: true});

        expect(maximumPendingDecodedPages).toBe(1);
        expect(pendingDecodedPages).toBe(0);
        expect(writableWrites.filter(chunk => chunk.byteLength === 4).map(chunk => (
            (chunk[0] ?? 0) + ((chunk[1] ?? 0) * 0x100)
        ))).toEqual(
            Array.from({length: pageCount}, (_value, index) => index + 1),
        );
        expect(writable.close).toHaveBeenCalledOnce();
        expect(writable.abort).not.toHaveBeenCalled();
        expect(getPage).toHaveBeenCalledTimes(pageCount);
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('aborts the DjVu TIFF writable when a later page cannot be rendered', async () => {
        const terminate = vi.fn();
        const getPage = vi.fn((pageNumber: number) => {
            if (pageNumber === 2) {
                throw new Error('DjVu page render failed');
            }
            return {createPngObjectUrl: () => ({run: async () => ({url: `blob:djvu-page-${pageNumber}`})})};
        });
        createDjvuWorkerFromPathMock.mockResolvedValue({
            doc: {
                getPagesSizes: () => ({run: async () => [
                    {
                        width: 1,
                        height: 1,
                    },
                    {
                        width: 1,
                        height: 1,
                    },
                ]}),
                getPage,
            },
            revokeObjectURL: vi.fn(),
            terminate,
        });

        const writable = createFileSystemWritableFileStream();
        const typedHandle = createFileSystemFileHandle('sample.tiff', writable);
        pickSaveTargetMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'sample.tiff',
            handle: typedHandle,
        });
        vi.stubGlobal('fetch', vi.fn(async () => ({
            arrayBuffer: async () => new Uint8Array([1]).buffer,
            ok: true,
        })));
        vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
            close: vi.fn(),
            height: 1,
            width: 1,
        })));

        const {createBrowserImageExportCapability} = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            requireDocumentRef('browser://documents/work/sample.djvu'),
            undefined,
            undefined,
            'djvu',
        )).rejects.toThrow('DjVu page render failed');

        expect(writable.abort).toHaveBeenCalledOnce();
        expect(writable.close).not.toHaveBeenCalled();
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('cleans up the PDF page and resets its canvas when rendering rejects', async () => {
        const canvas = createCanvas();
        const cleanup = vi.fn(async () => {});
        const fakePdfDocument = {
            numPages: 1,
            destroy: vi.fn(async () => {}),
            getPage: vi.fn(async () => ({
                getViewport: vi.fn(() => ({
                    width: 4,
                    height: 5,
                })),
                render: vi.fn(() => ({promise: Promise.reject(new Error('render failed'))})),
                cleanup,
            })),
        };
        getDocumentMock.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});
        vi.stubGlobal('document', {createElement: vi.fn(() => canvas)});

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToImages(
            requireDocumentRef('browser://documents/work/sample.pdf'),
            [requirePageNumber(1)],
        )).rejects.toThrow('render failed');

        expect(cleanup).toHaveBeenCalledOnce();
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
        expect(fakePdfDocument.destroy).toHaveBeenCalledOnce();
    });

    it('cleans up the PDF page and resets its canvas when no 2D context is available', async () => {
        const canvas = createCanvas();
        canvas.getContext.mockReturnValueOnce(null as never);
        const cleanup = vi.fn(async () => {});
        const render = vi.fn();
        const fakePdfDocument = {
            numPages: 1,
            destroy: vi.fn(async () => {}),
            getPage: vi.fn(async () => ({
                getViewport: vi.fn(() => ({
                    width: 4,
                    height: 5,
                })),
                render,
                cleanup,
            })),
        };
        getDocumentMock.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});
        vi.stubGlobal('document', {createElement: vi.fn(() => canvas)});

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        await expect(createBrowserImageExportCapability().exportPdfToImages(
            requireDocumentRef('browser://documents/work/sample.pdf'),
            [requirePageNumber(1)],
        )).rejects.toThrow('Canvas 2D context is unavailable');

        expect(render).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
        expect(fakePdfDocument.destroy).toHaveBeenCalledOnce();
    });

    it('defaults browser image export to JPEG and stores handle-backed outputs', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });
        pickSaveTargetMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'page-001.jpg',
            handle: { name: 'page-001.jpg' } as FileSystemFileHandle,
        });
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/output/page-001.jpg',
        );

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        const result = await capability.exportPdfToImages(
            requireDocumentRef('browser://documents/work/sample.pdf'),
            [requirePageNumber(1)],
        );

        expect(result).toEqual({
            success: true,
            outputPaths: ['browser://documents/output/page-001.jpg'],
        });
        expect(pickSaveTargetMock).toHaveBeenCalledWith({
            suggestedName: 'page-001.jpg',
            pickerTypes: [
                {
                    description: 'JPEG Images',
                    accept: { 'image/jpeg': [
                        '.jpg',
                        '.jpeg',
                    ] },
                },
                {
                    description: 'PNG Images',
                    accept: { 'image/png': ['.png'] },
                },
                {
                    description: 'TIFF Images',
                    accept: { 'image/tiff': [
                        '.tif',
                        '.tiff',
                    ] },
                },
            ],
        });
        expect(writeBytesToHandleMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'page-001.jpg' }),
            new Uint8Array([1]),
        );
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledWith(
            'page-001.jpg',
            expect.objectContaining({ byteLength: 0 }),
            expect.objectContaining({
                mimeType: 'image/jpeg',
                saveHandle: expect.objectContaining({ name: 'page-001.jpg' }),
                storageMode: 'handle',
            }),
        );
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.replaceWithHandleBackedDocument).toHaveBeenCalledWith(
            'browser://documents/output/page-001.jpg',
            expect.objectContaining({
                fileSize: 1,
                saveHandle: expect.objectContaining({ name: 'page-001.jpg' }),
                saveName: 'page-001.jpg',
            }),
        );
    });

    it('exports PNG images when the selected file name uses a PNG extension', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });
        pickSaveTargetMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'page-001.png',
            handle: null,
        });
        saveBytesToPickerOrDownloadMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'page-001.png',
            handle: null,
        });
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/output/page-001.png',
        );

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        const result = await capability.exportPdfToImages(
            requireDocumentRef('browser://documents/work/sample.pdf'),
            [requirePageNumber(1)],
        );

        expect(result).toEqual({
            success: true,
            outputPaths: ['browser://documents/output/page-001.png'],
        });
        expect(saveBytesToPickerOrDownloadMock).toHaveBeenCalledWith(
            new Uint8Array([1]),
            expect.objectContaining({
                suggestedName: 'page-001.png',
                mimeType: 'image/png',
            }),
        );
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledWith(
            'page-001.png',
            new Uint8Array([1]),
            expect.objectContaining({
                mimeType: 'image/png',
                saveHandle: null,
            }),
        );
        expect(writeBytesToHandleMock).not.toHaveBeenCalled();
    });

    it('exports single-page TIFF images when the selected file name uses a TIFF extension', async () => {
        const fakePdfDocument = createFakePdfDocument(1);
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });
        pickSaveTargetMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'page-001.tiff',
            handle: null,
        });
        saveBytesToPickerOrDownloadMock.mockResolvedValueOnce({
            canceled: false,
            fileName: 'page-001.tiff',
            handle: null,
        });
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/output/page-001.tiff',
        );

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        const result = await capability.exportPdfToImages(
            requireDocumentRef('browser://documents/work/sample.pdf'),
            [requirePageNumber(1)],
        );

        expect(result).toEqual({
            success: true,
            outputPaths: ['browser://documents/output/page-001.tiff'],
        });

        const savedBytes = saveBytesToPickerOrDownloadMock.mock.calls[0]?.[0];
        expect(savedBytes).toBeInstanceOf(Uint8Array);
        if (!(savedBytes instanceof Uint8Array)) {
            throw new Error('Expected TIFF image export to save raw TIFF bytes');
        }

        expect(saveBytesToPickerOrDownloadMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
            suggestedName: 'page-001.tiff',
            mimeType: 'image/tiff',
        }));
        expect(countTiffDirectories(savedBytes)).toBe(1);
        expect(utifLoaderState.encoderAccess).toHaveBeenCalled();
        const ifds = UTIF.decode(savedBytes);
        expect(ifds).toHaveLength(1);
        UTIF.decodeImage(savedBytes, ifds[0]!);
        expect(Array.from(UTIF.toRGBA8(ifds[0]!).slice(0, 4))).toEqual([
            0,
            0,
            0,
            255,
        ]);
        expect(browserDocumentStoreMock.createStoredDocument).toHaveBeenCalledWith(
            'page-001.tiff',
            savedBytes,
            expect.objectContaining({
                mimeType: 'image/tiff',
                saveHandle: null,
            }),
        );
    });

    it('fails image export when selected pages resolve to no valid PDF pages', async () => {
        const fakePdfDocument = createFakePdfDocument(2);
        const getPage = fakePdfDocument.getPage;
        getDocumentMock.mockReturnValue({ promise: Promise.resolve(fakePdfDocument) });

        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        // The malformed value stays unknown until a runtime guard crosses the
        // typed method boundary. The capability still validates its page bounds.
        const pageNumbers: unknown[] = [
            0,
            requirePageNumber(3),
        ];
        const guardedPageNumbers = pageNumbers.filter(
            (value): value is TPageNumber => typeof value === 'number',
        );
        const result = await capability.exportPdfToImages(
            requireDocumentRef('browser://documents/work/sample.pdf'),
            guardedPageNumbers,
        );

        expect(result).toEqual({
            success: false,
            canceled: true,
        });
        expect(fakePdfDocument.destroy).toHaveBeenCalledTimes(1);
        expect(getPage).not.toHaveBeenCalled();
        expect(saveBlobToPickerOrDownloadMock).not.toHaveBeenCalled();
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.createStoredDocument).not.toHaveBeenCalled();
    });

    it('refuses native PDF paths before entering a browser image export route', async () => {
        const { createBrowserImageExportCapability } = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );
        const capability = createBrowserImageExportCapability();

        await expect(capability.exportPdfToImages(requireDocumentRef('/tmp/native.pdf'), [requirePageNumber(1)])).rejects.toMatchObject({
            name: 'PdfCombineCapabilityError',
            code: 'native-unavailable',
            operation: 'image-export',
        });
        await expect(capability.exportPdfToMultiPageTiff(requireDocumentRef('/tmp/native.pdf'), [requirePageNumber(1)])).rejects.toMatchObject({
            name: 'PdfCombineCapabilityError',
            code: 'native-unavailable',
            operation: 'image-export',
        });

        expect(getDocumentMock).not.toHaveBeenCalled();
        expect(createDjvuWorkerFromPathMock).not.toHaveBeenCalled();
    });

    it('refuses an oversized all-pages PDF image export before materializing the page range or rendering', async () => {
        const fakePdfDocument = createFakePdfDocument(OVERSIZED_PAGE_COUNT);
        const getPage = fakePdfDocument.getPage;
        getDocumentMock.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});
        // Keep a pre-fix run cheap: cancel the save picker after the first page.
        pickSaveTargetMock
            .mockResolvedValueOnce({
                canceled: false,
                fileName: 'page-001.jpg',
                handle: null,
            })
            .mockResolvedValue({
                canceled: true,
                fileName: 'page-002.jpg',
                handle: null,
            });

        const {createBrowserImageExportCapability} = await import('@app/platform/browser-api/createBrowserImageExportCapability');
        const capability = createBrowserImageExportCapability();

        const rejection = await capability.exportPdfToImages(
            requireDocumentRef('browser://documents/work/sample.pdf'),
        ).then(
            () => {
                throw new Error('Expected the oversized all-pages export to be refused');
            },
            (error: unknown) => error,
        );

        expect(rejection).toBeInstanceOf(RangeError);
        expect(rejection).toMatchObject({
            code: 'image-export-page-budget-exceeded',
            pageCount: OVERSIZED_PAGE_COUNT,
            name: 'BrowserImageExportPageBudgetError',
        });
        expect((rejection as Error).message).toContain('all-pages exports above 100,000 pages');
        expect((rejection as Error).message).toContain('100,001 pages');

        expect(rangeSpy).not.toHaveBeenCalled();
        expect(getPage).not.toHaveBeenCalled();
        expect(pickSaveTargetMock).toHaveBeenCalledOnce();
        expect(saveBytesToPickerOrDownloadMock).not.toHaveBeenCalled();
        expect(browserDocumentStoreMock.createStoredDocument).not.toHaveBeenCalled();
        expect(fakePdfDocument.destroy).toHaveBeenCalledTimes(1);
    });

    it('refuses an oversized all-pages DjVu image export without rendering any page', async () => {
        const terminate = vi.fn();
        const getPage = vi.fn();
        createDjvuWorkerFromPathMock.mockResolvedValue({
            doc: {
                getPagesSizes: () => ({run: async () => Array.from(
                    {length: OVERSIZED_PAGE_COUNT},
                    () => ({
                        width: 1,
                        height: 1,
                    }),
                )}),
                getPage,
            },
            revokeObjectURL: vi.fn(),
            terminate,
        });

        const {createBrowserImageExportCapability} = await import('@app/platform/browser-api/createBrowserImageExportCapability');

        const rejection = await createBrowserImageExportCapability().exportPdfToMultiPageTiff(
            requireDocumentRef('browser://documents/work/sample.djvu'),
            undefined,
            undefined,
            'djvu',
        ).then(
            () => {
                throw new Error('Expected the oversized all-pages export to be refused');
            },
            (error: unknown) => error,
        );

        expect(rejection).toBeInstanceOf(RangeError);
        expect((rejection as Error).message).toContain('all-pages exports above 100,000 pages');

        expect(rangeSpy).not.toHaveBeenCalled();
        expect(getPage).not.toHaveBeenCalled();
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    it('keeps explicit page selections working on oversized documents', async () => {
        const fakePdfDocument = createFakePdfDocument(OVERSIZED_PAGE_COUNT);
        const getPage = fakePdfDocument.getPage;
        getDocumentMock.mockReturnValue({promise: Promise.resolve(fakePdfDocument)});
        pickSaveTargetMock.mockResolvedValue({
            canceled: false,
            fileName: 'page-007.jpg',
            handle: null,
        });
        saveBytesToPickerOrDownloadMock.mockResolvedValue({
            canceled: false,
            fileName: 'page-007.jpg',
            handle: null,
        });
        browserDocumentStoreMock.createStoredDocument.mockResolvedValue(
            'browser://documents/output/page-007.jpg',
        );

        const {createBrowserImageExportCapability} = await import(
            '@app/platform/browser-api/createBrowserImageExportCapability'
        );

        const result = await createBrowserImageExportCapability().exportPdfToImages(
            requireDocumentRef('browser://documents/work/sample.pdf'),
            [requirePageNumber(7)],
        );

        expect(result).toEqual({
            success: true,
            outputPaths: ['browser://documents/output/page-007.jpg'],
        });
        expect(rangeSpy).not.toHaveBeenCalled();
        expect(getPage).toHaveBeenCalledWith(7);
        expect(fakePdfDocument.destroy).toHaveBeenCalledTimes(1);
    });
});
