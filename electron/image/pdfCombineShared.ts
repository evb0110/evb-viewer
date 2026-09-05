import {
    mkdtemp,
    open,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {
    extname,
    join,
} from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { iterateDecodedTiffFrames } from '@pdf-core/iterateDecodedTiffFrames';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { tryCreatePdfWithNativeImageCombiner } from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { tryCreatePdfFromInputPathsNative } from '@electron/image/tryCreatePdfFromInputPathsNative';
import { PdfCombineCapabilityError } from '@contracts/pdfCombineErrors';
import type { IImageDimensions } from '@electron/image/imageDimensions';
import {
    createPdfCombineOutputTooLargeError,
    normalizePdfCombineOutputLimit,
    PDF_COMBINE_MAX_OUTPUT_BYTES,
} from '@contracts/pdfCombineOutputPolicy';

export interface ICreateCombinedPdfProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface ICreateCombinedPdfOptions {
    onProgress?: (progress: ICreateCombinedPdfProgress) => void;
    unsupportedFileError: (sourcePath: string) => string;
    signal?: AbortSignal;
}

interface IPdfCombineResourceLimits {
    maxInputBytes: number;
    maxPages: number;
    maxTiffFrames: number;
    maxImagePixels: number;
    maxOutputBytes: number;
}

export const PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS = [
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
] as const;

const SUPPORTED_IMAGE_EXTENSION_SET = new Set<string>(
    PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS,
);
const DEFAULT_RESOURCE_LIMITS: IPdfCombineResourceLimits = {
    maxInputBytes: parseIntegerEnv('EVB_PDF_COMBINE_MAX_INPUT_MB', 512, 16, 4096) * 1024 * 1024,
    maxPages: parseIntegerEnv('EVB_PDF_COMBINE_MAX_PAGES', 500, 1, 10_000),
    maxTiffFrames: parseIntegerEnv('EVB_PDF_COMBINE_MAX_TIFF_FRAMES', 250, 1, 5_000),
    maxImagePixels: parseIntegerEnv('EVB_PDF_COMBINE_MAX_IMAGE_PIXELS', 80_000_000, 1_000_000),
    maxOutputBytes: normalizePdfCombineOutputLimit(
        parseIntegerEnv(
            'EVB_PDF_COMBINE_MAX_OUTPUT_MB',
            PDF_COMBINE_MAX_OUTPUT_BYTES / (1024 * 1024),
            1,
            PDF_COMBINE_MAX_OUTPUT_BYTES / (1024 * 1024),
        ) * 1024 * 1024,
    ),
};
const PNG_SIGNATURE = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
] as const;
const JPEG_START_OF_IMAGE = 0xd8;
const JPEG_START_OF_SCAN = 0xda;
const BITMAP_HEADER_PREFIX_BYTES = 64 * 1024;

function getDefaultResourceLimits(): IPdfCombineResourceLimits {
    return { ...DEFAULT_RESOURCE_LIMITS };
}

function assertPageLimit(nextPageCount: number, limits: IPdfCombineResourceLimits) {
    if (nextPageCount > limits.maxPages) {
        throw new Error(`Combined PDF is capped at ${limits.maxPages} pages`);
    }
}

function assertPixelLimit(width: number, height: number, sourcePath: string, limits: IPdfCombineResourceLimits) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw new Error(`Image has invalid dimensions: ${sourcePath}`);
    }
    if (width > limits.maxImagePixels / height) {
        throw new Error(`Image dimensions are too large to combine safely: ${sourcePath}`);
    }
}

function assertOutputLimit(outputBytes: Uint8Array, limits: IPdfCombineResourceLimits) {
    if (outputBytes.byteLength > limits.maxOutputBytes) {
        throw createPdfCombineOutputTooLargeError();
    }
}

async function assertInputByteLimit(sourcePath: string, limits: IPdfCombineResourceLimits) {
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
        throw new Error(`Input path is not a regular file: ${sourcePath}`);
    }
    if (fileStat.size > limits.maxInputBytes) {
        throw new Error(`Input file is too large to combine safely: ${sourcePath}`);
    }
}

function readUint16BE(data: Uint8Array, offset: number) {
    return (data[offset]! << 8) | data[offset + 1]!;
}

function readUint16LE(data: Uint8Array, offset: number) {
    return data[offset]! | (data[offset + 1]! << 8);
}

