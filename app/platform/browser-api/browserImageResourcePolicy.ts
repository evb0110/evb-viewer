import { readBrowserRasterImageMetadata } from '@app/platform/browser-api/browserRasterImageMetadata';

export interface IBrowserImageResourceLimits {
    maxEncodedBytes: number;
    maxPixels: number;
    maxEdge: number;
    maxFrames: number;
    maxSvgBytes: number;
    maxSvgElements: number;
    maxSvgFilterPrimitives: number;
}

export interface IProbedBrowserImage {
    orientation?: number;
    bytes: Uint8Array;
    width: number;
    height: number;
    frameCount: number;
    mimeType: string;
}

export const PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS: Readonly<IBrowserImageResourceLimits> = {
    maxEncodedBytes: 128 * 1024 * 1024,
    maxPixels: 80_000_000,
    maxEdge: 32_768,
    maxFrames: 10_000,
    maxSvgBytes: 4 * 1024 * 1024,
    maxSvgElements: 20_000,
    maxSvgFilterPrimitives: 4_000,
};

export const ASSISTANT_IMAGE_RESOURCE_LIMITS: Readonly<IBrowserImageResourceLimits> = {
    maxEncodedBytes: 10 * 1024 * 1024,
    maxPixels: 20_000_000,
    maxEdge: 8_192,
    maxFrames: 10_000,
    maxSvgBytes: 2 * 1024 * 1024,
    maxSvgElements: 10_000,
    maxSvgFilterPrimitives: 2_000,
};

const SVG_GZIP_MAX_BYTES = 4 * 1024 * 1024;

function readByte(data: Uint8Array, offset: number) {
    const value = data[offset];
    if (value === undefined) {
        throw new RangeError('ERR_BROWSER_IMAGE_DATA_TRUNCATED');
    }
    return value;
}

interface IImageDecoderTrackLike {
    codedWidth: number;
    codedHeight: number;
    frameCount: number;
}

interface IImageDecoderLike {
    tracks: {
        ready: Promise<void>;
        selectedTrack?: IImageDecoderTrackLike | null;
    };
    close(): void;
}

interface IImageDecoderConstructorLike {
    new(options: {
        data: BufferSource;
        type: string;
    }): IImageDecoderLike;
    isTypeSupported?(type: string): Promise<boolean>;
}

function throwIfAborted(signal?: AbortSignal) {
    signal?.throwIfAborted();
}

function resolveImageExtension(file: File) {
    const extension = /\.[^.]+$/u.exec(file.name.toLowerCase())?.[0];
    if (extension) {
        return extension === '.apng' ? '.png' : extension;
    }
    const byMime: Record<string, string> = {
        'image/bmp': '.bmp',
        'image/gif': '.gif',
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
    };
    return byMime[file.type.toLowerCase()] ?? '';
}

