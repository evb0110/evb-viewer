import {
    assertBrowserDjvuDecodableDimensions,
    assertBrowserDjvuRasterDimensions,
    toBrowserDjvuDecodeError,
} from '@app/platform/browser-api/assertBrowserDjvuRasterDimensions';
import type { IDjvuWorker } from '@app/platform/browser-api/djvujsLoader';
import { getDjvuWorkerPageSizes } from '@app/platform/browser-api/browserDjvuSource';
import {
    createDjvuCanvas as createCanvas,
    drawDjvuImageDataScaled,
    encodeDjvuCanvas as canvasToImageBytes,
    getDjvuCanvas2dContext as getCanvas2dContext,
    releaseDjvuCanvas as releaseCanvas,
} from '@app/platform/browser-api/browserDjvuCanvas';

export class DjvuCanceledError extends Error {
    constructor() {
        super('DjVu conversion canceled');
        this.name = 'DjvuCanceledError';
    }
}

export function throwIfDjvuCanceled(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new DjvuCanceledError();
    }
}

export interface IDjvuPageMetrics {
    width?: number;
    height?: number;
    dpi: number;
}

export interface IRenderedDjvuPage {
    bytes: Uint8Array;
    width: number;
    height: number;
    dpi: number;
}

export interface IRenderedDjvuPpmPage {
    input: {
        fileName: string;
        data: Uint8Array;
    };
    pageSize: {
        widthPoints: number;
        heightPoints: number;
    };
}

