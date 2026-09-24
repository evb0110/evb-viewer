import type { TLocale } from '@i18n-app';
import { isLocaleMessageSource } from '@i18n-core';
import { createPluginTranslate } from '@app/utils/createPluginTranslate';
import { isAutomationSession } from '@app/utils/isAutomationSession';

// The monitor is a development aid that automation sessions also load, so
// Electron E2E checks viewer invariants in the production renderer. Ordinary
// packaged sessions never fetch its chunk.
export default defineNuxtPlugin(async (nuxtApp) => {
    if (!import.meta.dev && !isAutomationSession()) {
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

    const {installViewerInvariantMonitor} = await import('@app/modules/viewer-invariants/public');
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
