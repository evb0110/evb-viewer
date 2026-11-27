// @vitest-environment happy-dom

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {scheduleIdleWork} from '@app/utils/scheduleIdleWork';

describe('scheduleIdleWork', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('uses the idle callback with the default timeout', () => {
        const work = vi.fn();
        const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
            callback({
                didTimeout: false,
                timeRemaining: () => 10,
            });
            return 3;
        });
        window.requestIdleCallback = requestIdleCallback;
        window.cancelIdleCallback = vi.fn();

        scheduleIdleWork(work);

        expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {timeout: 1_000});
        expect(work).toHaveBeenCalledOnce();
    });

    it('passes an explicit idle timeout', () => {
        window.requestIdleCallback = vi.fn(() => 4);
        window.cancelIdleCallback = vi.fn();

        scheduleIdleWork(vi.fn(), {timeoutMs: 250});

        expect(window.requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {timeout: 250});
    });

    it('uses a zero-delay timer fallback', () => {
        Reflect.deleteProperty(window, 'requestIdleCallback');
        const work = vi.fn();

        scheduleIdleWork(work);
        expect(work).not.toHaveBeenCalled();
        vi.runAllTimers();

        expect(work).toHaveBeenCalledOnce();
    });

    it('cancels work before execution', () => {
        Reflect.deleteProperty(window, 'requestIdleCallback');
        const work = vi.fn();
        const cancel = scheduleIdleWork(work);

        cancel();
        vi.runAllTimers();

        expect(work).not.toHaveBeenCalled();
    });

    it('runs at most once and ignores cancellation after start', () => {
        let callback: IdleRequestCallback | undefined;
        window.requestIdleCallback = vi.fn((scheduled) => {
            callback = scheduled;
            return 5;
        });
        window.cancelIdleCallback = vi.fn();
        const work = vi.fn();
        const cancel = scheduleIdleWork(work);

        callback?.({
            didTimeout: false,
            timeRemaining: () => 10,
        });
        callback?.({
            didTimeout: false,
            timeRemaining: () => 10,
        });
        cancel();

        expect(work).toHaveBeenCalledOnce();
        expect(window.cancelIdleCallback).not.toHaveBeenCalled();
    });
});
