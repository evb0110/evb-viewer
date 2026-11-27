import {afterEach, describe, expect, it, vi} from 'vitest';
import {waitForBoundedOperation} from '@node-runtime/waitForBoundedOperation';

afterEach(() => vi.useRealTimers());

const never = () => new Promise<never>(() => undefined);

describe('waitForBoundedOperation', () => {
    it('resolves with the operation value and clears its deadline', async () => {
        vi.useFakeTimers();
        await expect(
            waitForBoundedOperation(Promise.resolve('done'), {
                timeoutMs: 250,
                timeoutError: () => new Error('late'),
            }),
        ).resolves.toBe('done');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('preserves an operation failure and clears its deadline', async () => {
        vi.useFakeTimers();
        await expect(
            waitForBoundedOperation(Promise.reject(new Error('process failed')), {
                timeoutMs: 250,
                timeoutResult: 'timeout',
            }),
        ).rejects.toThrow('process failed');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves with the timeout result at the deadline', async () => {
        vi.useFakeTimers();
        const wait = waitForBoundedOperation(never(), {
            timeoutMs: 250,
            timeoutResult: 'timeout' as const,
        });
        await vi.advanceTimersByTimeAsync(249);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(wait).resolves.toBe('timeout');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects with the custom error at the deadline and calls onTimeout once', async () => {
        vi.useFakeTimers();
        class StatTimeoutError extends Error {}
        const onTimeout = vi.fn();
        const wait = expect(
            waitForBoundedOperation(never(), {
                timeoutMs: 250,
                timeoutError: () => new StatTimeoutError('Assistant interrupt timed out.'),
                onTimeout,
            }),
        ).rejects.toBeInstanceOf(StatTimeoutError);
        await vi.advanceTimersByTimeAsync(1_000);
        await wait;
        expect(onTimeout).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not call onTimeout when the operation settles first', async () => {
        vi.useFakeTimers();
        const onTimeout = vi.fn();
        await waitForBoundedOperation(Promise.resolve(), {
            timeoutMs: 250,
            timeoutResult: undefined,
            onTimeout,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(onTimeout).not.toHaveBeenCalled();
    });

    it('aborts the signal it gives the operation at the deadline, not before', async () => {
        vi.useFakeTimers();
        let deadline: AbortSignal | undefined;
        const wait = expect(
            waitForBoundedOperation(
                (signal) => {
                    deadline = signal;
                    return never();
                },
                {
                    timeoutMs: 250,
                    timeoutError: () => new Error('Latest release fetch exceeded its total deadline.'),
                },
            ),
        ).rejects.toThrow('Latest release fetch exceeded its total deadline.');
        expect(deadline?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(250);
        await wait;
        expect(deadline?.aborted).toBe(true);
    });

    it('keeps the process alive while waiting unless unref is asked for', async () => {
        const liveTimers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
        const settle = Promise.withResolvers<void>();
        const before = liveTimers();
        const released = waitForBoundedOperation(settle.promise, {timeoutMs: 60_000, timeoutResult: undefined, unref: true});
        let kept: Promise<void> | undefined;
        try {
            expect(liveTimers()).toBe(before);
            kept = waitForBoundedOperation(settle.promise, {timeoutMs: 60_000, timeoutResult: undefined});
            expect(liveTimers()).toBe(before + 1);
        } finally {
            settle.resolve();
            await Promise.all([released, kept]);
        }
        expect(liveTimers()).toBe(before);
    });
});
