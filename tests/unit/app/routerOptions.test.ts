// @vitest-environment happy-dom

import {afterEach, describe, expect, it, vi} from 'vitest';
import {createRouter} from 'vue-router';
import {resolveAppRouterOptions} from '@app/router.options';

const TEST_ROUTES = [
    {
        name: 'index',
        path: '/',
        component: {template: '<div />'},
    },
    {
        name: 'about',
        path: '/about',
        component: {template: '<div />'},
    },
    {
        name: 'privacy',
        path: '/privacy',
        component: {template: '<div />'},
    },
];

function setHappyDomUrl(url: string) {
    const happyDom = (window as Window & {happyDOM?: {setURL: (nextUrl: string) => void}}).happyDOM;
    if (!happyDom) {
        throw new Error('Expected happy-dom window.happyDOM');
    }
    happyDom.setURL(url);
}

async function createExtensionRouter(url: string, initialState: Record<string, unknown> | null = null) {
    setHappyDomUrl(url);
    history.replaceState(initialState, '', url);
    const options = resolveAppRouterOptions();
    expect(typeof options.history).toBe('function');
    expect(typeof options.routes).toBe('function');
    const routerHistory = options.history?.('/');
    if (!routerHistory) {
        throw new Error('Expected browser-backed extension history on Chrome extension page');
    }
    const router = createRouter({
        history: routerHistory,
        routes: await options.routes!(TEST_ROUTES),
    });
    await router.push(routerHistory.location);
    await router.isReady();
    return {
        router,
        routerHistory,
    };
}

describe('resolveAppRouterOptions', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        setHappyDomUrl('about:blank');
    });

    it('leaves default Nuxt router history and routes untouched outside the Chrome extension', () => {
        setHappyDomUrl('https://web.evb-viewer.com/');
        expect(resolveAppRouterOptions()).toEqual({});
    });

    it('uses browser-backed history with hash-free viewer URLs, index.html#/ secondary links, preserved query/state, and working Back', async () => {
        const launchQuery = '?file=https://math.phys.msu.ru/data/28/Lecture_1.pdf?token=abc%23page=7';
        const extensionUrl = `chrome-extension://emheppcmboellngecbpoclbkhoonkaem/index.html${launchQuery}`;
        const {router, routerHistory} = await createExtensionRouter(extensionUrl, {evbExtensionDocument: 'doc:launch-1'});

        try {
            // Simulate Nuxt's initial router.replace on /index.html?file=...
            await router.replace(`/index.html${launchQuery}`);
            expect(router.currentRoute.value.path).toBe('/');
            expect(location.href).toBe(extensionUrl);
            expect(location.hash).toBe('');
            expect(location.search).toBe(launchQuery);
            expect((history.state as Record<string, unknown>)?.evbExtensionDocument).toBe('doc:launch-1');

            // Ctrl-click / new-tab href targets index.html#/privacy and index.html#/about (not excluded /privacy).
            expect(router.resolve('/privacy').href).toBe('/index.html#/privacy');
            expect(router.resolve('/about').href).toBe('/index.html#/about');
            expect(router.resolve('/').href).toBe('/index.html');

            // Normal navigation pushes a real browser history entry so Chrome Back can return.
            const viewerState = history.state;
            await router.push('/privacy');
            expect(router.currentRoute.value.path).toBe('/privacy');
            expect(location.pathname).toBe('/index.html');
            expect(location.search).toBe(launchQuery);
            expect(location.hash).toBe('#/privacy');

            // Simulate Chrome Back returning to the viewer's browser history entry.
            history.replaceState(viewerState, '', extensionUrl);
            window.dispatchEvent(new PopStateEvent('popstate', {state: viewerState}));
            await vi.waitFor(() => {
                expect(router.currentRoute.value.path).toBe('/');
            });
            expect(location.href).toBe(extensionUrl);
            expect(location.hash).toBe('');
            expect((history.state as Record<string, unknown>)?.evbExtensionDocument).toBe('doc:launch-1');

            // Navigating to /about and returning via <NuxtLink to="/"> keeps viewer hash-free with launch query.
            await router.push('/about');
            expect(router.currentRoute.value.path).toBe('/about');
            expect(location.hash).toBe('#/about');
            expect(location.search).toBe(launchQuery);

            await router.push('/');
            expect(router.currentRoute.value.path).toBe('/');
            expect(location.href).toBe(extensionUrl);
            expect(location.hash).toBe('');
            // Preserves evbExtensionDocument even after About -> Back to Viewer push.
            expect((history.state as Record<string, unknown>)?.evbExtensionDocument).toBe('doc:launch-1');
        } finally {
            routerHistory.destroy();
        }
    });

    it('preserves encoded query parameters inside #/ fragments across Nuxt initial replace', async () => {
        const origin = 'chrome-extension://emheppcmboellngecbpoclbkhoonkaem';
        const entryPath = '/index.html#/privacy?key=a%26b%3Dc';
        const {router, routerHistory} = await createExtensionRouter(`${origin}${entryPath}`);

        try {
            expect(router.currentRoute.value.path).toBe('/privacy');
            expect(router.currentRoute.value.query).toEqual({key: 'a&b=c'});
            await router.replace(entryPath);
            expect(router.currentRoute.value.path).toBe('/privacy');
            expect(router.currentRoute.value.query).toEqual({key: 'a&b=c'});
            expect(location.hash).toBe('#/privacy?key=a%26b%3Dc');
        } finally {
            routerHistory.destroy();
        }
    });

    it.each([
        ['/index.html#/privacy', '/privacy', '#/privacy'],
        ['/index.html#/about', '/about', '#/about'],
        ['/index.html#/', '/', ''],
    ])('reads %s on startup and resolves to %s across Nuxt initial replace', async (entryPath, expectedPath, expectedHash) => {
        const origin = 'chrome-extension://emheppcmboellngecbpoclbkhoonkaem';
        const {router, routerHistory} = await createExtensionRouter(`${origin}${entryPath}`);

        try {
            expect(router.currentRoute.value.path).toBe(expectedPath);
            // Simulate Nuxt's app:created replace with raw location pathname + hash.
            await router.replace(entryPath);
            expect(router.currentRoute.value.path).toBe(expectedPath);
            expect(location.pathname).toBe('/index.html');
            expect(location.hash).toBe(expectedHash);
        } finally {
            routerHistory.destroy();
        }
    });
});
