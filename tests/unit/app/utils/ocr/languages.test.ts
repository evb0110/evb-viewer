import {describe, expect, it} from 'vitest';
import {OCR_PAGE_SELECTION_EXPANSION_LIMIT, parseOcrPageSelection, parsePageRange} from '@app/utils/ocr/parsePageRange';

describe('parsePageRange', () => {
    it.each([100_001, 1_000_001])('keeps all-page selection scalar for %i pages', (totalPages) => {
        const selection = parseOcrPageSelection('all', '', 1, totalPages);

        expect(Array.isArray(selection)).toBe(false);
        expect(selection).toEqual({
            kind: 'all',
            pageCount: totalPages,
        });
        expect(totalPages).toBeGreaterThan(OCR_PAGE_SELECTION_EXPANSION_LIMIT);
    });

    it('keeps a wide custom range scalar instead of expanding every page', () => {
        const selection = parseOcrPageSelection('custom', '1-1000001', 1, 1_000_001);

        expect(selection).toEqual({
            kind: 'range',
            firstPage: 1,
            lastPage: 1_000_001,
        });
    });

    describe('rangeType "current"', () => {
        it('returns only the current page', () => {
            expect(parsePageRange('current', '', 5, 10)).toEqual([5]);
        });

        it('returns page 1 when current is 1', () => {
            expect(parsePageRange('current', '', 1, 100)).toEqual([1]);
        });

        it('returns no pages when current is outside the document bounds', () => {
            expect(parsePageRange('current', '', 0, 10)).toEqual([]);
            expect(parsePageRange('current', '', 11, 10)).toEqual([]);
        });
    });

    describe('rangeType "all"', () => {
        it('returns all pages from 1 to totalPages', () => {
            expect(parsePageRange('all', '', 1, 5)).toEqual([1, 2, 3, 4, 5]);
        });

        it('handles single-page document', () => {
            expect(parsePageRange('all', '', 1, 1)).toEqual([1]);
        });
    });

    describe('rangeType "custom"', () => {
        it('parses a single page number', () => {
            expect(parsePageRange('custom', '3', 1, 10)).toEqual([3]);
        });

        it('parses comma-separated pages', () => {
            expect(parsePageRange('custom', '1, 3, 5', 1, 10)).toEqual([1, 3, 5]);
        });

        it('parses a range like "2-5"', () => {
            expect(parsePageRange('custom', '2-5', 1, 10)).toEqual([2, 3, 4, 5]);
        });

        it('parses mixed ranges and individual pages', () => {
            expect(parsePageRange('custom', '1, 3-5, 8', 1, 10)).toEqual([1, 3, 4, 5, 8]);
        });

        it('deduplicates overlapping ranges', () => {
            expect(parsePageRange('custom', '1-3, 2-4', 1, 10)).toEqual([1, 2, 3, 4]);
        });

        it('clamps ranges to totalPages', () => {
            expect(parsePageRange('custom', '8-15', 1, 10)).toEqual([8, 9, 10]);
        });

        it('ignores page numbers below 1', () => {
            expect(parsePageRange('custom', '0, -1, 1', 1, 10)).toEqual([1]);
        });

        it('ignores page numbers above totalPages', () => {
            expect(parsePageRange('custom', '10, 11, 12', 1, 10)).toEqual([10]);
        });

        it('ignores non-numeric values', () => {
            expect(parsePageRange('custom', 'abc, 2, xyz', 1, 10)).toEqual([2]);
        });

        it('returns empty array for completely invalid input', () => {
            expect(parsePageRange('custom', 'abc', 1, 10)).toEqual([]);
        });

        it('returns sorted results', () => {
            expect(parsePageRange('custom', '5, 1, 3', 1, 10)).toEqual([1, 3, 5]);
        });

        it('handles empty custom range string', () => {
            expect(parsePageRange('custom', '', 1, 10)).toEqual([]);
        });

        it('handles ranges with spaces around the dash', () => {
            expect(parsePageRange('custom', '2 - 4', 1, 10)).toEqual([2, 3, 4]);
        });

        it('rejects tokens that only start with a valid page number', () => {
            expect(parsePageRange('custom', '1abc, 2-4x, 3..5, 6', 1, 10)).toEqual([6]);
        });

        it('rejects malformed and reversed ranges instead of partially parsing them', () => {
            expect(parsePageRange('custom', '1-3-5, 7 - 4, 8', 1, 10)).toEqual([8]);
        });
    });
});
