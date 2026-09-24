import { injectAnalytics } from '@vercel/analytics/nuxt/runtime';
import { hasElectronAPI } from '@app/utils/platform';

// Vercel Web Analytics for the hosted browser build only. The desktop app sends
// no analytics. Query strings and fragments never leave the page.
export default defineNuxtPlugin(() => {
    if (hasElectronAPI() || useRuntimeConfig().public.analyticsEnabled !== true) {
        return;
    }

    injectAnalytics({beforeSend: event => ({
        ...event,
        url: event.url.split(/[?#]/u, 1)[0] ?? event.url,
    })});
});
