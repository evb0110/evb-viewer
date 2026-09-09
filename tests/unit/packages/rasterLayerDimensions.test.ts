import {
    mkdtemp,
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
import {
    readPpmDimensions,
    readPpmRaster,
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
});
