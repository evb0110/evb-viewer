import UTIF, { type IUtifFrame } from 'utif';

export type { IUtifFrame };

const {
    decode,
    decodeImage,
    toRGBA8,
} = UTIF;

export interface IDecodedTiffFrame {
    frame: IUtifFrame;
    width: number;
    height: number;
    rgba: Uint8Array;
}

export interface IIterateDecodedTiffFramesOptions {
    maxFrames?: number | undefined;
    maxPixels?: number | undefined;
    maxTotalPixels?: number | undefined;
    sourceLabel?: string | undefined;
}

export const DEFAULT_TIFF_DECODE_MAX_FRAMES = 250;
export const DEFAULT_TIFF_DECODE_MAX_PIXELS = 80_000_000;
export const DEFAULT_TIFF_DECODE_MAX_TOTAL_PIXELS = 256_000_000;
export const DEFAULT_TIFF_DECODE_LIMITS: Required<Pick<
    IIterateDecodedTiffFramesOptions,
    'maxFrames' | 'maxPixels' | 'maxTotalPixels'
>> = {
    maxFrames: DEFAULT_TIFF_DECODE_MAX_FRAMES,
    maxPixels: DEFAULT_TIFF_DECODE_MAX_PIXELS,
    maxTotalPixels: DEFAULT_TIFF_DECODE_MAX_TOTAL_PIXELS,
};

function getSourceSuffix(sourceLabel: string | undefined) {
    return sourceLabel ? `: ${sourceLabel}` : '';
}

function normalizePositiveInteger(value: number | undefined) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function assertTiffFrameCount(
    frameCount: number,
    options: IIterateDecodedTiffFramesOptions,
) {
    const maxFrames = normalizePositiveInteger(options.maxFrames);
    if (maxFrames !== null && frameCount > maxFrames) {
        throw new Error(`TIFF frame count is capped at ${maxFrames}${getSourceSuffix(options.sourceLabel)}`);
    }
}

function assertTiffPixelCount(
    width: number,
    height: number,
    options: IIterateDecodedTiffFramesOptions,
) {
    const maxPixels = normalizePositiveInteger(options.maxPixels);
    if (maxPixels !== null && width > maxPixels / height) {
        throw new Error(`TIFF frame dimensions are too large to decode safely${getSourceSuffix(options.sourceLabel)}`);
    }
}

function assertTiffTotalPixelCount(
    totalPixels: number,
    options: IIterateDecodedTiffFramesOptions,
) {
    const maxTotalPixels = normalizePositiveInteger(options.maxTotalPixels);
    if (maxTotalPixels !== null && totalPixels > maxTotalPixels) {
        throw new Error(`TIFF aggregate decoded pixels are capped at ${maxTotalPixels}${getSourceSuffix(options.sourceLabel)}`);
    }
}

function readTiffUint16(bytes: Uint8Array, offset: number, littleEndian: boolean) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, littleEndian);
}

function readTiffUint32(bytes: Uint8Array, offset: number, littleEndian: boolean) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, littleEndian);
}

function readTiffUint64(bytes: Uint8Array, offset: number, littleEndian: boolean) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, littleEndian);
}

export interface ITiffFrameDimensions {
    width: number;
    height: number;
}

/** Reads `length` bytes at `offset`, or fewer at the end of the file. */
export type TTiffByteReader = (offset: number, length: number) => Promise<Uint8Array>;

interface ITiffByteRange {
    offset: number;
    length: number;
}

interface ITiffLayout {
    bigTiff: boolean;
    littleEndian: boolean;
}

interface ITiffDirectoryWalk {
    frames: Array<{
        width: number | null;
        height: number | null;
    }>;
    damaged: boolean;
}

const TIFF_TAG_IMAGE_WIDTH = 256;
const TIFF_TAG_IMAGE_LENGTH = 257;
// A classic directory cannot hold more entries; a larger BigTIFF count is
// damage, and refusing it bounds the directory read.
const TIFF_DIRECTORY_MAX_ENTRIES = 65_535n;
const MAX_SAFE_TIFF_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);

