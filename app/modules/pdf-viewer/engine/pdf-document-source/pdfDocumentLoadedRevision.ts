import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {IPdfAnnotationParseResult} from '@contracts/pdfAnnotationParseTypes';
import type {TDocumentRef} from '@contracts/documentRef';

interface IPdfOriginalAnnotationSource {
    readonly ref: TDocumentRef;
    release: () => Promise<void>;
}

// A save that rewrites the working copy in place mints a new revision but
// keeps the PDF.js document every view shows, which still holds the older
// bytes. The revision the document was loaded from tells them apart.
const loadedRevisions = new WeakMap<IPdfDocument, {
    readonly revision: string | null;
    annotations: IPdfAnnotationParseResult | null;
    originalSource?: Promise<IPdfOriginalAnnotationSource>;
}>();

export function recordPdfDocumentLoadedRevision(document: IPdfDocument, revision: string | null) {
    const raw = toRaw(document);
    // A later view cannot establish different bytes, including when the first load's revision was unknown.
    if (!loadedRevisions.has(raw)) loadedRevisions.set(raw, {
        revision,
        annotations: null,
    });
}

/** The working-copy revision a PDF.js document holds, or null when unknown. */
export function readPdfDocumentLoadedRevision(document: IPdfDocument) {
    // A reactive ref hands out a proxy of the document; the record is on the document itself.
    return loadedRevisions.get(toRaw(document))?.revision ?? null;
}

function freezeParsedInput<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(freezeParsedInput);
        Object.freeze(value);
    }
    return value;
}

/** The native parse of these loaded bytes, never the store's later saved baseline. */
export async function recordPdfDocumentOriginalAnnotations(
    document: IPdfDocument,
    result: IPdfAnnotationParseResult,
    preserveOriginalSource?: () => Promise<IPdfOriginalAnnotationSource>,
) {
    const loaded = loadedRevisions.get(toRaw(document));
    if (loaded && loaded.revision === result.documentRevisionToken) {
        loaded.annotations ??= freezeParsedInput(structuredClone(result));
        if (!loaded.originalSource && preserveOriginalSource && loaded.annotations.entities.some(entry => entry.kind === 'text-box' && !entry.readOnly && !entry.recoveryData)) {
            const originalSource = preserveOriginalSource();
            loaded.originalSource = originalSource;
            void originalSource.catch(() => {
                if (loaded.originalSource === originalSource) delete loaded.originalSource;
            });
        }
    }
    await loaded?.originalSource;
}

export function readPdfDocumentOriginalAnnotations(document: IPdfDocument) {
    return loadedRevisions.get(toRaw(document))?.annotations ?? null;
}

/** The managed immutable source retained when an original graph exceeds inline recovery. */
export function readPdfDocumentOriginalAnnotationSource(document: IPdfDocument) {
    return loadedRevisions.get(toRaw(document))?.originalSource?.then(source => source.ref) ?? Promise.resolve(null);
}

/** The document owner releases these immutable bytes after its PDF.js proxy retires. */
export async function releasePdfDocumentOriginalAnnotations(document: IPdfDocument) {
    const raw = toRaw(document);
    const loaded = loadedRevisions.get(raw);
    loadedRevisions.delete(raw);
    // A rejected capture already releases its allocation at the source boundary.
    const source = await loaded?.originalSource?.catch(() => null);
    await source?.release();
}
