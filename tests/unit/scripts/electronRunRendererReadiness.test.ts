import type {
    Browser,
    ConsoleMessage,
    Page,
} from 'puppeteer-core';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    findAppPage,
    probeRendererBody,
    waitForRendererPaint,
} from '@scripts/electron-run/rendererReadiness';

describe('Electron renderer readiness', () => {
    it.each([
        true,
        false,
    ])('reads body readiness in the main world and clears its timer, body=%s', async (hasBody) => {
        vi.useFakeTimers();
        try {
            const query = vi.fn(() => new Promise<never>(() => {}));
            const evaluate = vi.fn(async (probe: () => boolean) => {
                vi.stubGlobal('document', {body: hasBody ? {} : null});
                return probe();
            });
            // Puppeteer's overloaded evaluate method is DOM-bound, but this
            // test exercises only its zero-argument boolean probe.
            const page = {
                evaluate,
                $: query,
            } as Pick<Page, 'evaluate'>;

            await expect(probeRendererBody(page)).resolves.toBe(hasBody ? 'ready' : 'waiting');
            expect(query).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });

    it('bounds CDP page discovery when a target attach never responds', async () => {
        const browser = {pages: () => new Promise<never>(() => {})} satisfies Pick<Browser, 'pages'>;

        await expect(findAppPage(browser, 5)).rejects.toThrow(
            'Puppeteer page discovery did not respond within 5ms',
        );
    });

    it('clears the discovery timer after CDP page discovery resolves', async () => {
        vi.useFakeTimers();
        try {
            const browser = {pages: async () => []} satisfies Pick<Browser, 'pages'>;

            await expect(findAppPage(browser, 5_000)).resolves.toBeNull();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        0,
        1,
        2,
    ])('keeps the paint outcome and diagnostic state after %s callbacks', async (callbacks) => {
        vi.useFakeTimers();
        let listener: ((message: ConsoleMessage) => void) | undefined;
        const frames: FrameRequestCallback[] = [];
        const evaluationPage = {evaluate: vi.fn(async (probe: () => Promise<void>) => probe())} as Pick<Page, 'evaluate'>;
        const page = {
            ...evaluationPage,
            on: vi.fn((_event: string, callback: (message: ConsoleMessage) => void) => {
                listener = callback;
            }),
            off: vi.fn(() => {
                listener = undefined;
            }),
        };
        vi.stubGlobal('document', {
            visibilityState: 'hidden',
            hidden: true,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        });
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        vi.spyOn(console, 'debug').mockImplementation(message => {
            listener?.({text: () => String(message)} as ConsoleMessage);
        });
        try {
            let settled = false;
            const result = waitForRendererPaint(page).catch(error => {
                settled = true;
                return error;
            });
            if (callbacks >= 1) {
                frames.shift()?.(16);
            }
            if (callbacks === 2) {
                frames.shift()?.(32);
                await expect(result).resolves.toBeUndefined();
                await vi.advanceTimersByTimeAsync(30_000);
                return;
            }
            await vi.advanceTimersByTimeAsync(29_999);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(await result).toMatchObject({
                name: 'RendererReadinessError',
                message: expect.stringContaining(`rAFCallbacks=${callbacks} visibilityState=hidden hidden=true`),
            });
        } finally {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });

});
