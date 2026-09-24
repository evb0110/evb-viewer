import {
    describe,
    expect,
    it,
} from 'vitest';
import {PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES} from '@contracts/electronApiDocuments';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {DOCUMENT_FILES_PLATFORM_FEATURE} from '@contracts/documentsPlatformFeature';

const token = requireDocumentRevisionToken('drt1:embedded-shape-index-test');
const channels = DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels;
const codecs = DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs;

describe('PDF embedded shape index IPC contracts', () => {
    it('round-trips begin, chunk, and lifecycle payloads', () => {
        const entry = {
            pageIndex: 4,
            objectNumber: 17,
            generationNumber: 0,
            stableKey: 'shape-17',
            pdfSubtype: 'Square',
            type: 'rectangle',
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.4,
            x2: null,
            y2: null,
            color: '#ff0000',
            fillColor: '#00ff00',
            opacity: 0.75,
            strokeWidth: 2,
            points: null,
            strokes: null,
            lineStartStyle: null,
            lineEndStyle: null,
            createdAt: 1_704_164_645_000,
            modifiedAt: null,
        };
        const session = {
            sessionId: 'embedded-shape-index-session',
            documentRef: '/tmp/document.pdf',
            documentRevisionToken: token,
            pageCount: 5,
            entryCount: 1,
            totalBytes: 512,
        };
        const chunk = {
            offset: 0,
            nextOffset: null,
            byteLength: 512,
            done: true,
            entries: [entry],
        };

        expect(codecs[channels.beginPdfEmbeddedShapeIndex]!.decodeArgs([
            '/tmp/document.pdf',
            {expectedDocumentRevisionToken: token},
        ])).toEqual([
            '/tmp/document.pdf',
            {expectedDocumentRevisionToken: token},
        ]);
        expect(codecs[channels.beginPdfEmbeddedShapeIndex]!.decodeResult(session)).toEqual(session);
        expect(codecs[channels.readPdfEmbeddedShapeIndexChunk]!.decodeArgs([
            'embedded-shape-index-session',
            0,
            {chunkBytes: 512},
        ])).toEqual([
            'embedded-shape-index-session',
            0,
            {chunkBytes: 512},
        ]);
        expect(codecs[channels.readPdfEmbeddedShapeIndexChunk]!.decodeResult(chunk)).toEqual(chunk);
        expect(codecs[channels.releasePdfEmbeddedShapeIndex]!.decodeArgs(['embedded-shape-index-session'])).toEqual(['embedded-shape-index-session']);
    });

    it('rejects missing revisions, unsafe shape fields, and oversized chunks', () => {
        const beginCodec = codecs[channels.beginPdfEmbeddedShapeIndex]!;
        const chunkCodec = codecs[channels.readPdfEmbeddedShapeIndexChunk]!;

        expect(() => beginCodec.decodeArgs([
            '/tmp/document.pdf',
            {},
        ])).toThrow(/invalid document revision options/iu);
        expect(() => chunkCodec.decodeArgs([
            'embedded-shape-index-session',
            0,
            {chunkBytes: PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES + 1},
        ])).toThrow(/chunkBytes/iu);
        expect(() => chunkCodec.decodeResult({
            offset: 0,
            nextOffset: null,
            byteLength: 0,
            done: true,
            entries: [{
                pageIndex: 0,
                objectNumber: Number.MAX_SAFE_INTEGER + 1,
                generationNumber: 0,
                stableKey: null,
                pdfSubtype: 'Square',
                type: 'rectangle',
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                x2: null,
                y2: null,
                color: '#000000',
                fillColor: null,
                opacity: 1,
                strokeWidth: 1,
                points: null,
                strokes: null,
                lineStartStyle: null,
                lineEndStyle: null,
                createdAt: null,
                modifiedAt: null,
            }],
        })).toThrow(/objectNumber/iu);
    });
});
