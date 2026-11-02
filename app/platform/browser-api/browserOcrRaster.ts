import type {
    IPdfOperatorList,
    IPdfPage,
} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import pdfjsRuntime, {AnnotationMode} from '@app/services/pdfjs/runtimeLib';
import {renderBrowserPdfRaster} from '@app/platform/browser-api/browserPdfRaster';
import {
    BROWSER_OCR_MAX_RASTER_PIXELS,
    BROWSER_OCR_MAX_RASTER_DIMENSION_PX,
    type TBrowserOcrEngineRequest,
} from '@contracts/browserOcrEngine';

// Poppler paints every annotation's appearance into an OCR raster.
export const BROWSER_OCR_ANNOTATION_MODE: number = AnnotationMode.ENABLE;

type TMatrix = [number, number, number, number, number, number];

interface IPageImage {
    width: number;
    height: number;
    dpi: number;
    mask: boolean;
}

/** Transfer painted tiles; workers perform readback and RGB packing. */
export interface IBrowserOcrRaster {image: TBrowserOcrEngineRequest['payload']['image']}

export class BrowserOcrRasterTooLargeError extends Error {
    public constructor(width: number, height: number, maxPixels = BROWSER_OCR_MAX_RASTER_PIXELS) {
        super(`The page renders to ${width} x ${height} pixels, above the limit of ${maxPixels} pixels`);
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

/**
 * Renders the page view (crop box, rotation, user unit) at `dpi` the way
 * desktop's Poppler renders it for OCR: RGB on white, annotations included.
 * Large pages render in tiles and are assembled into one raster, since
 * recognizing tiles separately would change Tesseract's layout analysis.
 */
export function renderBrowserOcrRaster(page: IPdfPage, dpi: number, signal: AbortSignal): Promise<IBrowserOcrRaster> {
    return renderBrowserPdfRaster(page, page.getViewport({scale: dpi / 72}), signal, {
        annotationMode: BROWSER_OCR_ANNOTATION_MODE,
        maxPixels: BROWSER_OCR_MAX_RASTER_PIXELS,
        maxDimensionPx: BROWSER_OCR_MAX_RASTER_DIMENSION_PX,
        tooLarge: (width, height) => new BrowserOcrRasterTooLargeError(width, height),
    });
}
