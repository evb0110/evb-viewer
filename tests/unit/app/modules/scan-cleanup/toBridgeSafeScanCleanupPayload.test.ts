import {describe, expect, it} from 'vitest';
import {reactive, readonly} from 'vue';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';

describe('toBridgeSafeScanCleanupPayload', () => {
    it('rebuilds reactive payloads as structured-cloneable plain data', () => {
        const payload = reactive({
            sourcePdfPath: '/tmp/a.pdf',
            pageNumber: 2,
            options: {pageOverrides: {'1': {rotationDegrees: 90}}},
            documentPrior: readonly({
                dominantLayout: 'two-page-spread',
                clusterDims: {
                    widthPx: 100,
                    heightPx: 141,
                },
            }),
        });
        const safe = toBridgeSafeScanCleanupPayload(payload);
        expect(() => structuredClone(safe)).not.toThrow();
        expect(safe).toEqual({
            sourcePdfPath: '/tmp/a.pdf',
            pageNumber: 2,
            options: {pageOverrides: {'1': {rotationDegrees: 90}}},
            documentPrior: {
                dominantLayout: 'two-page-spread',
                clusterDims: {
                    widthPx: 100,
                    heightPx: 141,
                },
            },
        });
    });

    it('converts reactive Maps and Sets and drops undefined values', () => {
        const safe = toBridgeSafeScanCleanupPayload({
            classifications: reactive(new Map([[1, {kind: 'spread'}]])),
            pages: new Set([1, 2]),
            skip: undefined,
        });
        expect(() => structuredClone(safe)).not.toThrow();
        expect(safe).toEqual({
            classifications: {'1': {kind: 'spread'}},
            pages: [1, 2],
        });
    });

    it('rejects non-plain class instances loudly', () => {
        class Exotic {
            value = 1;
        }
        expect(() => toBridgeSafeScanCleanupPayload({value: new Exotic()})).toThrow(/non-plain object/);
    });
});
