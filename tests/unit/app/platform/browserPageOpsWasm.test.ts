import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    PDFDocument,
    degrees,
    PDFName,
    PDFNumber,
    PDFString,
} from 'pdf-lib';
import type {
    PDFArray,
    PDFDict,
    PDFRef,
} from 'pdf-lib';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPageGeometry } from '@contracts/shared';
import type {IPageMutationWorkerResult} from '@app/platform/browser-api/browserPageOpsWorker.types';
import type {IBrowserPageOpsWasmFailure} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import {decodeBrowserPdfAnnotationsOutput} from '@app/platform/browser-api/decodeBrowserPdfAnnotationsOutput';
import {
    resolvePdfLibCropBox,
    resolvePdfLibMediaBox,
} from '@pdf-core';

const NativeWebAssembly = WebAssembly;
const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: loggerWarn}}));

interface IPdfPageSummary {
    mediaBox: IPageGeometry['mediaBox'];
    cropBox: IPageGeometry['cropBox'];
    rotation: number;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
}

function assertSuccessfulWasmMutation(
    result: IPageMutationWorkerResult | IBrowserPageOpsWasmFailure | null,
): asserts result is IPageMutationWorkerResult {
    if (result === null || 'status' in result) {
        throw new Error('Expected successful browser page-ops WASM mutation');
    }
}

async function createPdf(options: {
    pageWidths: number[];
    cropSecondPage?: boolean;
    rotateSecondPage?: boolean;
}) {
    const pdfDocument = await PDFDocument.create();
    for (const [
        index,
        width,
    ] of options.pageWidths.entries()) {
        const page = pdfDocument.addPage([
            width,
            100 + (index * 20),
        ]);
        if (index === 1 && options.cropSecondPage) {
            page.setCropBox(10, 12, width - 30, 80);
        }
        if (index === 1 && options.rotateSecondPage) {
            page.setRotation(degrees(90));
        }
    }

    return new Uint8Array(await pdfDocument.save());
}

async function createMetadataPdf() {
    const pdfDocument = await PDFDocument.create();
    const pages = [
        pdfDocument.addPage([
            200,
            100,
        ]),
        pdfDocument.addPage([
            300,
            100,
        ]),
        pdfDocument.addPage([
            400,
            100,
        ]),
    ];
    const {context} = pdfDocument;
    const decimalLabels = context.register(context.obj({
        S: PDFName.of('D'),
        St: PDFNumber.of(1),
    }));
    const romanLabels = context.register(context.obj({
        S: PDFName.of('R'),
        St: PDFNumber.of(1),
    }));
    const pageLabels = context.register(context.obj({Nums: [
        0,
        decimalLabels,
        1,
        romanLabels,
    ]}));
    const outlineItem = context.register(context.obj({
        Title: PDFString.of('Page three'),
        Dest: [
            pages[2]!.ref,
            PDFName.of('Fit'),
        ],
    }));
    const outlines = context.register(context.obj({
        Type: PDFName.of('Outlines'),
        First: outlineItem,
        Last: outlineItem,
        Count: PDFNumber.of(1),
    }));
    (context.lookup(outlineItem) as PDFDict).set(PDFName.of('Parent'), outlines);
    pdfDocument.catalog.set(PDFName.of('PageLabels'), pageLabels);
    pdfDocument.catalog.set(PDFName.of('Outlines'), outlines);
    return new Uint8Array(await pdfDocument.save());
}

async function readPasswordProtectedPdf() {
    const encoded = await readFile(
        join(process.cwd(), 'tests/fixtures/electron/password-protected.pdf.b64'),
        'utf8',
    );
    return Uint8Array.from(Buffer.from(encoded.trim(), 'base64'));
}

function readPageLabels(pdfDocument: PDFDocument) {
    const pageLabels = pdfDocument.context.lookup(
        pdfDocument.catalog.get(PDFName.of('PageLabels')) as PDFRef,
    ) as PDFDict;
    const nums = pageLabels.get(PDFName.of('Nums')) as PDFArray;
    const labels: string[] = [];
    for (let index = 0; index < nums.size(); index += 2) {
        const pageLabel = pdfDocument.context.lookup(nums.get(index + 1)) as PDFDict;
        labels.push((pageLabel.get(PDFName.of('P')) as PDFString).decodeText());
    }
    return labels;
}

