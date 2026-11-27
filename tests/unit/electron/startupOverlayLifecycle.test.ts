// @vitest-environment happy-dom

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {installStartupOverlayLifecycle} from '@electron/preload/installStartupOverlayLifecycle';
import {cast} from '@tests/helpers/cast';

const OVERLAY_ID = 'evb-startup-overlay';

function dispatchClaim(pathCount: number) {
    window.dispatchEvent(new CustomEvent('evb:startup-open-claimed', {detail: {pathCount}}));
}

function dispatchAppReady() {
    window.dispatchEvent(new Event('evb:app-ready'));
}

function dispatchVisualReady(reason: 'first-view-presented' | 'password-prompt' | 'timed-out') {
    window.dispatchEvent(new CustomEvent('evb:startup-open-visual-ready', {detail: {reason}}));
}

function dispatchStartupFailed() {
    window.dispatchEvent(new Event('evb:startup-failed'));
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
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        window.sessionStorage.clear();
    });

    afterEach(() => {
        dispatchStartupFailed();
        window.dispatchEvent(new Event('DOMContentLoaded'));
        vi.restoreAllMocks();
        Reflect.deleteProperty(process, 'defaultApp');
    });

    it('leaves the placeholder about:blank document without an overlay or log', () => {
        const browser = cast<{happyDOM: {setURL: (url: string) => void}}>(window).happyDOM;
        const url = window.location.href;
        browser.setURL('about:blank');
        try {
            const deps = install();
            expect(document.getElementById(OVERLAY_ID)).toBeNull();
            expect(deps.forwardPreloadLogToMain).not.toHaveBeenCalled();
        } finally {
            browser.setURL(url);
        }
    });

    it('leaves Chromium’s failed-navigation page without an overlay or log', () => {
        const browser = cast<{happyDOM: {setURL: (url: string) => void}}>(window).happyDOM;
        const url = window.location.href;
        browser.setURL('chrome-error://chromewebdata/');
        try {
            const deps = install();
            expect(document.getElementById(OVERLAY_ID)).toBeNull();
            expect(deps.forwardPreloadLogToMain).not.toHaveBeenCalled();
        } finally {
            browser.setURL(url);
        }
    });

    it('removes after app-ready followed by an empty claim', () => {
        install();
        dispatchAppReady();
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();

        dispatchClaim(0);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it.each(['first-view-presented', 'password-prompt', 'timed-out'] as const)(
        'retains a positive claim until the %s visual receipt',
        (reason) => {
            install();
            dispatchAppReady();
            dispatchClaim(1);
            expect(document.getElementById(OVERLAY_ID)).not.toBeNull();

            dispatchVisualReady(reason);
            expect(document.getElementById(OVERLAY_ID)).toBeNull();
        },
    );

    it('handles an empty claim before app-ready', () => {
        install();
        dispatchClaim(0);
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();

        dispatchAppReady();
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('removes on a startup failure before the claim or app-ready', () => {
        install();
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
        dispatchStartupFailed();
        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });

    it('removes in development after app-ready and an empty claim', () => {
        install(true);
        dispatchAppReady();
        expect(document.getElementById(OVERLAY_ID)).not.toBeNull();
        dispatchClaim(0);
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

    it('keeps the overlay absent after duplicate and late receipts', () => {
        install();
        dispatchAppReady();
        dispatchClaim(0);
        expect(document.getElementById(OVERLAY_ID)).toBeNull();

        dispatchAppReady();
        dispatchClaim(1);
        dispatchVisualReady('first-view-presented');
        dispatchStartupFailed();
        window.dispatchEvent(new Event('DOMContentLoaded'));

        expect(document.getElementById(OVERLAY_ID)).toBeNull();
    });
});