function readTiffOffset(bytes: Uint8Array, offset: number, layout: ITiffLayout) {
    return layout.bigTiff
        ? readTiffUint64(bytes, offset, layout.littleEndian)
        : BigInt(readTiffUint32(bytes, offset, layout.littleEndian));
}

function readTiffLayout(header: Uint8Array): ITiffLayout | null {
    if (header.byteLength < 8) {
        return null;
    }
    const byteOrder = String.fromCharCode(header[0]!, header[1]!);
    if (byteOrder !== 'II' && byteOrder !== 'MM') {
        return null;
    }
    const littleEndian = byteOrder === 'II';
    const magic = readTiffUint16(header, 2, littleEndian);
    const bigTiff = magic === 43;
    if (magic !== 42 && !bigTiff) {
        return null;
    }
    if (bigTiff && (
        header.byteLength < 16
        || readTiffUint16(header, 4, littleEndian) !== 8
        || readTiffUint16(header, 6, littleEndian) !== 0
    )) {
        return null;
    }
    return {
        bigTiff,
        littleEndian,
    };
}

// A dimension is a single SHORT, LONG or BigTIFF LONG8, stored inside its entry.
function readTiffDimensionTag(directory: Uint8Array, entryCount: number, tag: number, layout: ITiffLayout) {
    const entryBytes = layout.bigTiff ? 20 : 12;
    const valueField = layout.bigTiff ? 12 : 8;
    for (let entry = 0; entry < entryCount * entryBytes; entry += entryBytes) {
        if (readTiffUint16(directory, entry, layout.littleEndian) !== tag) {
            continue;
        }
        if (readTiffOffset(directory, entry + 4, layout) !== 1n) {
            return null;
        }
        switch (readTiffUint16(directory, entry + 2, layout.littleEndian)) {
            case 3:
                return readTiffUint16(directory, entry + valueField, layout.littleEndian);
            case 4:
                return readTiffUint32(directory, entry + valueField, layout.littleEndian);
            case 16:
                return layout.bigTiff ? Number(readTiffUint64(directory, entry + valueField, layout.littleEndian)) : null;
            default:
                return null;
        }
    }
    return null;
}

/**
 * Walks the page directories of a classic or BigTIFF file and reads each one's
 * width and height without touching pixel data. It asks for byte ranges, so a
 * caller holding the whole file and one reading a file handle share this parser.
 * Only the frame cap throws; each caller decides what a damaged chain means.
 */
function* walkTiffDirectories(
    options: Pick<IIterateDecodedTiffFramesOptions, 'maxFrames' | 'sourceLabel'>,
): Generator<ITiffByteRange, ITiffDirectoryWalk, Uint8Array> {
    const frames: ITiffDirectoryWalk['frames'] = [];
    const damaged = () => ({
        frames,
        damaged: true,
    });
    const header = yield {
        offset: 0,
        length: 16,
    };
    const layout = readTiffLayout(header);
    if (!layout) {
        return {
            frames,
            damaged: false,
        };
    }
    const countBytes = layout.bigTiff ? 8 : 2;
    const entryBytes = layout.bigTiff ? 20 : 12;
    const offsetBytes = layout.bigTiff ? 8 : 4;
    const visitedOffsets = new Set<bigint>();
    let directoryOffset = readTiffOffset(header, layout.bigTiff ? 8 : 4, layout);
    while (directoryOffset > 0n) {
        if (directoryOffset > MAX_SAFE_TIFF_OFFSET || visitedOffsets.has(directoryOffset)) {
            return damaged();
        }
        visitedOffsets.add(directoryOffset);
        const offset = Number(directoryOffset);
        const countData = yield {
            offset,
            length: countBytes,
        };
        if (countData.byteLength < countBytes) {
            return damaged();
        }
        assertTiffFrameCount(visitedOffsets.size, options);
        const entryCount = layout.bigTiff
            ? readTiffUint64(countData, 0, layout.littleEndian)
            : BigInt(readTiffUint16(countData, 0, layout.littleEndian));
        if (entryCount > TIFF_DIRECTORY_MAX_ENTRIES) {
            return damaged();
        }
        const entriesLength = Number(entryCount) * entryBytes;
        const directory = yield {
            offset: offset + countBytes,
            length: entriesLength + offsetBytes,
        };
        if (directory.byteLength < entriesLength + offsetBytes) {
            return damaged();
        }
        frames.push({
            width: readTiffDimensionTag(directory, Number(entryCount), TIFF_TAG_IMAGE_WIDTH, layout),
            height: readTiffDimensionTag(directory, Number(entryCount), TIFF_TAG_IMAGE_LENGTH, layout),
        });
        directoryOffset = readTiffOffset(directory, entriesLength, layout);
    }
    return {
        frames,
        damaged: false,
    };
}

