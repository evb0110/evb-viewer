import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { effectScope } from 'vue';
import { useWindowDevicePixelRatio } from '@app/composables/useWindowDevicePixelRatio';

class FakeMediaQueryList extends EventTarget {
    listenerCount = 0;

    constructor(public readonly media: string) {
        super();
    }

    override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
    ) {
        if (type === 'change') {
            this.listenerCount += 1;
        }
        super.addEventListener(type, listener, options);
    }

    override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
    ) {
        if (type === 'change') {
            this.listenerCount -= 1;
        }
        super.removeEventListener(type, listener, options);
    }
}

class FakeWindow extends EventTarget {
    devicePixelRatio: number;
    resizeListenerCount = 0;
    readonly mediaQueries: FakeMediaQueryList[] = [];
    matchMedia?: (query: string) => MediaQueryList;

    constructor(initialDpr: number, withMatchMedia = true) {
        super();
        this.devicePixelRatio = initialDpr;
        if (withMatchMedia) {
            this.matchMedia = (query: string) => {
                const list = new FakeMediaQueryList(query);
                this.mediaQueries.push(list);
                return list as unknown as MediaQueryList;
            };
        }
    }

    override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
    ) {
        if (type === 'resize') {
            this.resizeListenerCount += 1;
        }
        super.addEventListener(type, listener, options);
    }

    override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
    ) {
        if (type === 'resize') {
            this.resizeListenerCount -= 1;
        }
        super.removeEventListener(type, listener, options);
    }
}

describe('useWindowDevicePixelRatio', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('normalizes zero, NaN, and missing window to 1', () => {
        vi.stubGlobal('window', undefined);
        const ssrScope = effectScope();
        const ssrRatio = ssrScope.run(() => useWindowDevicePixelRatio());
        expect(ssrRatio?.value).toBe(1);
        ssrScope.stop();

        for (const rawDpr of [
            0,
            Number.NaN,
        ]) {
            const fakeWindow = new FakeWindow(rawDpr);
            vi.stubGlobal('window', fakeWindow);
            const scope = effectScope();
            const ratio = scope.run(() => useWindowDevicePixelRatio());
            expect(ratio?.value).toBe(1);
            expect(fakeWindow.mediaQueries[0]?.media).toBe('(resolution: 1dppx)');
            scope.stop();
        }
    });

    it('tracks DPR changes via matchMedia, synchronously rearms, and detaches on scope disposal', () => {
        const fakeWindow = new FakeWindow(1);
        vi.stubGlobal('window', fakeWindow);
        const scope = effectScope();
        const ratio = scope.run(() => useWindowDevicePixelRatio())!;

        expect(ratio.value).toBe(1);
        expect(fakeWindow.mediaQueries).toHaveLength(1);
        expect(fakeWindow.mediaQueries[0]?.media).toBe('(resolution: 1dppx)');
        expect(fakeWindow.mediaQueries[0]?.listenerCount).toBe(1);
        expect(fakeWindow.resizeListenerCount).toBe(1);

        // First DPR change via media query
        fakeWindow.devicePixelRatio = 2;
        fakeWindow.mediaQueries[0]!.dispatchEvent(new Event('change'));
        expect(ratio.value).toBe(2);
        expect(fakeWindow.mediaQueries).toHaveLength(2);
        expect(fakeWindow.mediaQueries[0]?.listenerCount).toBe(0);
        expect(fakeWindow.mediaQueries[1]?.media).toBe('(resolution: 2dppx)');
        expect(fakeWindow.mediaQueries[1]?.listenerCount).toBe(1);

        // Stale media query no longer reacts; newly armed query reacts synchronously
        fakeWindow.devicePixelRatio = 1.5;
        fakeWindow.mediaQueries[0]!.dispatchEvent(new Event('change'));
        expect(ratio.value).toBe(2);

        fakeWindow.mediaQueries[1]!.dispatchEvent(new Event('change'));
        expect(ratio.value).toBe(1.5);
        expect(fakeWindow.mediaQueries).toHaveLength(3);
        expect(fakeWindow.mediaQueries[1]?.listenerCount).toBe(0);
        expect(fakeWindow.mediaQueries[2]?.media).toBe('(resolution: 1.5dppx)');
        expect(fakeWindow.mediaQueries[2]?.listenerCount).toBe(1);

        // Disposing the scope detaches both the latest rearmed media listener and resize listener
        scope.stop();
        expect(fakeWindow.mediaQueries[2]?.listenerCount).toBe(0);
        expect(fakeWindow.resizeListenerCount).toBe(0);

        fakeWindow.devicePixelRatio = 3;
        fakeWindow.mediaQueries[2]!.dispatchEvent(new Event('change'));
        fakeWindow.dispatchEvent(new Event('resize'));
        expect(ratio.value).toBe(1.5);
    });

    it('updates DPR on resize-only changes with and without matchMedia', () => {
        const fakeWindowWithMatchMedia = new FakeWindow(1, true);
        vi.stubGlobal('window', fakeWindowWithMatchMedia);
        const scopeWithMatchMedia = effectScope();
        const ratioWithMatchMedia = scopeWithMatchMedia.run(() => useWindowDevicePixelRatio())!;

        fakeWindowWithMatchMedia.devicePixelRatio = 2;
        fakeWindowWithMatchMedia.dispatchEvent(new Event('resize'));
        expect(ratioWithMatchMedia.value).toBe(2);
        expect(fakeWindowWithMatchMedia.mediaQueries[0]?.listenerCount).toBe(0);
        expect(fakeWindowWithMatchMedia.mediaQueries[1]?.media).toBe('(resolution: 2dppx)');
        expect(fakeWindowWithMatchMedia.mediaQueries[1]?.listenerCount).toBe(1);
        scopeWithMatchMedia.stop();
        expect(fakeWindowWithMatchMedia.mediaQueries[1]?.listenerCount).toBe(0);
        expect(fakeWindowWithMatchMedia.resizeListenerCount).toBe(0);

        const fakeWindowWithoutMatchMedia = new FakeWindow(1, false);
        vi.stubGlobal('window', fakeWindowWithoutMatchMedia);
        const scopeWithoutMatchMedia = effectScope();
        const ratioWithoutMatchMedia = scopeWithoutMatchMedia.run(() => useWindowDevicePixelRatio())!;

        fakeWindowWithoutMatchMedia.devicePixelRatio = 2.5;
        fakeWindowWithoutMatchMedia.dispatchEvent(new Event('resize'));
        expect(ratioWithoutMatchMedia.value).toBe(2.5);

        // Normalizes zero back to 1 on subsequent resize
        fakeWindowWithoutMatchMedia.devicePixelRatio = 0;
        fakeWindowWithoutMatchMedia.dispatchEvent(new Event('resize'));
        expect(ratioWithoutMatchMedia.value).toBe(1);

        scopeWithoutMatchMedia.stop();
        expect(fakeWindowWithoutMatchMedia.resizeListenerCount).toBe(0);
    });
});