function positiveInteger(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function pointsFromPixels(pixels: number, dpi: number) {
    return Math.max(1, pixels / Math.max(1, dpi) * 72);
}

// The decoded raster is already rotated, so its own size sets the output.
function compactPhotoTargetSize(width: number, height: number, dpi: number, ppiCap: number) {
    const scale = Math.max(1, dpi / ppiCap);
    return {
        height: Math.max(1, Math.round(height / scale)),
        width: Math.max(1, Math.round(width / scale)),
    };
}

function rgbaToPpmBytes(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array) {
    const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
    const pixels = new Uint8Array(width * height * 3);
    for (let sourceOffset = 0, targetOffset = 0; targetOffset < pixels.byteLength; sourceOffset += 4, targetOffset += 3) {
        const alpha = (rgba[sourceOffset + 3] ?? 255) / 255;
        pixels[targetOffset] = Math.round((rgba[sourceOffset] ?? 255) * alpha + 255 * (1 - alpha));
        pixels[targetOffset + 1] = Math.round((rgba[sourceOffset + 1] ?? 255) * alpha + 255 * (1 - alpha));
        pixels[targetOffset + 2] = Math.round((rgba[sourceOffset + 2] ?? 255) * alpha + 255 * (1 - alpha));
    }
    const output = new Uint8Array(header.byteLength + pixels.byteLength);
    output.set(header, 0);
    output.set(pixels, header.byteLength);
    return output;
}

/**
 * Decodes one page at full resolution, rotated as DjVu.js presents it. A page
 * the decoder cannot represent is refused before decoding; one that does not
 * fit in memory fails its allocation and is reported as the page's limit.
 */
export async function decodeDjvuPageImageData(
    worker: IDjvuWorker,
    pageNumber: number,
    signal?: AbortSignal,
) {
    throwIfDjvuCanceled(signal);
    const pageSize = (await getDjvuWorkerPageSizes(worker))[pageNumber - 1];
    if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
    const context = `DjVu page ${pageNumber}`;
    assertBrowserDjvuDecodableDimensions(pageSize.width, pageSize.height, context);
    let imageData: ImageData;
    try {
        imageData = await worker.doc.getPage(pageNumber).getImageData().run();
    } catch (error) {
        throw toBrowserDjvuDecodeError(error, pageSize.width, pageSize.height, context);
    }
    throwIfDjvuCanceled(signal);
    return imageData;
}

/**
 * Draws a decoded page onto a new canvas of the output size. Only the output
 * must fit one browser canvas; the source is drawn in tiles when it does not.
 */
function drawDjvuPageCanvas(imageData: ImageData, targetWidth: number, targetHeight: number, context: string) {
    assertBrowserDjvuRasterDimensions(targetWidth, targetHeight, context);
    const canvas = createCanvas(targetWidth, targetHeight);
    try {
        const canvasContext = getCanvas2dContext(canvas);
        if (!canvasContext) {
            throw new Error('Canvas 2D context is unavailable');
        }
        canvasContext.fillStyle = '#ffffff';
        canvasContext.fillRect(0, 0, targetWidth, targetHeight);
        drawDjvuImageDataScaled(canvasContext, imageData, targetWidth, targetHeight);
        return {
            canvas,
            canvasContext,
        };
    } catch (error) {
        releaseCanvas(canvas);
        throw error;
    }
}

export async function renderDjvuPage(
    worker: IDjvuWorker,
    pageNumber: number,
    pageDpi: number,
    subsample: number,
    jpegQuality: number,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPage> {
    const imageData = await decodeDjvuPageImageData(worker, pageNumber, signal);
    const targetWidth = Math.max(1, Math.round(imageData.width / Math.max(1, subsample)));
    const targetHeight = Math.max(1, Math.round(imageData.height / Math.max(1, subsample)));
    const {canvas} = drawDjvuPageCanvas(imageData, targetWidth, targetHeight, `DjVu page ${pageNumber} output`);
    try {
        const bytes = await canvasToImageBytes(canvas, 'image/jpeg', jpegQuality);
        throwIfDjvuCanceled(signal);
        return {
            bytes,
            width: targetWidth,
            height: targetHeight,
            dpi: Math.max(1, Math.round(pageDpi / subsample)),
        };
    } finally {
        releaseCanvas(canvas);
    }
}

/**
 * Renders a page for display at `targetWidth`, never larger than the decoded
 * page. The PNG is what an image element shows, so its pixels are exact.
 */
export async function renderDjvuPagePreviewPng(
    worker: IDjvuWorker,
    pageNumber: number,
    targetWidth: number,
    signal?: AbortSignal,
) {
    const imageData = await decodeDjvuPageImageData(worker, pageNumber, signal);
    const width = Math.max(1, Math.min(imageData.width, Math.round(targetWidth)));
    const height = Math.max(1, Math.round(width * imageData.height / imageData.width));
    const {canvas} = drawDjvuPageCanvas(imageData, width, height, `DjVu page ${pageNumber} preview`);
    try {
        const bytes = await canvasToImageBytes(canvas, 'image/png');
        throwIfDjvuCanceled(signal);
        return {
            bytes,
            width,
            height,
        };
    } finally {
        releaseCanvas(canvas);
    }
}

/**
 * Renders a page as the PPM of a compact photo page: upright, and reduced to
 * at most `ppiCap` pixels per inch.
 */
export async function renderDjvuPageAsPpm(
    worker: IDjvuWorker,
    pageNumber: number,
    pageSize: IDjvuPageMetrics,
    ppiCap: number,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPpmPage> {
    const imageData = await decodeDjvuPageImageData(worker, pageNumber, signal);
    const dpi = positiveInteger(pageSize.dpi) ?? ppiCap;
    const targetSize = compactPhotoTargetSize(imageData.width, imageData.height, dpi, ppiCap);
    let data: Uint8Array;
    if (imageData.width === targetSize.width && imageData.height === targetSize.height) {
        data = rgbaToPpmBytes(imageData.width, imageData.height, imageData.data);
    } else {
        const {
            canvas,
            canvasContext,
        } = drawDjvuPageCanvas(imageData, targetSize.width, targetSize.height, `DjVu page ${pageNumber} compact image`);
        try {
            throwIfDjvuCanceled(signal);
            data = rgbaToPpmBytes(
                targetSize.width,
                targetSize.height,
                canvasContext.getImageData(0, 0, targetSize.width, targetSize.height).data,
            );
        } finally {
            releaseCanvas(canvas);
        }
    }

    return {
        input: {
            data,
            fileName: `page-${String(pageNumber).padStart(5, '0')}.ppm`,
        },
        pageSize: {
            widthPoints: pointsFromPixels(imageData.width, dpi),
            heightPoints: pointsFromPixels(imageData.height, dpi),
        },
    };
}
