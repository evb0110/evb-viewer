// @vitest-environment happy-dom

import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {THostResourceTier} from '@contracts/hostResourceProfile';

const mocks = vi.hoisted(() => ({getPerformanceProfile: vi.fn(() => ({tier: 'medium' as THostResourceTier}))}));

vi.mock('@app/utils/performanceProfile', () => ({getPerformanceProfile: mocks.getPerformanceProfile}));

interface IControllableMediaQueryList extends MediaQueryList {
    setMatches: (matches: boolean) => void;
}

function createMediaQueryList(initialMatches = false): IControllableMediaQueryList {
    const target = new EventTarget() as IControllableMediaQueryList;
    let matches = initialMatches;
    Object.defineProperties(target, {
        matches: {get: () => matches},
        media: {value: '(prefers-reduced-motion: reduce)'},
        onchange: {
            value: null,
            writable: true,
        },
        setMatches: {
            value: (nextMatches: boolean) => {
                matches = nextMatches;
                target.dispatchEvent(new Event('change'));
            },
        },
    });
    target.addListener = () => {};
    target.removeListener = () => {};
    target.dispatchEvent = target.dispatchEvent.bind(target);
    return target;
}

function getTierClasses(root: HTMLElement) {
    return [...root.classList].filter((className) => className.startsWith('performance-tier-'));
}

describe('performance profile root plugin', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        document.documentElement.className = '';
        vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
    });

    it.each<THostResourceTier>(['low', 'medium', 'high'])('installs exactly one %s tier class synchronously', async (tier) => {
        const mediaQuery = createMediaQueryList();
        mocks.getPerformanceProfile.mockReturnValue({tier});
        const matchMedia = vi.fn(() => mediaQuery);
        vi.stubGlobal('matchMedia', matchMedia);
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            value: matchMedia,
        });
        const plugin = (await import('@app/plugins/performance-profile.client')).default as () => void;

        plugin();

        expect(mocks.getPerformanceProfile).toHaveBeenCalledOnce();
        expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
        expect(getTierClasses(document.documentElement)).toEqual([`performance-tier-${tier}`]);
        expect(document.documentElement.classList.contains('app-low-graphics')).toBe(tier === 'low');
    });

    it('tracks reduced motion and keeps low-tier graphics suppressed', async () => {
        const {installPerformanceProfileRootClasses} = await import('@app/plugins/performance-profile.client');
        const mediaQuery = createMediaQueryList();
        const cleanup = installPerformanceProfileRootClasses(document.documentElement, mediaQuery, 'medium');

        expect(document.documentElement.classList.contains('app-low-graphics')).toBe(false);
        mediaQuery.setMatches(true);
        expect(document.documentElement.classList.contains('app-low-graphics')).toBe(true);
        mediaQuery.setMatches(false);
        expect(document.documentElement.classList.contains('app-low-graphics')).toBe(false);

        cleanup();
        const lowMediaQuery = createMediaQueryList();
        const cleanupLow = installPerformanceProfileRootClasses(document.documentElement, lowMediaQuery, 'low');
        lowMediaQuery.setMatches(false);

        expect(document.documentElement.classList.contains('app-low-graphics')).toBe(true);
        cleanupLow();
    });

    it('removes the listener and all managed classes during cleanup', async () => {
        const {installPerformanceProfileRootClasses} = await import('@app/plugins/performance-profile.client');
        const mediaQuery = createMediaQueryList();
        document.documentElement.classList.add('unrelated-root-class');
        const cleanup = installPerformanceProfileRootClasses(document.documentElement, mediaQuery, 'high');

        cleanup();
        mediaQuery.setMatches(true);

        expect(getTierClasses(document.documentElement)).toEqual([]);
        expect(document.documentElement.classList.contains('app-low-graphics')).toBe(false);
        expect(document.documentElement.classList.contains('unrelated-root-class')).toBe(true);
    });
});
