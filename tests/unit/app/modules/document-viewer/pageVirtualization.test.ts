import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createAnchorFirstPageOrder,
    createAnchorPageWindow,
    createPageNumbersForWindow,
    expandVirtualWindowForAnchor,
    normalizeDocumentViewerPageRange,
} from '@app/modules/document-viewer/virtualization/pageVirtualization';

describe('document viewer page virtualization', () => {
    it('normalizes inclusive 1-based page ranges with padding', () => {
        expect(normalizeDocumentViewerPageRange({
            startPage: 12,
            endPage: 8,
            totalPages: 20,
            paddingPages: 2,
        })).toEqual({
            start: 6,
            end: 14,
        });
    });

    it('returns an empty range for invalid document totals', () => {
        expect(normalizeDocumentViewerPageRange({
            startPage: 1,
            endPage: 3,
            totalPages: 0,
            paddingPages: 2,
        })).toEqual({
            start: 1,
            end: 0,
        });
        expect(createPageNumbersForWindow({
            start: 1,
            end: 0,
        })).toEqual([]);
    });

    it('creates fallback anchor windows clamped to document bounds', () => {
        expect(createAnchorPageWindow({
            anchorPage: 1,
            totalPages: 5,
            radiusPages: 4,
        })).toEqual({
            start: 1,
            end: 5,
        });

        expect(createAnchorPageWindow({
            anchorPage: null,
            totalPages: 5,
            radiusPages: 4,
        })).toBeNull();
    });

    it('keeps the existing window when no resize anchor page is provided', () => {
        expect(expandVirtualWindowForAnchor({
            baseStart: 10,
            baseEnd: 20,
            anchorPage: null,
            totalPages: 100,
            buffer: 6,
        })).toEqual({
            start: 10,
            end: 20,
        });
    });

    it('expands the window to keep an anchor page mounted', () => {
        expect(expandVirtualWindowForAnchor({
            baseStart: 40,
            baseEnd: 52,
            anchorPage: 30,
            totalPages: 100,
            buffer: 6,
        })).toEqual({
            start: 24,
            end: 52,
        });
    });

    it('clamps expanded windows into document bounds', () => {
        expect(expandVirtualWindowForAnchor({
            baseStart: 3,
            baseEnd: 10,
            anchorPage: 1,
            totalPages: 12,
            buffer: 8,
        })).toEqual({
            start: 1,
            end: 10,
        });
    });

    it('prioritizes pages in the forward scroll direction', () => {
        expect(createAnchorFirstPageOrder({
            anchorPage: 10,
            direction: 1,
            range: normalizeDocumentViewerPageRange({
                startPage: 8,
                endPage: 12,
                totalPages: 20,
                paddingPages: 2,
            }),
        })).toEqual([
            10,
            11,
            9,
            12,
            13,
            14,
            8,
            7,
            6,
        ]);
    });

    it('prioritizes pages in the backward scroll direction', () => {
        expect(createAnchorFirstPageOrder({
            anchorPage: 10,
            direction: -1,
            range: normalizeDocumentViewerPageRange({
                startPage: 8,
                endPage: 12,
                totalPages: 20,
                paddingPages: 2,
            }),
        })).toEqual([
            10,
            9,
            11,
            8,
            7,
            6,
            12,
            13,
            14,
        ]);
    });

    it('balances both sides when scroll direction is unknown', () => {
        expect(createAnchorFirstPageOrder({
            anchorPage: 10,
            direction: 0,
            range: normalizeDocumentViewerPageRange({
                startPage: 8,
                endPage: 12,
                totalPages: 20,
                paddingPages: 2,
            }),
        })).toEqual([
            10,
            11,
            9,
            12,
            8,
            13,
            7,
            14,
            6,
        ]);
    });

    it('clamps anchors into the range and avoids duplicates', () => {
        expect(createAnchorFirstPageOrder({
            anchorPage: 1,
            direction: 0,
            range: {
                start: 5,
                end: 7,
            },
        })).toEqual([
            5,
            6,
            7,
        ]);
    });
});
