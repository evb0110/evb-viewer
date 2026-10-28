// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { installStartupOverlayLifecycle } from '@electron/preload/installStartupOverlayLifecycle';
import { cast } from '@tests/helpers/cast';

const OVERLAY_ID = 'evb-startup-overlay';

function dispatchClaim(pathCount: number) {
    window.dispatchEvent(new CustomEvent('evb:startup-open-claimed', {detail: {pathCount}}));
}

function dispatchAppReady() {
    window.dispatchEvent(new Event('evb:app-ready'));
}

function dispatchVisualReady() {
    window.dispatchEvent(new CustomEvent('evb:startup-open-visual-ready', {detail: {reason: 'first-page-painted'}}));
}

function hideDocumentNode(name: 'head' | 'body') {
    const originalDescriptor = Object.getOwnPropertyDescriptor(document, name);
    Object.defineProperty(document, name, {
        configurable: true,
        value: null,
    });
    return () => {
        if (originalDescriptor) {
            Object.defineProperty(document, name, originalDescriptor);
        } else {
            Reflect.deleteProperty(document, name);
        }
    };
}

function install(defaultApp = false) {
    Object.defineProperty(process, 'defaultApp', {
        configurable: true,
        value: defaultApp,
    });
    const deps = {
        tracePreload: vi.fn(),
        forwardPreloadLogToMain: vi.fn(),
    };
    installStartupOverlayLifecycle(deps);
    return deps;
}

describe('installStartupOverlayLifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        window.sessionStorage.clear();
        delete (window as Window & {__appReady?: boolean}).__appReady;
    });

    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        Reflect.deleteProperty(process, 'defaultApp');
    });

    it('leaves the placeholder about:blank document without an overlay or log', () => {
        const browser = cast<{happyDOM: {setURL: (url: string) => void}}>(window).happyDOM;
        const url = window.location.href;
        browser.setURL('about:blank');
        try {
            const deps = install();
            vi.advanceTimersByTime(60_000);
            expect(document.getElementById(OVERLAY_ID)).toBeNull();
            expect(deps.forwardPreloadLogToMain).not.toHaveBeenCalled();
        } finally {
            browser.setURL(url);
        }
    });

    it('retains app-ready-only startup until the startup-open claim arrives', () => {
        install();
        dispatchAppReady();

        vi.advanceTimersByTime(300);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
        vi.advanceTimersByTime(60_000);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();

        dispatchClaim(0);
        vi.advanceTimersByTime(300);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('removes after app-ready and an empty claim', () => {
        install();
        dispatchAppReady();
        dispatchClaim(0);

        vi.advanceTimersByTime(299);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
        vi.advanceTimersByTime(1);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('retains a positive claim through renderer-ready timing until visual-ready', () => {
        install();
        dispatchAppReady();
        dispatchClaim(1);

        vi.advanceTimersByTime(300);
        window.dispatchEvent(new Event('app:rendererReady'));
        vi.advanceTimersByTime(30_000);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();

        dispatchVisualReady();
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('handles an empty claim before app-ready', () => {
        install();
        dispatchClaim(0);
        vi.advanceTimersByTime(5_000);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();

        dispatchAppReady();
        vi.advanceTimersByTime(300);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('removes fatal no-claim startup at the original hard deadline', () => {
        install();

        vi.advanceTimersByTime(29_999);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
        vi.advanceTimersByTime(1);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('preserves the development stabilization delay', () => {
        install(true);
        dispatchAppReady();
        dispatchClaim(0);

        vi.advanceTimersByTime(2_199);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
        vi.advanceTimersByTime(1);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('waits for the document head before mounting from preload', () => {
        const restoreHead = hideDocumentNode('head');
        const readyStateGetter = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');

        try {
            expect(() => install()).not.toThrow();
            expect(document.getElementById(OVERLAY_ID)).toBeNull();
        } finally {
            restoreHead();
            readyStateGetter.mockRestore();
        }

        window.dispatchEvent(new Event('DOMContentLoaded'));

        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
    });

    it('waits for the document body before mounting from preload', () => {
        const restoreBody = hideDocumentNode('body');
        const readyStateGetter = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');

        try {
            expect(() => install()).not.toThrow();
            expect(document.getElementById(OVERLAY_ID)).toBeNull();
        } finally {
            restoreBody();
            readyStateGetter.mockRestore();
        }

        window.dispatchEvent(new Event('DOMContentLoaded'));

        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
    });

    it('does not remount or remove twice after duplicate and late events', () => {
        const deps = install();
        dispatchAppReady();
        dispatchClaim(0);
        vi.advanceTimersByTime(300);

        dispatchAppReady();
        dispatchClaim(1);
        dispatchVisualReady();

        expect(document.getElementById(OVERLAY_ID)).toBeNull();
        expect(deps.tracePreload).toHaveBeenCalledWith(
            'startup overlay removed',
            expect.any(Object),
        );
        expect(deps.tracePreload.mock.calls.filter(([stage]) => stage === 'startup overlay removed')).toHaveLength(1);
    });
});
