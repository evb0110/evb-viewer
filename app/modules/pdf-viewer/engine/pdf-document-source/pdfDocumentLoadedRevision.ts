import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';

// Every view of a working copy loads its own PDF.js document, and a save
// that rewrites the file in place mints a new revision without replacing
// them. The revision each document was loaded from tells its bytes apart.
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
