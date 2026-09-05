import {
    describe,
    expect,
    it,
} from 'vitest';
import {PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES} from '@contracts/electronApiDocuments';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {PDF_ANNOTATION_PARSE_MAX_ENTRIES} from '@contracts/pdfAnnotationParseTypes';
import {
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';

const token = requireDocumentRevisionToken('drt1:annotation-parse-test');
const channels = DOCUMENT_FILES_PLATFORM_FEATURE.invokeChannels;
const codecs = DOCUMENT_FILES_PLATFORM_FEATURE.ipcCodecs;

describe('PDF annotation parse IPC contracts', () => {
    it('round-trips parse sessions, entries, chunks, and lifecycle payloads', () => {
        const textBox = {
            kind: 'text-box' as const,
            pageIndex: 0,
            objectNumber: 17,
            generationNumber: 0,
            name: 'text-box-17',
            author: 'Author',
            createdAt: 1_788_091_200_000,
            modifiedAt: null,
            text: 'A text box',
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.4,
            },
            rotation: 0 as const,
            fontSize: 12,
            color: '#336699',
        };
        const note = {
            kind: 'note' as const,
            pageIndex: 0,
            objectNumber: 18,
            generationNumber: 0,
            name: 'note-18',
            author: null,
            createdAt: null,
            modifiedAt: null,
            position: {
                left: 0.4,
                top: 0.1,
                width: 0.1,
                height: 0.1,
            },
            contents: 'A note',
            color: '#ff0000',
            open: true,
            replies: [{
                objectNumber: 24,
                generationNumber: 0,
                contents: 'A reply',
                author: null,
                createdAt: 1_788_091_320_000,
                modifiedAt: null,
            }],
        };
        const foreign = {
            kind: 'foreign' as const,
            pageIndex: 0,
            objectNumber: 19,
            generationNumber: 0,
            name: 'foreign-19',
            subtype: 'Link',
            reason: 'Unsupported annotation subtype /Link',
        };
        const highlight = {
            kind: 'highlight' as const,
            pageIndex: 0,
            objectNumber: 20,
            generationNumber: 0,
            name: 'highlight-20',
            author: 'Author',
            createdAt: null,
            modifiedAt: 1_788_091_300_000,
            subtype: 'Highlight' as const,
            quadPoints: [{
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.05,
            }],
            color: '#ffcc00',
            opacity: 0.5,
            contents: 'A highlight',
        };
        const stamp = {
            kind: 'stamp' as const,
            pageIndex: 0,
            objectNumber: 21,
            generationNumber: 0,
            name: 'stamp-21',
            author: null,
            createdAt: null,
            modifiedAt: null,
            rect: {
                left: 0.1,
                top: 0.2,
                width: 0.25,
                height: 0.35,
            },
            rotation: 90 as const,
            image: {
                objectNumber: 22,
                generationNumber: 0,
                byteLength: 128,
                sha256: 'a'.repeat(64),
            },
        };
        const shape = {
            kind: 'shape' as const,
            pageIndex: 0,
            objectNumber: 23,
            generationNumber: 0,
            name: 'shape-23',
            author: 'Author',
            createdAt: null,
            modifiedAt: null,
            stableKey: 'shape-23',
            pdfSubtype: 'Line' as const,
            type: 'line' as const,
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.4,
            x2: 0.8,
            y2: 0.9,
            color: '#112233',
            fillColor: null,
            opacity: 0.75,
            strokeWidth: 2,
            points: null,
            strokes: null,
            lineStartStyle: 'none' as const,
            lineEndStyle: 'closedArrow' as const,
        };
        const session = {
            sessionId: 'annotation-parse-session',
            documentRef: '/tmp/document.pdf',
            documentRevisionToken: token,
            pageCount: 1,
            entryCount: 6,
            totalBytes: 512,
        };
        const chunk = {
            offset: 0,
            nextOffset: null,
            byteLength: 512,
            done: true,
            entries: [
                textBox,
                note,
                foreign,
                highlight,
                stamp,
                shape,
            ],
        };

        expect(codecs[channels.beginPdfAnnotationParse]!.decodeArgs([
            '/tmp/document.pdf',
            {expectedDocumentRevisionToken: token},
        ])).toEqual([
            '/tmp/document.pdf',
            {expectedDocumentRevisionToken: token},
        ]);
        expect(codecs[channels.beginPdfAnnotationParse]!.decodeResult(session)).toEqual(session);
        expect(codecs[channels.readPdfAnnotationParseChunk]!.decodeArgs([
            'annotation-parse-session',
            0,
            {chunkBytes: 512},
        ])).toEqual([
            'annotation-parse-session',
            0,
            {chunkBytes: 512},
        ]);
        const decodedChunk = codecs[channels.readPdfAnnotationParseChunk]!.decodeResult(chunk);
        expect(decodedChunk).toEqual(chunk);
        expect(decodedChunk.entries.map(entry => entry.kind)).toEqual([
            'text-box',
            'note',
            'foreign',
            'highlight',
            'stamp',
            'shape',
        ]);
        expect(decodedChunk.entries[1]).toMatchObject({
            kind: 'note',
            replies: [{
                objectNumber: 24,
                generationNumber: 0,
                contents: 'A reply',
                author: null,
                createdAt: 1_788_091_320_000,
                modifiedAt: null,
            }],
        });
        expect(decodedChunk.entries[3]).toMatchObject({
            kind: 'highlight',
            subtype: 'Highlight',
            color: '#ffcc00',
            opacity: 0.5,
            quadPoints: [{
                left: 0.2,
                top: 0.3,
                width: 0.4,
                height: 0.05,
            }],
        });
        expect(decodedChunk.entries[4]).toMatchObject({
            kind: 'stamp',
            rotation: 90,
            image: {
                byteLength: 128,
                sha256: 'a'.repeat(64),
            },
        });
        expect(decodedChunk.entries[5]).toMatchObject({
            kind: 'shape',
            pdfSubtype: 'Line',
            type: 'line',
            x2: 0.8,
            y2: 0.9,
            lineEndStyle: 'closedArrow',
        });
        const uppercaseStampChunk = {
            ...chunk,
            entries: chunk.entries.map(entry => entry.kind === 'stamp'
                ? {
                    ...entry,
                    image: {
                        ...entry.image,
                        sha256: 'A'.repeat(64),
                    },
                }
                : entry),
        };
        const normalizedStampChunk = codecs[channels.readPdfAnnotationParseChunk]!.decodeResult(uppercaseStampChunk);
        expect(normalizedStampChunk.entries[4]).toMatchObject({
            kind: 'stamp',
            image: {sha256: 'a'.repeat(64)},
        });
        const invalidStampChunk = {
            ...chunk,
            entries: chunk.entries.map(entry => entry.kind === 'stamp'
                ? {
                    ...entry,
                    image: {
                        ...entry.image,
                        sha256: 'not-a-sha256',
                    },
                }
                : entry),
        };
        expect(() => codecs[channels.readPdfAnnotationParseChunk]!.decodeResult(invalidStampChunk))
            .toThrow(/sha256/iu);
        const noteWithUnknownReply = {
            ...chunk,
            entries: chunk.entries.map(entry => entry.kind === 'note'
                ? {
                    ...entry,
                    replies: entry.replies.map(reply => ({
                        ...reply,
                        unexpected: true,
                    })),
                }
                : entry),
        };
        expect(() => codecs[channels.readPdfAnnotationParseChunk]!.decodeResult(noteWithUnknownReply))
            .toThrow(/unsupported field/iu);

        const shapeWithUnknownPointField = {
            ...shape,
            points: [{
                x: 0.1,
                y: 0.2,
                unexpected: true,
            }],
        };
        expect(() => codecs[channels.readPdfAnnotationParseChunk]!.decodeResult({
            ...chunk,
            entries: [
                textBox,
                note,
                foreign,
                highlight,
                stamp,
                shapeWithUnknownPointField,
            ],
        })).toThrow(/unsupported field/iu);

        expect(() => codecs[channels.readPdfAnnotationParseChunk]!.decodeResult({
            ...chunk,
            entries: [
                {
                    ...textBox,
                    fontSize: 512.01,
                },
                note,
                foreign,
                highlight,
                stamp,
                shape,
            ],
        })).toThrow(/fontSize.*512/iu);

        expect(() => codecs[channels.readPdfAnnotationParseChunk]!.decodeResult({
            ...chunk,
            entries: [
                textBox,
                note,
                foreign,
                {
                    ...highlight,
                    opacity: 1.01,
                },
                stamp,
                shape,
            ],
        })).toThrow(/highlight\.opacity.*1/iu);

        expect(() => codecs[channels.readPdfAnnotationParseChunk]!.decodeResult({
            ...chunk,
            entries: [
                textBox,
                note,
                foreign,
                highlight,
                stamp,
                {
                    ...shape,
                    opacity: 1.01,
                },
            ],
        })).toThrow(/shape\.opacity.*1/iu);

        expect(codecs[channels.releasePdfAnnotationParse]!.decodeArgs(['annotation-parse-session']))
            .toEqual(['annotation-parse-session']);
        expect(codecs[channels.releasePdfAnnotationParse]!.decodeResult(true)).toBe(true);
        expect(codecs[channels.cancelPdfAnnotationParse]!.decodeArgs(['annotation-parse-session']))
            .toEqual(['annotation-parse-session']);
        expect(codecs[channels.cancelPdfAnnotationParse]!.decodeResult({canceled: true}))
            .toEqual({canceled: true});

        const parseResult = {
            documentRevisionToken: token,
            pageCount: 1,
            entities: [
                textBox,
                note,
                highlight,
                stamp,
                shape,
            ],
            foreign: [foreign],
        };
        const workingCopyParseCodec = DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.ipcCodecs[
            DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.parsePdfAnnotations
        ]!;
        expect(workingCopyParseCodec.decodeArgs([
            '/tmp/document.pdf',
            {expectedDocumentRevisionToken: token},
        ])).toEqual([
            '/tmp/document.pdf',
            {expectedDocumentRevisionToken: token},
        ]);
        expect(workingCopyParseCodec.decodeResult(parseResult)).toEqual(parseResult);
    });

    it('rejects missing revisions, invalid entities, and oversized chunks', () => {
        const beginCodec = codecs[channels.beginPdfAnnotationParse]!;
        const chunkCodec = codecs[channels.readPdfAnnotationParseChunk]!;
        expect(() => beginCodec.decodeArgs([
            '/tmp/document.pdf',
            {},
        ])).toThrow(/invalid document revision options/iu);
        expect(() => chunkCodec.decodeArgs([
            'annotation-parse-session',
            0,
            {chunkBytes: PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES + 1},
        ])).toThrow(/chunkBytes/iu);
        expect(() => chunkCodec.decodeResult({
            offset: 0,
            nextOffset: null,
            byteLength: 0,
            done: true,
            entries: [{
                kind: 'text-box',
                pageIndex: 0,
                objectNumber: 1,
                generationNumber: 0,
                name: 'invalid',
                author: null,
                createdAt: null,
                modifiedAt: null,
                text: 'bad',
                rect: {
                    left: 0.9,
                    top: 0.9,
                    width: 0.2,
                    height: 0.2,
                },
                rotation: 0,
                fontSize: 12,
                color: '#336699',
            }],
        })).toThrow(/normalized page bounds/iu);
        expect(() => chunkCodec.decodeResult({
            offset: 0,
            nextOffset: null,
            byteLength: 0,
            done: true,
            entries: [{
                kind: 'foreign',
                pageIndex: 0,
                objectNumber: 1,
                generationNumber: 0,
                name: 'foreign',
                subtype: 'Link',
                reason: 'unsupported',
                unexpected: true,
            }],
        })).toThrow(/unsupported field/iu);

        const workingCopyParseCodec = DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.ipcCodecs[
            DOCUMENT_WORKING_COPY_PLATFORM_FEATURE.invokeChannels.parsePdfAnnotations
        ]!;
        expect(() => workingCopyParseCodec.decodeResult({
            documentRevisionToken: token,
            pageCount: 1,
            entities: new Array(PDF_ANNOTATION_PARSE_MAX_ENTRIES + 1).fill(null),
            foreign: [],
        })).toThrow(/more than/iu);
    });
});
