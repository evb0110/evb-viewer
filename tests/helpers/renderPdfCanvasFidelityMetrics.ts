import { readFile } from 'node:fs/promises';
import {
    resolve,
    sep,
} from 'node:path';
import {
    DOMMatrix,
    ImageData,
    Path2D,
    createCanvas,
} from '@napi-rs/canvas';
import { isRecord } from '@contracts/runtimeGuards';
import {adaptPdfjsDocument} from '@app/services/pdfjs/pdfjsCompatibility';

export interface IPdfCanvasFidelityMetrics {
    darkPixelRatio: number;
    height: number;
    inkPixelRatio: number;
    meanLuminance: number;
    textItemCount: number;
    width: number;
}

export const PDF_CANVAS_INK_RATIO_MIN = 0.01;
export const PDF_CANVAS_INK_RATIO_MAX = 0.2;

export function isPdfCanvasInkCoverageSane(metrics: IPdfCanvasFidelityMetrics) {
    return metrics.inkPixelRatio >= PDF_CANVAS_INK_RATIO_MIN
        && metrics.inkPixelRatio <= PDF_CANVAS_INK_RATIO_MAX;
}

export async function renderPdfCanvasFidelityMetrics(
    path: string,
    pageNumber = 1,
): Promise<IPdfCanvasFidelityMetrics> {
    Object.assign(globalThis, {
        DOMMatrix,
        ImageData,
        Path2D,
    });
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const bytes = await readFile(path);
    const documentParameters = {
        data: new Uint8Array(bytes),
        // The legacy build still accepts this Node option although current
        // PDF.js declarations omit it.
        disableWorker: true,
        wasmUrl: `${resolve(process.cwd(), 'public/pdf/wasm')}${sep}`,
        // Fidelity fixtures contain unembedded standard fonts. Resolve those
        // from the same vendored PDF.js payload as the app so this corpus
        // measures rendering rather than whichever Helvetica substitute is
        // installed on the current macOS/Linux runner image.
        standardFontDataUrl: `${resolve(process.cwd(), 'public/pdf/standard_fonts')}${sep}`,
        useSystemFonts: false,
        useWorkerFetch: false,
    } satisfies Extract<Parameters<typeof pdfjs.getDocument>[0], {data?: unknown}> & {disableWorker: boolean};
    const task = pdfjs.getDocument(documentParameters);
    const document = adaptPdfjsDocument(await task.promise, () => task.destroy());
    try {
        const page = await document.getPage(pageNumber);
        // PDF points are 1/72 inch. Scale 1 therefore compares every fixture at
        // the same physical 72-DPI output size rather than at source pixel size.
        const viewport = page.getViewport({scale: 1});
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        // PDF.js's public types require browser DOM objects, while its
        // legacy Node build accepts the @napi-rs/canvas equivalents. Read
        // and invoke this third-party method through the runtime boundary
        // so the browser-only parameter type does not leak into the shim.
        const renderFunction: unknown = Reflect.get(page, 'render');
        if (typeof renderFunction !== 'function') {
            throw new TypeError('PDF.js page render method is unavailable');
        }
        const renderTask: unknown = Reflect.apply(renderFunction, page, [{
            canvas,
            canvasContext: context,
            viewport,
        }]);
        if (!isRecord(renderTask) || !(renderTask.promise instanceof Promise)) {
            throw new TypeError('PDF.js page render task is invalid');
        }
        await renderTask.promise;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let darkPixels = 0;
        let inkPixels = 0;
        let luminanceTotal = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
            const luminance = (pixels[offset]! * 0.2126)
                + (pixels[offset + 1]! * 0.7152)
                + (pixels[offset + 2]! * 0.0722);
            luminanceTotal += luminance;
            if (luminance < 245) {
                inkPixels += 1;
            }
            if (luminance < 128) {
                darkPixels += 1;
            }
        }
        const pixelCount = canvas.width * canvas.height;
        const textContent = await page.getTextContent();
        return {
            darkPixelRatio: darkPixels / pixelCount,
            height: canvas.height,
            inkPixelRatio: inkPixels / pixelCount,
            meanLuminance: luminanceTotal / pixelCount,
            textItemCount: textContent.items.length,
            width: canvas.width,
        };
    } finally {
        await document.destroy();
    }
}
