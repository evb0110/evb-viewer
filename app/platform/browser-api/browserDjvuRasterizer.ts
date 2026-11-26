import {
    assertBrowserDjvuDecodableDimensions,
    assertBrowserDjvuRasterDimensions,
    toBrowserDjvuDecodeError,
} from '@app/platform/browser-api/assertBrowserDjvuRasterDimensions';
import type { IDjvuWorker } from '@app/platform/browser-api/browserDjvuWorkerClient';
import { getDjvuWorkerPageSizes } from '@app/platform/browser-api/browserDjvuSource';
import {
    createDjvuCanvas as createCanvas,
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

function compactPhotoTargetSize(width: number, height: number, dpi: number, ppiCap: number) {
    const scale = Math.max(1, dpi / ppiCap);
    return {
        height: Math.max(1, Math.round(height / scale)),
        width: Math.max(1, Math.round(width / scale)),
    };
}

function toImageData(rgba: Uint8Array, width: number, height: number) {
    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    return new ImageData(
        clamped.buffer instanceof ArrayBuffer ? new Uint8ClampedArray(clamped) : new Uint8ClampedArray(rgba),
        width,
        height,
    );
}

/**
 * Decodes one page as upright RGBA at full resolution (or a requested target
 * size when provided) using DjVuLibre WASM's native scaler.
 */
export async function decodeDjvuPageImageData(
    worker: IDjvuWorker,
    pageNumber: number,
    signal?: AbortSignal,
    targetSize?: {
        width: number;
        height: number;
    },
) {
    throwIfDjvuCanceled(signal);
    const pageSize = (await getDjvuWorkerPageSizes(worker))[pageNumber - 1];
    if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
    const decodeWidth = targetSize?.width ?? pageSize.width;
    const decodeHeight = targetSize?.height ?? pageSize.height;
    const context = `DjVu page ${pageNumber}`;
    assertBrowserDjvuDecodableDimensions(decodeWidth, decodeHeight, context);
    try {
        const rendered = await worker.renderPage(pageNumber, {
            mode: 'color',
            pixelFormat: 'rgba',
            ...(targetSize ? {
                targetWidth: targetSize.width,
                targetHeight: targetSize.height,
            } : {}),
        });
        throwIfDjvuCanceled(signal);
        return toImageData(rendered.bytes, rendered.width, rendered.height);
    } catch (error) {
        if (error instanceof DjvuCanceledError) {
            throw error;
        }
        throw toBrowserDjvuDecodeError(error, decodeWidth, decodeHeight, context);
    }
}

function putImageDataOnCanvas(imageData: ImageData, context: string) {
    assertBrowserDjvuRasterDimensions(imageData.width, imageData.height, context);
    const canvas = createCanvas(imageData.width, imageData.height);
    try {
        const canvasContext = getCanvas2dContext(canvas);
        if (!canvasContext) {
            throw new Error('Canvas 2D context is unavailable');
        }
        canvasContext.putImageData(imageData, 0, 0);
        return canvas;
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
    throwIfDjvuCanceled(signal);
    const pageSize = (await getDjvuWorkerPageSizes(worker))[pageNumber - 1];
    if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
    const effectiveSubsample = Math.max(1, subsample);
    const targetWidth = Math.max(1, Math.round(pageSize.width / effectiveSubsample));
    const targetHeight = Math.max(1, Math.round(pageSize.height / effectiveSubsample));
    assertBrowserDjvuRasterDimensions(targetWidth, targetHeight, `DjVu page ${pageNumber} output`);
    const imageData = await decodeDjvuPageImageData(worker, pageNumber, signal, {
        width: targetWidth,
        height: targetHeight,
    });
    const canvas = putImageDataOnCanvas(imageData, `DjVu page ${pageNumber} output`);
    try {
        const bytes = await canvasToImageBytes(canvas, 'image/jpeg', jpegQuality);
        throwIfDjvuCanceled(signal);
        return {
            bytes,
            width: imageData.width,
            height: imageData.height,
            dpi: Math.max(1, Math.round(pageDpi / effectiveSubsample)),
        };
    } finally {
        releaseCanvas(canvas);
    }
}

/**
 * Renders a page for display at `targetWidth`, never larger than the native
 * page, decoding directly at the target dimensions in DjVuLibre WASM.
 */
export async function renderDjvuPagePreviewPng(
    worker: IDjvuWorker,
    pageNumber: number,
    targetWidth: number,
    signal?: AbortSignal,
) {
    throwIfDjvuCanceled(signal);
    const pageSize = (await getDjvuWorkerPageSizes(worker))[pageNumber - 1];
    if (!pageSize) throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
    const width = Math.max(1, Math.min(pageSize.width, Math.round(targetWidth)));
    const height = Math.max(1, Math.round(width * pageSize.height / Math.max(1, pageSize.width)));
    assertBrowserDjvuRasterDimensions(width, height, `DjVu page ${pageNumber} preview`);
    const imageData = await decodeDjvuPageImageData(worker, pageNumber, signal, {
        width,
        height,
    });
    const canvas = putImageDataOnCanvas(imageData, `DjVu page ${pageNumber} preview`);
    try {
        const bytes = await canvasToImageBytes(canvas, 'image/png');
        throwIfDjvuCanceled(signal);
        return {
            bytes,
            width: imageData.width,
            height: imageData.height,
        };
    } finally {
        releaseCanvas(canvas);
    }
}

/**
 * Renders a page as the PPM of a compact photo page: upright, and reduced to
 * at most `ppiCap` pixels per inch directly inside DjVuLibre WASM.
 */
export async function renderDjvuPageAsPpm(
    worker: IDjvuWorker,
    pageNumber: number,
    pageSize: IDjvuPageMetrics,
    ppiCap: number,
    signal?: AbortSignal,
): Promise<IRenderedDjvuPpmPage> {
    throwIfDjvuCanceled(signal);
    const tableSize = (await getDjvuWorkerPageSizes(worker))[pageNumber - 1];
    const nativeWidth = positiveInteger(pageSize.width) ?? tableSize?.width ?? 0;
    const nativeHeight = positiveInteger(pageSize.height) ?? tableSize?.height ?? 0;
    if (nativeWidth <= 0 || nativeHeight <= 0) {
        throw new RangeError(`DjVu page ${pageNumber} is outside the document`);
    }
    const dpi = positiveInteger(pageSize.dpi) ?? tableSize?.dpi ?? ppiCap;
    const targetSize = compactPhotoTargetSize(nativeWidth, nativeHeight, dpi, ppiCap);
    const context = `DjVu page ${pageNumber} compact image`;
    assertBrowserDjvuDecodableDimensions(targetSize.width, targetSize.height, context);
    let rendered;
    try {
        rendered = await worker.renderPagePpm(pageNumber, {
            mode: 'color',
            targetWidth: targetSize.width,
            targetHeight: targetSize.height,
        });
    } catch (error) {
        throw toBrowserDjvuDecodeError(error, targetSize.width, targetSize.height, context);
    }
    throwIfDjvuCanceled(signal);
    if (!rendered) {
        throw new Error(`DjVu page ${pageNumber} produced no photo raster`);
    }
    return {
        input: {
            data: rendered.ppm,
            fileName: `page-${String(pageNumber).padStart(5, '0')}.ppm`,
        },
        pageSize: {
            widthPoints: pointsFromPixels(nativeWidth, dpi),
            heightPoints: pointsFromPixels(nativeHeight, dpi),
        },
    };
}
