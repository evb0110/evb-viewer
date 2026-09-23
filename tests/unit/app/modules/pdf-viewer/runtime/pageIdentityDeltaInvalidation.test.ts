import {
    describe, expect, it, 
} from 'vitest';
import { collectPageIdentityDeltaInvalidatedPages } from '@app/modules/pdf-viewer/runtime/composables/pdf/collectPageIdentityDeltaInvalidatedPages';

describe('collectPageIdentityDeltaInvalidatedPages', () => {
    it('invalidates only touched pages for a sparse rotation delta', () => {
        expect(collectPageIdentityDeltaInvalidatedPages({
            previousPageCount: 5,
            nextPageCount: 5,
            ranges: [
                {
                    kind: 'retain',
                    fromPageNumber: 1,
                    toPageNumber: 1,
                    count: 5,
                },
                {
                    kind: 'touch',
                    toPageNumber: 3,
                    count: 1,
                    reason: 'rotate',
                },
            ],
        })).toEqual([3]);
    });

    it('invalidates destinations whose identities move, including shifted pages', () => {
        expect(collectPageIdentityDeltaInvalidatedPages({
            previousPageCount: 5,
            nextPageCount: 5,
            ranges: [
                {
                    kind: 'retain',
                    fromPageNumber: 1,
                    toPageNumber: 1,
                    count: 1,
                },
                {
                    kind: 'move',
                    fromPageNumber: 4,
                    toPageNumber: 2,
                    count: 2,
                },
                {
                    kind: 'move',
                    fromPageNumber: 2,
                    toPageNumber: 4,
                    count: 2,
                },
            ],
        })).toEqual([
            2,
            3,
            4,
            5,
        ]);
    });

    it('invalidates shifted retain destinations after a deletion', () => {
        expect(collectPageIdentityDeltaInvalidatedPages({
            previousPageCount: 5,
            nextPageCount: 4,
            ranges: [
                {
                    kind: 'retain',
                    fromPageNumber: 1,
                    toPageNumber: 1,
                    count: 1,
                },
                {
                    kind: 'delete',
                    fromPageNumber: 2,
                    count: 1,
                },
                {
                    kind: 'retain',
                    fromPageNumber: 3,
                    toPageNumber: 2,
                    count: 3,
                },
            ],
        })).toEqual([
            2,
            3,
            4,
        ]);
    });

    it('supports the legacy full permutation and explicit touched-page fallback', () => {
        expect(collectPageIdentityDeltaInvalidatedPages({
            previousPageCount: 4,
            pages: [
                {fromPageNumber: 1},
                {insertedId: 'new-page'},
                {fromPageNumber: 2},
                {fromPageNumber: 4},
            ],
        }, [
            1,
            3,
        ])).toEqual([
            1,
            2,
            3,
        ]);
    });
});
