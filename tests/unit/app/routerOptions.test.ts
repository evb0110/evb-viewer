// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { resolveAppRouterOptions } from '@app/router.options';

describe('resolveAppRouterOptions', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('leaves default Nuxt router history and routes untouched outside the Chrome extension', () => {
        vi.stubGlobal('location', new URL('https://web.evb-viewer.com/'));
        expect(resolveAppRouterOptions()).toEqual({});
    });

    it('uses memory history and redirects /index.html to / on Chrome extension pages without mutating location', () => {
        const extensionUrl = 'chrome-extension://emheppcmboellngecbpoclbkhoonkaem/index.html?file=https://math.phys.msu.ru/data/28/Lecture_1.pdf';
        vi.stubGlobal('location', new URL(extensionUrl));
        const options = resolveAppRouterOptions();
        expect(typeof options.history).toBe('function');
        expect(typeof options.routes).toBe('function');

        const history = options.history?.('/');
        expect(history?.location).toBe('');
        history?.push('/about');
        expect(history?.location).toBe('/about');
        expect(location.href).toBe(extensionUrl);
        expect(location.hash).toBe('');

        const routes = options.routes?.([{
            name: 'index',
            path: '/',
            children: [],
        }]);
        expect(routes).toEqual([
            {
                name: 'index',
                path: '/',
                children: [],
            },
            {
                path: '/index.html',
                redirect: '/',
            },
        ]);
    });
});
