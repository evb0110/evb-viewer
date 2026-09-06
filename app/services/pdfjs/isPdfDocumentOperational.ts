import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    getOptionalObject,
    isRecord,
} from '@app/services/pdfjs/runtime';

function isPdfDocumentDestroyed(pdfDocument: IPdfDocument) {
    return isRecord(pdfDocument) && pdfDocument['destroyed'] === true;
}

function getRuntimeTransport(pdfDocument: IPdfDocument) {
    if (!isRecord(pdfDocument) || !('_transport' in pdfDocument)) {
        return undefined;
    }

    const transport: unknown = pdfDocument['_transport'];
    return transport;
}

function hasUsableDocumentTransport(pdfDocument: IPdfDocument) {
    const transport: unknown = getOptionalObject(pdfDocument, '_transport') ?? getRuntimeTransport(pdfDocument);

    if (transport === null) {
        return false;
    }

    if (
        isRecord(transport)
        && 'messageHandler' in transport
        && transport.messageHandler == null
    ) {
        return false;
    }

    return true;
}

export function isPdfDocumentOperational(pdfDocument: IPdfDocument) {
    if (isPdfDocumentDestroyed(pdfDocument)) {
        return false;
    }

    return hasUsableDocumentTransport(pdfDocument);
}
