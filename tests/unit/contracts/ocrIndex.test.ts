import {
    describe,
    expect,
    it,
} from 'vitest';
import {decodeOcrPage} from '@contracts/ocrIndex';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

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
