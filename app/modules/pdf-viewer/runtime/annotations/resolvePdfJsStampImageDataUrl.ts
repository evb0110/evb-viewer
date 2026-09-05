import {ImageKind} from '@app/services/pdfjs/runtimeLib';
import {
    formatPdfJsAnnotationRef,
    normalizePdfJsAnnotationId,
} from '@app/utils/pdfAnnotationRefs';
import type { IAnnotationImageReference } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

const MAX_STAMP_IMAGE_PIXELS = 16 * 1024 * 1024;

interface IByteArrayLike {
    readonly length: number;
    readonly [index: number]: number;
}

interface IPdfJsImageDataLike {
    readonly width: number;
    readonly height: number;
    readonly kind: number | null;
    readonly data: IByteArrayLike | null;
    readonly bitmap: unknown;
    readonly ref: string;
}

interface IPdfJsPageWithObjects {readonly objs: Iterable<unknown>;}

function asRecord(value: unknown): Record<PropertyKey, unknown> | null {
    return typeof value === 'object' && value !== null
        ? value as Record<PropertyKey, unknown>
        : null;
}

function asByteArray(value: unknown): IByteArrayLike | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const length = (value as {length?: unknown}).length;
    return typeof length === 'number'
        && Number.isSafeInteger(length)
        && length >= 0
        ? value as IByteArrayLike
        : null;
}

function inferImageKind(
    width: number,
    height: number,
    dataLength: number,
) {
    const pixelCount = width * height;
    if (dataLength === pixelCount * 4) {
        return ImageKind.RGBA_32BPP;
    }
    if (dataLength === pixelCount * 3) {
        return ImageKind.RGB_24BPP;
    }
    if (dataLength === Math.ceil(width / 8) * height) {
        return ImageKind.GRAYSCALE_1BPP;
    }
    return null;
}

function asImageData(value: unknown): IPdfJsImageDataLike | null {
    const record = asRecord(value);
    if (!record) {
        return null;
    }
    const width = record.width;
    const height = record.height;
    const declaredKind = record.kind;
    const ref = record.ref;
    const data = asByteArray(record.data);
    const bitmap = record.bitmap;
    if (
        typeof width !== 'number'
        || !Number.isSafeInteger(width)
        || width <= 0
        || typeof height !== 'number'
        || !Number.isSafeInteger(height)
        || height <= 0
        || width * height > MAX_STAMP_IMAGE_PIXELS
        || typeof ref !== 'string'
        || (!data && (bitmap === null || bitmap === undefined))
    ) {
        return null;
    }
    const kind = typeof declaredKind === 'number' && Number.isSafeInteger(declaredKind)
        ? declaredKind
        : data
            ? inferImageKind(width, height, data.length)
            : null;
    if (data && kind === null) {
        return null;
    }
    return {
        width,
        height,
        kind,
        data,
        bitmap,
        ref,
    };
}

function findImageData(
    pdfPage: IPdfJsPageWithObjects,
    imageReference: IAnnotationImageReference,
) {
    const expectedRef = formatPdfJsAnnotationRef(imageReference);
    for (const entry of pdfPage.objs) {
        if (!Array.isArray(entry) || entry.length < 2) {
            continue;
        }
        const imageData = asImageData(entry[1]);
        if (imageData && normalizePdfJsAnnotationId(imageData.ref) === expectedRef) {
            return imageData;
        }
    }
    return null;
}

function toRgba(imageData: IPdfJsImageDataLike) {
    if (!imageData.data || imageData.kind === null) {
        return null;
    }
    const pixelCount = imageData.width * imageData.height;
    const rgba = new Uint8ClampedArray(pixelCount * 4);
    if (imageData.kind === ImageKind.RGBA_32BPP) {
        if (imageData.data.length < rgba.length) {
            return null;
        }
        for (let index = 0; index < rgba.length; index += 1) {
            rgba[index] = imageData.data[index] ?? 0;
        }
        return rgba;
    }
    if (imageData.kind === ImageKind.RGB_24BPP) {
        if (imageData.data.length < pixelCount * 3) {
            return null;
        }
        for (let sourceIndex = 0, targetIndex = 0; targetIndex < rgba.length; sourceIndex += 3, targetIndex += 4) {
            rgba[targetIndex] = imageData.data[sourceIndex] ?? 0;
            rgba[targetIndex + 1] = imageData.data[sourceIndex + 1] ?? 0;
            rgba[targetIndex + 2] = imageData.data[sourceIndex + 2] ?? 0;
            rgba[targetIndex + 3] = 255;
        }
        return rgba;
    }
    if (imageData.kind !== ImageKind.GRAYSCALE_1BPP) {
        return null;
    }
    const rowByteLength = Math.ceil(imageData.width / 8);
    if (imageData.data.length < rowByteLength * imageData.height) {
        return null;
    }
    for (let y = 0, targetIndex = 0; y < imageData.height; y += 1) {
        const rowStart = y * rowByteLength;
        for (let x = 0; x < imageData.width; x += 1, targetIndex += 4) {
            const sourceByte = imageData.data[rowStart + Math.floor(x / 8)] ?? 0;
            const value = sourceByte & (0x80 >> (x % 8)) ? 255 : 0;
            rgba[targetIndex] = value;
            rgba[targetIndex + 1] = value;
            rgba[targetIndex + 2] = value;
            rgba[targetIndex + 3] = 255;
        }
    }
    return rgba;
}

export function resolvePdfJsStampImageDataUrl(
    pdfPage: IPdfJsPageWithObjects,
    imageReference: IAnnotationImageReference,
) {
    if (typeof document === 'undefined') {
        return null;
    }
    const imageData = findImageData(pdfPage, imageReference);
    if (!imageData) {
        return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    try {
        const context = canvas.getContext('2d');
        if (!context) {
            return null;
        }
        if (imageData.bitmap !== null && imageData.bitmap !== undefined) {
            context.drawImage(
                imageData.bitmap as CanvasImageSource,
                0,
                0,
                imageData.width,
                imageData.height,
            );
            return canvas.toDataURL('image/png');
        }
        const rgba = toRgba(imageData);
        if (!rgba) {
            return null;
        }
        const output = context.createImageData(imageData.width, imageData.height);
        output.data.set(rgba);
        context.putImageData(output, 0, 0);
        return canvas.toDataURL('image/png');
    } catch {
        return null;
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}
