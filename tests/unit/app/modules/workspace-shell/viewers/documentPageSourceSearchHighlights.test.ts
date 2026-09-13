import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveDocumentPageSourceSearchHighlights } from '@app/modules/workspace-shell/viewers/resolveDocumentPageSourceSearchHighlights';
import type { IDocumentSearchMatch } from '@app/modules/document-viewer/search/documentSearch';

function createMatch(overrides: Partial<IDocumentSearchMatch> = {}): IDocumentSearchMatch {
    return {
        pageIndex: 1,
        matchIndex: 7,
        startOffset: 0,
        endOffset: 4,
        pageWidth: 200,
        pageHeight: 400,
        words: [{
            text: 'word',
            x: 20,
            y: 80,
            width: 60,
            height: 40,
        }],
        ...overrides,
    };
}

describe('resolveDocumentPageSourceSearchHighlights', () => {
    it('normalizes matching-page word geometry and marks the current result', () => {
        const highlights = resolveDocumentPageSourceSearchHighlights({
            pageNumber: 2,
            results: [
                createMatch(),
                createMatch({
                    matchIndex: 8,
                    words: [{
                        text: 'next',
                        x: 100,
                        y: 200,
                        width: 20,
                        height: 80,
                    }],
                }),
                createMatch({
                    pageIndex: 2,
                    matchIndex: 9,
                }),
            ],
            currentResultIndex: 1,
        });

        expect(highlights).toHaveLength(2);
        expect(highlights[0]).toMatchObject({
            current: false,
            matchIndex: 7,
            resultIndex: 0,
        });
        expect(highlights[0]?.rect.left).toBeCloseTo(0.1);
        expect(highlights[0]?.rect.top).toBeCloseTo(0.2);
        expect(highlights[0]?.rect.width).toBeCloseTo(0.3);
        expect(highlights[0]?.rect.height).toBeCloseTo(0.1);
        expect(highlights[1]).toMatchObject({
            current: true,
            matchIndex: 8,
            resultIndex: 1,
        });
    });

    it('rotates normalized boxes without coupling them to rendered zoom dimensions', () => {
        const base = createMatch({rotation: 90});
        const ninety = resolveDocumentPageSourceSearchHighlights({
            pageNumber: 2,
            results: [base],
            currentResultIndex: 0,
        });
        const twoSeventy = resolveDocumentPageSourceSearchHighlights({
            pageNumber: 2,
            results: [{
                ...base,
                rotation: 270,
            }],
            currentResultIndex: 0,
        });

        expect(ninety[0]?.rect.left).toBeCloseTo(0.7);
        expect(ninety[0]?.rect.top).toBeCloseTo(0.1);
        expect(ninety[0]?.rect.width).toBeCloseTo(0.1);
        expect(ninety[0]?.rect.height).toBeCloseTo(0.3);
        expect(twoSeventy[0]?.rect.left).toBeCloseTo(0.2);
        expect(twoSeventy[0]?.rect.top).toBeCloseTo(0.6);
        expect(twoSeventy[0]?.rect.width).toBeCloseTo(0.1);
        expect(twoSeventy[0]?.rect.height).toBeCloseTo(0.3);
    });

    it('drops geometry-free, degenerate, and fully out-of-bounds matches', () => {
        const highlights = resolveDocumentPageSourceSearchHighlights({
            pageNumber: 2,
            results: [
                createMatch({words: []}),
                createMatch({pageWidth: 0}),
                createMatch({words: [{
                    text: 'outside',
                    x: 500,
                    y: 500,
                    width: 20,
                    height: 20,
                }]}),
            ],
            currentResultIndex: 0,
        });

        expect(highlights).toEqual([]);
    });
});
