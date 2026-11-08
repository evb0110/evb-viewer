import { isBrowserExtensionPage } from '@app/utils/isBrowserExtensionPage';
import {
    loadBrowserPlatformApi,
    shouldPreferDesktopPlatform,
} from '@app/utils/platform';

// The hosted build loads its platform implementation once, before any page
// mounts, so every caller reads one plain object.
export default defineNuxtPlugin({
    name: 'browser-platform',
    parallel: false,
    async setup() {
        if (!shouldPreferDesktopPlatform(useRoute().path)) {
            await loadBrowserPlatformApi();
            // The extension's document downloads while the workspace mounts.
            if (isBrowserExtensionPage()) {
                void import('@app/platform/browser-api/public')
                    .then(browserApi => browserApi.openBrowserExtensionLaunchDocument());
            }
        }
    },
});
