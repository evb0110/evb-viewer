import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    iterateDecodedTiffFrames,
    readTiffFrameDimensions,
} from '@pdf-core/iterateDecodedTiffFrames';
import { createTiffBytes } from './createTiffBytes';

const utifMock = vi.hoisted(() => ({
    decode: vi.fn(),
    decodeImage: vi.fn(),
    toRGBA8: vi.fn(),
}));

vi.mock('utif', () => {
    const decode = (...args: unknown[]) => utifMock.decode(...args);
    const decodeImage = (...args: unknown[]) => utifMock.decodeImage(...args);
    const toRGBA8 = (...args: unknown[]) => utifMock.toRGBA8(...args);
    return {
        decode,
        decodeImage,
        toRGBA8,
        default: {
            decode,
            decodeImage,
            toRGBA8,
        },
    };
});

describe('iterateDecodedTiffFrames', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        utifMock.decode.mockReturnValue([]);
        utifMock.decodeImage.mockImplementation(() => undefined);
        utifMock.toRGBA8.mockReturnValue(new Uint8Array());
    });

    it('yields decoded RGBA frames within the configured limits', () => {
        const frame = {
            width: 2,
            height: 3,
        };
        const rgba = new Uint8Array(2 * 3 * 4).fill(255);
        utifMock.decode.mockReturnValue([frame]);
        utifMock.toRGBA8.mockReturnValue(rgba);

        expect([...iterateDecodedTiffFrames(new Uint8Array([1]), {
            maxFrames: 1,
            maxPixels: 6,
            sourceLabel: 'scan.tif',
        })]).toEqual([{
            frame,
            width: 2,
            height: 3,
            rgba,
        }]);
    });

    it('rejects oversized frame counts before decoding image data', () => {
        utifMock.decode.mockReturnValue([
            {},
            {},
        ]);

        expect(() => [...iterateDecodedTiffFrames(new Uint8Array([1]), {
            maxFrames: 1,
            sourceLabel: 'scan.tif',
        })]).toThrow('TIFF frame count is capped at 1: scan.tif');
        expect(utifMock.decodeImage).not.toHaveBeenCalled();
        expect(utifMock.toRGBA8).not.toHaveBeenCalled();
    });

    it('preflights a valid TIFF IFD chain before asking UTIF to parse every frame', () => {
        const bytes = new Uint8Array(20);
        const view = new DataView(bytes.buffer);
        bytes.set([
            0x49,
            0x49,
        ], 0);
        view.setUint16(2, 42, true);
        view.setUint32(4, 8, true);
        view.setUint16(8, 0, true);
        view.setUint32(10, 14, true);
        view.setUint16(14, 0, true);
        view.setUint32(16, 0, true);

        expect(() => [...iterateDecodedTiffFrames(bytes, {
            maxFrames: 1,
            sourceLabel: 'ifd-chain.tif',
        })]).toThrow('TIFF frame count is capped at 1: ifd-chain.tif');
        expect(utifMock.decode).not.toHaveBeenCalled();
    });

    it('rejects oversized decoded dimensions before allocating RGBA output', () => {
        const frame = {
            width: 10_000,
            height: 10_000,
        };
        utifMock.decode.mockReturnValue([frame]);

        expect(() => [...iterateDecodedTiffFrames(new Uint8Array([1]), {
            maxPixels: 80_000_000,
            sourceLabel: 'huge.tif',
        })]).toThrow('TIFF frame dimensions are too large to decode safely: huge.tif');
        expect(utifMock.decodeImage).not.toHaveBeenCalled();
        expect(utifMock.toRGBA8).not.toHaveBeenCalled();
    });

    it('rejects aggregate frame pixels before decoding any frame', () => {
        utifMock.decode.mockReturnValue([
            {
                width: 10,
                height: 10,
            },
            {
                width: 10,
                height: 10,
            },
        ]);

        expect(() => [...iterateDecodedTiffFrames(new Uint8Array([1]), {
            maxPixels: 100,
            maxTotalPixels: 150,
            sourceLabel: 'many.tif',
        })]).toThrow('TIFF aggregate decoded pixels are capped at 150: many.tif');
        expect(utifMock.decodeImage).not.toHaveBeenCalled();
    });
});

