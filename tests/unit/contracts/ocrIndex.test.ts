import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeOcrPage,
    parseOcrIndexV3Manifest,
} from '@contracts/ocrIndex';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const revision = requireDocumentRevisionToken('drt1:test');

function createPage(overrides: Record<string, unknown> = {}) {
    return {
        rotation: 0,
        render: {
            dpi: 300,
            imagePx: {
                w: 1200,
                h: 1600,
            },
        },
        text: 'hello',
        words: [],
        ...overrides,
    };
}

describe('OCR index codecs', () => {
    it('reconstructs a strict manifest and rejects malformed page mappings', () => {
        const manifest = {
            version: 3,
            documentRevision: {token: revision},
            createdAt: 1,
            source: {pdfPath: '/tmp/work.pdf'},
            pageCount: 1,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {1: {path: 'page-1.json'}},
        };

        expect(parseOcrIndexV3Manifest(manifest)).toEqual(manifest);
        expect(parseOcrIndexV3Manifest({
            ...manifest,
            pages: {'1junk': {path: 'page-1.json'}},
        })).toBeNull();
    });

    it('carries the page generation and drops an unusable one instead of the mapping', () => {
        const manifest = {
            version: 3,
            documentRevision: {token: revision},
            createdAt: 1,
            source: {pdfPath: '/tmp/work.pdf'},
            pageCount: 2,
            pageBox: 'crop',
            ocr: {
                engine: 'tesseract',
                languages: ['eng'],
                renderDpi: 300,
            },
            pages: {
                1: {
                    path: 'page-1.json',
                    generation: 'run-a',
                },
                2: {path: 'page-2.json'},
            },
        };

        expect(parseOcrIndexV3Manifest(manifest)?.pages).toEqual({
            1: {
                path: 'page-1.json',
                generation: 'run-a',
            },
            2: {path: 'page-2.json'},
        });
        expect(parseOcrIndexV3Manifest({
            ...manifest,
            pages: {
                1: {
                    path: 'page-1.json',
                    generation: '',
                },
                2: {
                    path: 'page-2.json',
                    generation: 7,
                },
            },
        })?.pages).toEqual({
            1: {path: 'page-1.json'},
            2: {path: 'page-2.json'},
        });
    });

    it('reads a page artifact written under the per-page revision schema', () => {
        expect(decodeOcrPage(createPage({
            pageNumber: 7,
            documentRevision: {token: requireDocumentRevisionToken('drt1:some-older-revision')},
        }))).toEqual({
            rotation: 0,
            render: {
                dpi: 300,
                imagePx: {
                    w: 1200,
                    h: 1600,
                },
            },
            text: 'hello',
            words: [],
        });
    });

    it('salvages text from an incomplete page only in repair-legacy mode', () => {
        const incompletePage = {
            text: 'hello',
            words: [],
        };

        expect(decodeOcrPage(incompletePage, 'strict')).toBeNull();
        expect(decodeOcrPage(incompletePage, 'repair-legacy')).toMatchObject({text: 'hello'});
    });

    it('rejects malformed OCR words', () => {
        expect(decodeOcrPage(createPage({words: [{text: 'bad'}]}))).toBeNull();
    });

    it('rejects zero-sized geometry and zero DPI in strict mode', () => {
        expect(decodeOcrPage(createPage({render: {
            dpi: 300,
            imagePx: {
                w: 0,
                h: 1600,
            },
        }}))).toBeNull();
        expect(decodeOcrPage(createPage({render: {
            dpi: 0,
            imagePx: {
                w: 1200,
                h: 1600,
            },
        }}))).toBeNull();
    });
});
