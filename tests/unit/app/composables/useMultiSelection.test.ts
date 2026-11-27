import {describe, expect, it} from 'vitest';
import {useMultiSelection} from '@app/composables/useMultiSelection';

describe('useMultiSelection', () => {
    it('does not expose a stale-anchor select-all helper', () => {
        const selection = useMultiSelection<number>();

        expect('selectAll' in selection).toBe(false);
    });

    it('uses a fallback anchor for an initial shift range selection', () => {
        const selection = useMultiSelection<number>();

        selection.toggle(3, [1, 2, 3, 4], {
            shift: true,
            fallbackAnchor: 1,
        });

        expect([...selection.selected.value]).toEqual([1, 2, 3]);
        expect(selection.anchor.value).toBe(1);
    });

    it('keeps the existing anchor ahead of a fallback anchor', () => {
        const selection = useMultiSelection<number>();

        selection.toggle(2, [1, 2, 3, 4]);
        selection.toggle(4, [1, 2, 3, 4], {
            shift: true,
            fallbackAnchor: 1,
        });

        expect([...selection.selected.value]).toEqual([2, 3, 4]);
        expect(selection.anchor.value).toBe(2);
    });
});
