<template>
    <UApp :toaster="toasterOptions">
        <AppFatalRuntimeDialog
            :open="Boolean(fatalRuntimeError)"
            :title="fatalRuntimeTitle"
            :description="fatalRuntimeDescription"
            :detail="fatalRuntimeError?.detail ?? null"
            :failure="fatalRuntimeError?.failure ?? null"
            :detail-label="t('errors.runtime.details')"
            :error-id-label="t('errors.runtime.errorId')"
            :reload-label="t('errors.runtime.reload')"
            :copy-label="t('errors.runtime.copy')"
            :copied="recentlyCopiedFatalDetail"
            @reload="reloadAfterFatalRuntimeError"
            @copy="handleCopyFatalRuntimeDetail"
        >
            <NuxtPage />
            <DevOnly>
                <ClientOnly>
                    <component :is="AgentationWidget" v-if="AgentationWidget" />
                </ClientOnly>
            </DevOnly>
        </AppFatalRuntimeDialog>
    </UApp>
</template>

<script setup lang="ts">
import { useClipboard } from '@vueuse/core';
import AppFatalRuntimeDialog from '@app/components/AppFatalRuntimeDialog.vue';
import { setRendererDiagnosticsPreference } from '@app/utils/failureReporter';
import type {IRuntimeErrorReport} from '@app/composables/useRuntimeErrorReports';
import {useFailureToast} from '@app/composables/useFailureToast';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getOrCaptureRendererBootstrapFailure } from '@app/utils/getOrCaptureRendererBootstrapFailure';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import { markStartupMetricOnce } from '@app/utils/startupMetrics';
import { traceRendererStartup } from '@app/utils/traceRendererStartup';
import {onBrowserDocumentPersistenceWarning} from '@app/platform/browser/browserDocumentPersistenceWarnings';
import { waitForPreferredDesktopPlatformBridge } from '@app/utils/platform';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';

// Every failure and notice is a toast, stacked upward from the bottom-right
// corner, at most three at a time.
const toasterOptions = {
    position: 'bottom-right' as const,
    max: 3,
    ui: {base: 'app-toast'},
};
const DIAGNOSTICS_CONSENT_TOAST_ID = 'diagnostics-consent';

// The <DevOnly> template block is stripped from production builds, but a static
// import would still pull agentation-vue3 into the production entry chunk.
const AgentationWidget = import.meta.dev
    ? defineAsyncComponent(() => import('@app/components/AgentationWidget.vue'))
    : null;

const {
    loadOrThrow: loadSettings,
    isLoaded,
    settings,
    save: saveSettings,
    updateSetting,
} = useSettings();
const {
    effectiveScale: uiEffectiveScale,
    hostSnapshot: uiHostSnapshot,
    applyUiScaleToDocument,
    attachHostEnvironmentListener,
    refreshHostSnapshot,
    setPreferenceFromSettings,
} = useUiScale();
const hostEnvironmentUnsubscribers: Array<() => void> = [];
const toast = useToast();
let themeRepaintRevision = 0;
const {isDesktopRuntime} = useRuntimeEnvironment();
const {
    locale,
    t,
    loadLocaleMessages,
    setLocale,
} = useTypedI18n();
const {
    fatalRuntimeError,
    setFatalRuntimeError,
    reloadAfterFatalRuntimeError,
} = useFatalRuntimeError();
const {
    reports: runtimeErrorReports,
    clearRuntimeErrorReports,
    discardPendingDiagnostics,
    resendPendingDiagnosticOnce,
} = useRuntimeErrorReports();
const diagnosticsConsentBusy = ref<string | null>(null);
const {presentFailureToast} = useFailureToast();
const route = useRoute();
const colorMode = useColorMode();
const localeHead = useLocaleHead({
    dir: true,
    lang: true,
    seo: true,
});
const DEV_RELOAD_EVENT_KEY = 'evb-viewer:dev:last-vite-reload-event';
const fatalRuntimeTitle = computed(() => fatalRuntimeError.value?.kind === 'startup'
    ? t('errors.runtime.startupTitle')
    : t('errors.runtime.title'));
