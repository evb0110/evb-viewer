import { getNuxtPort } from '@scripts/electron-run/electronRunPortConfig';

export const ELECTRON_SERVER_PATH = '/electron';

function isElectronRendererPath(pathname: string) {
    return pathname === ELECTRON_SERVER_PATH
        || pathname.startsWith(`${ELECTRON_SERVER_PATH}/`);
}

function isLocalNuxtHost(hostname: string) {
    return hostname === '127.0.0.1'
        || hostname === 'localhost'
        || hostname === '::1'
        || hostname === '[::1]';
}

export function isElectronAppPageUrl(url: string) {
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol === 'evb-viewer:' && parsedUrl.hostname === 'app') {
            return isElectronRendererPath(parsedUrl.pathname);
        }

        return (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')
            && isLocalNuxtHost(parsedUrl.hostname)
            && parsedUrl.port === String(getNuxtPort())
            && isElectronRendererPath(parsedUrl.pathname);
    } catch {
        return false;
    }
}

export function isNuxtDevServerUrl(url: string) {
    try {
        const parsedUrl = new URL(url);
        return (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')
            && isLocalNuxtHost(parsedUrl.hostname)
            && parsedUrl.port === String(getNuxtPort());
    } catch {
        return false;
    }
}

