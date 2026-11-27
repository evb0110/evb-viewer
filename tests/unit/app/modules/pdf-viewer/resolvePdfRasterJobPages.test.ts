import {resolvePdfRasterJobPages} from '@app/modules/pdf-viewer/runtime/sessions/resolvePdfRasterJobPages';
import {describe, expect, it} from 'vitest';

describe('resolvePdfRasterJobPages', () => {
    it('returns the contiguous viewport window without an explicit demand set', () => {
        expect(
            resolvePdfRasterJobPages({
                start: 3,
                end: 5,
                totalPages: 10,
            }),
        ).toEqual([3, 4, 5]);
    });

    it('keeps a sparse demand sparse across a large document', () => {
        expect(
            resolvePdfRasterJobPages({
                start: 1,
                end: 100_000,
                totalPages: 100_000,
                explicitPages: [1, 100_000, 1, 100_001],
            }),
        ).toEqual([1, 100_000]);
    });
});
