import {
    access,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {decode} from 'fast-png';
import {
    readPpmDimensions,
    readPpmRaster,
    writePngFromPpm,
} from '@evb/scan-cleanup/core/rasterLayerDimensions';

const temporaryDirectories: string[] = [];

async function createPpm(contents: Buffer) {
    const directory = await mkdtemp(join(tmpdir(), 'evb-ppm-raster-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'page.ppm');
    await writeFile(path, contents);
    return path;
}

describe('rasterLayerDimensions PPM reads', () => {
    afterEach(async () => {
        await Promise.all(temporaryDirectories.splice(0).map(
            directory => rm(directory, {
                force: true,
                recursive: true,
            }),
        ));
    });

    it('reads only the exact payload declared by a valid PPM header', async () => {
        const path = await createPpm(Buffer.concat([
            Buffer.from('P6\n2 1\n255\n', 'ascii'),
            Buffer.from([
                0x01,
                0x02,
                0x03,
                0x04,
                0x05,
                0x06,
            ]),
        ]));

        await expect(readPpmRaster(path, {
            maxDimensionPx: 100,
            maxPixels: 100,
        })).resolves.toEqual({
            width: 2,
            height: 1,
            isColor: true,
            pixels: Buffer.from([
                0x01,
                0x02,
                0x03,
                0x04,
                0x05,
                0x06,
            ]),
        });
    });

    it('rejects a small declared raster with a surplus tail before materialization', async () => {
        const path = await createPpm(Buffer.concat([
            Buffer.from('P6\n1 1\n255\n', 'ascii'),
            Buffer.from([
                0x01,
                0x02,
                0x03,
            ]),
            Buffer.alloc(1024 * 1024, 0xff),
        ]));

        await expect(readPpmRaster(path, {
            maxDimensionPx: 100,
            maxPixels: 100,
        })).rejects.toThrow(`Surplus PPM payload for ${path}`);
        await expect(readPpmDimensions(path)).rejects.toThrow(`Surplus PPM payload for ${path}`);
    });

    it('rejects a truncated declared payload', async () => {
        const path = await createPpm(Buffer.concat([
            Buffer.from('P6\n2 1\n255\n', 'ascii'),
            Buffer.from([
                0x01,
                0x02,
                0x03,
            ]),
        ]));

        await expect(readPpmRaster(path, {
            maxDimensionPx: 100,
            maxPixels: 100,
        })).rejects.toThrow(`Truncated PPM payload for ${path}`);
    });

    it('honors cancellation before allocating the pixel payload', async () => {
        const path = await createPpm(Buffer.concat([
            Buffer.from('P6\n1 1\n255\n', 'ascii'),
            Buffer.from([
                0x01,
                0x02,
                0x03,
            ]),
        ]));
        const controller = new AbortController();
        controller.abort(new Error('cancelled'));

        await expect(readPpmRaster(path, {
            maxDimensionPx: 100,
            maxPixels: 100,
            signal: controller.signal,
        })).rejects.toThrow('cancelled');
    });

    // Poppler's PNG writer is fixed at maximum compression; scan cleanup and
    // OCR encode Poppler's PPM instead. A page larger than one encoder block
    // becomes several IDAT chunks, and every pixel must survive.
    it('encodes a PPM larger than one block as a PNG with the same pixels', async () => {
        const width = 700;
        const height = 600;
        const pixels = Buffer.alloc(width * height * 3);
        for (let index = 0; index < pixels.length; index += 1) {
            pixels[index] = (index * 7 + (index >> 9)) & 0xff;
        }
        const path = await createPpm(Buffer.concat([
            Buffer.from(`P6\n${String(width)} ${String(height)}\n255\n`, 'ascii'),
            pixels,
        ]));
        const pngPath = path.replace(/\.ppm$/u, '.png');

        await expect(writePngFromPpm(path, pngPath, {
            maxDimensionPx: 1_000,
            maxPixels: 1_000_000,
        })).resolves.toEqual({
            width,
            height,
        });
        const image = decode(await readFile(pngPath));
        expect([
            image.width,
            image.height,
            image.channels,
            image.depth,
        ]).toEqual([
            width,
            height,
            3,
            8,
        ]);
        expect(Buffer.from(image.data).equals(pixels)).toBe(true);
    });

    it('refuses a PPM over the caller\'s limits before writing a PNG', async () => {
        const path = await createPpm(Buffer.concat([
            Buffer.from('P6\n4 4\n255\n', 'ascii'),
            Buffer.alloc(4 * 4 * 3),
        ]));
        const pngPath = path.replace(/\.ppm$/u, '.png');

        await expect(writePngFromPpm(path, pngPath, {
            maxDimensionPx: 100,
            maxPixels: 8,
        })).rejects.toThrow('PPM raster 4x4 exceeds limits');
        await expect(access(pngPath)).rejects.toMatchObject({code: 'ENOENT'});
    });
});