const fatalRuntimeDescription = computed(() => fatalRuntimeError.value?.kind === 'startup'
    ? t('errors.runtime.startupDescription')
    : t('errors.runtime.description'));
const pendingDiagnosticConsentReport = computed(() => isLoaded.value
    && settings.value.clientDiagnosticsPreference === 'unknown'
    ? runtimeErrorReports.value.find(report => report.pendingDiagnostic?.isLive) ?? null
    : null);
const {
    copied: recentlyCopiedFatalDetail,
    copy: copyFatalDetailToClipboard,
    isSupported: isFatalDetailClipboardSupported,
} = useClipboard({ copiedDuring: 1500 });
let appReadyDispatched = false;

// A runtime error is told like any other failure: once when it first
// happens, and again (the toast pulses) each time it repeats.
const toldRuntimeReportCounts = new Map<string, number>();
watch(runtimeErrorReports, (reports) => {
    for (const report of reports) {
        if (!report.failure || toldRuntimeReportCounts.get(report.id) === report.count) {
            continue;
        }
        toldRuntimeReportCounts.set(report.id, report.count);
        presentFailureToast({
            failure: report.failure,
            title: report.title,
            description: report.detail || t('errors.runtime.reportDescription'),
            ...(report.technicalDetails ? {technicalDetails: report.technicalDetails} : {}),
        });
    }
    if (reports.length === 0) {
        toldRuntimeReportCounts.clear();
    }
});

// The first report the user may send asks once, beside its failure toast,
// and stays until they answer or decide in Settings.
watch(pendingDiagnosticConsentReport, (report, previous) => {
    if (report?.id === previous?.id) {
        return;
    }
    toast.remove(DIAGNOSTICS_CONSENT_TOAST_ID);
    if (!report) {
        return;
    }
    toast.add({
        id: DIAGNOSTICS_CONSENT_TOAST_ID,
        color: 'info',
        icon: 'i-ph-info',
        title: t('errors.runtime.diagnosticsConsentTitle'),
        description: t('errors.runtime.diagnosticsConsentDescription'),
        duration: Number.POSITIVE_INFINITY,
        progress: false,
        actions: [
            {
                label: t('errors.runtime.diagnosticsConsentGrant'),
                color: 'primary',
                onClick: () => {
                    void grantDiagnosticsConsent(report);
                },
            },
            {
                label: t('errors.runtime.diagnosticsConsentDeny'),
                color: 'neutral',
                variant: 'outline',
                onClick: () => denyDiagnosticsConsent(report),
            },
        ],
    });
});

async function copyText(
    value: string,
    copyToClipboard: (value: string) => Promise<void>,
    isClipboardSupported: boolean,
) {
    if (!import.meta.client || !isClipboardSupported) {
        return false;
    }
    try {
        await copyToClipboard(value);
        return true;
    } catch (error) {
        BrowserLogger.warn('runtime-errors', 'Failed to copy runtime error report', error);
        return false;
    }
}

async function handleCopyFatalRuntimeDetail() {
    const detail = fatalRuntimeError.value?.detail;
    if (!detail) {
        return;
    }
    await copyText(detail, copyFatalDetailToClipboard, isFatalDetailClipboardSupported.value);
}


