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
        }
    },
});