function readInt32LE(data: Uint8Array, offset: number) {
    return (
        data[offset]!
        | (data[offset + 1]! << 8)
        | (data[offset + 2]! << 16)
        | (data[offset + 3]! << 24)
    );
}

function readUint24LE(data: Uint8Array, offset: number) {
    return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
}

function readUint32LE(data: Uint8Array, offset: number) {
    return (
        data[offset]!
        | (data[offset + 1]! << 8)
        | (data[offset + 2]! << 16)
        | (data[offset + 3]! << 24)
    ) >>> 0;
}

function readUint32BE(data: Uint8Array, offset: number) {
    return ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;
}

function readPngDimensions(data: Uint8Array): IImageDimensions | null {
    if (
        data.byteLength < 24
        || !PNG_SIGNATURE.every((value, index) => data[index] === value)
        || data[12] !== 0x49
        || data[13] !== 0x48
        || data[14] !== 0x44
        || data[15] !== 0x52
    ) {
        return null;
    }
    return {
        width: readUint32BE(data, 16),
        height: readUint32BE(data, 20),
    };
}

function isJpegStartOfFrameMarker(marker: number) {
    return (
        (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf)
    );
}

function readJpegDimensions(data: Uint8Array): IImageDimensions | null {
    if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== JPEG_START_OF_IMAGE) {
        return null;
    }
    let offset = 2;
    while (offset + 4 < data.byteLength) {
        if (data[offset] !== 0xff) {
            return null;
        }
        while (offset < data.byteLength && data[offset] === 0xff) {
            offset += 1;
        }
        const marker = data[offset]!;
        offset += 1;
        if (marker === JPEG_START_OF_SCAN) {
            return null;
        }
        if (offset + 2 > data.byteLength) {
            return null;
        }
        const segmentLength = readUint16BE(data, offset);
        if (segmentLength < 2 || offset + segmentLength > data.byteLength) {
            return null;
        }
        if (isJpegStartOfFrameMarker(marker)) {
            if (segmentLength < 7) {
                return null;
            }
            return {
                height: readUint16BE(data, offset + 3),
                width: readUint16BE(data, offset + 5),
            };
        }
        offset += segmentLength;
    }
    return null;
}

function readBmpDimensions(data: Uint8Array): IImageDimensions | null {
    if (
        data.byteLength < 22
        || data[0] !== 0x42
        || data[1] !== 0x4d
    ) {
        return null;
    }

    const dibHeaderSize = readUint32LE(data, 14);
    if (dibHeaderSize === 12) {
        if (data.byteLength < 22) {
            return null;
        }
        return {
            width: readUint16LE(data, 18),
            height: readUint16LE(data, 20),
        };
    }

    if (dibHeaderSize < 40 || data.byteLength < 26) {
        return null;
    }

    return {
        width: readInt32LE(data, 18),
        height: Math.abs(readInt32LE(data, 22)),
    };
}

function readGifDimensions(data: Uint8Array): IImageDimensions | null {
    if (
        data.byteLength < 10
        || data[0] !== 0x47
        || data[1] !== 0x49
        || data[2] !== 0x46
        || data[3] !== 0x38
        || (data[4] !== 0x37 && data[4] !== 0x39)
        || data[5] !== 0x61
    ) {
        return null;
    }

    return {
        width: readUint16LE(data, 6),
        height: readUint16LE(data, 8),
    };
}

function readWebpLossyDimensions(data: Uint8Array, payloadOffset: number, chunkSize: number): IImageDimensions | null {
    if (chunkSize < 10 || payloadOffset + 10 > data.byteLength) {
        return null;
    }

    return {
        width: readUint16LE(data, payloadOffset + 6) & 0x3fff,
        height: readUint16LE(data, payloadOffset + 8) & 0x3fff,
    };
}

function readWebpLosslessDimensions(data: Uint8Array, payloadOffset: number, chunkSize: number): IImageDimensions | null {
    if (chunkSize < 5 || payloadOffset + 5 > data.byteLength || data[payloadOffset] !== 0x2f) {
        return null;
    }

    const bits = readUint32LE(data, payloadOffset + 1);
    return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
    };
}

function readWebpExtendedDimensions(data: Uint8Array, payloadOffset: number, chunkSize: number): IImageDimensions | null {
    if (chunkSize < 10 || payloadOffset + 10 > data.byteLength) {
        return null;
    }

    return {
        width: 1 + readUint24LE(data, payloadOffset + 4),
        height: 1 + readUint24LE(data, payloadOffset + 7),
    };
}

