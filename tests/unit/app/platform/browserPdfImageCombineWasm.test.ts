import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import * as utifModule from 'utif';
import {
    buildTiffImageIfd,
    encodeTiffIfds,
} from '@pdf-core';
import type {ITiffEncoderModule} from '@pdf-core/tiffEncoding';

const NativeWebAssembly = WebAssembly;
const wasmGlobalMockBase = {Memory: NativeWebAssembly.Memory};
const loggerWarn = vi.hoisted(() => vi.fn());

const UTIF = utifModule as typeof utifModule & ITiffEncoderModule;

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: loggerWarn}}));

function createFetchMock() {
    return vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
    }));
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
}

async function stubSuccessfulImageCombineWasmFetch() {
    vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
    vi.stubGlobal('WebAssembly', NativeWebAssembly);
    const wasmBytes = await readFile(join(process.cwd(), 'public/wasm/evb-pdf-image-combine.wasm'));
    const fetchMock = vi.fn(async () => ({
        ok: true,
        headers: {get: () => null},
        arrayBuffer: async () => toArrayBuffer(wasmBytes),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function createPgmBytes(value: number) {
    const header = new TextEncoder().encode('P5\n1 1\n255\n');
    const bytes = new Uint8Array(header.byteLength + 1);
    bytes.set(header);
    bytes[header.byteLength] = value;
    return bytes;
}

function createTwoFrameTiffBytes() {
    const pages = [
        {
            width: 1,
            height: 1,
            dataLength: 3,
        },
        {
            width: 2,
            height: 1,
            dataLength: 6,
        },
    ];
    const buildRgbTiffImageIfd = (page: typeof pages[number], dataOffset: number) => {
        const {
            t338: _extraSamples, ...ifd
        } = buildTiffImageIfd(page, dataOffset);
        return {
            ...ifd,
            t258: [
                8,
                8,
                8,
            ],
            t262: [2],
            t277: [3],
        };
    };
    const header = encodeTiffIfds(
        pages.map(page => buildRgbTiffImageIfd(page, 0)),
        UTIF,
    );
    const encoded = encodeTiffIfds(
        pages.map((page, index) => buildRgbTiffImageIfd(
            page,
            header.byteLength + pages
                .slice(0, index)
                .reduce((total, previous) => total + previous.dataLength, 0),
        )),
        UTIF,
    );
    const bytes = new Uint8Array(encoded.byteLength + 9);
    bytes.set(encoded);
    bytes.set(Uint8Array.of(255, 0, 0), encoded.byteLength);
    bytes.set(Uint8Array.of(0, 255, 0, 0, 0, 255), encoded.byteLength + 3);
    return bytes;
}

async function runBrowserPdfCombineWorker(inputs: Array<{
    fileName: string;
    data: Uint8Array;
}>) {
    let messageListener: ((event: MessageEvent<unknown>) => void | Promise<void>) | undefined;
    const postedMessages: unknown[] = [];
    vi.stubGlobal('self', {
        addEventListener: vi.fn((
            _type: string,
            listener: (event: MessageEvent<unknown>) => void | Promise<void>,
        ) => {
            messageListener = listener;
        }),
        postMessage: vi.fn((message: unknown) => {
            postedMessages.push(message);
        }),
    });
    await import('@app/platform/browser-api/browserPdfCombine.worker');
    if (!messageListener) {
        throw new Error('Browser PDF combine worker did not register its message listener');
    }
    await messageListener({data: {
        id: 1,
        type: 'combinePdfs',
        payload: {inputs},
    }} as MessageEvent<unknown>);
    return postedMessages.at(-1);
}

function decodeRequestNameAndData(request: Uint8Array) {
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    let offset = 4 + (6 * 4);
    const nameLength = view.getUint32(offset, true);
    offset += 4;
    const dataLength = view.getUint32(offset, true);
    offset += 4;
    const name = new TextDecoder().decode(request.slice(offset, offset + nameLength));
    offset += nameLength;
    const data = request.slice(offset, offset + dataLength);
    return {
        data,
        name,
    };
}

function decodeInputAt(request: Uint8Array, offset: number) {
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    const nameLength = view.getUint32(offset, true);
    offset += 4;
    const dataLength = view.getUint32(offset, true);
    offset += 4;
    const name = new TextDecoder().decode(request.slice(offset, offset + nameLength));
    offset += nameLength;
    const data = request.slice(offset, offset + dataLength);
    offset += dataLength;
    return {
        data,
        name,
        offset,
    };
}

function decodeV4FirstPageSpec(request: Uint8Array) {
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    let offset = 4 + (6 * 4);
    const kind = view.getUint32(offset, true);
    offset += 4;
    const widthPoints = view.getFloat64(offset, true);
    offset += 8;
    const heightPoints = view.getFloat64(offset, true);
    offset += 8;
    const jpegQuality = view.getUint32(offset, true);
    offset += 4;
    const ppiCap = view.getUint32(offset, true);
    offset += 4;
    const background = decodeInputAt(request, offset);
    const mask = decodeInputAt(request, background.offset);
    offset = mask.offset;
    const foregroundColor = [
        view.getUint32(offset, true),
        view.getUint32(offset + 4, true),
        view.getUint32(offset + 8, true),
    ];
    return {
        background: {
            data: background.data,
            name: background.name,
        },
        foregroundColor,
        heightPoints,
        jpegQuality,
        kind,
        mask: {
            data: mask.data,
            name: mask.name,
        },
        ppiCap,
        widthPoints,
    };
}

function createWasmExportsMock(options: {
    allocReturnsZero?: boolean;
    allocThrows?: boolean;
    buildResultCode?: number;
    output?: Uint8Array;
    reportedOutputLength?: number;
    errorText?: string;
} = {}) {
    const memory = new NativeWebAssembly.Memory({initial: 1});
    const output = options.output ?? new Uint8Array([
        0x25,
        0x50,
        0x44,
        0x46,
    ]);
    let cursor = 1024;
    let capturedRequest = new Uint8Array();
    let outputPointer = 0;
    let errorPointer = 0;
    let liveAllocation: {
        pointer: number;
        byteLength: number;
    } | null = null;
    let nextAllocationPointer: number | null = null;
    const error = new TextEncoder().encode(options.errorText ?? 'wasm failed');
    const free = vi.fn((pointer: number, byteLength: number) => {
        if (liveAllocation?.pointer === pointer && liveAllocation.byteLength === byteLength) {
            liveAllocation = null;
        }
    });
    const buildPdf = vi.fn((requestPointer: number, requestLength: number) => {
        capturedRequest = new Uint8Array(memory.buffer, requestPointer, requestLength).slice();
        if (options.buildResultCode && options.buildResultCode !== 0) {
            errorPointer = cursor;
            cursor += error.byteLength + 16;
            new Uint8Array(memory.buffer, errorPointer, error.byteLength).set(error);
            return options.buildResultCode;
        }

        outputPointer = cursor;
        cursor += output.byteLength + 16;
        new Uint8Array(memory.buffer, outputPointer, output.byteLength).set(output);
        return 0;
    });

    const alloc = vi.fn((len: number) => {
        if (options.allocThrows) {
            throw new Error('alloc failed');
        }
        if (options.allocReturnsZero || liveAllocation !== null) {
            return 0;
        }
        const pointer = nextAllocationPointer ?? cursor;
        nextAllocationPointer = null;
        if (pointer === cursor) {
            cursor += len + 16;
        }
        liveAllocation = {
            pointer,
            byteLength: len,
        };
        return pointer;
    });

    return {
        alloc,
        capturedRequest: () => capturedRequest,
        exports: {
            memory,
            evb_wasm_request_allocation_abi_version: vi.fn(() => 1),
            evb_pdf_image_combine_alloc: alloc,
            evb_pdf_image_combine_free: free,
            evb_pdf_image_combine_build_pdf: buildPdf,
            evb_pdf_image_combine_output_ptr: vi.fn(() => outputPointer),
            evb_pdf_image_combine_output_len: vi.fn(() => options.reportedOutputLength ?? output.byteLength),
            evb_pdf_image_combine_error_ptr: vi.fn(() => errorPointer),
            evb_pdf_image_combine_error_len: vi.fn(() => error.byteLength),
        },
        free,
        setNextAllocationPointer(pointer: number) {
            nextAllocationPointer = pointer;
        },
    };
}

describe('tryCombineImageInputsWithWasm', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        vi.stubGlobal('location', {href: 'https://viewer.test/electron'});
    });

    it('keeps one exact live request allocation across repeated awkward lengths', async () => {
        const wasmBytes = await readFile(join(process.cwd(), 'public/wasm/evb-pdf-image-combine.wasm'));
        const module = new NativeWebAssembly.Module(wasmBytes);
        const instance = await NativeWebAssembly.instantiate(module);
        const memory = instance.exports.memory;
        const allocationAbiVersion = instance.exports.evb_wasm_request_allocation_abi_version;
        const alloc = instance.exports.evb_pdf_image_combine_alloc;
        const free = instance.exports.evb_pdf_image_combine_free;
        if (
            !(memory instanceof NativeWebAssembly.Memory)
            || typeof allocationAbiVersion !== 'function'
            || typeof alloc !== 'function'
            || typeof free !== 'function'
        ) {
            throw new Error('PDF image combine WASM allocation exports are missing');
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

    it('admits 500 one-page inputs through the browser combine worker', async () => {
        const fetchMock = await stubSuccessfulImageCombineWasmFetch();
        const inputs = Array.from({length: 500}, (_value, index) => ({
            fileName: `page-${index + 1}.pgm`,
            data: createPgmBytes(index % 256),
        }));

        const response = await runBrowserPdfCombineWorker(inputs);

        expect(response).toMatchObject({
            id: 1,
            type: 'combinePdfs',
            ok: true,
        });
        if (!response || typeof response !== 'object' || !('data' in response) || !(response.data instanceof Uint8Array)) {
            throw new Error('Expected the browser combine worker to return PDF bytes');
        }
        const combined = await PDFDocument.load(response.data);
        expect(combined.getPageCount()).toBe(500);
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('rejects 501 image pages before loading combine WASM', async () => {
        const fetchMock = await stubSuccessfulImageCombineWasmFetch();
        const {tryCombineImageInputsWithWasm} = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');
        const inputs = Array.from({length: 501}, (_value, index) => ({
            fileName: `page-${index + 1}.pgm`,
            data: createPgmBytes(index % 256),
        }));
        const sourceSnapshot = inputs.map(input => input.data.slice());

        await expect(tryCombineImageInputsWithWasm(inputs)).resolves.toMatchObject({
            status: 'fatal',
            error: {code: 'too-large'},
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(inputs.map(input => input.data)).toEqual(sourceSnapshot);

        await expect(runBrowserPdfCombineWorker(inputs)).resolves.toEqual({
            id: 1,
            ok: false,
            error: 'Invalid browser PDF combine worker request',
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('turns a valid two-frame TIFF into ordered worker PDF pages', async () => {
        const fetchMock = await stubSuccessfulImageCombineWasmFetch();
        const tiff = createTwoFrameTiffBytes();
        const response = await runBrowserPdfCombineWorker([{
            fileName: 'scan.tiff',
            data: tiff,
        }]);
        expect(response).toMatchObject({
            id: 1,
            type: 'combinePdfs',
            ok: true,
        });
        if (!response || typeof response !== 'object' || !('data' in response) || !(response.data instanceof Uint8Array)) {
            throw new Error('Expected the browser combine worker to return TIFF PDF bytes');
        }
        const combined = await PDFDocument.load(response.data);
        expect(combined.getPages().map(page => ({
            height: page.getHeight(),
            width: page.getWidth(),
        }))).toEqual([
            {
                height: 1,
                width: 1,
            },
            {
                height: 1,
                width: 2,
            },
        ]);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(tiff).toEqual(createTwoFrameTiffBytes());
    });

    it('counts TIFF frames toward the 500-page worker budget', async () => {
        const fetchMock = await stubSuccessfulImageCombineWasmFetch();
        const inputs = [
            {
                fileName: 'scan.tiff',
                data: createTwoFrameTiffBytes(),
            },
            ...Array.from({length: 499}, (_value, index) => ({
                fileName: 'page-' + (index + 1) + '.pgm',
                data: createPgmBytes(index % 256),
            })),
        ];

        const response = await runBrowserPdfCombineWorker(inputs);

        expect(response).toMatchObject({
            id: 1,
            ok: false,
            errorEnvelope: {code: 'too-large'},
        });
        expect(response).not.toHaveProperty('data');
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('returns a worker decode error without loading WASM for malformed TIFF input', async () => {
        const fetchMock = await stubSuccessfulImageCombineWasmFetch();
        const tiff = Uint8Array.of(1, 2, 3);
        const sourceSnapshot = tiff.slice();

        const response = await runBrowserPdfCombineWorker([{
            fileName: 'malformed.tiff',
            data: tiff,
        }]);

        expect(response).toMatchObject({
            id: 1,
            ok: false,
            error: expect.any(String),
        });
        expect(response).not.toHaveProperty('data');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(tiff).toEqual(sourceSnapshot);
    });

    it('combines supported image inputs through the WASM export', async () => {
        const fetchMock = createFetchMock();
        const wasmMock = createWasmExportsMock({output: new Uint8Array([
            9,
            8,
            7,
        ])});
        const instantiateMock = vi.fn(async () => ({instance: {exports: wasmMock.exports}}));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: instantiateMock,
        });
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const result = await tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([
                1,
                2,
                3,
            ]),
        }]);

        expect(result).toEqual({
            status: 'success',
            data: new Uint8Array([
                9,
                8,
                7,
            ]),
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://viewer.test/wasm/evb-pdf-image-combine.wasm',
            {signal: expect.any(AbortSignal)},
        );
        expect(instantiateMock).toHaveBeenCalledTimes(1);
        expect(wasmMock.free).toHaveBeenCalledTimes(1);
        const request = wasmMock.capturedRequest();
        expect(new TextDecoder().decode(request.slice(0, 4))).toBe('EPIC');
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        expect(view.getUint32(4, true)).toBe(1);
        expect(view.getUint32(4 + (5 * 4), true)).toBe(1);
        expect(decodeRequestNameAndData(request)).toEqual({
            data: new Uint8Array([
                1,
                2,
                3,
            ]),
            name: 'scan.png',
        });
    });

    it('stops before WASM allocation when admission is canceled after module loading', async () => {
        const wasmMock = createWasmExportsMock();
        const admission = Promise.withResolvers<{instance: {exports: object}}>();
        const instantiateMock = vi.fn(() => admission.promise);
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: instantiateMock,
        });
        const {tryCombineImageInputsWithWasm} = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');
        const controller = new AbortController();
        const combining = tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }], undefined, controller.signal);

        await vi.waitFor(() => expect(instantiateMock).toHaveBeenCalledOnce());
        controller.abort();
        admission.resolve({instance: {exports: wasmMock.exports}});

        await expect(combining).rejects.toMatchObject({name: 'AbortError'});
        expect(wasmMock.alloc).not.toHaveBeenCalled();
        expect(wasmMock.exports.evb_pdf_image_combine_build_pdf).not.toHaveBeenCalled();
    });

    it('encodes layered page specs as a version 4 WASM request', async () => {
        const wasmMock = createWasmExportsMock({output: new Uint8Array([
            4,
            5,
            6,
        ])});
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const background = new Uint8Array([
            0x50,
            0x36,
        ]);
        const mask = new Uint8Array([
            0x50,
            0x34,
        ]);
        const result = await tryCombineImageInputsWithWasm([], {pageSpecs: [{
            kind: 'layered-color',
            pageSize: {
                widthPoints: 310.32,
                heightPoints: 471.84,
            },
            jpegQuality: 80,
            ppiCap: 300,
            foregroundColor: [
                128,
                16,
                16,
            ],
            background: {
                fileName: 'background.ppm',
                data: background,
            },
            mask: {
                fileName: 'mask.pbm',
                data: mask,
            },
        }]});

        expect(result).toEqual({
            status: 'success',
            data: new Uint8Array([
                4,
                5,
                6,
            ]),
        });
        const request = wasmMock.capturedRequest();
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        expect(new TextDecoder().decode(request.slice(0, 4))).toBe('EPIC');
        expect(view.getUint32(4, true)).toBe(4);
        expect(view.getUint32(4 + (5 * 4), true)).toBe(1);
        expect(decodeV4FirstPageSpec(request)).toEqual({
            background: {
                data: background,
                name: 'background.ppm',
            },
            foregroundColor: [
                128,
                16,
                16,
            ],
            heightPoints: 471.84,
            jpegQuality: 80,
            kind: 4,
            mask: {
                data: mask,
                name: 'mask.pbm',
            },
            ppiCap: 300,
            widthPoints: 310.32,
        });
    });

    it.each([
        90,
        630,
    ] as const)('encodes page transform %i as a version 5 WASM request', async (rotationDegrees) => {
        const wasmMock = createWasmExportsMock({output: new Uint8Array([
            4,
            5,
            6,
        ])});
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryCombineImageInputsWithWasm} = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        await expect(tryCombineImageInputsWithWasm([], {pageSpecs: [{
            kind: 'image',
            pageSize: {
                widthPoints: 72,
                heightPoints: 36,
            },
            rotationDegrees,
            image: {
                fileName: 'page.ppm',
                data: new Uint8Array([
                    0x50,
                    0x36,
                ]),
            },
        }]})).resolves.toEqual({
            status: 'success',
            data: new Uint8Array([
                4,
                5,
                6,
            ]),
        });

        const request = wasmMock.capturedRequest();
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        expect(new TextDecoder().decode(request.slice(0, 4))).toBe('EPIC');
        expect(view.getUint32(4, true)).toBe(5);
        expect(view.getUint32(24, true)).toBe(1);
        const offset = 28 + 4 + 8 + 8 + 4 + 4;
        expect(view.getUint32(offset, true)).toBe(rotationDegrees);
    });

    it('skips WASM for mixed PDF inputs', async () => {
        const fetchMock = createFetchMock();
        vi.stubGlobal('fetch', fetchMock);
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const result = await tryCombineImageInputsWithWasm([{
            fileName: 'source.pdf',
            data: new Uint8Array([1]),
        }]);

        expect(result).toEqual({status: 'unsupported'});
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a cached module with an incompatible allocation ABI as unavailable', async () => {
        const wasmMock = createWasmExportsMock();
        wasmMock.exports.evb_wasm_request_allocation_abi_version.mockReturnValue(0);
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryCombineImageInputsWithWasm} = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        await expect(tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }])).resolves.toEqual({status: 'unavailable'});
        expect(wasmMock.exports.evb_pdf_image_combine_alloc).not.toHaveBeenCalled();
    });

    it('fails closed with the native error code when the WASM export rejects the image payload', async () => {
        const wasmMock = createWasmExportsMock({
            buildResultCode: -1,
            errorText: JSON.stringify({
                code: 'corrupt-xref',
                message: 'wasm failed',
            }),
        });
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const result = await tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }]);

        expect(result).toMatchObject({
            status: 'fatal',
            error: {
                code: 'corrupt-xref',
                message: 'wasm failed',
            },
        });
        expect(wasmMock.free).toHaveBeenCalledTimes(1);
        expect(loggerWarn).toHaveBeenCalledWith(
            'browser-wasm',
            'PDF image combine WASM failed',
            {
                error: 'wasm failed',
                resultCode: -1,
            },
        );
    });

    it('fails closed when WASM allocation throws before a pointer is available', async () => {
        const wasmMock = createWasmExportsMock({allocThrows: true});
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const { tryCombineImageInputsWithWasm } = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const result = await tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }]);

        expect(result).toMatchObject({
            status: 'fatal',
            error: {code: 'native-failure'},
        });
        expect(wasmMock.free).not.toHaveBeenCalled();
    });

    it('fails closed when WASM allocation returns address zero', async () => {
        const wasmMock = createWasmExportsMock({allocReturnsZero: true});
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryCombineImageInputsWithWasm} = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        const result = await tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }]);

        expect(result).toMatchObject({
            status: 'fatal',
            error: {code: 'too-large'},
        });
        expect(wasmMock.free).not.toHaveBeenCalled();
    });

    it('refuses WASM output above the shared browser combine cap', async () => {
        const wasmMock = createWasmExportsMock({reportedOutputLength: 16 * 1024 * 1024 + 1});
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryCombineImageInputsWithWasm} = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        await expect(tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }])).resolves.toMatchObject({
            status: 'fatal',
            error: {
                code: 'too-large',
                message: expect.stringContaining('16MB'),
            },
        });
        expect(wasmMock.free).toHaveBeenCalledOnce();
    });

    it('refuses an oversized WASM request before loading or allocating its memory', async () => {
        const wasmMock = createWasmExportsMock();
        const fetchMock = createFetchMock();
        vi.stubGlobal('fetch', fetchMock);
        const instantiateMock = vi.fn(async () => ({instance: {exports: wasmMock.exports}}));
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: instantiateMock,
        });
        const {tryCombineImageInputsWithWasm} = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');
        const data = new Uint8Array([1]);
        Object.defineProperty(data, 'byteLength', {value: 256 * 1024 * 1024 + 1});

        await expect(tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data,
        }])).resolves.toMatchObject({
            status: 'fatal',
            error: {
                code: 'too-large',
                message: 'Image combine WASM request exceeds the admission ceiling',
            },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(instantiateMock).not.toHaveBeenCalled();
        expect(wasmMock.alloc).not.toHaveBeenCalled();
        expect(wasmMock.exports.evb_pdf_image_combine_build_pdf).not.toHaveBeenCalled();
    });

    it('rejects an out-of-bounds allocation pointer and releases ABI ownership', async () => {
        const wasmMock = createWasmExportsMock();
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
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryCombineImageInputsWithWasm} = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        await expect(tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }])).resolves.toMatchObject({
            status: 'fatal',
            error: {code: 'native-failure'},
        });
        expect(wasmMock.exports.evb_pdf_image_combine_build_pdf).not.toHaveBeenCalled();
        expect(wasmMock.free).toHaveBeenCalledOnce();

        await expect(tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }])).resolves.toMatchObject({status: 'success'});
        expect(wasmMock.exports.evb_pdf_image_combine_build_pdf).toHaveBeenCalledOnce();
        expect(wasmMock.free).toHaveBeenCalledTimes(2);
    });

    it('rejects an out-of-bounds output span and frees the valid request allocation', async () => {
        const wasmMock = createWasmExportsMock();
        wasmMock.exports.evb_pdf_image_combine_output_ptr.mockReturnValue(65_535);
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryCombineImageInputsWithWasm} = await import('@app/platform/browser-api/tryCombineImageInputsWithWasm');

        await expect(tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }])).resolves.toMatchObject({
            status: 'fatal',
            error: {code: 'native-failure'},
        });
        expect(wasmMock.exports.evb_pdf_image_combine_build_pdf).toHaveBeenCalledOnce();
        expect(wasmMock.free).toHaveBeenCalledOnce();
    });

    it.each([
        'not-json',
        JSON.stringify({
            code: 'future-native-code',
            message: 'future failure',
        }),
    ])('falls back to native-failure for malformed or unknown WASM errors', async (errorText) => {
        const wasmMock = createWasmExportsMock({
            buildResultCode: -1,
            errorText,
        });
        vi.stubGlobal('fetch', createFetchMock());
        vi.stubGlobal('WebAssembly', {
            ...wasmGlobalMockBase,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryCombineImageInputsWithWasm} = await import(
            '@app/platform/browser-api/tryCombineImageInputsWithWasm'
        );

        await expect(tryCombineImageInputsWithWasm([{
            fileName: 'scan.png',
            data: new Uint8Array([1]),
        }])).resolves.toMatchObject({
            status: 'fatal',
            error: {code: 'native-failure'},
        });
    });
});
