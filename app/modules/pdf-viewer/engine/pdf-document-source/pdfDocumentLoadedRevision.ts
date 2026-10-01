import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';

// A save that rewrites the working copy in place mints a new revision but
// keeps the PDF.js document every view shows, which still holds the older
// bytes. The revision the document was loaded from tells them apart.
const loadedRevisions = new WeakMap<IPdfDocument, string>();

export function recordPdfDocumentLoadedRevision(document: IPdfDocument, revision: string | null) {
    if (revision === null) {
        loadedRevisions.delete(toRaw(document));
        return;
    }
    loadedRevisions.set(toRaw(document), revision);
}

/** The working-copy revision a PDF.js document holds, or null when unknown. */
export function readPdfDocumentLoadedRevision(document: IPdfDocument) {
    // A reactive ref hands out a proxy of the document; the record is on the document itself.
    return loadedRevisions.get(toRaw(document)) ?? null;
}
