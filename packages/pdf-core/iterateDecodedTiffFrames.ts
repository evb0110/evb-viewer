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

type TTiffDirectorySizes = Array<{
    width: number | null;
    height: number | null;
}>;

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

function createTiffDirectoryDamagedError(options: IIterateDecodedTiffFramesOptions) {
    return new Error(`TIFF page directory is damaged or truncated${getSourceSuffix(options.sourceLabel)}`);
}

/**
 * Walks the page directories of a classic or BigTIFF file and reads each one's
 * width and height without touching pixel data. It asks for byte ranges, so a
 * caller holding the whole file and one reading a file handle share this parser.
 * A chain that points outside the file or back into itself is damaged.
 */
function* walkTiffDirectories(
    options: IIterateDecodedTiffFramesOptions,
): Generator<ITiffByteRange, TTiffDirectorySizes, Uint8Array> {
    const frames: TTiffDirectorySizes = [];
    const header = yield {
        offset: 0,
        length: 16,
    };
    const layout = readTiffLayout(header);
    if (!layout) {
        return frames;
    }
    const countBytes = layout.bigTiff ? 8 : 2;
    const entryBytes = layout.bigTiff ? 20 : 12;
    const offsetBytes = layout.bigTiff ? 8 : 4;
    const visitedOffsets = new Set<bigint>();
    let directoryOffset = readTiffOffset(header, layout.bigTiff ? 8 : 4, layout);
    while (directoryOffset > 0n) {
        if (directoryOffset > MAX_SAFE_TIFF_OFFSET || visitedOffsets.has(directoryOffset)) {
            throw createTiffDirectoryDamagedError(options);
        }
        visitedOffsets.add(directoryOffset);
        const offset = Number(directoryOffset);
        const countData = yield {
            offset,
            length: countBytes,
        };
        if (countData.byteLength < countBytes) {
            throw createTiffDirectoryDamagedError(options);
        }
        assertTiffFrameCount(visitedOffsets.size, options);
        const entryCount = layout.bigTiff
            ? readTiffUint64(countData, 0, layout.littleEndian)
            : BigInt(readTiffUint16(countData, 0, layout.littleEndian));
        if (entryCount > TIFF_DIRECTORY_MAX_ENTRIES) {
            throw createTiffDirectoryDamagedError(options);
        }
        const entriesLength = Number(entryCount) * entryBytes;
        const directory = yield {
            offset: offset + countBytes,
            length: entriesLength + offsetBytes,
        };
        if (directory.byteLength < entriesLength + offsetBytes) {
            throw createTiffDirectoryDamagedError(options);
        }
        frames.push({
            width: readTiffDimensionTag(directory, Number(entryCount), TIFF_TAG_IMAGE_WIDTH, layout),
            height: readTiffDimensionTag(directory, Number(entryCount), TIFF_TAG_IMAGE_LENGTH, layout),
        });
        directoryOffset = readTiffOffset(directory, entriesLength, layout);
    }
    return frames;
}

/**
 * Checks every directory's frame against the per-frame and total pixel caps
 * and returns the frame sizes. A directory without a width holds no image.
 */
function checkTiffFrameSizes(
    sizes: TTiffDirectorySizes,
    options: IIterateDecodedTiffFramesOptions,
): ITiffFrameDimensions[] {
    let totalPixels = 0;
    return sizes.flatMap(({
        width,
        height,
    }) => {
        if (width === null || width <= 0) {
            return [];
        }
        if (height === null) {
            throw createTiffDirectoryDamagedError(options);
        }
        if (height <= 0) {
            return [];
        }
        assertTiffPixelCount(width, height, options);
        totalPixels += width * height;
        assertTiffTotalPixelCount(totalPixels, options);
        return {
            width,
            height,
        };
    });
}

/**
 * Reads every TIFF frame's dimensions from its page directory and enforces the
 * frame and pixel caps, reading only directory bytes.
 */
export async function readTiffFrameDimensions(
    read: TTiffByteReader,
    options: IIterateDecodedTiffFramesOptions,
): Promise<ITiffFrameDimensions[]> {
    const walker = walkTiffDirectories(options);
    let step = walker.next();
    while (!step.done) {
        step = walker.next(await read(step.value.offset, step.value.length));
    }
    return checkTiffFrameSizes(step.value, options);
}

/** The in-memory form of readTiffFrameDimensions: sizes and caps without decoding pixels. */
export function readTiffFrameDimensionsFromBytes(
    bytes: Uint8Array,
    options: IIterateDecodedTiffFramesOptions,
): ITiffFrameDimensions[] {
    const walker = walkTiffDirectories(options);
    let step = walker.next();
    while (!step.done) {
        step = walker.next(bytes.subarray(step.value.offset, step.value.offset + step.value.length));
    }
    return checkTiffFrameSizes(step.value, options);
}
