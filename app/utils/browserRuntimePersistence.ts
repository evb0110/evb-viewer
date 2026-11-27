import {safeSetLocalStorageItem} from '@app/utils/localStorage';

export const BROWSER_RECENT_FILES_STORAGE_KEY = 'evb-viewer:browser:recentFiles';
export const BROWSER_SETTINGS_STORAGE_KEY = 'evb-viewer:browser:settings';
export const BROWSER_INSTALL_HINT_COOKIE_KEY = 'evb_viewer_web_install_hint_dismissed';
export const BROWSER_INSTALL_HINT_STORAGE_KEY = 'evb-viewer:browser:installHintDismissed';

function hasLegacyBrowserInstallHintCookie() {
    if (typeof document === 'undefined') {
        return false;
    }

    try {
        return document.cookie.split(';').some((cookie) => {
            const separatorIndex = cookie.indexOf('=');
            const name = separatorIndex === -1 ? cookie : cookie.slice(0, separatorIndex);
            return name.trim() === BROWSER_INSTALL_HINT_COOKIE_KEY;
        });
    } catch {
        return false;
    }
}

function getSecureCookieAttribute() {
    try {
        return typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    } catch {
        return '';
    }
}

export function migrateLegacyBrowserInstallHintCookie() {
    if (!hasLegacyBrowserInstallHintCookie()) {
        return false;
    }

    const committed = safeSetLocalStorageItem(BROWSER_INSTALL_HINT_STORAGE_KEY, 'true');
    if (!committed) {
        return false;
    }
    try {
        document.cookie = `${BROWSER_INSTALL_HINT_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax${getSecureCookieAttribute()}`;
    } catch {
        // The local preference is canonical even when cookie access is blocked.
    }
    return true;
}
