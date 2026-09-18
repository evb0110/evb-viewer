import type { TLocale } from '@i18n-app';
import { isLocaleMessageSource } from '@i18n-core';
import { createPluginTranslate } from '@app/utils/createPluginTranslate';

// The monitor is a development aid. Nuxt replaces `import.meta.dev` with a
// literal in a production build, so this ternary is what lets rollup drop the
// dynamic import and leave the module out of the shipped renderer entirely.
// The same pattern keeps the dev-only agent widget out of production.
const loadViewerInvariantMonitor = import.meta.dev
    ? () => import('@app/modules/viewer-invariants/public')
    : null;

export default defineNuxtPlugin(async (nuxtApp) => {
    if (!loadViewerInvariantMonitor || typeof window === 'undefined') {
        return;
    }

    const toast = useToast();
    const localeCookie = useCookie<TLocale>('i18n_redirected');
    const t = createPluginTranslate(
        (locale) => {
            const composer: unknown = nuxtApp.$i18n;
            return isLocaleMessageSource(composer) ? composer.getLocaleMessage(locale) : {};
        },
        () => localeCookie.value,
    );

    const {installViewerInvariantMonitor} = await loadViewerInvariantMonitor();
    const monitor = installViewerInvariantMonitor({announceBugReport: (result) => {
        toast.add({
            color: result.written ? 'success' : 'warning',
            ...(result.written ? {description: result.directoryName} : {}),
            icon: 'i-ph-bug',
            title: result.written
                ? t('viewerInvariants.bugReportSaved')
                : t('viewerInvariants.bugReportUnavailable'),
        });
    }});

    if (import.meta.hot) {
        import.meta.hot.dispose(() => {
            monitor.dispose();
        });
    }
});
