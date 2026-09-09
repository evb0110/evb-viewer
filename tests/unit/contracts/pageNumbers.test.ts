import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildPageMoveOrder,
    buildPageMoveRangesOrder,
    clampPageNumber,
    createAllPageSelection,
    createComplementOfPageSelection,
    createExplicitPageSelection,
    createMappedPageSelection,
    createPageMoveRange,
    createPageMoveRanges,
    createPredicatePageSelection,
    createRangePageSelection,
    invertPageSelection,
    isPageMoveNoOp,
    isPageSelected,
    iteratePageSelectionBatches,
    iteratePageSelectionRanges,
    mapPageNumberAfterPageMove,
    mapPageNumberBeforePageMove,
    pageMoveRangesSelectedPageCount,
    pageSelectionCount,
    pageIndexToPageNumber,
    pageNumberToPageIndex,
    parsePageIndex,
    parsePageNumber,
    requirePageIndex,
    requirePageNumber,
} from '@pdf-core/pdfPageSelection';

describe('page number contracts', () => {
    it.each([
        [
            0,
            3,
            0,
        ],
        [
            1,
            3,
            1,
        ],
        [
            2,
            3,
            2,
        ],
    ])('accepts valid zero-based page index %s of %s', (value, pageCount, expected) => {
        expect(parsePageIndex(value, pageCount)).toBe(expected);
    });

    it.each([
        [-1],
        [1.5],
        [Number.NaN],
        [Number.MAX_SAFE_INTEGER + 1],
    ])('rejects invalid page index %s', value => {
        expect(parsePageIndex(value)).toBeNull();
    });

    it('rejects page indexes at or beyond pageCount', () => {
        expect(parsePageIndex(3, 3)).toBeNull();
        expect(parsePageIndex(4, 3)).toBeNull();
    });

    it.each([
        [
            1,
            3,
            1,
        ],
        [
            2,
            3,
            2,
        ],
        [
            3,
            3,
            3,
        ],
    ])('accepts valid one-based page number %s of %s', (value, pageCount, expected) => {
        expect(parsePageNumber(value, pageCount)).toBe(expected);
    });

    it.each([
        [0],
        [-1],
        [1.5],
        [Number.NaN],
        [Number.MAX_SAFE_INTEGER + 1],
    ])('rejects invalid page number %s', value => {
        expect(parsePageNumber(value)).toBeNull();
    });

    it('rejects page numbers above pageCount', () => {
        expect(parsePageNumber(4, 3)).toBeNull();
    });

    it('clamps a viewport reading instead of rejecting it', () => {
        expect(clampPageNumber(7, 0)).toBe(7);
        expect(clampPageNumber(7, 3)).toBe(3);
        expect(clampPageNumber(0)).toBe(1);
        expect(clampPageNumber(-4, 10)).toBe(1);
        expect(clampPageNumber(2.8, 10)).toBe(2);
        expect(clampPageNumber(Number.NaN)).toBe(1);
        expect(clampPageNumber(Number.POSITIVE_INFINITY, 12)).toBe(12);
        expect(clampPageNumber(Number.NEGATIVE_INFINITY, 12)).toBe(1);
        expect(clampPageNumber(Number.MAX_SAFE_INTEGER * 2)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('round-trips page index and page number conversions', () => {
        expect(pageIndexToPageNumber(requirePageIndex(0))).toBe(1);
        expect(pageNumberToPageIndex(requirePageNumber(1))).toBe(0);
        expect(pageNumberToPageIndex(pageIndexToPageNumber(requirePageIndex(4)))).toBe(4);
    });

    it('keeps million-page complements and predicates scalar until a batch is read', () => {
        const pageCount = 1_000_000;
        const all = createAllPageSelection(pageCount);
        const inverted = createComplementOfPageSelection(createRangePageSelection(pageCount, 10, 20));
        const even = createPredicatePageSelection(pageCount, 'even');

        expect(pageSelectionCount(all)).toBe(pageCount);
        expect(pageSelectionCount(inverted)).toBe(pageCount - 11);
        expect(pageSelectionCount(even)).toBe(500_000);
        expect(isPageSelected(inverted, 9)).toBe(true);
        expect(isPageSelected(inverted, 10)).toBe(false);
        expect([...iteratePageSelectionBatches(all, {batchSize: 3})].slice(0, 2)).toEqual([
            [
                1,
                2,
                3,
            ],
            [
                4,
                5,
                6,
            ],
        ]);
        expect([...iteratePageSelectionRanges(all)]).toEqual([{
            startPage: 1,
            endPage: pageCount,
        }]);
        expect([...iteratePageSelectionRanges(inverted)]).toEqual([
            {
                startPage: 1,
                endPage: 9,
            },
            {
                startPage: 21,
                endPage: pageCount,
            },
        ]);
    });

    it('inverts an explicit selection without losing its compact representation', () => {
        const selection = createExplicitPageSelection(8, [
            2,
            4,
            4,
        ]);
        const inverted = invertPageSelection(selection);

        expect(inverted).toEqual({
            kind: 'complement',
            pageCount: 8,
            excludedPages: [
                2,
                4,
            ],
        });
        expect(pageSelectionCount(inverted)).toBe(6);
    });

    it.each([
        [
            1,
            1,
            4,
            [
                2,
                3,
                4,
                1,
            ],
        ],
        [
            2,
            2,
            4,
            [
                1,
                3,
                4,
                2,
            ],
        ],
        [
            2,
            3,
            0,
            [
                2,
                3,
                1,
                4,
            ],
        ],
    ])('maps a contiguous move %s-%s into the expected order', (start, end, insertAt, expected) => {
        const move = createPageMoveRange(4, start, end, insertAt);
        expect(buildPageMoveOrder(move)).toEqual(expected);
        expect(isPageMoveNoOp(move)).toBe(false);
    });

    it('keeps a move inside its source range as a no-op', () => {
        const move = createPageMoveRange(100, 20, 30, 25);
        expect(isPageMoveNoOp(move)).toBe(true);
        expect(mapPageNumberAfterPageMove(25, move)).toBe(25);
    });

    it('maps non-contiguous moves without requiring a document-sized permutation', () => {
        const move = createPageMoveRanges(1_000_000, [
            {
                startPage: 900_000,
                endPage: 900_000,
            },
            {
                startPage: 900_002,
                endPage: 900_002,
            },
        ], 0);

        expect(pageMoveRangesSelectedPageCount(move)).toBe(2);
        expect(move.ranges).toEqual([
            {
                startPage: 900_000,
                endPage: 900_000,
            },
            {
                startPage: 900_002,
                endPage: 900_002,
            },
        ]);
        expect(mapPageNumberAfterPageMove(900_000, move)).toBe(1);
        expect(mapPageNumberAfterPageMove(900_002, move)).toBe(2);
        expect(mapPageNumberBeforePageMove(1, move)).toBe(900_000);
        expect(mapPageNumberBeforePageMove(2, move)).toBe(900_002);
    });

    it('preserves source order for a small non-contiguous move', () => {
        const move = createPageMoveRanges(7, [
            {
                startPage: 2,
                endPage: 2,
            },
            {
                startPage: 4,
                endPage: 4,
            },
        ], 0);

        expect(buildPageMoveRangesOrder(move)).toEqual([
            2,
            4,
            1,
            3,
            5,
            6,
            7,
        ]);
        for (let page = 1; page <= 7; page += 1) {
            const destination = mapPageNumberAfterPageMove(page, move);
            expect(destination).not.toBeNull();
            expect(mapPageNumberBeforePageMove(destination!, move)).toBe(page);
        }
    });

    it('maps lazy selections through repeated moves without flattening them', () => {
        const source = createPredicatePageSelection(1_000_000, 'odd');
        const firstMove = createPageMoveRange(1_000_000, 2, 2, 1_000_000);
        const secondMove = createPageMoveRange(1_000_000, 10, 20, 0);
        const mapped = createMappedPageSelection(
            createMappedPageSelection(source, firstMove),
            secondMove,
        );

        expect(mapped).toMatchObject({
            kind: 'mapped',
            source,
            moves: [
                firstMove,
                secondMove,
            ],
        });
        expect(mapPageNumberBeforePageMove(1_000_000, firstMove)).toBe(2);
        expect(isPageSelected(mapped, 999_999)).toBe(false);
        expect(pageSelectionCount(mapped)).toBe(pageSelectionCount(source));
    });

    it('iterates mapped selections in destination order without a full permutation', () => {
        const source = createExplicitPageSelection(8, [
            1,
            4,
        ]);
        const mapped = createMappedPageSelection(
            source,
            createPageMoveRange(8, 1, 1, 8),
        );

        expect([...iteratePageSelectionBatches(mapped, {batchSize: 8})]).toEqual([[
            3,
            8,
        ]]);
    });
});