function readOutlineDestination(pdfDocument: PDFDocument) {
    const outlines = pdfDocument.context.lookup(
        pdfDocument.catalog.get(PDFName.of('Outlines')) as PDFRef,
    ) as PDFDict;
    const first = pdfDocument.context.lookup(outlines.get(PDFName.of('First'))) as PDFDict;
    return (first.get(PDFName.of('Dest')) as PDFArray).get(0) as PDFRef;
}

async function summarizePdf(data: Uint8Array): Promise<IPdfPageSummary[]> {
    const pdfDocument = await PDFDocument.load(data);
    return pdfDocument.getPages().map((page) => {
        const mediaBox = resolvePdfLibMediaBox(page);
        return {
            mediaBox,
            cropBox: resolvePdfLibCropBox(page, mediaBox),
            rotation: page.getRotation().angle,
        };
    });
}

async function stubSuccessfulWasmFetch() {
    vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
    vi.stubGlobal('WebAssembly', NativeWebAssembly);
    const wasmBytes = await readFile(join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
    const fetchMock = vi.fn(async () => ({
        ok: true,
        headers: {get: () => null},
        arrayBuffer: async () => toArrayBuffer(wasmBytes),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function createFailingPageOpsWasmExports(errorText: string) {
    const memory = new NativeWebAssembly.Memory({initial: 1});
    const error = new TextEncoder().encode(errorText);
    const errorPointer = 2048;
    let liveAllocation: {
        pointer: number;
        byteLength: number;
    } | null = null;
    let nextAllocationPointer = 1024;
    const alloc = vi.fn((byteLength: number) => {
        if (liveAllocation !== null) {
            return 0;
        }
        const pointer = nextAllocationPointer;
        nextAllocationPointer = 1024;
        liveAllocation = {
            pointer,
            byteLength,
        };
        return pointer;
    });
    const free = vi.fn((pointer: number, byteLength: number) => {
        if (liveAllocation?.pointer === pointer && liveAllocation.byteLength === byteLength) {
            liveAllocation = null;
        }
    });
    const run = vi.fn(() => {
        new Uint8Array(memory.buffer, errorPointer, error.byteLength).set(error);
        return -7;
    });

    return {
        exports: {
            memory,
            evb_wasm_request_allocation_abi_version: vi.fn(() => 1),
            evb_pdf_page_ops_alloc: alloc,
            evb_pdf_page_ops_free: free,
            evb_pdf_page_ops_run: run,
            evb_pdf_page_ops_output_ptr: vi.fn(() => 0),
            evb_pdf_page_ops_output_len: vi.fn(() => 0),
            evb_pdf_page_ops_error_ptr: vi.fn(() => errorPointer),
            evb_pdf_page_ops_error_len: vi.fn(() => error.byteLength),
        },
        alloc,
        free,
        run,
        setNextAllocationPointer(pointer: number) {
            nextAllocationPointer = pointer;
        },
    };
}

async function loadWasmRunner() {
    vi.resetModules();
    vi.unstubAllGlobals();
    const fetchMock = await stubSuccessfulWasmFetch();
    const module = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
    return {
        fetchMock,
        run: module.tryRunBrowserPageOpsWithWasm,
    };
}

async function loadCoreWithWasm() {
    vi.resetModules();
    vi.unstubAllGlobals();
    const fetchMock = await stubSuccessfulWasmFetch();
    const core = await import('@app/platform/browser-api/browserPageOpsCore');
    return {
        ...core,
        fetchMock,
    };
}

describe('browser page-ops WASM fast path', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('keeps one exact live request allocation across repeated awkward lengths', async () => {
        const wasmBytes = await readFile(join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
        const module = new NativeWebAssembly.Module(toArrayBuffer(wasmBytes));
        const instance = await NativeWebAssembly.instantiate(module);
        const memory = instance.exports.memory;
        const allocationAbiVersion = instance.exports.evb_wasm_request_allocation_abi_version;
        const alloc = instance.exports.evb_pdf_page_ops_alloc;
        const free = instance.exports.evb_pdf_page_ops_free;
        if (
            !(memory instanceof NativeWebAssembly.Memory)
            || typeof allocationAbiVersion !== 'function'
            || typeof alloc !== 'function'
            || typeof free !== 'function'
        ) {
            throw new Error('Page operation WASM allocation exports are missing');
        }
        expect(allocationAbiVersion()).toBe(1);

        for (const length of [
            1,
            3,
            17,
            257,
            1021,
            4093,
        ]) {
            const pointer = alloc(length);
            expect(pointer).not.toBe(0);
            expect(alloc(1)).toBe(0);
            new Uint8Array(memory.buffer, pointer >>> 0, length).fill(0xa5);
            free(pointer, length);
        }
    });

    it('decrypts an encrypted PDF through WASM operation 9 with the correct password', async () => {
        const encryptedPdf = await readPasswordProtectedPdf();
        const wasm = await loadWasmRunner();

        const result = await wasm.run('decrypt', {
            data: encryptedPdf,
            password: 'frame-secret',
        });

        assertSuccessfulWasmMutation(result);
        expect(result.data).not.toEqual(encryptedPdf);
        expect(result.pageCount).toBe(1);
        const opened = await PDFDocument.load(result.data);
        expect(opened.getPageCount()).toBe(1);
        expect(wasm.fetchMock).toHaveBeenCalledOnce();
    });

    it('reports a typed password failure through WASM operation 9', async () => {
        const encryptedPdf = await readPasswordProtectedPdf();
        const wasm = await loadWasmRunner();

        const result = await wasm.run('decrypt', {
            data: encryptedPdf,
            password: 'wrong-password',
        });

        expect(result).toMatchObject({
            status: 'failed',
            error: {code: 'needs-password'},
        });
    });

    it('parses reachable FreeText and Popup entries through the writer WASM operation', async () => {
        const data = new Uint8Array(await readFile(join(
            process.cwd(),
            'tests/fixtures/electron/freetext-lifecycle-test.pdf',
        )));
        const wasm = await loadWasmRunner();
        const result = await wasm.run('parseAnnotations', {data});
        expect(result).not.toBeNull();
        if (result === null || 'status' in result) {
            throw new Error('Expected annotation parse WASM output');
        }

        const parsed = decodeBrowserPdfAnnotationsOutput(result.data);
        expect(parsed.pageCount).toBe(1);
        expect(parsed.entities.map(entity => entity.kind)).toEqual([
            'note',
            'text-box',
            'text-box',
        ]);
        expect(parsed.entities.map(entity => entity.name)).toEqual([
            'lifecycle-note',
            'lifecycle-text-box-one',
            'lifecycle-text-box-two',
        ]);
        expect(parsed.foreign).toEqual([]);
    });

    it('matches pdf-lib page summaries for representative operations', async () => {
        const basePdf = await createPdf({
            pageWidths: [
                200,
                300,
                400,
            ],
            cropSecondPage: true,
            rotateSecondPage: true,
        });
        const insertionPdf = await createPdf({pageWidths: [500]});

        const wasm = await loadWasmRunner();
        const wasmDelete = await wasm.run('deletePages', {
            data: basePdf,
            pages: [2],
        });
        const wasmExtract = await wasm.run('extractPages', {
            data: basePdf,
            pages: [
                3,
                1,
            ],
        });
        const wasmReorder = await wasm.run('reorderPages', {
            data: basePdf,
            newOrder: [
                3,
                1,
                2,
            ],
        });
        const wasmInsert = await wasm.run('insertPages', {
            data: basePdf,
            insertionData: insertionPdf,
            afterPage: 1,
        });
        const wasmRotate = await wasm.run('rotate', {
            data: basePdf,
            pages: [
                1,
                3,
            ],
            angle: 90,
        });
        const wasmCrop = await wasm.run('crop', {
            data: basePdf,
            pages: [1],
            margins: {
                top: 4,
                bottom: 6,
                left: 8,
                right: 10,
            },
        });
        const wasmRemoveCrop = await wasm.run('removeCrop', {
            data: basePdf,
            pages: [2],
        });
        const wasmGeometry = await wasm.run('getPageGeometry', {
            data: basePdf,
            pageNumber: 2,
        });

        expect(wasmDelete).not.toBeNull();
        expect(wasmExtract).not.toBeNull();
        expect(wasmReorder).not.toBeNull();
        expect(wasmInsert).not.toBeNull();
        expect(wasmRotate).not.toBeNull();
        expect(wasmCrop).not.toBeNull();
        expect(wasmRemoveCrop).not.toBeNull();
        expect(wasmGeometry).not.toBeNull();
        assertSuccessfulWasmMutation(wasmDelete);
        assertSuccessfulWasmMutation(wasmExtract);
        assertSuccessfulWasmMutation(wasmReorder);
        assertSuccessfulWasmMutation(wasmInsert);
        assertSuccessfulWasmMutation(wasmRotate);
        assertSuccessfulWasmMutation(wasmCrop);
        assertSuccessfulWasmMutation(wasmRemoveCrop);
        expect(wasm.fetchMock).toHaveBeenCalledWith(
            'https://viewer.test/wasm/evb-pdf-page-ops.wasm',
            {signal: expect.any(AbortSignal)},
        );

        expect((await summarizePdf(wasmDelete.data)).map(page => page.mediaBox.width))
            .toEqual([
                200,
                400,
            ]);
        expect((await summarizePdf(wasmExtract.data)).map(page => page.mediaBox.width))
            .toEqual([
                400,
                200,
            ]);
        expect((await summarizePdf(wasmReorder.data)).map(page => page.mediaBox.width))
            .toEqual([
                400,
                200,
                300,
            ]);
        expect((await summarizePdf(wasmInsert.data)).map(page => page.mediaBox.width))
            .toEqual([
                200,
                500,
                300,
                400,
            ]);
        expect((await summarizePdf(wasmRotate.data)).map(page => page.rotation))
            .toEqual([
                90,
                90,
                90,
            ]);
        expect((await summarizePdf(wasmCrop.data))[0]?.cropBox).toEqual({
            x: 8,
            y: 6,
            width: 182,
            height: 90,
        });
        expect((await summarizePdf(wasmRemoveCrop.data))[1]?.cropBox).toBeNull();
        expect(wasmGeometry).toEqual({
            mediaBox: {
                x: 0,
                y: 0,
                width: 300,
                height: 120,
            },
            cropBox: {
                x: 10,
                y: 12,
                width: 270,
                height: 80,
            },
            rotation: 90,
        });
    });

    it('preserves outlines and remaps page labels across browser page operations', async () => {
        const basePdf = await createMetadataPdf();
        const insertionPdf = await createPdf({pageWidths: [500]});
        const wasm = await loadWasmRunner();
        const operations = [
            {
                result: await wasm.run('deletePages', {
                    data: basePdf,
                    pages: [2],
                }),
                labels: [
                    '1',
                    'II',
                ],
                destinationPage: 2,
            },
            {
                result: await wasm.run('reorderPages', {
                    data: basePdf,
                    newOrder: [
                        3,
                        1,
                        2,
                    ],
                }),
                labels: [
                    'II',
                    '1',
                    'I',
                ],
                destinationPage: 1,
            },
            {
                result: await wasm.run('insertPages', {
                    data: basePdf,
                    insertionData: insertionPdf,
                    afterPage: 1,
                }),
                labels: [
                    '1',
                    '2',
                    'I',
                    'II',
                ],
                destinationPage: 4,
            },
        ];

        for (const operation of operations) {
            assertSuccessfulWasmMutation(operation.result);
            const output = await PDFDocument.load(operation.result.data);
            expect(output.catalog.get(PDFName.of('Outlines'))).toBeDefined();
            expect(readPageLabels(output)).toEqual(operation.labels);
            expect(readOutlineDestination(output).objectNumber)
                .toBe(output.getPage(operation.destinationPage - 1).ref.objectNumber);
        }
    });

    it('reads catalog and conformance and merges N documents through EPPO v3', async () => {
        const sourcePdf = await createMetadataPdf();
        const secondPdf = await createPdf({pageWidths: [500]});
        const wasm = await loadWasmRunner();

        const catalogResult = await wasm.run('readCatalog', {data: sourcePdf});
        expect(catalogResult).toEqual({
            bookmarks: [{
                title: 'Page three',
                pageIndex: 2,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }],
            pageLabels: [
                {
                    pageIndex: 0,
                    style: 'D',
                    start: 1,
                },
                {
                    pageIndex: 1,
                    style: 'R',
                    start: 1,
                },
            ],
        });

        const conformanceResult = await wasm.run('conformance', {data: sourcePdf});
        expect(conformanceResult).toEqual({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            hasAcroForm: false,
            hasXfa: false,
        });

        const mergedResult = await wasm.run('mergePages', {documents: [
            sourcePdf,
            secondPdf,
        ]});
        assertSuccessfulWasmMutation(mergedResult);
        expect(mergedResult.pageCount).toBe(4);
        const merged = await PDFDocument.load(mergedResult.data);
        const mergedCatalog = await wasm.run('readCatalog', {data: mergedResult.data});
        expect(mergedCatalog).toMatchObject({
            bookmarks: [{
                title: 'Page three',
                pageIndex: 2,
            }],
            pageLabels: [
                {
                    pageIndex: 0,
                    style: 'D',
                },
                {
                    pageIndex: 1,
                    style: 'R',
                },
            ],
        });
        expect(readOutlineDestination(merged).objectNumber)
            .toBe(merged.getPage(2).ref.objectNumber);
    });

    it('preserves and offsets catalogs from every document in mergePages', async () => {
        const sourcePdf = await createMetadataPdf();
        const wasm = await loadWasmRunner();

        const mergedResult = await wasm.run('mergePages', {documents: [
            sourcePdf,
            sourcePdf,
        ]});
        assertSuccessfulWasmMutation(mergedResult);

        const mergedCatalog = await wasm.run('readCatalog', {data: mergedResult.data});
        if (mergedCatalog === null || 'status' in mergedCatalog) {
            throw new Error('Expected a successful browser page-ops catalog read');
        }
        expect(mergedCatalog.bookmarks).toHaveLength(2);
        expect(mergedCatalog.bookmarks.map(bookmark => bookmark.pageIndex)).toEqual([
            2,
            5,
        ]);
        expect(mergedCatalog.pageLabels.map(range => range.pageIndex)).toEqual([
            0,
            1,
            3,
            4,
        ]);
    });

    it('fails closed when core receives non-integer runtime page fields', async () => {
        const basePdf = await createPdf({pageWidths: [200]});
        const insertionPdf = await createPdf({pageWidths: [300]});
        const core = await loadCoreWithWasm();

        await expect(core.deletePdfPages(basePdf, [1.5]))
            .rejects.toThrow('Invalid page-op WASM integer field');
        await expect(core.insertPdfPages(basePdf, insertionPdf, 1.5))
            .rejects.toThrow('Invalid page-op WASM integer field');
        await expect(core.getPageGeometryFromPdfBytes(basePdf, 1.5))
            .rejects.toThrow('Invalid page-op WASM integer field');
        expect(core.fetchMock).toHaveBeenCalledWith(
            'https://viewer.test/wasm/evb-pdf-page-ops.wasm',
            {signal: expect.any(AbortSignal)},
        );
    });

    it('rejects delete-all through native page-ops WASM before saving a zero-page PDF', async () => {
        const basePdf = await createPdf({pageWidths: [200]});
        const core = await loadCoreWithWasm();

        await expect(core.deletePdfPages(basePdf, [1]))
            .rejects.toThrow('deletePages: cannot delete every page');
    });

    it('returns null when the WASM asset is unavailable', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('WebAssembly', NativeWebAssembly);
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            arrayBuffer: async () => new ArrayBuffer(0),
        })));
        const { tryRunBrowserPageOpsWithWasm } = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('deletePages', {
            data: basePdf,
            pages: [1],
        })).resolves.toBeNull();
    });

    it('returns null for a cached module with an incompatible allocation ABI', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        })));
        const wasmMock = createFailingPageOpsWasmExports('unused');
        wasmMock.exports.evb_wasm_request_allocation_abi_version.mockReturnValue(0);
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryRunBrowserPageOpsWithWasm} = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('deletePages', {
            data: basePdf,
            pages: [1],
        })).resolves.toBeNull();
        expect(wasmMock.exports.evb_pdf_page_ops_alloc).not.toHaveBeenCalled();
    });

    it('preserves native WASM error envelopes when a page operation falls back', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        })));
        const wasmMock = createFailingPageOpsWasmExports(JSON.stringify({
            code: 'corrupt-xref',
            message: 'page wasm failed',
        }));
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const { tryRunBrowserPageOpsWithWasm } = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('deletePages', {
            data: basePdf,
            pages: [1],
        })).resolves.toEqual({
            status: 'failed',
            error: {
                code: 'corrupt-xref',
                message: 'page wasm failed',
            },
        });

        expect(wasmMock.run).toHaveBeenCalledTimes(1);
        expect(wasmMock.free).toHaveBeenCalledTimes(1);
        expect(loggerWarn).toHaveBeenCalledWith(
            'browser-wasm',
            'PDF page operation WASM failed',
            {
                error: 'page wasm failed',
                resultCode: -7,
                type: 'deletePages',
            },
        );
    });

    it('classifies allocation failure without touching linear memory', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        })));
        const wasmMock = createFailingPageOpsWasmExports('unused');
        wasmMock.exports.evb_pdf_page_ops_alloc.mockReturnValue(0);
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryRunBrowserPageOpsWithWasm} = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('deletePages', {
            data: basePdf,
            pages: [1],
        })).resolves.toMatchObject({
            status: 'failed',
            error: {code: 'too-large'},
        });
        expect(wasmMock.run).not.toHaveBeenCalled();
        expect(wasmMock.free).not.toHaveBeenCalled();
    });

    it('rejects an out-of-bounds allocation pointer and releases ABI ownership', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        })));
        const wasmMock = createFailingPageOpsWasmExports('unused');
        const probePointer = wasmMock.alloc(7);
        wasmMock.free(probePointer, 6);
        expect(wasmMock.alloc(1)).toBe(0);
        wasmMock.free(probePointer, 7);
        const reusedPointer = wasmMock.alloc(1);
        expect(reusedPointer).not.toBe(0);
        wasmMock.free(reusedPointer, 1);
        wasmMock.alloc.mockClear();
        wasmMock.free.mockClear();
        wasmMock.setNextAllocationPointer(65_520);
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryRunBrowserPageOpsWithWasm} = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('deletePages', {
            data: basePdf,
            pages: [1],
        })).resolves.toMatchObject({
            status: 'failed',
            error: {code: 'invalid-request'},
        });
        expect(wasmMock.run).not.toHaveBeenCalled();
        expect(wasmMock.free).toHaveBeenCalledOnce();

        await expect(tryRunBrowserPageOpsWithWasm('deletePages', {
            data: basePdf,
            pages: [1],
        })).resolves.toMatchObject({status: 'failed'});
        expect(wasmMock.run).toHaveBeenCalledOnce();
        expect(wasmMock.free).toHaveBeenCalledTimes(2);
    });

    it('rejects an out-of-bounds output span and frees the valid request allocation', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        })));
        const wasmMock = createFailingPageOpsWasmExports('unused');
        const probePointer = wasmMock.alloc(7);
        wasmMock.free(probePointer, 6);
        expect(wasmMock.alloc(1)).toBe(0);
        wasmMock.free(probePointer, 7);
        const reusedPointer = wasmMock.alloc(1);
        expect(reusedPointer).not.toBe(0);
        wasmMock.free(reusedPointer, 1);
        wasmMock.alloc.mockClear();
        wasmMock.free.mockClear();
        wasmMock.run.mockReturnValue(0);
        wasmMock.exports.evb_pdf_page_ops_output_ptr.mockReturnValue(65_520);
        wasmMock.exports.evb_pdf_page_ops_output_len.mockReturnValue(32);
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryRunBrowserPageOpsWithWasm} = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('deletePages', {
            data: basePdf,
            pages: [1],
        })).resolves.toMatchObject({
            status: 'failed',
            error: {code: 'invalid-request'},
        });
        expect(wasmMock.run).toHaveBeenCalledOnce();
        expect(wasmMock.free).toHaveBeenCalledOnce();

        await expect(tryRunBrowserPageOpsWithWasm('deletePages', {
            data: basePdf,
            pages: [1],
        })).resolves.toMatchObject({
            status: 'failed',
            error: {code: 'invalid-request'},
        });
        expect(wasmMock.run).toHaveBeenCalledTimes(2);
        expect(wasmMock.free).toHaveBeenCalledTimes(2);
    });

    it.each([
        'not-json',
        JSON.stringify({
            code: 'future-native-code',
            message: 'future failure',
        }),
    ])('falls back to native-failure for malformed or unknown WASM errors', async (encodedError) => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        })));
        const wasmMock = createFailingPageOpsWasmExports(encodedError);
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryRunBrowserPageOpsWithWasm} = await import(
            '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm'
        );
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('deletePages', {
            data: basePdf,
            pages: [1],
        })).resolves.toMatchObject({
            status: 'failed',
            error: {code: 'native-failure'},
        });
    });
});
