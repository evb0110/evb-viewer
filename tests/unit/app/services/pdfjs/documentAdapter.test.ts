import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { isPdfDocumentOperational } from '@app/services/pdfjs/isPdfDocumentOperational';

function asPdfDocument(value: Record<string, unknown>): IPdfDocument {
    return Object.assign({} as IPdfDocument, value);
}

describe('documentAdapter', () => {
    it('returns false for destroyed documents even when transport exists', () => {
        const doc = asPdfDocument({
            destroyed: true,
            _transport: { messageHandler: {} },
        });

        expect(isPdfDocumentOperational(doc)).toBe(false);
    });

    it('returns false when runtime transport is explicitly null', () => {
        const doc = asPdfDocument({
            destroyed: false,
            _transport: null,
        });

        expect(isPdfDocumentOperational(doc)).toBe(false);
    });

    it('returns false when transport message handler is unavailable', () => {
        const doc = asPdfDocument({_transport: { messageHandler: null }});

        expect(isPdfDocumentOperational(doc)).toBe(false);
    });

    it('returns true for live documents with usable transport', () => {
        const doc = asPdfDocument({_transport: { messageHandler: { postMessage: () => undefined } }});

        expect(isPdfDocumentOperational(doc)).toBe(true);
    });

    it('treats missing runtime transport shape as operational for compatibility', () => {
        const doc = asPdfDocument({});

        expect(isPdfDocumentOperational(doc)).toBe(true);
    });
});
