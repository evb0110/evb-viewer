import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Check whether a PDFDocumentProxy is still in a usable state.
 *
 * pdf.js tears down internal state (nulls `_transport`, sets `destroyed`)
 * during `PDFDocumentProxy.destroy()`.  Calling methods like `getPage()`
 * or `render()` after destruction throws, so callers should bail early.
 */
export function isPdfDocumentUsable(pdfDocument: PDFDocumentProxy) {
    // pdf.js sets `destroyed = true` at runtime during cleanup.
    // PDFDocumentProxy's type declarations omit this property,
    // so we use an `in` check for runtime narrowing.
    if ('destroyed' in pdfDocument && pdfDocument.destroyed === true) {
        return false;
    }

    // `_transport` is typed as `any` on PDFDocumentProxy.
    // pdf.js nulls it during destroy(), which causes getPage/render to crash.
    if (pdfDocument._transport === null) {
        return false;
    }

    if (
        pdfDocument._transport
        && typeof pdfDocument._transport === 'object'
        && 'messageHandler' in pdfDocument._transport
        && pdfDocument._transport.messageHandler == null
    ) {
        return false;
    }

    return true;
}
