import {
    createWriteStream,
    type WriteStream,
} from 'fs';
import {
    readFile,
    rm,
} from 'fs/promises';
import { finished } from 'node:stream/promises';
import { sumBy } from 'es-toolkit/math';
import UTIF, { type IUtifFrame } from 'utif';
import {
    buildTiffImageIfd,
    encodeTiffIfds,
} from '@pdf-core/tiffEncoding';
import type { ITiffImageDescriptor } from '@pdf-core/tiffEncoding';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { tryCombinePagesWithNativeTiffCombiner } from '@electron/features/image-export/main/tryCombinePagesWithNativeTiffCombiner';
import { abortErrorFromSignal } from '@electron/utils/abort';

interface ITiffPageRgba {
    width: number;
    height: number;
    rgba: Uint8Array;
}

type TTiffOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

interface ILocalTiffPageDescriptor extends ITiffImageDescriptor {
    orientation: TTiffOrientation;
    path: string;
    sourceHeight: number;
    sourceWidth: number;
}

interface ICombinePagesIntoMultiPageTiffLocalOptions {
    deleteSourcePages?: boolean;
    defaultDpi?: number;
    signal?: AbortSignal;
}

const CLASSIC_TIFF_MAX_BYTE_LENGTH = 0xFFFFFFFF;

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortErrorFromSignal(signal);
}

async function removeSourcePages(pagePaths: string[]) {
    await Promise.all(pagePaths.map(pagePath => rm(pagePath, {force: true}).catch(() => undefined)));
}

interface IIndexedArrayBufferView extends ArrayBufferView {
    readonly length: number;
    readonly [index: number]: unknown;
}

function isIndexedArrayBufferView(value: ArrayBufferView): value is IIndexedArrayBufferView {
    return 'length' in value && typeof value.length === 'number';
}

function toPositiveInteger(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }
    if (typeof value === 'bigint' && value > 0n) {
        return Number(value);
    }
    return null;
}

function resolveTiffDimensionValue(value: unknown) {
    const direct = toPositiveInteger(value);
    if (direct) {
        return direct;
    }

    if (Array.isArray(value) && value.length > 0) {
        return toPositiveInteger(value[0]);
    }

    if (ArrayBuffer.isView(value) && isIndexedArrayBufferView(value) && value.length > 0) {
        return toPositiveInteger(value[0]);
    }

    return null;
}

function resolveTiffDimension(ifd: IUtifFrame, candidates: Array<string | number>) {
    const record = ifd as Record<string | number, unknown>;

    for (const key of candidates) {
        const resolved = resolveTiffDimensionValue(record[key]);
        if (resolved) {
            return resolved;
        }
    }

    return null;
}

function resolveTiffNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (Array.isArray(value)) {
        if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number' && value[1] !== 0) {
            return value[0] / value[1];
        }
        return resolveTiffNumber(value[0]);
    }
    if (ArrayBuffer.isView(value) && isIndexedArrayBufferView(value) && value.length > 0) {
        return resolveTiffNumber(value[0]);
    }
    return null;
}

function resolveTiffOrientation(ifd: IUtifFrame): TTiffOrientation {
    const value = resolveTiffNumber((ifd as Record<string | number, unknown>).t274);
    return value === 2 || value === 3 || value === 4 || value === 5 || value === 6 || value === 7 || value === 8
        ? value
        : 1;
}

function resolveTiffDpi(ifd: IUtifFrame, defaultDpi: number) {
    const record = ifd as Record<string | number, unknown>;
    const unit = resolveTiffNumber(record.t296) ?? 2;
    const unitMultiplier = unit === 3 ? 2.54 : unit === 2 ? 1 : 0;
    const dpiX = (resolveTiffNumber(record.t282) ?? 0) * unitMultiplier;
    const dpiY = (resolveTiffNumber(record.t283) ?? 0) * unitMultiplier;
    return {
        dpiX: dpiX > 0 ? dpiX : defaultDpi,
        dpiY: dpiY > 0 ? dpiY : defaultDpi,
    };
}

