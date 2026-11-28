import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    hasElectronAPI: vi.fn<() => boolean>(() => false),
    analyticsEnabled: false as boolean | number,
    injectAnalytics: vi.fn(),
    analyticsModuleLoaded: vi.fn(),
}));

vi.mock('@app/utils/platform', () => ({hasElectronAPI: mocks.hasElectronAPI}));
vi.mock('@vercel/analytics/nuxt/runtime', () => {
    mocks.analyticsModuleLoaded();
    return {injectAnalytics: mocks.injectAnalytics};
});

describe('webAnalytics.client plugin', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.hasElectronAPI.mockReturnValue(false);
        mocks.analyticsEnabled = false;
        vi.stubGlobal('defineNuxtPlugin', (plugin: () => void) => plugin);
        vi.stubGlobal('useRuntimeConfig', () => ({public: {analyticsEnabled: mocks.analyticsEnabled}}));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('skips loading @vercel/analytics completely in Electron desktop builds', async () => {
        mocks.hasElectronAPI.mockReturnValue(true);
        mocks.analyticsEnabled = 1;

        const {default: plugin} = await import('@app/plugins/webAnalytics.client');
        plugin({} as never);
        await vi.dynamicImportSettled();

        expect(mocks.analyticsModuleLoaded).not.toHaveBeenCalled();
        expect(mocks.injectAnalytics).not.toHaveBeenCalled();
    });

    it('skips loading @vercel/analytics in browser builds when analytics is disabled', async () => {
        mocks.hasElectronAPI.mockReturnValue(false);
        mocks.analyticsEnabled = false;

        const {default: plugin} = await import('@app/plugins/webAnalytics.client');
        plugin({} as never);
        await vi.dynamicImportSettled();

        expect(mocks.analyticsModuleLoaded).not.toHaveBeenCalled();
        expect(mocks.injectAnalytics).not.toHaveBeenCalled();
    });

    it('dynamically loads @vercel/analytics in hosted browser builds and strips URL queries and fragments', async () => {
        mocks.hasElectronAPI.mockReturnValue(false);
        mocks.analyticsEnabled = 1;

        const {default: plugin} = await import('@app/plugins/webAnalytics.client');
        plugin({} as never);
        await vi.dynamicImportSettled();

        expect(mocks.analyticsModuleLoaded).toHaveBeenCalledOnce();
        expect(mocks.injectAnalytics).toHaveBeenCalledOnce();
        const config = mocks.injectAnalytics.mock.calls[0]?.[0] as {
            beforeSend: (event: {url: string; type: string}) => {url: string; type: string};
        };
        expect(
            config.beforeSend({
                type: 'pageview',
                url: 'https://viewer.example/doc?token=secret#page=4',
            }),
        ).toEqual({
            type: 'pageview',
            url: 'https://viewer.example/doc',
        });
    });
});