async function grantDiagnosticsConsent(report: IRuntimeErrorReport) {
    const lease = report.pendingDiagnostic;
    if (
        diagnosticsConsentBusy.value !== null
        || !lease?.isLive
        || settings.value.clientDiagnosticsPreference !== 'unknown'
    ) {
        return;
    }

    diagnosticsConsentBusy.value = report.id;
    const presentationRoute = route.fullPath;
    const previousPreference = settings.value.clientDiagnosticsPreference;
    updateSetting('clientDiagnosticsPreference', 'granted');
    const saved = await saveSettings();
    if (!saved) {
        settings.value = {
            ...settings.value,
            clientDiagnosticsPreference: previousPreference,
        };
        setRendererDiagnosticsPreference(previousPreference);
    } else {
        const preferenceAfterSave: string = settings.value.clientDiagnosticsPreference;
        if (
            preferenceAfterSave === 'granted'
        && route.fullPath === presentationRoute
        && runtimeErrorReports.value.some(candidate => (
            candidate.id === report.id
            && candidate.pendingDiagnostic?.isLive
        ))
        ) {
            resendPendingDiagnosticOnce();
        }
    }
    diagnosticsConsentBusy.value = null;
}

function denyDiagnosticsConsent(report: IRuntimeErrorReport) {
    if (diagnosticsConsentBusy.value !== null) {
        return;
    }

    diagnosticsConsentBusy.value = report.id;
    updateSetting('clientDiagnosticsPreference', 'denied');
    discardPendingDiagnostics();
    void saveSettings().finally(() => {
        diagnosticsConsentBusy.value = null;
    });
}

watch(() => colorMode.value, async () => {
    if (!import.meta.client) {
        return;
    }
    const revision = ++themeRepaintRevision;
    await nextTick();
    await waitForVisualFrames();
    if (revision !== themeRepaintRevision) {
        return;
    }

    // Hidden workspace tabs are retained with v-show. Some Chromium builds can
    // leave their composited layers painted in the prior color scheme until a
    // layout event occurs, so make the theme commit an explicit layout epoch.
    document.documentElement.getBoundingClientRect();
    window.dispatchEvent(new Event('resize'));
});

onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', clearRuntimeErrorReports);
    }
    clearRuntimeErrorReports();
    themeRepaintRevision += 1;
    while (hostEnvironmentUnsubscribers.length > 0) {
        const unsubscribe = hostEnvironmentUnsubscribers.pop();
        try {
            unsubscribe?.();
        } catch (error) {
            BrowserLogger.warn('host-env', 'Failed to unsubscribe host environment listener', error);
        }
    }
});

watch(() => route.fullPath, () => {
    clearRuntimeErrorReports();
}, {flush: 'sync'});

colorMode.preference = settings.value.theme;

setPreferenceFromSettings(settings.value);

watch(
    () => settings.value.uiScale,
    () => {
        setPreferenceFromSettings(settings.value);
    },
);

useHead(() => ({
    htmlAttrs: {
        ...localeHead.value.htmlAttrs,
        dir: 'ltr',
        'data-platform': uiHostSnapshot.value.platform,
        style: `--app-ui-scale: ${uiEffectiveScale.value};`,
        class: settings.value.theme,
    },
    meta: localeHead.value.meta,
    link: localeHead.value.link,
}));

function dispatchAppReady() {
    if (typeof window === 'undefined' || appReadyDispatched) {
        return;
    }
    appReadyDispatched = true;
    window.__appReady = true;
    window.__appReadyAt = Date.now();
    window.dispatchEvent(new Event('evb:app-ready'));
    traceRendererStartup('evb:app-ready dispatched');
}

