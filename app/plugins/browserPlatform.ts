import {readBrowserExtensionDocumentUrl} from '@contracts/browserExtensionLaunch';
import {parseDocumentRef} from '@contracts/documentRef';
import type {IBrowserExtensionPrefetchedLaunch} from '@app/platform/browserPlatformApi';
import {BrowserLogger} from '@app/utils/browserLogger';
import {isBrowserExtensionPage} from '@app/utils/isBrowserExtensionPage';
import {loadBrowserPlatformApi, shouldPreferDesktopPlatform} from '@app/utils/platform';

const EXTENSION_LAUNCHED_DOCUMENT_STATE_KEY = 'evbExtensionDocument';

function hasRememberedExtensionLaunchDocument() {
    if (typeof history === 'undefined') {
        return false;
    }
    const state: unknown = history.state;
    return (
        typeof state === 'object' && state !== null && parseDocumentRef(Reflect.get(state, EXTENSION_LAUNCHED_DOCUMENT_STATE_KEY)) !== null
    );
}

function abortPrefetchedLaunch(prefetched: IBrowserExtensionPrefetchedLaunch | undefined) {
    if (!prefetched) {
        return;
    }
    prefetched.controller?.abort();
    void prefetched.response.then((response) => response.body?.cancel()).catch(() => undefined);
}

function startPrefetchedExtensionLaunch(): IBrowserExtensionPrefetchedLaunch | undefined {
    if (!isBrowserExtensionPage() || typeof fetch !== 'function' || hasRememberedExtensionLaunchDocument()) {
        return undefined;
    }
    const documentUrl = readBrowserExtensionDocumentUrl(location.href);
    if (!documentUrl) {
        return undefined;
    }
    try {
        const protocol = new URL(documentUrl).protocol;
        if (protocol !== 'http:' && protocol !== 'https:') {
            return undefined;
        }
    } catch {
        return undefined;
    }
    const controller = new AbortController();
    const response = fetch(documentUrl, {
        credentials: 'include',
        signal: controller.signal,
    });
    // Rejections are observed when openBrowserExtensionDocument awaits the response;
    // suppress an unhandled rejection if boot fails before handoff.
    void response.catch(() => undefined);
    return {
        url: documentUrl,
        controller,
        response,
    };
}

// The hosted build loads its platform implementation once, before any page
// mounts, so every caller reads one plain object.
export default defineNuxtPlugin({
    name: 'browser-platform',
    parallel: false,
    async setup() {
        if (!shouldPreferDesktopPlatform(useRoute().path)) {
            // Overlap the extension's HTTP document fetch with loading the
            // browser platform shell and mounting the workspace.
            const prefetchedLaunch = startPrefetchedExtensionLaunch();
            try {
                await loadBrowserPlatformApi();
            } catch (error) {
                abortPrefetchedLaunch(prefetchedLaunch);
                throw error;
            }
            if (isBrowserExtensionPage()) {
                void import('@app/platform/browserPlatformApi')
                    .then((platform) => platform.openBrowserExtensionLaunchDocument(prefetchedLaunch))
                    .catch((error: unknown) => {
                        abortPrefetchedLaunch(prefetchedLaunch);
                        BrowserLogger.warn('browser-platform', 'The extension could not open its document', error);
                    });
            }
        }
    },
});
