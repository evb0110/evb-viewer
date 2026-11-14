import type {
    InjectionKey,
    ShallowRef,
} from 'vue';
import type {
    ICreatePdfDocumentSessionOptions,
    TPdfDocumentSession,
} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';

/**
 * Where a document keeps its one PDF session. The session module loads
 * PDF.js, which only the lazily loaded viewer may import, so the document's
 * first viewer creates the session here, in the document's effect scope: it
 * lives as long as the document, not as long as that viewer. The document
 * reads it here, without a view (null until a viewer created it).
 */
export function createPdfDocumentSessionSlot(options: ICreatePdfDocumentSessionOptions) {
    const scope = effectScope();
    const session = shallowRef<TPdfDocumentSession | null>(null);
    return {
        session: session as Readonly<ShallowRef<TPdfDocumentSession | null>>,
        resolve(create: (sessionOptions: ICreatePdfDocumentSessionOptions) => TPdfDocumentSession) {
            session.value ??= scope.run(() => create(options)) ?? null;
            if (!session.value) {
                throw new Error('The document of this PDF session is closed.');
            }
            return session.value;
        },
    };
}

export type TPdfDocumentSessionSlot = ReturnType<typeof createPdfDocumentSessionSlot>;

/** A document provides its PDF session slot to the viewers it mounts. */
export const pdfDocumentSessionSlotKey: InjectionKey<TPdfDocumentSessionSlot> = Symbol('pdfDocumentSessionSlot');
