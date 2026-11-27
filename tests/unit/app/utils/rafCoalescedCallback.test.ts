import {describe, expect, it, vi} from 'vitest';
import {createRafCoalescedCallback} from '@app/utils/createRafCoalescedCallback';

function createHarness() {
    const frames = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    return {
        frames,
        environment: {
            requestAnimationFrame(callback: FrameRequestCallback) {
                const handle = nextHandle;
                nextHandle += 1;
                frames.set(handle, callback);
                return handle;
            },
            cancelAnimationFrame(handle: number) {
                frames.delete(handle);
            },
        },
        flushFrame() {
            const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
            if (!entry) {
                return;
            }
            frames.delete(entry[0]);
            entry[1](0);
        },
    };
}

describe('createRafCoalescedCallback', () => {
    it('coalesces a burst to the latest arguments', () => {
        const harness = createHarness();
        const callback = vi.fn();
        const coalesced = createRafCoalescedCallback(callback, harness.environment);

        coalesced.schedule(1, 2);
        coalesced.schedule(3, 4);
        expect(harness.frames).toHaveLength(1);

        harness.flushFrame();
        expect(callback).toHaveBeenCalledExactlyOnceWith(3, 4);
    });

    it('flushes pointerup coordinates synchronously and cancels the queued frame', () => {
        const harness = createHarness();
        const callback = vi.fn();
        const coalesced = createRafCoalescedCallback(callback, harness.environment);

        coalesced.schedule(10);
        coalesced.flush(15);

        expect(callback).toHaveBeenCalledExactlyOnceWith(15);
        expect(harness.frames).toHaveLength(0);
    });

    it('cancels pending work without invoking it', () => {
        const harness = createHarness();
        const callback = vi.fn();
        const coalesced = createRafCoalescedCallback(callback, harness.environment);

        coalesced.schedule('pending');
        coalesced.cancel();
        harness.flushFrame();

        expect(callback).not.toHaveBeenCalled();
    });
});
