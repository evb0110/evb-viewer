import {beforeAll, describe, expect, it} from 'vitest';
import type {
    clampListDragDeltaToDropSlots as importedClampListDragDeltaToDropSlots,
    IListDragSlot,
} from '@app/composables/useListDragReorder';

let clampListDragDeltaToDropSlots: typeof importedClampListDragDeltaToDropSlots;

beforeAll(async () => {
    ({clampListDragDeltaToDropSlots} = await import('@app/composables/useListDragReorder'));
});

function createSlot(top: number, height = 40): IListDragSlot {
    return {
        top,
        height,
        centerY: top + height / 2,
    };
}

describe('clampListDragDeltaToDropSlots', () => {
    const slots = [createSlot(100), createSlot(152), createSlot(204)];

    it('keeps drag movement within the first and last row drop slots', () => {
        expect(clampListDragDeltaToDropSlots(-120, 1, slots)).toBe(-52);
        expect(clampListDragDeltaToDropSlots(120, 1, slots)).toBe(52);
        expect(clampListDragDeltaToDropSlots(24, 1, slots)).toBe(24);
    });

    it('keeps a single-row drag in place because there is nowhere else to drop it', () => {
        expect(clampListDragDeltaToDropSlots(80, 0, [createSlot(100)])).toBe(0);
        expect(clampListDragDeltaToDropSlots(-80, 0, [createSlot(100)])).toBe(0);
    });

    it('leaves movement unchanged when slot data is unavailable', () => {
        expect(clampListDragDeltaToDropSlots(32, 0, [])).toBe(32);
        expect(clampListDragDeltaToDropSlots(32, 4, slots)).toBe(32);
    });
});
