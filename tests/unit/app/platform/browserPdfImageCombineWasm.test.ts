import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const NativeWebAssembly = WebAssembly;
const wasmGlobalMockBase = {Memory: NativeWebAssembly.Memory};
const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: loggerWarn}}));

function createFetchMock() {
    return vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
    }));
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

    it('encodes catalog metadata and page rotation as a version 5 WASM request', async () => {
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

        await expect(tryCombineImageInputsWithWasm([], {
            catalog: {
                bookmarks: [{
                    title: 'Chapter 1',
                    pageIndex: 0,
                    pageYRatio: 0.25,
                    namedDest: 'chapter-1',
                    bold: true,
                    italic: false,
                    color: '#336699',
                    items: [],
                }],
                pageLabels: [{
                    pageIndex: 0,
                    style: 'D',
                    prefix: 'Page ',
                    start: 1,
                }],
            },
            pageSpecs: [{
                kind: 'image',
                pageSize: {
                    widthPoints: 72,
                    heightPoints: 36,
                },
                rotationDegrees: 90,
                image: {
                    fileName: 'page.ppm',
                    data: new Uint8Array([
                        0x50,
                        0x36,
                    ]),
                },
            }],
        })).resolves.toEqual({
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
        let offset = 28;
        expect(view.getUint32(offset, true)).toBe(1);
        offset += 4;
        expect(view.getUint32(offset, true)).toBe(1);
        offset += 4;
        const titleLength = view.getUint32(offset, true);
        offset += 4;
        expect(new TextDecoder().decode(request.slice(offset, offset + titleLength))).toBe('Chapter 1');
        offset += titleLength;
        expect(view.getUint32(offset, true)).toBe(0);
        offset += 4;
        expect(view.getFloat64(offset, true)).toBe(0.25);
        offset += 8;
        const namedDestinationLength = view.getUint32(offset, true);
        offset += 4;
        expect(new TextDecoder().decode(request.slice(offset, offset + namedDestinationLength))).toBe('chapter-1');
        offset += namedDestinationLength;
        expect(view.getUint32(offset, true)).toBe(1);
        offset += 4;
        expect(view.getUint32(offset, true)).toBe(0);
        offset += 4;
        const colorLength = view.getUint32(offset, true);
        offset += 4;
        expect(new TextDecoder().decode(request.slice(offset, offset + colorLength))).toBe('#336699');
        offset += colorLength;
        expect(view.getUint32(offset, true)).toBe(0);
        offset += 4;
        expect(view.getUint32(offset, true)).toBe(1);
        offset += 4;
        const styleLength = view.getUint32(offset, true);
        offset += 4;
        expect(new TextDecoder().decode(request.slice(offset, offset + styleLength))).toBe('D');
        offset += styleLength;
        const prefixLength = view.getUint32(offset, true);
        offset += 4;
        expect(new TextDecoder().decode(request.slice(offset, offset + prefixLength))).toBe('Page ');
        offset += prefixLength;
        expect(view.getUint32(offset, true)).toBe(1);
        offset += 4;
        expect(view.getUint32(offset, true)).toBe(1);
        offset += 4 + 8 + 8 + 4 + 4;
        expect(view.getUint32(offset, true)).toBe(90);
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
