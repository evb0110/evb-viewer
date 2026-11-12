import {
    afterEach, describe, expect, it, vi,
} from 'vitest';
import {waitForBoundedAssistantInterrupt} from '@electron/features/agent/waitForBoundedAssistantInterrupt';

afterEach(() => vi.useRealTimers());

describe('bounded assistant interrupt', () => {
    it('settles when the operation completes and clears its deadline', async () => {
        vi.useFakeTimers();
        await expect(waitForBoundedAssistantInterrupt(Promise.resolve())).resolves.toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('preserves an operation failure', async () => {
        await expect(waitForBoundedAssistantInterrupt(Promise.reject(new Error('process failed')))).rejects.toThrow('process failed');
    });
    it('rejects an operation that never completes at the deadline', async () => {
        vi.useFakeTimers();
        const result = expect(waitForBoundedAssistantInterrupt(new Promise(() => undefined), 250)).rejects.toThrow('Assistant interrupt timed out.');
        await vi.advanceTimersByTimeAsync(250);
        await result;
        expect(vi.getTimerCount()).toBe(0);
    });
});
