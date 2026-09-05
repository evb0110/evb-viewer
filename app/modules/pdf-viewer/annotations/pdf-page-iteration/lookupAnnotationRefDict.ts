import { PDFRef } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { IPdfAnnotationRefDict } from '@app/modules/pdf-viewer/annotations/pdf-page-iteration/pdfAnnotationRefDict';
import { safePdfContextLookupDict } from '@pdf-core';

export function lookupAnnotationRefDict(
    doc: PDFDocument,
    value: unknown,
): IPdfAnnotationRefDict | null {
    const ref = value instanceof PDFRef ? value : null;
    if (!ref) {
        return null;
    }

    const dict = safePdfContextLookupDict(doc.context, ref);
    return dict
        ? {
            dict,
            ref,
        }
        : null;
}
