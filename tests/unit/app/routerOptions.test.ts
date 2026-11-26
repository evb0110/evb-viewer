// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createRouter } from 'vue-router';
import { resolveAppRouterOptions } from '@app/router.options';

describe('resolveAppRouterOptions', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('leaves default Nuxt router history and routes untouched outside the Chrome extension', () => {
        vi.stubGlobal('location', new URL('https://web.evb-viewer.com/'));
        expect(resolveAppRouterOptions()).toEqual({});
    });

    it('uses memory history and redirects /index.html to / on Chrome extension pages without mutating location or history state', async () => {
        const extensionUrl = 'chrome-extension://emheppcmboellngecbpoclbkhoonkaem/index.html?file=https://math.phys.msu.ru/data/28/Lecture_1.pdf?token=abc%23page=7';
        vi.stubGlobal('location', new URL(extensionUrl));
        const replaceStateSpy = vi.spyOn(history, 'replaceState');
        const pushStateSpy = vi.spyOn(history, 'pushState');
        const options = resolveAppRouterOptions();
        expect(typeof options.history).toBe('function');
        expect(typeof options.routes).toBe('function');

        const memoryHistory = options.history?.('/');
        if (!memoryHistory) {
            throw new Error('Expected memory history on Chrome extension page');
        }
        const router = createRouter({
            history: memoryHistory,
            routes: await options.routes!([
                {
                    name: 'index',
                    path: '/',
                    component: { template: '<div />' },
                },
                {
                    name: 'about',
                    path: '/about',
                    component: { template: '<div />' },
                },
                {
                    name: 'privacy',
                    path: '/privacy',
                    component: { template: '<div />' },
                },
            ]),
        });

        await router.replace('/index.html?file=https://math.phys.msu.ru/data/28/Lecture_1.pdf?token=abc%23page=7');
        expect(router.currentRoute.value.path).toBe('/');
        await router.push('/about');
        expect(router.currentRoute.value.path).toBe('/about');
        await router.push('/privacy');
        expect(router.currentRoute.value.path).toBe('/privacy');
        await router.push('/');
        expect(router.currentRoute.value.path).toBe('/');

        expect(location.href).toBe(extensionUrl);
        expect(location.hash).toBe('');
        expect(replaceStateSpy).not.toHaveBeenCalled();
        expect(pushStateSpy).not.toHaveBeenCalled();
        replaceStateSpy.mockRestore();
        pushStateSpy.mockRestore();
    });
});
