import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    resetBrowserYieldStateForTests,
    yieldToBrowser,
} from '@app/platform/browser-api/browserYield';

class FakeMessageChannel {
    public readonly port1: { onmessage: ((event: Event) => void) | null; };

    public readonly port2: { postMessage: () => void; };

    public constructor() {
        this.port1 = { onmessage: null };
        this.port2 = { postMessage: () => {
            queueMicrotask(() => {
                this.port1.onmessage?.(new Event('message'));
            });
        } };
    }
}

describe('yieldToBrowser', () => {
    beforeEach(() => {
        resetBrowserYieldStateForTests();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('continues visible work when the next animation frame never arrives', async () => {
        let settled = false;
        vi.stubGlobal('document', { visibilityState: 'visible' });
        vi.stubGlobal('requestAnimationFrame', () => 1);
        vi.stubGlobal('MessageChannel', FakeMessageChannel);

        const yieldPromise = yieldToBrowser().then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(settled).toBe(false);
        await yieldPromise;
        expect(settled).toBe(true);
    });

    it('does not wait for an animation frame when the document is hidden', async () => {
        vi.stubGlobal('document', { visibilityState: 'hidden' });
        vi.stubGlobal('requestAnimationFrame', () => 1);
        vi.stubGlobal('MessageChannel', FakeMessageChannel);

        let settled = false;
        const yieldPromise = yieldToBrowser().then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        await yieldPromise;
        expect(settled).toBe(true);
    });

    it('falls back to timers when task channels are unavailable', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('document', { visibilityState: 'hidden' });
        vi.stubGlobal('MessageChannel', undefined);

        let settled = false;
        const yieldPromise = yieldToBrowser().then(() => {
            settled = true;
        });
        await Promise.resolve();

        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        await yieldPromise;
        expect(settled).toBe(true);
    });
});
