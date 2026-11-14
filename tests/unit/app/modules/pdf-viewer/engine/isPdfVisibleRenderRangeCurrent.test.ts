import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolvePdfProtectedVisibleRange,
} from '@app/modules/pdf-viewer/engine/pdf-visible-render-range-policy/isPdfVisibleRenderRangeCurrent';

describe('isPdfVisibleRenderRangeCurrent', () => {
    it('protects the pending target instead of the stale committed viewport', () => {
        expect(resolvePdfProtectedVisibleRange({
            visibleRange: {
                start: 1,
                end: 1,
            },
            navigationTargetPage: 21,
            viewMode: 'single',
            totalPages: 120,
        })).toEqual({
            start: 21,
            end: 21,
        });
    });

    it('expands a partially intersecting facing row without a navigation target', () => {
        expect(resolvePdfProtectedVisibleRange({
            visibleRange: {
                start: 13,
                end: 13,
            },
            navigationTargetPage: null,
            viewMode: 'facing',
            totalPages: 120,
        })).toEqual({
            start: 13,
            end: 14,
        });
    });

    it('does not retain rows that no longer intersect the live viewport', () => {
        expect(resolvePdfProtectedVisibleRange({
            visibleRange: {
                start: 9,
                end: 14,
            },
            navigationTargetPage: 11,
            viewMode: 'facing',
            totalPages: 120,
        })).toEqual({
            start: 9,
            end: 14,
        });
        expect(resolvePdfProtectedVisibleRange({
            visibleRange: {
                start: 11,
                end: 12,
            },
            navigationTargetPage: 11,
            viewMode: 'facing',
            totalPages: 120,
        })).toEqual({
            start: 11,
            end: 12,
        });
    });

    it('keeps a navigation target from a longer document inside the shorter one', () => {
        expect(resolvePdfProtectedVisibleRange({
            visibleRange: {
                start: 1,
                end: 1,
            },
            navigationTargetPage: 2,
            viewMode: 'single',
            totalPages: 1,
        })).toEqual({
            start: 1,
            end: 1,
        });
    });
});
