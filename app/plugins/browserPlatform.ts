import { loadBrowserPlatformApi } from '@app/utils/platform';
import { hasElectronPlatformBridge } from '@app/utils/electronPlatformBridge';

// The hosted build loads its platform implementation once, before any page
// mounts, so every caller reads one plain object.
export default defineNuxtPlugin({
    name: 'browser-platform',
    parallel: false,
    async setup() {
        if (!hasElectronPlatformBridge() && !isElectronRoutePath(useRoute().path)) {
            await loadBrowserPlatformApi();
        }
    },
});

function isElectronRoutePath(path: string) {
    return path === '/electron' || path.startsWith('/electron/');
}
