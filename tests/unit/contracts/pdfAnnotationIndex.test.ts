import {
    describe,
    expect,
    it,
} from 'vitest';
import {PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES} from '@contracts/electronApiDocuments';
import {DOCUMENT_FILES_PLATFORM_FEATURE} from '@contracts/documentsPlatformFeature';

const channels = DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels;
const codecs = DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs;

describe('PDF annotation index IPC contracts', () => {

    it('rejects missing revisions, unsafe references, and oversized chunks', () => {
        const beginCodec = codecs[channels.beginPdfAnnotationIndex]!;
        const chunkCodec = codecs[channels.readPdfAnnotationIndexChunk]!;

        expect(() => beginCodec.decodeArgs([
            '/tmp/document.pdf',
            {},
        ])).toThrow(/invalid document revision options/iu);
        expect(() => chunkCodec.decodeArgs([
            'annotation-index-session',
            0,
            {chunkBytes: PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES + 1},
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
                subtype: 'Text',
                name: null,
                popupRef: null,
                parentRef: null,
            }],
        })).toThrow(/objectNumber/iu);
        expect(() => chunkCodec.decodeResult({
            offset: 0,
            nextOffset: null,
            byteLength: 0,
            done: true,
            entries: [{
                pageIndex: 0,
                objectNumber: -1,
                generationNumber: 0,
                subtype: 'Text',
                name: null,
                popupRef: null,
                parentRef: null,
            }],
        })).toThrow(/objectNumber/iu);
    });
});
