import {describe, expect, it} from 'vitest';
import {removeCompletedCombineSnapshot} from '@app/services/pdf/removeCompletedCombineSnapshot';

describe('combine operation snapshots', () => {
    it('removes only the completed immutable snapshot after success', () => {
        const first = {id: 'first'};
        const second = {id: 'second'};
        const lateDrop = {id: 'late-drop'};
        const latePickerFile = {id: 'late-picker'};
        const snapshot = Object.freeze([Object.freeze({...first}), Object.freeze({...second})]);

        expect(removeCompletedCombineSnapshot([first, second, lateDrop, latePickerFile], snapshot)).toEqual([lateDrop, latePickerFile]);
    });
});