function swapsTiffOrientationDimensions(orientation: TTiffOrientation) {
    return orientation >= 5;
}

function createTiffOrientationMapper(
    width: number,
    height: number,
    orientation: TTiffOrientation,
    outputWidth: number,
) {
    switch (orientation) {
        case 2:
            return (sourceX: number, sourceY: number) => (sourceY * outputWidth + width - 1 - sourceX) * 4;
        case 3:
            return (sourceX: number, sourceY: number) => (
                ((height - 1 - sourceY) * outputWidth + width - 1 - sourceX) * 4
            );
        case 4:
            return (sourceX: number, sourceY: number) => ((height - 1 - sourceY) * outputWidth + sourceX) * 4;
        case 5:
            return (sourceX: number, sourceY: number) => (sourceX * outputWidth + sourceY) * 4;
        case 6:
            return (sourceX: number, sourceY: number) => (sourceX * outputWidth + height - 1 - sourceY) * 4;
        case 7:
            return (sourceX: number, sourceY: number) => (
                ((width - 1 - sourceX) * outputWidth + height - 1 - sourceY) * 4
            );
        case 8:
            return (sourceX: number, sourceY: number) => ((width - 1 - sourceX) * outputWidth + sourceY) * 4;
        default:
            return (sourceX: number, sourceY: number) => (sourceY * outputWidth + sourceX) * 4;
    }
}

function transformTiffRgba(
    rgba: Uint8Array,
    width: number,
    height: number,
    orientation: TTiffOrientation,
) {
    if (orientation === 1) {
        return {
            width,
            height,
            rgba,
        };
    }

    const swapsDimensions = swapsTiffOrientationDimensions(orientation);
    const outputWidth = swapsDimensions ? height : width;
    const outputHeight = swapsDimensions ? width : height;
    const output = new Uint8Array(outputWidth * outputHeight * 4);
    const mapTarget = createTiffOrientationMapper(width, height, orientation, outputWidth);
    for (let sourceY = 0; sourceY < height; sourceY += 1) {
        for (let sourceX = 0; sourceX < width; sourceX += 1) {
            const sourceOffset = (sourceY * width + sourceX) * 4;
            const targetOffset = mapTarget(sourceX, sourceY);
            output[targetOffset] = rgba[sourceOffset]!;
            output[targetOffset + 1] = rgba[sourceOffset + 1]!;
            output[targetOffset + 2] = rgba[sourceOffset + 2]!;
            output[targetOffset + 3] = rgba[sourceOffset + 3]!;
        }
    }
    return {
        width: outputWidth,
        height: outputHeight,
        rgba: output,
    };
}

function readTiffDimensions(ifd: IUtifFrame) {
    const width = resolveTiffDimension(ifd, [
        'width',
        't256',
        'ImageWidth',
        256,
    ]);
    const height = resolveTiffDimension(ifd, [
        'height',
        't257',
        'ImageLength',
        257,
    ]);

    if (!width || !height) {
        return null;
    }

    return {
        width,
        height,
    };
}

function decodeSinglePageTiffMetadata(tiffBytes: Uint8Array, defaultDpi: number) {
    const ifds = UTIF.decode(tiffBytes);

    for (const ifd of ifds) {
        const dimensions = readTiffDimensions(ifd);
        if (!dimensions) {
            continue;
        }

        const orientation = resolveTiffOrientation(ifd);
        const resolution = resolveTiffDpi(ifd, defaultDpi);
        return {
            ...dimensions,
            ...resolution,
            orientation,
        };
    }

    throw new Error('Failed to decode TIFF page metadata');
}

