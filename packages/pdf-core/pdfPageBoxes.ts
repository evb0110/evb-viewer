import type {
    PDFDict,
    PDFDocument,
    PDFPage,
} from 'pdf-lib';
import type { IPdfBox } from '@contracts/geometry';
import {
    PDFArray,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import { safePdfDictLookupArray } from '@pdf-core/safePdfLookup';

// Removal condition: pdf-page-ops gains an N-source Form XObject composition
// operation, allowing the print path to stop using pdf-lib page geometry.

export type IPdfPageBox = IPdfBox;

// Keep pdf-lib here until pdf-page-ops gains the N-source Form XObject
// composition needed by the print imposition path.

export type TPdfRect = [number, number, number, number];

const RECT_NAME = 'Rect';

export function arePdfPageBoxesEqual(left: IPdfPageBox, right: IPdfPageBox) {
    return left.x === right.x
        && left.y === right.y
        && left.width === right.width
        && left.height === right.height;
}

export function normalizePdfPageBox(box: IPdfPageBox): IPdfPageBox | null {
    const minX = Math.min(box.x, box.x + box.width);
    const minY = Math.min(box.y, box.y + box.height);
    const maxX = Math.max(box.x, box.x + box.width);
    const maxY = Math.max(box.y, box.y + box.height);
    const width = maxX - minX;
    const height = maxY - minY;

    if (width <= 0 || height <= 0) {
        return null;
    }

    return {
        x: minX,
        y: minY,
        width,
        height,
    };
}

export function intersectPdfPageBoxes(left: IPdfPageBox, right: IPdfPageBox): IPdfPageBox | null {
    const minX = Math.max(left.x, right.x);
    const minY = Math.max(left.y, right.y);
    const maxX = Math.min(left.x + left.width, right.x + right.width);
    const maxY = Math.min(left.y + left.height, right.y + right.height);
    const width = maxX - minX;
    const height = maxY - minY;

    if (width <= 0 || height <= 0) {
        return null;
    }

    return {
        x: minX,
        y: minY,
        width,
        height,
    };
}

export function resolvePdfLibMediaBox(page: PDFPage): IPdfPageBox {
    const mediaBox = normalizePdfPageBox(page.getMediaBox())
        ?? normalizePdfPageBox({
            x: 0,
            y: 0,
            ...page.getSize(),
        });
    if (!mediaBox) {
        throw new Error('PDF page has an invalid media box');
    }

    return mediaBox;
}

export function resolvePdfLibCropBox(page: PDFPage, mediaBox: IPdfPageBox): IPdfPageBox | null {
    const cropBox = normalizePdfPageBox(page.getCropBox());
    if (!cropBox || arePdfPageBoxesEqual(cropBox, mediaBox)) {
        return null;
    }

    const effectiveCropBox = intersectPdfPageBoxes(cropBox, mediaBox);
    if (!effectiveCropBox || arePdfPageBoxesEqual(effectiveCropBox, mediaBox)) {
        return null;
    }

    return effectiveCropBox;
}

export function toPdfRect(box: IPdfPageBox): TPdfRect {
    return [
        box.x,
        box.y,
        box.x + box.width,
        box.y + box.height,
    ];
}

export function fromPdfRect(rect: TPdfRect): IPdfPageBox | null {
    return normalizePdfPageBox({
        x: rect[0],
        y: rect[1],
        width: rect[2] - rect[0],
        height: rect[3] - rect[1],
    });
}

export function resolvePdfLibPageView(page: ReturnType<PDFDocument['getPages']>[number]): TPdfRect {
    const mediaBox = resolvePdfLibMediaBox(page);
    const cropBox = resolvePdfLibCropBox(page, mediaBox);
    return toPdfRect(cropBox ?? mediaBox);
}

export function tryResolvePdfLibPageView(page: ReturnType<PDFDocument['getPages']>[number]): TPdfRect | null {
    try {
        return resolvePdfLibPageView(page);
    } catch {
        return null;
    }
}

export function numberFromPdfBox(box: PDFArray, index: number) {
    const value = box.get(index);
    return value instanceof PDFNumber ? value.asNumber() : null;
}

export function readPdfRectFromDict(dict: PDFDict): TPdfRect | null {
    const rect = safePdfDictLookupArray(dict, PDFName.of(RECT_NAME));
    if (!(rect instanceof PDFArray) || rect.size() < 4) {
        return null;
    }

    const x1 = numberFromPdfBox(rect, 0);
    const y1 = numberFromPdfBox(rect, 1);
    const x2 = numberFromPdfBox(rect, 2);
    const y2 = numberFromPdfBox(rect, 3);
    if (
        x1 === null
        || y1 === null
        || x2 === null
        || y2 === null
    ) {
        return null;
    }

    return [
        x1,
        y1,
        x2,
        y2,
    ];
}
