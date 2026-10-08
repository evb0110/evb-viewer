import { assertBrowserDjvuRasterDimensions } from '@app/platform/browser-api/assertBrowserDjvuRasterDimensions';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IDjvuWorker } from '@app/platform/browser-api/djvujsLoader';
import { getDjvuWorkerPageSizes } from '@app/platform/browser-api/createDjvuWorkerFromPath';
import {
    createDjvuCanvas as createCanvas,
    encodeDjvuCanvas as canvasToImageBytes,
    fetchDjvuObjectUrlBytes as fetchObjectUrlBytes,
    getDjvuCanvas2dContext as getCanvas2dContext,
    loadDjvuBitmap as loadBitmapFromBytes,
    releaseDjvuCanvas as releaseCanvas,
    type TDjvuCanvas,
} from '@app/platform/browser-api/browserDjvuCanvas';

export const DJVU_COMPACT_PHOTO_PPI_CAP = 300;

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

export function positiveInteger(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function pointsFromPixels(pixels: number, dpi: number) {
    return Math.max(1, pixels / Math.max(1, dpi) * 72);
}

function compactPhotoTargetSize(pageSize: IDjvuPageMetrics) {
    const width = positiveInteger(pageSize.width) ?? 1;
    const height = positiveInteger(pageSize.height) ?? 1;
    const dpi = positiveInteger(pageSize.dpi) ?? DJVU_COMPACT_PHOTO_PPI_CAP;
    const scale = Math.max(1, dpi / DJVU_COMPACT_PHOTO_PPI_CAP);
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

function canvasImageDataToPpm(canvas: TDjvuCanvas, width: number, height: number) {
    const context = getCanvas2dContext(canvas);
    if (!context) {
        throw new Error('Canvas 2D context is unavailable');
    }
    return rgbaToPpmBytes(width, height, context.getImageData(0, 0, width, height).data);
}

async function assertWorkerDjvuRasterBudget(worker: IDjvuWorker, pageNumber: number) {
    const pageSize = (await getDjvuWorkerPageSizes(worker))[pageNumber - 1];
    if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
    assertBrowserDjvuRasterDimensions(pageSize.width, pageSize.height, `DjVu page ${pageNumber}`);
}

async function openDjvuPagePngObject(
    worker: IDjvuWorker,
    pageNumber: number,
    signal?: AbortSignal,
) {
    throwIfDjvuCanceled(signal);
    await assertWorkerDjvuRasterBudget(worker, pageNumber);
    const pngObject = await worker.doc.getPage(pageNumber).createPngObjectUrl().run();
    throwIfDjvuCanceled(signal);
    return pngObject;
}

async function drawDjvuPngObjectOntoCanvas(
    canvas: TDjvuCanvas,
    pngObjectUrl: string,
    targetWidth: number,
    targetHeight: number,
    signal?: AbortSignal,
) {
    const context = getCanvas2dContext(canvas);
    if (!context) {
        throw new Error('Canvas 2D context is unavailable');
    }

    const pngBytes = await fetchObjectUrlBytes(pngObjectUrl);
    throwIfDjvuCanceled(signal);
    const bitmap = await loadBitmapFromBytes(pngBytes);
    throwIfDjvuCanceled(signal);
    try {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, targetWidth, targetHeight);
        context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    } finally {
        if ('close' in bitmap && typeof bitmap.close === 'function') {
            bitmap.close();
        }
    }
}

async function renderDjvuPageFromImageData(
    worker: IDjvuWorker,
    pageNumber: number,
    pageDpi: number,
    subsample: number,
    jpegQuality: number,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPage> {
    throwIfDjvuCanceled(signal);
    const imageData = await worker.doc.getPage(pageNumber).getImageData().run();
    throwIfDjvuCanceled(signal);
    const targetWidth = Math.max(1, Math.round(imageData.width / Math.max(1, subsample)));
    const targetHeight = Math.max(1, Math.round(imageData.height / Math.max(1, subsample)));
    const sourceCanvas = createCanvas(imageData.width, imageData.height);
    const targetCanvas = targetWidth === imageData.width && targetHeight === imageData.height
        ? sourceCanvas
        : createCanvas(targetWidth, targetHeight);

    try {
        const sourceContext = getCanvas2dContext(sourceCanvas);
        if (!sourceContext) {
            throw new Error('Canvas 2D context is unavailable');
        }

        sourceContext.putImageData(imageData, 0, 0);

        const targetContext = getCanvas2dContext(targetCanvas);
        if (!targetContext) {
            throw new Error('Canvas 2D context is unavailable');
        }

        if (targetCanvas !== sourceCanvas) {
            targetContext.fillStyle = '#ffffff';
            targetContext.fillRect(0, 0, targetWidth, targetHeight);
            targetContext.drawImage(
                sourceCanvas,
                0,
                0,
                targetWidth,
                targetHeight,
            );
        }

        const bytes = await canvasToImageBytes(
            targetCanvas,
            'image/jpeg',
            jpegQuality,
        );
        throwIfDjvuCanceled(signal);

        return {
            bytes,
            width: targetWidth,
            height: targetHeight,
            dpi: Math.max(1, Math.round(pageDpi / subsample)),
        };
    } finally {
        releaseCanvas(targetCanvas);
        if (targetCanvas !== sourceCanvas) {
            releaseCanvas(sourceCanvas);
        }
    }
}

async function renderDjvuPageFromPngObject(
    worker: IDjvuWorker,
    pageNumber: number,
    pageDpi: number,
    subsample: number,
    jpegQuality: number,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPage> {
    const pngObject = await openDjvuPagePngObject(worker, pageNumber, signal);
    const targetWidth = Math.max(1, Math.round(pngObject.width / Math.max(1, subsample)));
    const targetHeight = Math.max(1, Math.round(pngObject.height / Math.max(1, subsample)));
    const canvas = createCanvas(targetWidth, targetHeight);

    try {
        await drawDjvuPngObjectOntoCanvas(canvas, pngObject.url, targetWidth, targetHeight, signal);
        const bytes = await canvasToImageBytes(
            canvas,
            'image/jpeg',
            jpegQuality,
        );
        throwIfDjvuCanceled(signal);

        return {
            bytes,
            width: targetWidth,
            height: targetHeight,
            dpi: Math.max(1, Math.round(pageDpi / subsample)),
        };
    } finally {
        worker.revokeObjectURL(pngObject.url);
        releaseCanvas(canvas);
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
    await assertWorkerDjvuRasterBudget(worker, pageNumber);
    try {
        return await renderDjvuPageFromImageData(
            worker,
            pageNumber,
            pageDpi,
            subsample,
            jpegQuality,
            signal,
        );
    } catch (error) {
        if (error instanceof DjvuCanceledError) {
            throw error;
        }

        BrowserLogger.debug('djvu-browser', 'Falling back to PNG DjVu page rendering', {
            pageNumber,
            error,
        });
        return renderDjvuPageFromPngObject(
            worker,
            pageNumber,
            pageDpi,
            subsample,
            jpegQuality,
            signal,
        );
    }
}

async function renderDjvuPageAsPpmFromImageData(
    worker: IDjvuWorker,
    pageNumber: number,
    targetWidth: number,
    targetHeight: number,
    signal?: AbortSignal,
) {
    throwIfDjvuCanceled(signal);
    const imageData = await worker.doc.getPage(pageNumber).getImageData().run();
    throwIfDjvuCanceled(signal);
    if (imageData.width === targetWidth && imageData.height === targetHeight) {
        return rgbaToPpmBytes(
            imageData.width,
            imageData.height,
            imageData.data,
        );
    }

    const sourceCanvas = createCanvas(imageData.width, imageData.height);
    const targetCanvas = createCanvas(targetWidth, targetHeight);
    try {
        const sourceContext = getCanvas2dContext(sourceCanvas);
        const targetContext = getCanvas2dContext(targetCanvas);
        if (!sourceContext || !targetContext) {
            throw new Error('Canvas 2D context is unavailable');
        }
        sourceContext.putImageData(imageData, 0, 0);
        targetContext.fillStyle = '#ffffff';
        targetContext.fillRect(0, 0, targetWidth, targetHeight);
        targetContext.drawImage(
            sourceCanvas,
            0,
            0,
            targetWidth,
            targetHeight,
        );
        throwIfDjvuCanceled(signal);
        return canvasImageDataToPpm(targetCanvas, targetWidth, targetHeight);
    } finally {
        releaseCanvas(targetCanvas);
        releaseCanvas(sourceCanvas);
    }
}

async function renderDjvuPageAsPpmFromPngObject(
    worker: IDjvuWorker,
    pageNumber: number,
    targetWidth: number,
    targetHeight: number,
    signal?: AbortSignal,
) {
    const pngObject = await openDjvuPagePngObject(worker, pageNumber, signal);
    const canvas = createCanvas(targetWidth, targetHeight);

    try {
        await drawDjvuPngObjectOntoCanvas(canvas, pngObject.url, targetWidth, targetHeight, signal);
        return canvasImageDataToPpm(canvas, targetWidth, targetHeight);
    } finally {
        worker.revokeObjectURL(pngObject.url);
        releaseCanvas(canvas);
    }
}

export async function renderDjvuPageAsPpm(
    worker: IDjvuWorker,
    pageNumber: number,
    pageSize: IDjvuPageMetrics,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPpmPage> {
    await assertWorkerDjvuRasterBudget(worker, pageNumber);
    const targetSize = compactPhotoTargetSize(pageSize);
    let data: Uint8Array;
    try {
        data = await renderDjvuPageAsPpmFromImageData(
            worker,
            pageNumber,
            targetSize.width,
            targetSize.height,
            signal,
        );
    } catch (error) {
        if (error instanceof DjvuCanceledError) {
            throw error;
        }
        BrowserLogger.debug('djvu-browser', 'Falling back to PNG DjVu page rendering for compact WASM path', {
            pageNumber,
            error,
        });
        data = await renderDjvuPageAsPpmFromPngObject(
            worker,
            pageNumber,
            targetSize.width,
            targetSize.height,
            signal,
        );
    }

    const dpi = positiveInteger(pageSize.dpi) ?? DJVU_COMPACT_PHOTO_PPI_CAP;
    const sourceWidth = positiveInteger(pageSize.width) ?? targetSize.width;
    const sourceHeight = positiveInteger(pageSize.height) ?? targetSize.height;
    return {
        input: {
            data,
            fileName: `page-${String(pageNumber).padStart(5, '0')}.ppm`,
        },
        pageSize: {
            widthPoints: pointsFromPixels(sourceWidth, dpi),
            heightPoints: pointsFromPixels(sourceHeight, dpi),
        },
    };
}
