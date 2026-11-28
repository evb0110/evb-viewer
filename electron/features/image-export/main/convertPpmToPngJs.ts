import {copyFile, readFile, rename, rm, stat, unlink, writeFile} from 'fs/promises';
import {encode as encodePng} from 'fast-png';
import {createAbortError} from '@contracts/isAbortError';
import {isErrnoException} from '@contracts/runtimeGuards';
import {addPngPhysicalResolution} from '@pdf-core/addPngPhysicalResolution';
import {IMAGE_EXPORT_MAX_NETPBM_READ_BYTES} from '@pdf-core/imageExportResolution';
import {makeSiblingTempPath} from '@electron/utils/atomicReplace';

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

function readPnmToken(bytes: Uint8Array, cursor: {offset: number}) {
    while (cursor.offset < bytes.length) {
        const byte = bytes[cursor.offset];
        if (byte === 0x23) {
            while (cursor.offset < bytes.length && bytes[cursor.offset] !== 0x0a) {
                cursor.offset += 1;
            }
            continue;
        }
        if (byte !== undefined && byte <= 0x20) {
            cursor.offset += 1;
            continue;
        }
        break;
    }

    const start = cursor.offset;
    while (cursor.offset < bytes.length) {
        const byte = bytes[cursor.offset];
        if (byte === undefined || byte <= 0x20) {
            break;
        }
        cursor.offset += 1;
    }

    if (start === cursor.offset) {
        throw new Error('Invalid PPM image header');
    }

    return Buffer.from(bytes.buffer, bytes.byteOffset + start, cursor.offset - start).toString('ascii');
}

function parsePositivePnmInteger(value: string, label: string) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Invalid PPM ${label}`);
    }
    return parsed;
}

function parseRawPpm(bytes: Uint8Array) {
    const cursor = {offset: 0};
    const magic = readPnmToken(bytes, cursor);
    if (magic !== 'P6') {
        throw new Error(`Unsupported PPM image type: ${magic}`);
    }

    const width = parsePositivePnmInteger(readPnmToken(bytes, cursor), 'width');
    const height = parsePositivePnmInteger(readPnmToken(bytes, cursor), 'height');
    const maxValue = parsePositivePnmInteger(readPnmToken(bytes, cursor), 'max value');
    if (maxValue !== 255) {
        throw new Error(`Unsupported PPM max value: ${maxValue}`);
    }

    if (cursor.offset < bytes.length) {
        const separator = bytes[cursor.offset];
        if (separator !== undefined && separator <= 0x20) {
            cursor.offset += 1;
        }
    }

    const expectedByteLength = width * height * 3;
    const data = bytes.subarray(cursor.offset);
    if (data.length !== expectedByteLength) {
        throw new Error(`Invalid PPM pixel data length: expected ${expectedByteLength}, found ${data.length}`);
    }

    return {
        width,
        height,
        data,
    };
}

function createLosslessGrayscaleData(data: Uint8Array) {
    const grayscaleData = new Uint8Array(data.length / 3);
    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < data.length; sourceIndex += 3, targetIndex += 1) {
        const red = data[sourceIndex];
        const green = data[sourceIndex + 1];
        const blue = data[sourceIndex + 2];
        if (red === undefined || green === undefined || blue === undefined || red !== green || red !== blue) {
            return null;
        }
        grayscaleData[targetIndex] = red;
    }
    return grayscaleData;
}

export async function assertReadableRenderedPpmFile(sourcePath: string) {
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
        throw new Error(`Rendered PPM output is not a regular file: ${sourcePath}`);
    }
    if (sourceStat.size > IMAGE_EXPORT_MAX_NETPBM_READ_BYTES) {
        const maxMb = Math.floor(IMAGE_EXPORT_MAX_NETPBM_READ_BYTES / (1024 * 1024));
        throw new Error(`Rendered PPM output exceeds safe read limit (${maxMb}MB): ${sourcePath}`);
    }
    return sourceStat.size;
}

export async function convertRenderedPpmToPngJs(sourcePath: string, pngPath: string, dpi: number, signal?: AbortSignal) {
    throwIfAborted(signal);
    await assertReadableRenderedPpmFile(sourcePath);
    throwIfAborted(signal);
    const sourceBytes = await readFile(sourcePath);
    throwIfAborted(signal);
    const image = parseRawPpm(sourceBytes);
    const grayscaleData = createLosslessGrayscaleData(image.data);
    throwIfAborted(signal);
    const pngBytes = encodePng({
        width: image.width,
        height: image.height,
        channels: grayscaleData ? 1 : 3,
        depth: 8,
        data: grayscaleData ?? image.data,
    });
    throwIfAborted(signal);
    const encodedPng = addPngPhysicalResolution(pngBytes, dpi);
    const tempPngPath = makeSiblingTempPath(pngPath);
    try {
        await writeFile(tempPngPath, encodedPng);
        throwIfAborted(signal);
        try {
            await rename(tempPngPath, pngPath);
        } catch (error) {
            if (!isErrnoException(error) || error.code !== 'EXDEV') {
                throw error;
            }
            await copyFile(tempPngPath, pngPath);
            await rm(tempPngPath, {force: true}).catch(() => undefined);
        }
    } catch (error) {
        await rm(tempPngPath, {force: true}).catch(() => undefined);
        throw error;
    }
    await unlink(sourcePath).catch(() => undefined);
    return pngPath;
}
