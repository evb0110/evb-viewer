import type { PDFDocument } from 'pdf-lib';
import {
    PDFDict,
    PDFName,
    PDFRef,
} from 'pdf-lib';

export function getPdfPopupDict(doc: PDFDocument, dict: PDFDict | null) {
    if (!dict) {
        return null;
    }
    const popupValue = dict.get(PDFName.of('Popup'));
    if (popupValue instanceof PDFDict) {
        return popupValue;
    }
    if (popupValue instanceof PDFRef) {
        return doc.context.lookupMaybe(popupValue, PDFDict) ?? null;
    }
    return null;
}
