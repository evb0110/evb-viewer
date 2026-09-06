import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import { isPdfDocumentOperational } from '@app/services/pdfjs/isPdfDocumentOperational';

/**
 * Check whether a PDF document is still in a usable state.
 *
 * pdf.js tears down internal state (nulls `_transport`, sets `destroyed`)
 * during `destroy()`. Calling methods like `getPage()`
 * or `render()` after destruction throws, so callers should bail early.
 */
export function isPdfDocumentUsable(pdfDocument: IPdfDocument) {
    return isPdfDocumentOperational(pdfDocument);
}
