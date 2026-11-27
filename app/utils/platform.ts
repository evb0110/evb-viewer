import type {IPlatformApi} from '@contracts/platformApi';
import {getRawElectronPlatformApi, hasElectronPlatformBridge} from '@app/utils/electronPlatformBridge';

let browserPlatformApi: IPlatformApi | null = null;

export async function loadBrowserPlatformApi() {
    browserPlatformApi ??= (await import('@app/platform/browserPlatformApi')).browserPlatformApi;
    return browserPlatformApi;
}

/** Installs a browser platform implementation directly, for component tests. */
export function setBrowserPlatformApi(platformApi: IPlatformApi | null) {
    browserPlatformApi = platformApi;
}

export function hasElectronAPI() {
    return hasElectronPlatformBridge();
}

export function isDesktopPlatformActive(electronApiAvailable = hasElectronAPI()) {
    return electronApiAvailable;
}

export function isBrowserPlatformActive(electronApiAvailable = hasElectronAPI()) {
    return !isDesktopPlatformActive(electronApiAvailable);
}

export function isElectronRoutePath(path: string | null | undefined) {
    return path === '/electron' || path?.startsWith('/electron/') === true;
}

export function shouldPreferDesktopPlatform(
    routePath: string | null | undefined,
    desktopRuntime = false,
    electronApiAvailable = hasElectronAPI(),
) {
    // An Electron-shaped user agent is not a capability boundary. Embedded
    // browsers and automation hosts commonly expose it without installing the
    // preload bridge; only an explicit desktop route/runtime or a real bridge
    // may select the desktop platform.
    return electronApiAvailable || desktopRuntime || isElectronRoutePath(routePath);
}

export function resolveInitialDesktopRuntime(routePath: string | null | undefined, electronApiAvailable = hasElectronAPI()) {
    return shouldPreferDesktopPlatform(routePath, false, electronApiAvailable);
}

export function getPlatformAPI(): IPlatformApi {
    const platformApi = getRawElectronPlatformApi() ?? browserPlatformApi;
    if (!platformApi) {
        throw new Error('The browser platform API is used before the browser-platform plugin loaded it');
    }
    return platformApi;
}
