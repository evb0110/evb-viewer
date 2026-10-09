import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    iterateDecodedTiffFrames,
    readTiffFrameDimensions,
    readTiffFrameDimensionsFromBytes,
} from '@pdf-core/iterateDecodedTiffFrames';
import { createTiffBytes } from './createTiffBytes';

function decodeAll(bytes: Uint8Array, options: Parameters<typeof iterateDecodedTiffFrames>[1] = {}) {
    return [...iterateDecodedTiffFrames(bytes, options)].map(({
        width,
        height,
        rgba,
    }) => ({
        width,
        height,
        rgba: Buffer.from(rgba).toString('hex'),
    }));
}

describe('iterateDecodedTiffFrames', () => {
    it('decodes each frame of a real TIFF to RGBA', () => {
        const bytes = createTiffBytes([
            {
                width: 3,
                height: 1,
                grayPixels: Uint8Array.of(0, 128, 255),
            },
            {
                width: 1,
                height: 2,
                grayPixels: Uint8Array.of(40, 200),
            },
        ]);

        expect(decodeAll(bytes, {sourceLabel: 'scan.tif'})).toEqual([
            {
                width: 3,
                height: 1,
                rgba: '000000ff808080ffffffffff',
            },
            {
                width: 1,
                height: 2,
                rgba: '282828ffc8c8c8ff',
            },
        ]);
    });

    it('rejects more frames than the cap before decoding any of them', () => {
        const bytes = createTiffBytes(Array.from({length: 3}, () => ({
            width: 1,
            height: 1,
            grayPixels: Uint8Array.of(7),
        })));

        expect(() => decodeAll(bytes, {
            maxFrames: 2,
            sourceLabel: 'many.tif',
        })).toThrow('TIFF frame count is capped at 2: many.tif');
    });

    it('rejects a frame over the pixel cap from its directory instead of allocating it', () => {
        // Decoding this frame would ask UTIF for a 10-gigabyte buffer.
        const bytes = createTiffBytes([{
            width: 100_000,
            height: 100_000,
        }]);

        expect(() => decodeAll(bytes, {
            maxPixels: 80_000_000,
            sourceLabel: 'huge.tif',
        })).toThrow('TIFF frame dimensions are too large to decode safely: huge.tif');
    });

    it('rejects total pixels over the budget before decoding any frame', () => {
        const bytes = createTiffBytes(Array.from({length: 2}, () => ({
            width: 10,
            height: 10,
            grayPixels: new Uint8Array(100).fill(90),
        })));

        expect(() => decodeAll(bytes, {
            maxPixels: 100,
            maxTotalPixels: 150,
            sourceLabel: 'budget.tif',
        })).toThrow('TIFF aggregate decoded pixels are capped at 150: budget.tif');
    });

    it.each([
        [
            'loops back to an earlier directory',
            createTiffBytes([
                {
                    width: 1,
                    height: 1,
                    grayPixels: Uint8Array.of(1),
                },
                {
                    width: 1,
                    height: 1,
                    grayPixels: Uint8Array.of(2),
                },
            ], {loopLastDirectoryToFirst: true}),
        ],
        [
            'is truncated before its last directory',
            createTiffBytes([
                {
                    width: 32,
                    height: 32,
                    grayPixels: new Uint8Array(1024),
                },
                {
                    width: 32,
                    height: 32,
                    grayPixels: new Uint8Array(1024),
                },
            ]).slice(0, 1500),
        ],
    ])('fails on a page directory chain that %s instead of handing it to UTIF', (_damage, bytes) => {
        expect(() => decodeAll(bytes, {sourceLabel: 'damaged.tif'}))
            .toThrow('TIFF page directory is damaged or truncated: damaged.tif');
    });

    it('yields nothing for bytes that are not a TIFF', () => {
        expect(decodeAll(new TextEncoder().encode('not a TIFF'))).toEqual([]);
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

describe('readTiffFrameDimensionsFromBytes', () => {
    it('reads in-memory frame sizes and enforces the total budget without decoding pixels', () => {
        // Neither frame has strip data, so only the directories can supply these sizes.
        const bytes = createTiffBytes([
            {
                width: 2550,
                height: 3300,
            },
            {
                width: 1700,
                height: 2200,
            },
        ]);

        expect(readTiffFrameDimensionsFromBytes(bytes, {})).toEqual([
            {
                width: 2550,
                height: 3300,
            },
            {
                width: 1700,
                height: 2200,
            },
        ]);
        expect(() => readTiffFrameDimensionsFromBytes(bytes, {
            maxTotalPixels: 10_000_000,
            sourceLabel: 'scan.tif',
        })).toThrow('TIFF aggregate decoded pixels are capped at 10000000: scan.tif');
    });
});
