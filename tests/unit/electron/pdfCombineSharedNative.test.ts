import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createTiffBytes } from '../pdf-core/createTiffBytes';

const mocks = vi.hoisted(() => {
    let headerPrefix: Uint8Array = new Uint8Array();
    const fileReads = {bytes: 0};
    const openFileClose = vi.fn();
    const openFileRead = vi.fn(async (buffer: Uint8Array, offset = 0, length = buffer.byteLength, position = 0) => {
        const chunk = headerPrefix.subarray(position, position + length);
        buffer.set(chunk, offset);
        fileReads.bytes += chunk.byteLength;
        return { bytesRead: chunk.byteLength };
    });
    const open = vi.fn(async () => ({
        read: openFileRead,
        close: openFileClose,
    }));
    const readFile = vi.fn(async () => new Uint8Array([
        1,
        2,
        3,
    ]));
    const mkdtemp = vi.fn(async () => '/tmp/pdfExport-scope-normalized');
    const rm = vi.fn(async () => undefined);
    const writeFile = vi.fn(async () => undefined);
    const stat = vi.fn(async () => ({
        isFile: () => true,
        size: 1024,
    }));
    const drawImage = vi.fn();
    const addPage = vi.fn(() => ({drawImage}));
    const embedPng = vi.fn(async () => ({
        width: 10,
        height: 20,
    }));
    const save = vi.fn<() => Promise<{byteLength: number}>>(async () => new Uint8Array([
        9,
        9,
    ]));
    const create = vi.fn(async () => ({
        addPage,
        embedPng,
        embedJpg: vi.fn(),
        save,
    }));
    const nativeImageToPng = vi.fn(() => new Uint8Array([
        8,
        8,
    ]));
    const nativeImageIsEmpty = vi.fn(() => false);
    const nativeImageCreateFromPath = vi.fn(() => ({
        isEmpty: nativeImageIsEmpty,
        toPNG: nativeImageToPng,
    }));

    return {
        get headerPrefix() {
            return headerPrefix;
        },
        set headerPrefix(value: Uint8Array) {
            headerPrefix = value;
        },
        fileReads,
        open,
        openFileClose,
        openFileRead,
        readFile,
        mkdtemp,
        rm,
        writeFile,
        stat,
        drawImage,
        addPage,
        embedPng,
        save,
        create,
        nativeImageCreateFromPath,
        nativeImageIsEmpty,
        nativeImageToPng,
    };
});

vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: () => '/tmp'}));

vi.mock('fs/promises', () => ({
    mkdir: async () => undefined,
    lstat: async () => ({
        isDirectory: () => true,
        isFile: () => true,
        isSymbolicLink: () => false,
    }),
    mkdtemp: mocks.mkdtemp,
    open: mocks.open,
    readFile: (path: string, ...args: unknown[]) => path.endsWith('.evb-managed-scratch.json')
        ? Promise.resolve(JSON.stringify({
            createdAt: 0,
            pid: process.pid,
            prefix: 'pdfExport-scope-',
        }))
        : Reflect.apply(mocks.readFile, undefined, [
            path,
            ...args,
        ]),
    rm: mocks.rm,
    stat: mocks.stat,
    writeFile: mocks.writeFile,
}));

vi.mock('pdf-lib', () => ({PDFDocument: {create: mocks.create}}));

vi.mock('electron', () => ({
    app: {isPackaged: false},
    nativeImage: {createFromPath: mocks.nativeImageCreateFromPath},
}));

const {stageNativeCombineInputs} = await import('@electron/image/pdfCombineShared');

