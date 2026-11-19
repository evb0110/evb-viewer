import {
    getInputFileExtension, isImagePath, isDjvuPath,
} from '@electron/utils/documentFileTypes';
import { getAppTempDir } from '@electron/utils/appTempDir';
import {
    createManagedScratchTempDir,
    removeManagedScratchTempDir,
} from '@electron/utils/managedScratchTemp';
import {
    open,
    stat,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import { createRequire } from 'node:module';
import { readTiffFrameDimensions } from '@pdf-core/iterateDecodedTiffFrames';
import type { IImageDimensions } from '@electron/image/imageDimensions';
export {
    isImagePath, PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS,
} from '@electron/utils/documentFileTypes';

interface IPdfCombineResourceLimits {
    maxInputBytes: number;
    maxTiffFrames: number;
    maxImagePixels: number;
}

interface IImageDecoderModule {
    createCanvas: (width: number, height: number) => {
        getContext: (context: '2d') => {drawImage: (image: IImageDecoderBitmap, x: number, y: number) => void};
        toBuffer: (format: 'image/png') => Uint8Array;
    };
    loadImage: (sourcePath: string) => Promise<IImageDecoderBitmap>;
}

interface IImageDecoderBitmap {
    height: number;
    width: number;
}

const RESOURCE_LIMITS: IPdfCombineResourceLimits = {
    maxInputBytes: 512 * 1024 * 1024,
    maxTiffFrames: 250,
    maxImagePixels: 80_000_000,
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
const requireImageDecoder = createRequire(import.meta.url);
const requirePackagedImageDecoder = createRequire(new URL(
    './runtime/@napi-rs/canvas/index.js',
    import.meta.url,
));

function loadImageDecoderModule() {
    try {
        return requireImageDecoder('@napi-rs/canvas') as IImageDecoderModule;
    } catch {
        return requirePackagedImageDecoder('./index.js') as IImageDecoderModule;
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
    if (!image.isEmpty()) {
        return image.toPNG();
    }

    try {
        const {
            createCanvas,
            loadImage,
        } = loadImageDecoderModule();
        const decoded = await loadImage(sourcePath);
        const canvas = createCanvas(decoded.width, decoded.height);
        const context = canvas.getContext('2d');
        context.drawImage(decoded, 0, 0);
        return canvas.toBuffer('image/png');
    } catch (error) {
        throw new Error(`Unsupported or unreadable image: ${sourcePath}`, {cause: error});
    }
}

function throwIfAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('PDF combine was canceled.', 'AbortError');
    }
}

async function preflightImageInput(
    sourcePath: string,
    limits: IPdfCombineResourceLimits,
    signal?: AbortSignal,
) {
    const extension = getInputFileExtension(sourcePath);
    await assertInputByteLimit(sourcePath, limits);
    throwIfAborted(signal);

    if (extension === '.tif' || extension === '.tiff') {
        // Only the page directories are read; the native combiner decodes the pixels once.
        const file = await open(sourcePath, 'r');
        let frames;
        try {
            frames = await readTiffFrameDimensions(async (offset, length) => {
                throwIfAborted(signal);
                const bytes = new Uint8Array(length);
                const {bytesRead} = await file.read(bytes, 0, length, offset);
                return bytes.subarray(0, bytesRead);
            }, {
                maxFrames: limits.maxTiffFrames,
                maxPixels: limits.maxImagePixels,
                sourceLabel: sourcePath,
            });
        } finally {
            await file.close();
        }
        frames.forEach(({
            width,
            height,
        }) => {
            assertPixelLimit(width, height, sourcePath, limits);
        });
        if (frames.length === 0) {
            throw new Error(`No decodable TIFF pages found in ${sourcePath}`);
        }
        return;
    }

    assertKnownBitmapPixelLimit(
        await readBitmapHeaderPrefix(sourcePath),
        extension,
        sourcePath,
        limits,
    );
}

async function preflightCombineInputs(
    inputPaths: string[],
    limits: IPdfCombineResourceLimits,
    signal?: AbortSignal,
) {
    for (const sourcePath of inputPaths) {
        throwIfAborted(signal);
        const extension = getInputFileExtension(sourcePath);
        if (extension === '.pdf' || isDjvuPath(sourcePath)) {
            await assertInputByteLimit(sourcePath, limits);
            continue;
        }
        if (!isImagePath(sourcePath)) {
            throw new Error(`Unsupported file type: ${sourcePath}`);
        }
        await preflightImageInput(sourcePath, limits, signal);
    }
}

function needsElectronImageNormalization(sourcePath: string) {
    const extension = getInputFileExtension(sourcePath);
    return extension === '.bmp' || extension === '.gif' || extension === '.webp';
}

export async function stageNativeCombineInputs(
    inputPaths: string[],
    signal?: AbortSignal,
) {
    await preflightCombineInputs(inputPaths, RESOURCE_LIMITS, signal);

    if (!inputPaths.some(needsElectronImageNormalization)) {
        return {
            inputPaths,
            cleanup: () => Promise.resolve(),
        };
    }

    const scratchRoot = getAppTempDir();
    const tempDir = await createManagedScratchTempDir('pdfExport-scope-', scratchRoot);
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
        await removeManagedScratchTempDir(tempDir, 'pdfExport-scope-', scratchRoot).catch(() => undefined);
        throw error;
    }

    return {
        inputPaths: stagedPaths,
        cleanup: async () => {
            await removeManagedScratchTempDir(tempDir, 'pdfExport-scope-', scratchRoot).catch(() => undefined);
        },
    };
}
