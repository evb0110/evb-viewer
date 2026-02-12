import type {PDFDict} from 'pdf-lib';
import {
    PDFArray,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFString,
} from 'pdf-lib';

export function getPdfStringValue(value: unknown) {
    if (value instanceof PDFHexString || value instanceof PDFString) {
        return value.decodeText();
    }
    return '';
}

export function getPdfDictSubtype(dict: PDFDict | null) {
    if (!dict) {
        return null;
    }
    const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
    if (!(subtype instanceof PDFName)) {
        return null;
    }
    return subtype.decodeText();
}

export function getPdfDictContents(dict: PDFDict | null) {
    if (!dict) {
        return '';
    }
    return getPdfStringValue(dict.get(PDFName.of('Contents')));
}

function numberFromPdfArray(array: PDFArray, index: number) {
    const value = array.get(index);
    return value instanceof PDFNumber ? value.asNumber() : null;
}

export function normalizeMarkerRectFromDict(
    dict: PDFDict | null,
    pageWidth: number,
    pageHeight: number,
) {
    if (!dict || pageWidth <= 0 || pageHeight <= 0) {
        return null;
    }

    const rectArray = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
    if (!(rectArray instanceof PDFArray) || rectArray.size() < 4) {
        return null;
    }

    const x1 = numberFromPdfArray(rectArray, 0);
    const y1 = numberFromPdfArray(rectArray, 1);
    const x2 = numberFromPdfArray(rectArray, 2);
    const y2 = numberFromPdfArray(rectArray, 3);
    if (
        x1 === null
        || y1 === null
        || x2 === null
        || y2 === null
    ) {
        return null;
    }

    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);

    const width = (maxX - minX) / pageWidth;
    const height = (maxY - minY) / pageHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }

    const left = minX / pageWidth;
    const top = 1 - (maxY / pageHeight);

    return {
        left: Math.max(0, Math.min(1, left)),
        top: Math.max(0, Math.min(1, top)),
        width: Math.max(0, Math.min(1, width)),
        height: Math.max(0, Math.min(1, height)),
    };
}
