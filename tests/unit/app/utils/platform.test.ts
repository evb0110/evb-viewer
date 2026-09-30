import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import {
    shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge,
    waitForPreferredDesktopPlatformBridge,
} from '@app/utils/platform';

describe('platform runtime detection', () => {
    it('prefers the desktop platform only when runtime state or the bridge requires it', () => {
        expect(shouldPreferDesktopPlatform('/', true, false)).toBe(true);
        expect(shouldPreferDesktopPlatform('/electron', false, false)).toBe(true);
        expect(shouldPreferDesktopPlatform('/', false, true)).toBe(true);
        expect(shouldPreferDesktopPlatform('/', false, false)).toBe(false);
    });

    it('short-circuits bridge waiting when desktop is not required', async () => {
        await expect(waitForDesktopPlatformBridge({shouldWait: false})).resolves.toBe(false);
    });

    it('reports whether the preferred desktop bridge was required', async () => {
        await expect(waitForPreferredDesktopPlatformBridge({
            routePath: '/electron',
            attempts: 0,
        })).resolves.toEqual({
            shouldWait: true,
            bridgeReady: false,
        });
        await expect(waitForPreferredDesktopPlatformBridge({
            routePath: '/',
            attempts: 0,
        })).resolves.toEqual({
            shouldWait: false,
            bridgeReady: false,
        });
    });

    it('does not load the browser platform fallback while an electron api is present', async () => {
        vi.resetModules();
        let browserPlatformImportCount = 0;
        vi.doMock('@app/platform/browserPlatformApi', () => {
            browserPlatformImportCount += 1;
            return { browserPlatformApi: { shell: { openExternal: vi.fn().mockResolvedValue(undefined) } } };
        });

        const electronAPI = createElectronPlatformApiFixture({ shell: { openExternal: vi.fn().mockResolvedValue(undefined) } });
        vi.stubGlobal('window', { electronAPI });

        const { getPlatformAPI } = await import('@app/utils/platform');

        expect(getPlatformAPI()).toBe(electronAPI);
        expect(browserPlatformImportCount).toBe(0);

        vi.unstubAllGlobals();
        vi.doUnmock('@app/platform/browserPlatformApi');
    });

    it('serves the browser platform only after it is loaded once', async () => {
        vi.resetModules();
        let browserPlatformImportCount = 0;
        const openExternal = vi.fn().mockResolvedValue(undefined);
        vi.doMock('@app/platform/browserPlatformApi', () => {
            browserPlatformImportCount += 1;
            return { browserPlatformApi: { shell: { openExternal } } };
        });
        vi.stubGlobal('window', {});

        const {
            getPlatformAPI,
            loadBrowserPlatformApi,
        } = await import('@app/utils/platform');

        expect(() => getPlatformAPI()).toThrow('before the browser-platform plugin loaded it');
        await loadBrowserPlatformApi();
        await loadBrowserPlatformApi();
        await getPlatformAPI().shell.openExternal('https://example.com');
        expect(browserPlatformImportCount).toBe(1);
        expect(openExternal).toHaveBeenCalledWith('https://example.com');

        vi.unstubAllGlobals();
        vi.doUnmock('@app/platform/browserPlatformApi');
    });
});
