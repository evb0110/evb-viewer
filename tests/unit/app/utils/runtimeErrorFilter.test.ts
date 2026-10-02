import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getIgnorableRuntimeErrorMessage,
    isIgnorableRuntimeErrorMessage,
} from '@app/utils/runtimeErrorFilter';

describe('runtime error filter', () => {
    it('ignores known ResizeObserver browser warnings', () => {
        expect(isIgnorableRuntimeErrorMessage('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
        expect(isIgnorableRuntimeErrorMessage(new Error('ResizeObserver loop limit exceeded'))).toBe(true);
        expect(getIgnorableRuntimeErrorMessage({message: 'ResizeObserver loop completed with undelivered notifications.'})).toBe(
            'ResizeObserver loop completed with undelivered notifications.',
        );
    });

    it('keeps real runtime failures fatal', () => {
        expect(isIgnorableRuntimeErrorMessage('TypeError: Cannot read properties of undefined')).toBe(false);
        expect(getIgnorableRuntimeErrorMessage(new Error('Boom'))).toBeNull();
    });

    it('does not suppress real errors that merely mention ResizeObserver text', () => {
        expect(isIgnorableRuntimeErrorMessage(
            'TypeError: Cannot read properties of undefined. ResizeObserver loop completed with undelivered notifications.',
        )).toBe(false);
    });
});
