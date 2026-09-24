import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveCustomReloadZoomMultiplier } from '@app/modules/pdf-viewer/runtime/reload-zoom/resolveCustomReloadZoomMultiplier';

describe('resolveCustomReloadZoomMultiplier', () => {
    it('preserves the target display zoom as the custom zoom value', () => {
        expect(resolveCustomReloadZoomMultiplier(1.16)).toBe(1.16);
    });

    it('rejects targets that cannot be a zoom multiplier', () => {
        expect(resolveCustomReloadZoomMultiplier(Number.NaN)).toBeNull();
        expect(resolveCustomReloadZoomMultiplier(Number.POSITIVE_INFINITY)).toBeNull();
        expect(resolveCustomReloadZoomMultiplier(0)).toBeNull();
        expect(resolveCustomReloadZoomMultiplier(-1)).toBeNull();
    });
});
