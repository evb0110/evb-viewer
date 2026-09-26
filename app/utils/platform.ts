import type { IPlatformApi } from '@contracts/platformApi';
import { delay } from 'es-toolkit/promise';
import {
    getRawElectronPlatformApi,
    hasElectronPlatformBridge,
} from '@app/utils/electronPlatformBridge';

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

export function isElectronUserAgent(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
    return /\bElectron\//u.test(userAgent);
}

export function shouldPreferDesktopPlatform(
    routePath: string | null | undefined,
    desktopRuntime = false,
    electronApiAvailable = hasElectronAPI(),
    _electronUserAgent = isElectronUserAgent(),
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

interface IWaitForDesktopPlatformBridgeOptions {
    shouldWait?: boolean;
    retryDelayMs?: number;
    attempts?: number;
}

interface IPreferredDesktopPlatformBridgeOptions extends Omit<IWaitForDesktopPlatformBridgeOptions, 'shouldWait'> {
    routePath?: string | null | undefined;
    desktopRuntime?: boolean | undefined;
}

export interface IPreferredDesktopPlatformBridgeResolution {
    bridgeReady: boolean;
    shouldWait: boolean;
}

export async function waitForDesktopPlatformBridge({
    shouldWait = true,
    retryDelayMs = 25,
    attempts = 20,
}: IWaitForDesktopPlatformBridgeOptions = {}) {
    if (!shouldWait || hasElectronPlatformBridge()) {
        return hasElectronPlatformBridge();
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        await delay(retryDelayMs);

        if (hasElectronPlatformBridge()) {
            return true;
        }
    }

    return hasElectronPlatformBridge();
}

export async function waitForPreferredDesktopPlatformBridge({
    routePath,
    desktopRuntime = false,
    retryDelayMs,
    attempts,
}: IPreferredDesktopPlatformBridgeOptions = {}): Promise<IPreferredDesktopPlatformBridgeResolution> {
    const shouldWait = shouldPreferDesktopPlatform(routePath, desktopRuntime);
    return {
        shouldWait,
        bridgeReady: await waitForDesktopPlatformBridge({
            shouldWait,
            ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
            ...(attempts === undefined ? {} : { attempts }),
        }),
    };
}

export function getPlatformAPI(): IPlatformApi {
    const platformApi = getRawElectronPlatformApi() ?? browserPlatformApi;
    if (!platformApi) {
        throw new Error('The browser platform API is used before the browser-platform plugin loaded it');
    }
    return platformApi;
}