function decodeSinglePageTiffRgba(
    tiffBytes: Uint8Array,
    page: ILocalTiffPageDescriptor,
): ITiffPageRgba {
    const ifds = UTIF.decode(tiffBytes);

    for (const ifd of ifds) {
        const dimensions = readTiffDimensions(ifd);
        if (!dimensions) {
            continue;
        }

        if (dimensions.width !== page.sourceWidth || dimensions.height !== page.sourceHeight) {
            continue;
        }

        UTIF.decodeImage(tiffBytes, ifd);

        const rgba = UTIF.toRGBA8(ifd);
        if (!rgba || rgba.length !== page.sourceWidth * page.sourceHeight * 4) {
            continue;
        }

        return transformTiffRgba(rgba, page.sourceWidth, page.sourceHeight, page.orientation);
    }

    throw new Error('Failed to decode TIFF page data');
}

function alignOffset(offset: number, alignment: number) {
    if (alignment <= 1) {
        return offset;
    }
    const remainder = offset % alignment;
    return remainder === 0 ? offset : offset + (alignment - remainder);
}

function resolvePageDataOffsets(
    pages: Array<Pick<ITiffImageDescriptor, 'dataLength'>>,
    firstDataOffset: number,
): number[] {
    const offsets: number[] = [];
    let cursor = firstDataOffset;

    for (const page of pages) {
        offsets.push(cursor);
        cursor += page.dataLength;
    }

    return offsets;
}

function encodeMultiPageTiffHeader(pages: ITiffImageDescriptor[]) {
    let firstDataOffset = 0;
    let header = new Uint8Array();

    for (let attempt = 0; attempt < 8; attempt += 1) {
        const pageOffsets = resolvePageDataOffsets(pages, firstDataOffset);
        const ifds = pages.map((page, index) => buildTiffImageIfd(page, pageOffsets[index]!));
        header = encodeTiffIfds(ifds, UTIF);
        const nextFirstDataOffset = alignOffset(header.length, 8);
        if (nextFirstDataOffset === firstDataOffset) {
            break;
        }
        firstDataOffset = nextFirstDataOffset;
    }

    return {
        firstPageDataOffset: alignOffset(header.length, 8),
        header,
    };
}

export function estimateMultiPageTiffByteLength(pages: ITiffImageDescriptor[]) {
    const { firstPageDataOffset } = encodeMultiPageTiffHeader(pages);

    return firstPageDataOffset + sumBy(pages, page => page.dataLength);
}

export function splitTiffPageDescriptorsForClassicLimit<TPage extends ITiffImageDescriptor>(
    pages: TPage[],
    maxByteLength = CLASSIC_TIFF_MAX_BYTE_LENGTH,
) {
    if (pages.length === 0) {
        return [];
    }

    const groups: TPage[][] = [];
    let currentGroup: TPage[] = [];

    for (const page of pages) {
        if (estimateMultiPageTiffByteLength([page]) > maxByteLength) {
            throw new Error('A single TIFF page exceeds the Classic TIFF 4GB limit');
        }

        const nextGroup = [
            ...currentGroup,
            page,
        ];
        if (currentGroup.length > 0 && estimateMultiPageTiffByteLength(nextGroup) > maxByteLength) {
            groups.push(currentGroup);
            currentGroup = [page];
        } else {
            currentGroup = nextGroup;
        }
    }

    if (currentGroup.length > 0) {
        groups.push(currentGroup);
    }

    return groups;
}

export async function readTiffPageDescriptors(pagePaths: string[], signal?: AbortSignal, defaultDpi = 72) {
    const pages: ILocalTiffPageDescriptor[] = [];

    for (const pagePath of pagePaths) {
        throwIfAborted(signal);
        const tiffBytes = await readFile(pagePath);
        throwIfAborted(signal);
        const metadata = decodeSinglePageTiffMetadata(tiffBytes, defaultDpi);
        const swapsDimensions = swapsTiffOrientationDimensions(metadata.orientation);
        pages.push({
            path: pagePath,
            width: swapsDimensions ? metadata.height : metadata.width,
            height: swapsDimensions ? metadata.width : metadata.height,
            dataLength: metadata.width * metadata.height * 4,
            dpiX: swapsDimensions ? metadata.dpiY : metadata.dpiX,
            dpiY: swapsDimensions ? metadata.dpiX : metadata.dpiY,
            orientation: metadata.orientation,
            sourceWidth: metadata.width,
            sourceHeight: metadata.height,
        });
    }

    return pages;
}