function createByteReader(bytes: Uint8Array) {
    const reads = {bytes: 0};
    return {
        reads,
        read: async (offset: number, length: number) => {
            const chunk = bytes.slice(offset, offset + length);
            reads.bytes += chunk.byteLength;
            return chunk;
        },
    };
}

describe('readTiffFrameDimensions', () => {
    it('reads every frame size from the page directories without reading pixel data', async () => {
        const bytes = createTiffBytes([
            {
                width: 2550,
                height: 3300,
            },
            {
                width: 1700,
                height: 2200,
            },
            {
                width: 3300,
                height: 2550,
            },
        ], {pixelBytesPerFrame: 256 * 1024});
        const reader = createByteReader(bytes);

        await expect(readTiffFrameDimensions(reader.read, {sourceLabel: 'scan.tif'})).resolves.toEqual([
            {
                width: 2550,
                height: 3300,
            },
            {
                width: 1700,
                height: 2200,
            },
            {
                width: 3300,
                height: 2550,
            },
        ]);
        expect(bytes.byteLength).toBeGreaterThan(768 * 1024);
        expect(reader.reads.bytes).toBeLessThan(512);
    });

    it.each([
        [
            'big-endian',
            {bigEndian: true},
        ],
        [
            'BigTIFF',
            {bigTiff: true},
        ],
        [
            'big-endian BigTIFF',
            {
                bigEndian: true,
                bigTiff: true,
            },
        ],
    ])('reads %s directories', async (_layout, options) => {
        const bytes = createTiffBytes([
            {
                width: 640,
                height: 480,
            },
            {
                width: 480,
                height: 640,
            },
        ], options);

        await expect(readTiffFrameDimensions(createByteReader(bytes).read, {})).resolves.toEqual([
            {
                width: 640,
                height: 480,
            },
            {
                width: 480,
                height: 640,
            },
        ]);
    });

    it('skips a directory without an image width and finds no frames in a file that is not a TIFF', async () => {
        const withoutWidth = createTiffBytes([
            {height: 10},
            {
                width: 20,
                height: 30,
            },
        ]);

        await expect(readTiffFrameDimensions(createByteReader(withoutWidth).read, {})).resolves.toEqual([{
            width: 20,
            height: 30,
        }]);
        await expect(readTiffFrameDimensions(createByteReader(new TextEncoder().encode('%PDF-1.7 not a TIFF')).read, {}))
            .resolves.toEqual([]);
    });

    it('enforces the frame cap while walking the directory chain', async () => {
        const bytes = createTiffBytes(Array.from({length: 4}, () => ({
            width: 10,
            height: 10,
        })));

        await expect(readTiffFrameDimensions(createByteReader(bytes).read, {
            maxFrames: 3,
            sourceLabel: 'many.tif',
        })).rejects.toThrow('TIFF frame count is capped at 3: many.tif');
    });

    it('rejects a frame over the pixel cap from its directory', async () => {
        const bytes = createTiffBytes([{
            width: 10_000,
            height: 9_000,
        }]);

        await expect(readTiffFrameDimensions(createByteReader(bytes).read, {
            maxPixels: 80_000_000,
            sourceLabel: 'huge.tif',
        })).rejects.toThrow('TIFF frame dimensions are too large to decode safely: huge.tif');
    });

    it.each([
        [
            'loops back to an earlier directory',
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
        ],
        [
            'is truncated before its last directory',
            createTiffBytes([
                {
                    width: 10,
                    height: 10,
                },
                {
                    width: 10,
                    height: 10,
                },
            ], {pixelBytesPerFrame: 1024}).slice(0, 1500),
        ],
        [
            'gives a width without a height',
            createTiffBytes([{width: 10}]),
        ],
    ])('reports a page directory chain that %s as damaged', async (_damage, bytes) => {
        await expect(readTiffFrameDimensions(createByteReader(bytes).read, {sourceLabel: 'damaged.tif'}))
            .rejects.toThrow('TIFF page directory is damaged or truncated: damaged.tif');
    });
});