describe('native combine input preflight', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.headerPrefix = new Uint8Array();
        mocks.fileReads.bytes = 0;
        mocks.readFile.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 1024,
        });
        mocks.save.mockResolvedValue(new Uint8Array([
            9,
            9,
        ]));
    });

    it('stages image sets above 500 pages', async () => {
        const inputPaths = Array.from({length: 501}, (_, index) => `/tmp/page-${index}.jpg`);

        await expect(stageNativeCombineInputs(inputPaths)).resolves.toMatchObject({inputPaths});
    });

    it('rejects oversized JS fallback inputs before reading them', async () => {
        mocks.stat.mockResolvedValueOnce({
            isFile: () => true,
            size: 513 * 1024 * 1024,
        });

        await expect(stageNativeCombineInputs(['/tmp/huge.png']))
            .rejects
            .toThrow('Input file is too large to combine safely: /tmp/huge.png');

        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.embedPng).not.toHaveBeenCalled();
    });

    it.each([
        [
            'BMP',
            '/tmp/oversized.bmp',
            createBmpHeader(10_000, 10_000),
        ],
        [
            'GIF',
            '/tmp/oversized.gif',
            createGifHeader(10_000, 10_000),
        ],
        [
            'WEBP',
            '/tmp/oversized.webp',
            createWebpExtendedHeader(10_000, 10_000),
        ],
    ])('rejects oversized %s dimensions before Electron decodes the image', async (_format, sourcePath, header) => {
        mocks.headerPrefix = header;

        await expect(stageNativeCombineInputs([sourcePath]))
            .rejects
            .toThrow(`Image dimensions are too large to combine safely: ${sourcePath}`);

        expect(mocks.open).toHaveBeenCalledWith(sourcePath, 'r');
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.nativeImageCreateFromPath).not.toHaveBeenCalled();
        expect(mocks.embedPng).not.toHaveBeenCalled();
        expect(mocks.addPage).not.toHaveBeenCalled();
    });

    it.each([
        [
            'BMP',
            '/tmp/unparseable.bmp',
            new Uint8Array([
                0x42,
                0x4d,
            ]),
        ],
        [
            'GIF',
            '/tmp/unparseable.gif',
            new Uint8Array([
                0x47,
                0x49,
                0x46,
            ]),
        ],
        [
            'WEBP',
            '/tmp/unparseable.webp',
            new Uint8Array([
                0x52,
                0x49,
                0x46,
                0x46,
            ]),
        ],
    ])('fails closed for an unparseable %s header before Electron decodes the image', async (_format, sourcePath, header) => {
        mocks.headerPrefix = header;

        await expect(stageNativeCombineInputs([sourcePath]))
            .rejects
            .toThrow(`Image dimensions are too large to combine safely: ${sourcePath}`);

        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.nativeImageCreateFromPath).not.toHaveBeenCalled();
        expect(mocks.embedPng).not.toHaveBeenCalled();
    });
});

describe('TIFF combine preflight', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.fileReads.bytes = 0;
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 1024,
        });
    });

    it.each([
        [
            'more frames than the TIFF frame cap',
            createTiffBytes(Array.from({length: 251}, () => ({
                width: 10,
                height: 10,
            }))),
            'TIFF frame count is capped at 250: /tmp/scan.tif',
        ],
        [
            'a frame over the pixel cap',
            createTiffBytes([{
                width: 10_000,
                height: 9_000,
            }]),
            'TIFF frame dimensions are too large to decode safely: /tmp/scan.tif',
        ],
        [
            'a page directory chain that loops',
            createTiffBytes([
                {
                    width: 10,
                    height: 10,
                },
                {
                    width: 10,
                    height: 10,
                },
            ], {loopLastDirectoryToFirst: true}),
            'TIFF page directory is damaged or truncated: /tmp/scan.tif',
        ],
        [
            'no image directory',
            createTiffBytes([{height: 10}]),
            'No decodable TIFF pages found in /tmp/scan.tif',
        ],
        [
            'bytes that are not a TIFF',
            new TextEncoder().encode('not a TIFF at all'),
            'No decodable TIFF pages found in /tmp/scan.tif',
        ],
    ])('refuses %s before staging', async (_case, bytes, message) => {
        mocks.headerPrefix = bytes;

        await expect(stageNativeCombineInputs(['/tmp/scan.tif']))
            .rejects.toThrow(message);

    });
});

function writeUint16LE(data: Uint8Array, offset: number, value: number) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >>> 8) & 0xff;
}

function writeInt32LE(data: Uint8Array, offset: number, value: number) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >>> 8) & 0xff;
    data[offset + 2] = (value >>> 16) & 0xff;
    data[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint24LE(data: Uint8Array, offset: number, value: number) {
    data[offset] = value & 0xff;
    data[offset + 1] = (value >>> 8) & 0xff;
    data[offset + 2] = (value >>> 16) & 0xff;
}

function createBmpHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(new ArrayBuffer(26));
    data[0] = 0x42;
    data[1] = 0x4d;
    writeInt32LE(data, 14, 40);
    writeInt32LE(data, 18, width);
    writeInt32LE(data, 22, height);
    return data;
}

function createGifHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(new ArrayBuffer(10));
    data.set([
        0x47,
        0x49,
        0x46,
        0x38,
        0x39,
        0x61,
    ]);
    writeUint16LE(data, 6, width);
    writeUint16LE(data, 8, height);
    return data;
}

function createWebpExtendedHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
    const data = new Uint8Array(new ArrayBuffer(30));
    data.set([
        0x52,
        0x49,
        0x46,
        0x46,
        0x16,
        0x00,
        0x00,
        0x00,
        0x57,
        0x45,
        0x42,
        0x50,
        0x56,
        0x50,
        0x38,
        0x58,
        0x0a,
        0x00,
        0x00,
        0x00,
    ]);
    writeUint24LE(data, 24, width - 1);
    writeUint24LE(data, 27, height - 1);
    return data;
}
