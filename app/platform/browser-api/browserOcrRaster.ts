import type {
    IPdfOperatorList,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import pdfjsRuntime, {AnnotationMode} from '@app/services/pdfjs/runtimeLib';

// Poppler paints every annotation's appearance into an OCR raster.
export const BROWSER_OCR_ANNOTATION_MODE: number = AnnotationMode.ENABLE;

/** Desktop's raster admission: a page above either bound is refused, not downscaled. */
export const BROWSER_OCR_MAX_RASTER_PIXELS = 45_000_000;
const BROWSER_OCR_MAX_RASTER_DIMENSION_PX = 40_000;
// Below every browser's canvas area limit (Safari: 4096 x 4096).
const RENDER_TILE_PX = 4096;

type TMatrix = [number, number, number, number, number, number];

interface IPageImage {
    width: number;
    height: number;
    dpi: number;
    mask: boolean;
}

export interface IBrowserOcrRaster {
    /** Binary PPM (P6), the format the engine reads without image codecs. */
    image: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
}

export class BrowserOcrRasterTooLargeError extends Error {
    public constructor(width: number, height: number) {
        super(`The page renders to ${width} x ${height} pixels, above the OCR limit of ${BROWSER_OCR_MAX_RASTER_PIXELS} pixels`);
        this.name = 'BrowserOcrRasterTooLargeError';
    }
}

function multiply(left: TMatrix, right: TMatrix): TMatrix {
    return [
        left[0] * right[0] + left[2] * right[1],
        left[1] * right[0] + left[3] * right[1],
        left[0] * right[2] + left[2] * right[3],
        left[1] * right[2] + left[3] * right[3],
        left[0] * right[4] + left[2] * right[5] + left[4],
        left[1] * right[4] + left[3] * right[5] + left[5],
    ];
}

function isMatrix(value: unknown): value is TMatrix {
    return Array.isArray(value) && value.length === 6 && value.every(entry => typeof entry === 'number' && Number.isFinite(entry));
}

function imageSize(value: unknown) {
    if (typeof value !== 'object' || value === null) return null;
    const {
        width, height,
    } = value as {
        width?: unknown;
        height?: unknown
    };
    return typeof width === 'number' && typeof height === 'number' ? {
        width,
        height,
    } : null;
}

/**
 * The images a page paints, with the resolution each is drawn at: pixels per
 * inch along the image's own axes, as `pdfimages -list` reports them.
 */
function readPageImages(operatorList: IPdfOperatorList) {
    const {OPS} = pdfjsRuntime;
    const images: IPageImage[] = [];
    const stack: TMatrix[] = [];
    let ctm: TMatrix = [
        1,
        0,
        0,
        1,
        0,
        0,
    ];
    const record = (size: {
        width: number;
        height: number
    } | null, mask: boolean) => {
        const scaleX = Math.hypot(ctm[0], ctm[1]);
        const scaleY = Math.hypot(ctm[2], ctm[3]);
        if (!size || size.width <= 0 || size.height <= 0 || scaleX <= 0 || scaleY <= 0) return;
        images.push({
            width: size.width,
            height: size.height,
            dpi: Math.round(Math.max(size.width * 72 / scaleX, size.height * 72 / scaleY)),
            mask,
        });
    };
    operatorList.fnArray.forEach((fn, index) => {
        const args = operatorList.argsArray[index] ?? [];
        switch (fn) {
            case OPS.save:
                stack.push(ctm);
                break;
            case OPS.restore:
                ctm = stack.pop() ?? ctm;
                break;
            case OPS.transform:
                if (isMatrix(args)) ctm = multiply(ctm, args);
                break;
            case OPS.paintFormXObjectBegin:
                stack.push(ctm);
                if (isMatrix(args[0])) ctm = multiply(ctm, args[0]);
                break;
            case OPS.paintFormXObjectEnd:
                ctm = stack.pop() ?? ctm;
                break;
            case OPS.paintImageXObject:
                record(typeof args[1] === 'number' && typeof args[2] === 'number' ? {
                    width: args[1],
                    height: args[2],
                } : null, false);
                break;
            case OPS.paintInlineImageXObject:
                record(imageSize(args[0]), false);
                break;
            case OPS.paintImageMaskXObject:
                record(imageSize(args[0]), true);
                break;
        }
    });
    return images;
}

/**
 * The resolution of a page's scan: its largest image, or the stencil mask
 * drawn over it when the mask covers it and is finer, the rule desktop
 * applies to `pdfimages` output. Undefined for a page without an image.
 */
export function readPageSourceDpi(operatorList: IPdfOperatorList) {
    const images = readPageImages(operatorList);
    const area = (image: IPageImage) => image.width * image.height;
    const dominant = images
        .filter(image => !image.mask)
        .sort((left, right) => area(right) - area(left) || right.dpi - left.dpi)[0];
    if (!dominant) return undefined;
    const mask = images
        .filter(image => image.mask)
        .sort((left, right) => area(right) - area(left) || right.dpi - left.dpi)[0];
    return mask && area(mask) >= area(dominant) * 0.95 && mask.dpi > dominant.dpi ? mask.dpi : dominant.dpi;
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError');
}

/**
 * Renders the page view (crop box, rotation, user unit) at `dpi` the way
 * desktop's Poppler renders it for OCR: RGB on white, annotations included.
 * Large pages render in tiles and are assembled into one raster, since
 * recognizing tiles separately would change Tesseract's layout analysis.
 */
export async function renderBrowserOcrRaster(page: IPdfPage, dpi: number, signal: AbortSignal): Promise<IBrowserOcrRaster> {
    const viewport = page.getViewport({scale: dpi / 72});
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    if (width > BROWSER_OCR_MAX_RASTER_DIMENSION_PX || height > BROWSER_OCR_MAX_RASTER_DIMENSION_PX
        || width * height > BROWSER_OCR_MAX_RASTER_PIXELS) {
        throw new BrowserOcrRasterTooLargeError(width, height);
    }
    const header = new TextEncoder().encode(`P6\n${width} ${height}\n255\n`);
    const image = new Uint8Array(header.byteLength + width * height * 3);
    image.set(header);
    const canvas = document.createElement('canvas');
    try {
        for (let top = 0; top < height; top += RENDER_TILE_PX) {
            for (let left = 0; left < width; left += RENDER_TILE_PX) {
                throwIfAborted(signal);
                const tileWidth = Math.min(RENDER_TILE_PX, width - left);
                const tileHeight = Math.min(RENDER_TILE_PX, height - top);
                canvas.width = tileWidth;
                canvas.height = tileHeight;
                const context = canvas.getContext('2d', {willReadFrequently: true});
                if (!context) throw new Error('Canvas 2D context is unavailable');
                const task = page.render({
                    canvas,
                    canvasContext: context,
                    viewport,
                    transform: [
                        1,
                        0,
                        0,
                        1,
                        -left,
                        -top,
                    ],
                    background: 'rgb(255,255,255)',
                    annotationMode: BROWSER_OCR_ANNOTATION_MODE,
                });
                const cancel = () => task.cancel();
                signal.addEventListener('abort', cancel, {once: true});
                try {
                    await task.promise;
                } finally {
                    signal.removeEventListener('abort', cancel);
                }
                throwIfAborted(signal);
                const {data} = context.getImageData(0, 0, tileWidth, tileHeight);
                for (let row = 0; row < tileHeight; row += 1) {
                    let source = row * tileWidth * 4;
                    let target = header.byteLength + ((top + row) * width + left) * 3;
                    for (let column = 0; column < tileWidth; column += 1) {
                        image[target] = data[source]!;
                        image[target + 1] = data[source + 1]!;
                        image[target + 2] = data[source + 2]!;
                        source += 4;
                        target += 3;
                    }
                }
            }
        }
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
    return {
        image,
        width,
        height,
    };
}