/**
 * Reads every TIFF frame's dimensions from its page directory and enforces the
 * frame and per-frame pixel caps, reading only directory bytes. A directory
 * without a width holds no image, as UTIF's decoder treats it; a chain that
 * points outside the file or back into itself is damaged.
 */
export async function readTiffFrameDimensions(
    read: TTiffByteReader,
    options: Pick<IIterateDecodedTiffFramesOptions, 'maxFrames' | 'maxPixels' | 'sourceLabel'>,
): Promise<ITiffFrameDimensions[]> {
    const walker = walkTiffDirectories(options);
    let step = walker.next();
    while (!step.done) {
        step = walker.next(await read(step.value.offset, step.value.length));
    }
    const damagedError = new Error(`TIFF page directory is damaged or truncated${getSourceSuffix(options.sourceLabel)}`);
    if (step.value.damaged) {
        throw damagedError;
    }
    const dimensions: ITiffFrameDimensions[] = [];
    for (const {
        width,
        height,
    } of step.value.frames) {
        if (width === null || width <= 0) {
            continue;
        }
        if (height === null) {
            throw damagedError;
        }
        if (height > 0) {
            assertTiffPixelCount(width, height, options);
            dimensions.push({
                width,
                height,
            });
        }
    }
    return dimensions;
}

function preflightTiffIfdCount(bytes: Uint8Array, options: IIterateDecodedTiffFramesOptions) {
    const walker = walkTiffDirectories(options);
    let step = walker.next();
    while (!step.done) {
        step = walker.next(bytes.subarray(step.value.offset, step.value.offset + step.value.length));
    }
}

export function* iterateDecodedTiffFrames(
    bytes: Uint8Array,
    options: IIterateDecodedTiffFramesOptions = {},
): Generator<IDecodedTiffFrame> {
    preflightTiffIfdCount(bytes, options);
    const frames = decode(bytes);
    assertTiffFrameCount(frames.length, options);

    let totalPixels = 0;
    for (const frame of frames) {
        const width = typeof frame.width === 'number' ? frame.width : 0;
        const height = typeof frame.height === 'number' ? frame.height : 0;
        if (width <= 0 || height <= 0) {
            continue;
        }
        assertTiffPixelCount(width, height, options);
        totalPixels += width * height;
        assertTiffTotalPixelCount(totalPixels, options);
    }

    for (const frame of frames) {
        let width = typeof frame.width === 'number' ? frame.width : 0;
        let height = typeof frame.height === 'number' ? frame.height : 0;
        if (width > 0 && height > 0) {
            assertTiffPixelCount(width, height, options);
        }
        decodeImage(bytes, frame);
        width = typeof frame.width === 'number' ? frame.width : 0;
        height = typeof frame.height === 'number' ? frame.height : 0;
        if (width <= 0 || height <= 0) {
            continue;
        }
        assertTiffPixelCount(width, height, options);

        const rgba = toRGBA8(frame);
        if (rgba.byteLength === 0) {
            continue;
        }

        yield {
            frame,
            width,
            height,
            rgba,
        };
    }
}