function installViteReloadDiagnostics() {
    if (!import.meta.dev || typeof window === 'undefined') {
        return;
    }

    try {
        const rawPreviousEvent = window.sessionStorage.getItem(DEV_RELOAD_EVENT_KEY);
        if (rawPreviousEvent) {
            const previousEvent: unknown = JSON.parse(rawPreviousEvent);
            BrowserLogger.debug('dev-reload', 'Previous Vite reload event (persisted)', previousEvent);
            window.sessionStorage.removeItem(DEV_RELOAD_EVENT_KEY);
        }
    } catch {
        // sessionStorage may be unavailable or contain invalid JSON
    }

    const hot = import.meta.hot;

    if (typeof hot?.on !== 'function') {
        return;
    }

    hot.on('vite:beforeFullReload', (payload: unknown) => {
        const event = {
            timestamp: Date.now(),
            event: 'vite:beforeFullReload',
            payload,
        };

        BrowserLogger.debug('dev-reload', 'Vite announced full reload', event);
        try {
            window.sessionStorage.setItem(DEV_RELOAD_EVENT_KEY, JSON.stringify(event));
        } catch {
            // sessionStorage may be unavailable
        }
    });

    hot.on('vite:error', (payload: unknown) => {
        BrowserLogger.error('dev-reload', 'Vite HMR error event received', payload, {code: 'RENDERER_DEVELOPMENT_HMR_FAILED'});
    });
}

installViteReloadDiagnostics();

// `settings` is seeded from the persisted locale cookie before the authoritative
// load resolves, so the message chunk can download during the bridge/settings wait
// instead of after it. The real switch still happens once settings are loaded.
function prefetchPersistedLocaleMessages() {
    if (locale.value === settings.value.locale) {
        return;
    }

    void loadLocaleMessages(settings.value.locale).catch(error => {
        BrowserLogger.debug('i18n', 'Speculative locale message prefetch failed', error);
    });
}

onMounted(async () => {
    window.addEventListener('pagehide', clearRuntimeErrorReports);
    prefetchPersistedLocaleMessages();
    try {
        hostEnvironmentUnsubscribers.push(onBrowserDocumentPersistenceWarning(({
            fileName,
            error,
        }) => {
            BrowserLogger.warn('browser-storage', 'Document remains available only in memory', {
                fileName,
                error,
            });
            toast.add({
                color: 'warning',
                title: t('errors.file.browserStorageTitle'),
                description: t('errors.file.browserStorageDescription', {name: fileName}),
            });
        }));
        const bridgeResolution = await waitForPreferredDesktopPlatformBridge({
            routePath: route.path,
            desktopRuntime: isDesktopRuntime.value,
        });
        if (bridgeResolution.shouldWait && !bridgeResolution.bridgeReady) {
            const presentation = getOrCaptureRendererBootstrapFailure({
                error: new Error('Electron preload bridge is unavailable during app bootstrap.'),
                key: 'electron-preload-bridge',
                message: 'App bootstrap failed',
                section: 'loader',
                title: t('errors.runtime.title'),
            });
            setFatalRuntimeError('startup', presentation);
            return;
        }

        applyUiScaleToDocument(uiEffectiveScale.value, uiHostSnapshot.value);
        const unsubscribeHostEnvironment = attachHostEnvironmentListener();
        hostEnvironmentUnsubscribers.push(unsubscribeHostEnvironment);
        void refreshHostSnapshot();
        await loadSettings();
        const settingsRecoveryNotice = await getSettingsCapability().getRecoveryNotice();
        if (settingsRecoveryNotice) {
            toast.add({
                color: 'warning',
                title: t('settings.title'),
                description: settingsRecoveryNotice.quarantinePath
                    ? t('errors.settings.recoveredWithPath', {path: settingsRecoveryNotice.quarantinePath})
                    : t('errors.settings.recovered'),
            });
        }
        setPreferenceFromSettings(settings.value);
        if (locale.value !== settings.value.locale) {
            await setLocale(settings.value.locale);
        }
        colorMode.preference = settings.value.theme;
        traceRendererStartup('app bootstrap settings and locale ready');
        await nextTick();
        await waitForVisualFrames();
        markStartupMetricOnce('evb:shell-interactive');
        dispatchAppReady();
    } catch (error) {
        const presentation = getOrCaptureRendererBootstrapFailure({
            error,
            key: 'app-bootstrap',
            message: 'App bootstrap failed',
            section: 'loader',
            title: t('errors.runtime.title'),
        });
        setFatalRuntimeError('startup', presentation);
    }
});
</script>
