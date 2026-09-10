import type {IPdfViewport} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { IOcrWord } from '@contracts/shared';

interface IOcrPageRenderGeometry {render?: {imagePx: {
    w: number;
    h: number
}};}

export function transformOcrWordToViewport(
    word: IOcrWord,
    ocrPageData: IOcrPageRenderGeometry,
    pageWidth: number,
    pageHeight: number,
    viewport: IPdfViewport,
): {
    x: number;
    y: number;
    width: number;
    height: number;
} | null {
    const imagePx = ocrPageData.render?.imagePx;
    if (!imagePx) {
        return null;
    }

    const sx = pageWidth / imagePx.w;
    const sy = pageHeight / imagePx.h;
    const viewBox = Array.isArray(viewport.viewBox) ? viewport.viewBox : [];
    const pageX = viewBox[0] ?? 0;
    const pageY = viewBox[1] ?? 0;

    const pdfX = pageX + word.x * sx;
    const pdfY = pageY + pageHeight - (word.y + word.height) * sy;
    const pdfX2 = pageX + (word.x + word.width) * sx;
    const pdfY2 = pageY + pageHeight - word.y * sy;

    const rawRect: unknown = viewport.convertToViewportRectangle([
        pdfX,
        pdfY,
        pdfX2,
        pdfY2,
    ]);
    if (!Array.isArray(rawRect) || rawRect.length < 4) {
        return null;
    }
    const rectValues = rawRect as unknown[];
    const x1 = rectValues[0];
    const y1 = rectValues[1];
    const x2 = rectValues[2];
    const y2 = rectValues[3];
    if (
        typeof x1 !== 'number'
        || !Number.isFinite(x1)
        || typeof y1 !== 'number'
        || !Number.isFinite(y1)
        || typeof x2 !== 'number'
        || !Number.isFinite(x2)
        || typeof y2 !== 'number'
        || !Number.isFinite(y2)
    ) {
        return null;
    }
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);

    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
}