async function readStreamWithLimit(stream: ReadableStream<Uint8Array>, maxBytes: number) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
        const {
            done,
            value,
        } = await reader.read();
        if (done) {
            break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel('Expanded image metadata exceeds resource limit');
            throw new RangeError('ERR_BROWSER_IMAGE_EXPANDED_METADATA_TOO_LARGE');
        }
        chunks.push(value);
    }
    const output = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function readSvgNumericAttribute(source: string, name: string) {
    const match = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9]+(?:\\.[0-9]+)?)`, 'iu').exec(source);
    return match?.[1] ? Number.parseFloat(match[1]) : 0;
}

function readSvgMetadata(bytes: Uint8Array, limits: IBrowserImageResourceLimits) {
    if (bytes.byteLength > limits.maxSvgBytes) {
        throw new RangeError('ERR_BROWSER_IMAGE_SVG_TOO_LARGE');
    }
    const source = new TextDecoder().decode(bytes);
    const svgStart = /<svg\b[^>]*>/iu.exec(source)?.[0];
    if (!svgStart) {
        throw new Error('ERR_BROWSER_IMAGE_DIMENSIONS_UNAVAILABLE');
    }
    let elementCount = 0;
    let filterPrimitiveCount = 0;
    const elementPattern = /<\s*([a-z][\w:-]*)\b/giu;
    for (const match of source.matchAll(elementPattern)) {
        elementCount += 1;
        const tagName = match[1]?.toLowerCase() ?? '';
        if (tagName.startsWith('fe')) {
            filterPrimitiveCount += 1;
        }
        if (elementCount > limits.maxSvgElements || filterPrimitiveCount > limits.maxSvgFilterPrimitives) {
            throw new RangeError('ERR_BROWSER_IMAGE_SVG_COMPLEXITY_TOO_LARGE');
        }
    }
    let width = readSvgNumericAttribute(svgStart, 'width');
    let height = readSvgNumericAttribute(svgStart, 'height');
    const viewBox = /\bviewBox\s*=\s*["']\s*[-+0-9.e]+[\s,]+[-+0-9.e]+[\s,]+([-+0-9.e]+)[\s,]+([-+0-9.e]+)/iu.exec(svgStart);
    if ((!width || !height) && viewBox?.[1] && viewBox[2]) {
        width ||= Math.abs(Number.parseFloat(viewBox[1]));
        height ||= Math.abs(Number.parseFloat(viewBox[2]));
    }
    return {
        width: width || 300,
        height: height || 150,
        frameCount: 1,
    };
}

function readIcoMetadata(bytes: Uint8Array) {
    if (
        bytes.byteLength < 6
        || bytes[0] !== 0
        || bytes[1] !== 0
        || bytes[2] !== 1
        || bytes[3] !== 0
    ) {
        return null;
    }
    const frameCount = readByte(bytes, 4) | (readByte(bytes, 5) << 8);
    let width = 0;
    let height = 0;
    for (let index = 0; index < frameCount && 6 + ((index + 1) * 16) <= bytes.byteLength; index += 1) {
        const offset = 6 + (index * 16);
        const entryWidth = readByte(bytes, offset);
        const entryHeight = readByte(bytes, offset + 1);
        width = Math.max(width, entryWidth === 0 ? 256 : entryWidth);
        height = Math.max(height, entryHeight === 0 ? 256 : entryHeight);
    }
    return width > 0 && height > 0 ? {
        width,
        height,
        frameCount,
    } : null;
}

function countPngFrames(bytes: Uint8Array) {
    let offset = 8;
    let frameCount = 1;
    while (offset + 12 <= bytes.byteLength) {
        const length = (
            (readByte(bytes, offset) << 24)
            | (readByte(bytes, offset + 1) << 16)
            | (readByte(bytes, offset + 2) << 8)
            | readByte(bytes, offset + 3)
        ) >>> 0;
        if (offset + 12 + length > bytes.byteLength) {
            break;
        }
        if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === 'acTL' && length === 8) {
            frameCount = (
                (readByte(bytes, offset + 8) << 24)
                | (readByte(bytes, offset + 9) << 16)
                | (readByte(bytes, offset + 10) << 8)
                | readByte(bytes, offset + 11)
            ) >>> 0;
            break;
        }
        offset += 12 + length;
    }
    return frameCount;
}

function skipGifSubBlocks(bytes: Uint8Array, startOffset: number) {
    let offset = startOffset;
    while (offset < bytes.byteLength) {
        const length = readByte(bytes, offset);
        offset += 1;
        if (length === 0) {
            return offset;
        }
        if (offset + length > bytes.byteLength) {
            return bytes.byteLength;
        }
        offset += length;
    }
    return offset;
}

function countGifFrames(bytes: Uint8Array) {
    if (bytes.byteLength < 13) {
        return 1;
    }
    const globalColorTableFlags = readByte(bytes, 10);
    const globalColorTableBytes = (globalColorTableFlags & 0x80) === 0
        ? 0
        : 3 * (2 ** ((globalColorTableFlags & 0x07) + 1));
    let offset = 13 + globalColorTableBytes;
    let frameCount = 0;
    while (offset < bytes.byteLength) {
        const blockType = readByte(bytes, offset);
        if (blockType === 0x3b) break;
        if (blockType === 0x21) {
            if (offset + 2 > bytes.byteLength) break;
            offset = skipGifSubBlocks(bytes, offset + 2);
            continue;
        }
        if (blockType !== 0x2c || offset + 10 > bytes.byteLength) break;
        frameCount += 1;
        const imageFlags = readByte(bytes, offset + 9);
        const localColorTableBytes = (imageFlags & 0x80) === 0
            ? 0
            : 3 * (2 ** ((imageFlags & 0x07) + 1));
        offset += 10 + localColorTableBytes;
        if (offset >= bytes.byteLength) break;
        offset = skipGifSubBlocks(bytes, offset + 1);
    }
    return Math.max(1, frameCount);
}

function countWebpFrames(bytes: Uint8Array) {
    let offset = 12;
    let frameCount = 0;
    while (offset + 8 <= bytes.byteLength) {
        const length = (
            readByte(bytes, offset + 4)
            | (readByte(bytes, offset + 5) << 8)
            | (readByte(bytes, offset + 6) << 16)
            | (readByte(bytes, offset + 7) << 24)
        ) >>> 0;
        if (String.fromCharCode(...bytes.subarray(offset, offset + 4)) === 'ANMF') {
            frameCount += 1;
        }
        const nextOffset = offset + 8 + length + (length % 2);
        if (nextOffset <= offset || nextOffset > bytes.byteLength) {
            break;
        }
        offset = nextOffset;
    }
    return Math.max(1, frameCount);
}

async function probeWithImageDecoder(bytes: Uint8Array, mimeType: string, signal?: AbortSignal) {
    const ImageDecoder = Reflect.get(globalThis, 'ImageDecoder') as IImageDecoderConstructorLike | undefined;
    if (!ImageDecoder || !mimeType) {
        return null;
    }
    if (ImageDecoder.isTypeSupported && !await ImageDecoder.isTypeSupported(mimeType)) {
        return null;
    }
    throwIfAborted(signal);
    const decoder = new ImageDecoder({
        data: bytes.slice().buffer,
        type: mimeType,
    });
    const closeDecoder = () => decoder.close();
    signal?.addEventListener('abort', closeDecoder, {once: true});
    try {
        await decoder.tracks.ready;
        throwIfAborted(signal);
        const track = decoder.tracks.selectedTrack;
        return track ? {
            width: track.codedWidth,
            height: track.codedHeight,
            frameCount: Math.max(1, track.frameCount),
        } : null;
    } finally {
        signal?.removeEventListener('abort', closeDecoder);
        decoder.close();
    }
}

function assertImageResourceLimits(
    metadata: {
        width: number;
        height: number;
        frameCount: number;
    },
    limits: IBrowserImageResourceLimits,
) {
    if (
        !Number.isSafeInteger(metadata.width)
        || !Number.isSafeInteger(metadata.height)
        || metadata.width <= 0
        || metadata.height <= 0
        || metadata.width > limits.maxEdge
        || metadata.height > limits.maxEdge
        || metadata.width * metadata.height > limits.maxPixels
    ) {
        throw new RangeError('ERR_BROWSER_IMAGE_DECODED_SIZE_TOO_LARGE');
    }
    if (!Number.isSafeInteger(metadata.frameCount) || metadata.frameCount <= 0 || metadata.frameCount > limits.maxFrames) {
        throw new RangeError('ERR_BROWSER_IMAGE_FRAME_COUNT_TOO_LARGE');
    }
}

export async function probeBrowserImageFile(
    file: File,
    limits: IBrowserImageResourceLimits,
    signal?: AbortSignal,
): Promise<IProbedBrowserImage> {
    throwIfAborted(signal);
    if (file.size <= 0 || file.size > limits.maxEncodedBytes) {
        throw new RangeError('ERR_BROWSER_IMAGE_ENCODED_SIZE_TOO_LARGE');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    throwIfAborted(signal);
    const extension = resolveImageExtension(file);
    let metadata: {
        width: number;
        height: number;
        frameCount: number;
        orientation?: number;
    } | null = null;
    if (extension === '.svg' || extension === '.svgz') {
        let svgBytes = bytes;
        if (extension === '.svgz') {
            if (typeof DecompressionStream === 'undefined') {
                throw new Error('ERR_BROWSER_IMAGE_SVGZ_BACKEND_UNAVAILABLE');
            }
            svgBytes = await readStreamWithLimit(
                new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')),
                Math.min(limits.maxSvgBytes, SVG_GZIP_MAX_BYTES),
            );
        }
        metadata = readSvgMetadata(svgBytes, limits);
    } else if (extension === '.ico') {
        metadata = readIcoMetadata(bytes);
    } else {
        const rasterMetadata = readBrowserRasterImageMetadata(bytes, extension);
        if (rasterMetadata) {
            metadata = {
                width: rasterMetadata.orientation >= 5 ? rasterMetadata.height : rasterMetadata.width,
                height: rasterMetadata.orientation >= 5 ? rasterMetadata.width : rasterMetadata.height,
                ...(rasterMetadata.orientation === 1 ? {} : {orientation: rasterMetadata.orientation}),
                frameCount: extension === '.png'
                    ? countPngFrames(bytes)
                    : extension === '.gif'
                        ? countGifFrames(bytes)
                        : extension === '.webp'
                            ? countWebpFrames(bytes)
                            : 1,
            };
        }
    }
    metadata ??= await probeWithImageDecoder(bytes, file.type.toLowerCase(), signal);
    if (!metadata) {
        throw new Error('ERR_BROWSER_IMAGE_DIMENSIONS_UNAVAILABLE');
    }
    assertImageResourceLimits(metadata, limits);
    return {
        bytes,
        ...metadata,
        mimeType: file.type.toLowerCase() || 'image/png',
    };
}

function resolvePreviewDimensions(width: number, height: number, maxEdge: number) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

export async function createStaticBrowserImagePreview(
    image: IProbedBrowserImage,
    maxEdge: number,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const target = resolvePreviewDimensions(image.width, image.height, maxEdge);
    const sourceBlob = new Blob([image.bytes as BlobPart], {type: image.mimeType});
    const bitmap = await createImageBitmap(sourceBlob, {
        resizeWidth: target.width,
        resizeHeight: target.height,
        resizeQuality: 'high',
    });
    try {
        throwIfAborted(signal);
        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('ERR_BROWSER_IMAGE_PREVIEW_CANVAS_UNAVAILABLE');
        }
        context.drawImage(bitmap, 0, 0, target.width, target.height);
        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('ERR_BROWSER_IMAGE_PREVIEW_ENCODE_FAILED'));
                }
            }, 'image/png');
        });
    } finally {
        bitmap.close();
    }
}

export function readBlobAsDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Failed to read image preview'));
        reader.onload = () => typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('Invalid image preview data'));
        reader.readAsDataURL(blob);
    });
}
