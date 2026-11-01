import type {
    IPdfPage,
    IPdfViewport,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {yieldToBrowser} from '@app/platform/browser-api/browserYield';
import {
    createPpmRaster, writePpmTile,
} from '@ocr-core/ppmRaster';
import {
    BROWSER_PDF_RENDER_TILE_PX as RENDER_TILE_PX,
    type IBrowserPdfRasterTiles,
} from '@contracts/browserPdfRaster';

export interface IBrowserPdfRasterOptions {
    annotationMode: number;
    maxPixels: number;
    maxDimensionPx: number;
    /** The rectangle of the full viewport raster to paint; all of it by default. */
    region?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    tooLarge: (width: number, height: number) => Error;
    /**
     * Assemble a Netpbm image on this thread instead of transferring tiles, as
     * Optimize hands desktop's image combiner: gray (P5) or RGB (P6).
     */
    netpbm?: 'gray' | 'rgb';
}

/**
 * A page rendered on white, as painted tiles for the consuming worker to read
 * back, or as an assembled binary PPM where tiles cannot be transferred.
 */
export interface IBrowserPdfRaster {image: IBrowserPdfRasterTiles | Uint8Array}

/** A page box painted at a resolution: the viewport, and where the box lies in it. */
export interface IBrowserPdfBoxRaster {
    viewport: IPdfViewport;
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * A page box in PDF user space at `dpi`, under the page's rotation and
 * without UserUnit: the raster Poppler renders, whose size the desktop page
 * record predicts from the box's points alone. The page's own viewport maps
 * the box, so a MediaBox wider than the page view paints the same way.
 */
export function createBrowserPdfBoxRaster(page: IPdfPage, box: {
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
}, dpi: number): IBrowserPdfBoxRaster {
    const userUnit = page.getViewport({scale: 1}).userUnit || 1;
    const viewport = page.getViewport({scale: dpi / 72 / userUnit});
    const corners = [
        [
            box.xPoints,
            box.yPoints,
        ],
        [
            box.xPoints + box.widthPoints,
            box.yPoints + box.heightPoints,
        ],
    ].map(([
        x,
        y,
    ]) => viewport.convertToViewportPoint(x!, y!));
    const xs = corners.map(point => point[0]!);
    const ys = corners.map(point => point[1]!);
    const swapsAxes = Math.abs(Math.round(viewport.rotation / 90)) % 2 === 1;
    return {
        viewport,
        x: Math.round(Math.min(...xs)),
        y: Math.round(Math.min(...ys)),
        width: Math.max(1, Math.ceil((swapsAxes ? box.heightPoints : box.widthPoints) * dpi / 72)),
        height: Math.max(1, Math.ceil((swapsAxes ? box.widthPoints : box.heightPoints) * dpi / 72)),
    };
}

/**
 * Paints a viewport of the page, or a region of it, on white. Large rasters
 * render in tiles, which keeps each canvas under the browser's canvas limits;
 * the consuming worker assembles them into one raster. A canceled render
 * cancels the PDF.js task and closes every tile it painted.
 */
export async function renderBrowserPdfRaster(
    page: IPdfPage,
    viewport: IPdfViewport,
    signal: AbortSignal,
    options: IBrowserPdfRasterOptions,
): Promise<IBrowserPdfRaster> {
    const region = options.region ?? {
        x: 0,
        y: 0,
        width: Math.max(1, Math.ceil(viewport.width)),
        height: Math.max(1, Math.ceil(viewport.height)),
    };
    const {
        width, height,
    } = region;
    const channels = options.netpbm === 'gray' ? 1 : 3;
    if (width > options.maxDimensionPx || height > options.maxDimensionPx || width * height > options.maxPixels
        || !Number.isSafeInteger(width * height * channels + 64)) {
        throw options.tooLarge(width, height);
    }
    const transfer = !options.netpbm && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
    const ppm = transfer ? null : createPpmRaster(width, height, channels);
    const tiles: ImageBitmap[] = [];
    const canvas = document.createElement('canvas');
    try {
        for (let top = 0; top < height; top += RENDER_TILE_PX) {
            for (let left = 0; left < width; left += RENDER_TILE_PX) {
                signal.throwIfAborted();
                const tileWidth = Math.min(RENDER_TILE_PX, width - left);
                const tileHeight = Math.min(RENDER_TILE_PX, height - top);
                canvas.width = tileWidth;
                canvas.height = tileHeight;
                const context = canvas.getContext('2d', {willReadFrequently: !transfer});
                if (!context) throw new Error('Canvas 2D context is unavailable');
                const task = page.render({
                    canvas,
                    canvasContext: context,
                    // A raster for an engine does not paint the screen. Hidden
                    // tabs receive no animation frames.
                    useRequestAnimationFrame: false,
                    viewport,
                    transform: [
                        1,
                        0,
                        0,
                        1,
                        -(region.x + left),
                        -(region.y + top),
                    ],
                    background: 'rgb(255,255,255)',
                    annotationMode: options.annotationMode,
                });
                task.onContinue = (continueRender: () => void) => {
                    void yieldToBrowser().then(continueRender);
                };
                const cancel = () => task.cancel();
                signal.addEventListener('abort', cancel, {once: true});
                try {
                    await task.promise;
                } finally {
                    signal.removeEventListener('abort', cancel);
                }
                signal.throwIfAborted();
                if (ppm) {
                    writePpmTile(ppm, width, context.getImageData(0, 0, tileWidth, tileHeight).data, left, top, tileWidth, tileHeight);
                } else {
                    tiles.push(await createImageBitmap(canvas));
                }
            }
        }
        signal.throwIfAborted();
    } catch (error) {
        tiles.forEach(tile => tile.close());
        throw error;
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
    return {image: ppm?.image ?? {
        width,
        height,
        tiles,
    }};
}
