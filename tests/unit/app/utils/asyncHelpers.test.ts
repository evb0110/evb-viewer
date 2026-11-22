import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';

describe('waitForVisualFrames', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('waits for requestAnimationFrame when the document is visible', async () => {
        const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        vi.stubGlobal('window', { requestAnimationFrame });
        vi.stubGlobal('document', { hidden: false });

        await waitForVisualFrames({ frames: 2 });

        expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    });

    it('falls back to a timeout when the document is hidden', async () => {
        vi.stubGlobal('window', { requestAnimationFrame: vi.fn() });
        vi.stubGlobal('document', {hidden: true});

        const waitPromise = waitForVisualFrames({ hiddenFallbackMs: 25 });
        let settled = false;
        void waitPromise.then(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(24);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(waitPromise).resolves.toBeUndefined();
    });

    it('uses the watchdog when a visible animation frame never fires', async () => {
        const requestAnimationFrame = vi.fn(() => 1);
        vi.stubGlobal('window', { requestAnimationFrame });
        vi.stubGlobal('document', {hidden: false});

        const waitPromise = waitForVisualFrames({ timeoutMs: 64 });
        let settled = false;
        void waitPromise.then(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(63);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(waitPromise).resolves.toBeUndefined();
        expect(requestAnimationFrame).toHaveBeenCalledOnce();
    });
});