async function writeChunkToStream(
    stream: WriteStream,
    chunk: Uint8Array,
    streamCompletion: Promise<unknown>,
) {
    if (chunk.length === 0) {
        return;
    }

    if (stream.write(chunk)) {
        return;
    }

    const drain = new Promise<void>((resolve, reject) => {
        const handleDrain = () => {
            stream.off('error', handleError);
            resolve();
        };
        const handleError = (error: Error) => {
            stream.off('drain', handleDrain);
            reject(error);
        };

        stream.once('drain', handleDrain);
        stream.once('error', handleError);
    });
    await Promise.race([
        drain,
        streamCompletion,
    ]);
}

export async function combinePagesIntoMultiPageTiffLocal(
    pagePaths: string[],
    outputPath: string,
    options: ICombinePagesIntoMultiPageTiffLocalOptions | AbortSignal = {},
) {
    const signal = options instanceof AbortSignal ? options : options.signal;
    const defaultDpi = options instanceof AbortSignal ? 72 : options.defaultDpi ?? 72;
    const deleteSourcePages = !(options instanceof AbortSignal) && options.deleteSourcePages === true;
    if (pagePaths.length === 0) {
        throw new Error('No pages available for TIFF export');
    }
    throwIfAborted(signal);
    if (await tryCombinePagesWithNativeTiffCombiner(pagePaths, outputPath, signal, defaultDpi)) {
        if (deleteSourcePages) {
            await removeSourcePages(pagePaths);
        }
        return;
    }

    throwIfAborted(signal);
    const pages = await readTiffPageDescriptors(pagePaths, signal, defaultDpi);
    throwIfAborted(signal);
    const totalByteLength = estimateMultiPageTiffByteLength(pages);
    if (totalByteLength > CLASSIC_TIFF_MAX_BYTE_LENGTH) {
        throw new Error('Multi-page TIFF export exceeds the Classic TIFF 4GB limit');
    }

    const {
        firstPageDataOffset,
        header,
    } = encodeMultiPageTiffHeader(pages);
    const tempOutputPath = makeSiblingTempPath(outputPath);
    const stream = createWriteStream(tempOutputPath, { flags: 'w' });
    const streamCompletion = finished(stream);
    void streamCompletion.catch(() => undefined);
    const abortStream = signal
        ? () => stream.destroy(abortErrorFromSignal(signal))
        : null;
    if (abortStream) signal?.addEventListener('abort', abortStream, {once: true});
    let replacedOutput = false;

    try {
        throwIfAborted(signal);
        await writeChunkToStream(stream, header, streamCompletion);

        const paddingLength = firstPageDataOffset - header.length;
        if (paddingLength > 0) {
            await writeChunkToStream(stream, new Uint8Array(paddingLength), streamCompletion);
        }

        for (const page of pages) {
            throwIfAborted(signal);
            const tiffBytes = await readFile(page.path);
            throwIfAborted(signal);
            const decoded = decodeSinglePageTiffRgba(tiffBytes, page);

            if (decoded.rgba.length !== page.dataLength) {
                throw new Error('Decoded TIFF page size did not match computed descriptor size');
            }

            await writeChunkToStream(stream, decoded.rgba, streamCompletion);
        }

        stream.end();
        await streamCompletion;
        throwIfAborted(signal);
        await atomicReplace(tempOutputPath, outputPath);
        replacedOutput = true;
        if (deleteSourcePages) {
            await removeSourcePages(pages.map(page => page.path));
        }
    } catch (error) {
        stream.destroy();
        await streamCompletion.catch(() => undefined);
        throw error;
    } finally {
        if (abortStream) signal?.removeEventListener('abort', abortStream);
        if (!replacedOutput) {
            await rm(tempOutputPath, { force: true }).catch(() => undefined);
        }
    }
}