function readWebpDimensions(data: Uint8Array): IImageDimensions | null {
    if (
        data.byteLength < 20
        || data[0] !== 0x52
        || data[1] !== 0x49
        || data[2] !== 0x46
        || data[3] !== 0x46
        || data[8] !== 0x57
        || data[9] !== 0x45
        || data[10] !== 0x42
        || data[11] !== 0x50
    ) {
        return null;
    }

    const chunkType = String.fromCharCode(
        data[12]!,
        data[13]!,
        data[14]!,
        data[15]!,
    );
    const chunkSize = readUint32LE(data, 16);
    const payloadOffset = 20;

    // The first WEBP chunk carries canvas dimensions before any compressed payload decode.
    if (chunkType === 'VP8 ') {
        return readWebpLossyDimensions(data, payloadOffset, chunkSize);
    }
    if (chunkType === 'VP8L') {
        return readWebpLosslessDimensions(data, payloadOffset, chunkSize);
    }
    if (chunkType === 'VP8X') {
        return readWebpExtendedDimensions(data, payloadOffset, chunkSize);
    }
    return null;
}

function readKnownBitmapDimensions(data: Uint8Array, extension: string) {
    if (extension === '.png') {
        return readPngDimensions(data);
    }
    if (extension === '.jpg' || extension === '.jpeg') {
        return readJpegDimensions(data);
    }
    if (extension === '.bmp') {
        return readBmpDimensions(data);
    }
    if (extension === '.gif') {
        return readGifDimensions(data);
    }
    if (extension === '.webp') {
        return readWebpDimensions(data);
    }
    return null;
}

function shouldFailClosedForBitmapHeader(extension: string) {
    return extension === '.bmp' || extension === '.gif' || extension === '.webp';
}

function assertKnownBitmapPixelLimit(
    data: Uint8Array,
    extension: string,
    sourcePath: string,
    limits: IPdfCombineResourceLimits,
) {
    const dimensions = readKnownBitmapDimensions(data, extension);
    if (dimensions) {
        assertPixelLimit(dimensions.width, dimensions.height, sourcePath, limits);
        return;
    }
    if (shouldFailClosedForBitmapHeader(extension)) {
        throw new Error(`Image dimensions are too large to combine safely: ${sourcePath}`);
    }
}

async function readBitmapHeaderPrefix(sourcePath: string) {
    const file = await open(sourcePath, 'r');
    try {
        const data = new Uint8Array(BITMAP_HEADER_PREFIX_BYTES);
        const { bytesRead } = await file.read(data, 0, data.byteLength, 0);
        return data.subarray(0, bytesRead);
    } finally {
        await file.close();
    }
}

async function normalizeImageWithElectron(sourcePath: string) {
    const { nativeImage } = await import('electron');
    const image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) {
        throw new Error(`Unsupported or unreadable image: ${sourcePath}`);
    }
    return image.toPNG();
}

function normalizeCombineInputPaths(inputPaths: string[]): string[] {
    return inputPaths
        .filter((path) => path.length > 0);
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('PDF combine was canceled.', 'AbortError');
    }
}

export function isImagePath(filePath: string) {
    return SUPPORTED_IMAGE_EXTENSION_SET.has(extname(filePath).toLowerCase());
}

function isDjvuPath(filePath: string) {
    const extension = extname(filePath).toLowerCase();
    return extension === '.djvu' || extension === '.djv';
}

async function preflightImageInput(
    sourcePath: string,
    currentPageCount: number,
    limits: IPdfCombineResourceLimits,
    signal?: AbortSignal,
) {
    const extension = extname(sourcePath).toLowerCase();
    await assertInputByteLimit(sourcePath, limits);
    throwIfAborted(signal);

    if (extension === '.tif' || extension === '.tiff') {
        const tiffBytes = new Uint8Array(await readFile(sourcePath));
        let frameCount = 0;
        for (const {
            width,
            height,
        } of iterateDecodedTiffFrames(tiffBytes, {
                maxFrames: limits.maxTiffFrames,
                maxPixels: limits.maxImagePixels,
                sourceLabel: sourcePath,
            })) {
            throwIfAborted(signal);
            assertPageLimit(currentPageCount + frameCount + 1, limits);
            assertPixelLimit(width, height, sourcePath, limits);
            frameCount += 1;
        }
        if (frameCount === 0) {
            throw new Error(`No decodable TIFF pages found in ${sourcePath}`);
        }
        return frameCount;
    }

    assertKnownBitmapPixelLimit(
        await readBitmapHeaderPrefix(sourcePath),
        extension,
        sourcePath,
        limits,
    );
    assertPageLimit(currentPageCount + 1, limits);
    return 1;
}

