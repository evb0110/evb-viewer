import type { RouterConfig } from '@nuxt/schema';
import { createMemoryHistory } from 'vue-router';
import { BROWSER_EXTENSION_VIEWER_PAGE } from '@contracts/browserExtensionLaunch';
import { isBrowserExtensionPage } from '@app/utils/isBrowserExtensionPage';

/**
 * The Chrome extension loads the workspace from `/index.html?file=<url>` and
 * keeps that URL readable in the address bar without `#/` or path mutations.
 * Memory history keeps in-app routes (`/`, `/about`, `/privacy`) off
 * `window.location` and `window.history.state`, while redirecting the initial
 * `/index.html` entry to `/`.
 */
export function resolveAppRouterOptions(): RouterConfig {
    if (!isBrowserExtensionPage()) {
        return {};
    }

    return {
        history: base => createMemoryHistory(base),
        routes: scannedRoutes => [
            ...scannedRoutes,
            {
                path: `/${BROWSER_EXTENSION_VIEWER_PAGE}`,
                redirect: '/',
            },
        ],
    };
}

export default resolveAppRouterOptions();
