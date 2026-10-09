import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    readTiffFrameDimensions,
    readTiffFrameDimensionsFromBytes,
} from '@pdf-core/iterateDecodedTiffFrames';
import { createTiffBytes } from './createTiffBytes';

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