async function preflightCombineInputs(
    inputPaths: string[],
    limits: IPdfCombineResourceLimits,
    signal?: AbortSignal,
    unsupportedFileError?: (sourcePath: string) => string,
) {
    let imagePageCount = 0;
    for (const sourcePath of inputPaths) {
        throwIfAborted(signal);
        const extension = extname(sourcePath).toLowerCase();
        if (extension === '.pdf' || isDjvuPath(sourcePath)) {
            await assertInputByteLimit(sourcePath, limits);
            continue;
        }
        if (!isImagePath(sourcePath)) {
            throw new Error(unsupportedFileError?.(sourcePath) ?? `Unsupported file type: ${sourcePath}`);
        }
        imagePageCount += await preflightImageInput(
            sourcePath,
            imagePageCount,
            limits,
            signal,
        );
    }
}

function needsElectronImageNormalization(sourcePath: string) {
    const extension = extname(sourcePath).toLowerCase();
    return extension === '.bmp' || extension === '.gif' || extension === '.webp';
}

async function stageNativeCombineInputs(
    inputPaths: string[],
    signal?: AbortSignal,
) {
    if (!inputPaths.some(needsElectronImageNormalization)) {
        return {
            inputPaths,
            cleanup: () => Promise.resolve(),
        };
    }

    const tempDir = await mkdtemp(join(tmpdir(), `pdf-combine-normalized-${randomUUID()}-`));
    const stagedPaths: string[] = [];
    try {
        for (let index = 0; index < inputPaths.length; index += 1) {
            throwIfAborted(signal);
            const sourcePath = inputPaths[index]!;
            if (!needsElectronImageNormalization(sourcePath)) {
                stagedPaths.push(sourcePath);
                continue;
            }

            const normalizedBytes = await normalizeImageWithElectron(sourcePath);
            throwIfAborted(signal);
            const normalizedPath = join(tempDir, `input-${index + 1}.png`);
            await writeFile(normalizedPath, normalizedBytes);
            stagedPaths.push(normalizedPath);
        }
    } catch (error) {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
        throw error;
    }

    return {
        inputPaths: stagedPaths,
        cleanup: async () => {
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        },
    };
}

function createNativeCombineDeclinedError() {
    return new PdfCombineCapabilityError(
        'native-failure',
        'Native PDF combine did not produce an output file',
        {operation: 'pdf-combine'},
    );
}

export async function createCombinedPdf(
    inputPaths: string[],
    options: ICreateCombinedPdfOptions,
) {
    const normalizedPaths = normalizeCombineInputPaths(inputPaths);
    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }

    const limits = getDefaultResourceLimits();
    assertPageLimit(normalizedPaths.length, limits);

    throwIfAborted(options.signal);
    await preflightCombineInputs(
        normalizedPaths,
        limits,
        options.signal,
        options.unsupportedFileError,
    );
    const staged = await stageNativeCombineInputs(normalizedPaths, options.signal);
    try {
        const nativeOptions = {
            maxPages: limits.maxPages,
            maxInputBytes: limits.maxInputBytes,
            maxOutputBytes: limits.maxOutputBytes,
            ...(options.onProgress ? {onProgress: options.onProgress} : {}),
            ...(options.signal ? {signal: options.signal} : {}),
        };
        const hasDocumentInput = normalizedPaths.some((sourcePath) => {
            const extension = extname(sourcePath).toLowerCase();
            return extension === '.pdf' || isDjvuPath(sourcePath);
        });
        const nativeOutput = hasDocumentInput
            ? await tryCreatePdfFromInputPathsNative(staged.inputPaths, {
                ...nativeOptions,
                failureMode: 'capability-error',
            })
            : await tryCreatePdfWithNativeImageCombiner(staged.inputPaths, nativeOptions);
        if (!nativeOutput) {
            throw createNativeCombineDeclinedError();
        }
        throwIfAborted(options.signal);
        assertOutputLimit(nativeOutput, limits);
        return nativeOutput;
    } finally {
        await staged.cleanup();
    }
}
