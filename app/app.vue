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
            <div
                v-if="runtimeErrorReports.length > 0"
                class="runtime-error-reports fixed top-4 right-4 z-40"
            >
                <div
                    class="runtime-error-reports-card overflow-hidden rounded-lg border border-default bg-default p-4 shadow-[var(--shadow-popup)]"
                >
                    <div class="flex items-start gap-3">
                        <UIcon name="i-ph-warning-circle" class="mt-0.5 size-5 shrink-0 text-[color:var(--ui-warning)]" />
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                                <p class="truncate text-sm font-medium text-default">
                                    {{ t('errors.runtime.reportReady') }}
                                </p>
                                <UBadge
                                    color="neutral"
                                    variant="soft"
                                    size="sm"
                                >
                                    {{ runtimeErrorReportCount }}
                                </UBadge>
                            </div>
                            <p class="mt-1 text-xs text-dimmed">
                                {{ t('errors.runtime.reportDescription') }}
                            </p>
                            <div
                                v-if="pendingDiagnosticConsentReport"
                                class="mt-3 rounded-md border border-default bg-elevated p-3"
                                role="group"
                                :aria-label="t('errors.runtime.diagnosticsConsentTitle')"
                            >
                                <p class="text-xs font-medium text-default">
                                    {{ t('errors.runtime.diagnosticsConsentTitle') }}
                                </p>
                                <p class="mt-1 text-xs text-dimmed">
                                    {{ t('errors.runtime.diagnosticsConsentDescription') }}
                                </p>
                                <div class="mt-3 flex flex-wrap gap-2">
                                    <UButton
                                        data-runtime-error-action="grant-diagnostics"
                                        color="primary"
                                        size="xs"
                                        :loading="diagnosticsConsentBusy === pendingDiagnosticConsentReport.id"
                                        :disabled="diagnosticsConsentBusy !== null"
                                        @click="grantDiagnosticsConsent(pendingDiagnosticConsentReport)"
                                    >
                                        {{ t('errors.runtime.diagnosticsConsentGrant') }}
                                    </UButton>
                                    <UButton
                                        data-runtime-error-action="deny-diagnostics"
                                        color="neutral"
                                        variant="soft"
                                        size="xs"
                                        :disabled="diagnosticsConsentBusy !== null"
                                        @click="denyDiagnosticsConsent(pendingDiagnosticConsentReport)"
                                    >
                                        {{ t('errors.runtime.diagnosticsConsentDeny') }}
                                    </UButton>
                                </div>
                            </div>
                            <div
                                v-if="showRuntimeErrorDetails"
                                class="runtime-error-report-details app-scrollbar app-scroll-region--balanced mt-3 space-y-3 overflow-y-auto"
                            >
                                <div
                                    v-for="report in runtimeErrorReports"
                                    :key="report.id"
                                    :data-runtime-error-report-id="report.id"
                                    class="rounded-md bg-elevated p-3"
                                >
                                    <div class="flex items-center gap-2">
                                        <p class="min-w-0 flex-1 truncate text-xs font-medium text-default">
                                            {{ report.title }}
                                        </p>
                                        <UBadge
                                            v-if="report.count > 1"
                                            color="neutral"
                                            variant="soft"
                                            size="sm"
                                        >
                                            {{ report.count }}
                                        </UBadge>
                                        <AppTooltip :text="t('errors.runtime.dismiss')" :delay-duration="400">
                                            <UButton
                                                color="neutral"
                                                variant="ghost"
                                                size="xs"
                                                icon="i-ph-x"
                                                :aria-label="t('errors.runtime.dismiss')"
                                                @click="dismissRuntimeErrorReport(report.id)"
                                            />
                                        </AppTooltip>
                                    </div>
                                    <p class="mt-1 text-xs text-dimmed">
                                        {{ report.source }}
                                    </p>
                                    <p v-if="report.failure" class="mt-1 text-xs text-dimmed">
                                        <span class="font-medium text-default">Error ID</span>
                                        <code class="ml-1 break-all">{{ getFailureErrorId(report.failure) }}</code>
                                    </p>
                                    <pre class="app-scrollbar app-scroll-region--balanced mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{{ report.detail }}</pre>
                                </div>
                            </div>
                        </div>
                        <div class="flex shrink-0 gap-1">
                            <AppTooltip :text="t('errors.runtime.copy')" :delay-duration="400">
                                <UButton
                                    color="neutral"
                                    variant="ghost"
                                    size="xs"
                                    :icon="recentlyCopiedReports ? 'i-ph-check' : 'i-ph-copy'"
                                    :class="[
                                        'copy-report-button transition-transform duration-150 ease-out hover:scale-110 active:scale-90',
                                        recentlyCopiedReports && 'copy-report-button--success',
                                    ]"
                                    :aria-label="t('errors.runtime.copy')"
                                    @click="handleCopyReports"
                                />
                            </AppTooltip>
                            <AppTooltip :text="t('errors.runtime.details')" :delay-duration="400">
                                <UButton
                                    data-runtime-error-action="details"
                                    color="neutral"
                                    variant="ghost"
                                    size="xs"
                                    :icon="showRuntimeErrorDetails ? 'i-ph-caret-down' : 'i-ph-caret-up'"
                                    :aria-label="t('errors.runtime.details')"
                                    @click="showRuntimeErrorDetails = !showRuntimeErrorDetails"
                                />
                            </AppTooltip>
                            <AppTooltip :text="t('errors.runtime.dismiss')" :delay-duration="400">
                                <UButton
                                    color="neutral"
                                    variant="ghost"
                                    size="xs"
                                    icon="i-ph-x"
                                    :aria-label="t('errors.runtime.dismiss')"
                                    @click="clearRuntimeErrorReports"
                                />
                            </AppTooltip>
                        </div>
                    </div>
                </div>
            </div>
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
import { sumBy } from 'es-toolkit/math';
import AppFatalRuntimeDialog from '@app/components/AppFatalRuntimeDialog.vue';
import {
    initializeRendererFailureReporter,
    setRendererDiagnosticsPreference,
} from '@app/utils/failureReporter';
import type {IRuntimeErrorReport} from '@app/composables/useRuntimeErrorReports';
import {getFailureErrorId} from '@app/composables/useFailureToast';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
import { getOrCaptureRendererBootstrapFailure } from '@app/utils/getOrCaptureRendererBootstrapFailure';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import { markStartupMetricOnce } from '@app/utils/startupMetrics';
import { traceRendererStartup } from '@app/utils/traceRendererStartup';
import {onBrowserDocumentPersistenceWarning} from '@app/platform/browser/browserDocumentPersistenceWarnings';
import {
    isElectronUserAgent,
    waitForPreferredDesktopPlatformBridge,
} from '@app/utils/platform';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { getSettingsCapability } from '@app/utils/getSettingsCapability';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';
import {runPostReadyRecentGeometryPrewarm} from '@app/modules/workspace-shell/host/runPostReadyRecentGeometryPrewarm';
import {
    resolveStartupWorkProfile,
    type IStartupWorkProfile,
} from '@app/utils/startupWorkProfile';
import {
    scheduleIdleWork,
    type TCancelIdleWork,
} from '@app/utils/scheduleIdleWork';

// Nuxt UI stacks toasts upward from the bottom-right corner and keeps at most
// this many on screen. The shell pins both numbers instead of inheriting the
// library defaults, because the band the runtime diagnostic card has to stay out
// of is derived from them in CSS. This constant is the single source of that
// number: the toaster gets it as `max`, and `useHead` publishes it to the
// stylesheet as `--app-toast-stack-max`, so the reserve cannot describe a stack
// depth the toaster does not use.
const APP_TOAST_STACK_MAX = 3;
const toasterOptions = {
    position: 'bottom-right' as const,
    max: APP_TOAST_STACK_MAX,
    ui: {base: 'app-toast'},
};

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
const {
    loadRecentFiles,
    recentFiles,
} = useRecentFiles();
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
    reportRuntimeError,
    dismissRuntimeErrorReport,
    clearRuntimeErrorReports,
    discardPendingDiagnostics,
    resendPendingDiagnosticOnce,
} = useRuntimeErrorReports();
const showRuntimeErrorDetails = ref(false);
const diagnosticsConsentBusy = ref<string | null>(null);
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
const runtimeErrorReportCount = computed(() => sumBy(runtimeErrorReports.value, report => report.count));
const pendingDiagnosticConsentReport = computed(() => isLoaded.value
    && settings.value.clientDiagnosticsPreference === 'unknown'
    ? runtimeErrorReports.value.find(report => report.pendingDiagnostic?.isLive) ?? null
    : null);
const {
    copied: recentlyCopiedFatalDetail,
    copy: copyFatalDetailToClipboard,
    isSupported: isFatalDetailClipboardSupported,
} = useClipboard({ copiedDuring: 1500 });
let cancelPostReadyRecentGeometryWarmup: TCancelIdleWork | null = null;
let appReadyDispatched = false;
const {
    copied: recentlyCopiedReports,
    copy: copyReportsToClipboard,
    isSupported: isReportsClipboardSupported,
} = useClipboard({ copiedDuring: 1500 });

function formatRuntimeErrorReport(report: {
    title: string;
    source: string;
    detail: string;
    count: number;
}) {
    return [
        report.title,
        `${t('errors.runtime.source')}: ${report.source}`,
        `${t('errors.runtime.count')}: ${report.count}`,
        '',
        report.detail,
    ].join('\n');
}

function formatRuntimeErrorReports() {
    return runtimeErrorReports.value.map(formatRuntimeErrorReport).join('\n\n---\n\n');
}

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

async function handleCopyReports() {
    await copyText(formatRuntimeErrorReports(), copyReportsToClipboard, isReportsClipboardSupported.value);
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

function reportStartupWarmupFailure(title: string, error: unknown) {
    const presentation = initializeRendererFailureReporter().captureForPresentation({
        code: 'RENDERER_STARTUP_WARMUP_FAILED',
        context: {},
        local: {
            source: 'loader',
            message: title,
            cause: error,
        },
    }, {localAlreadyRecorded: true});
    BrowserLogger.error('loader', title, error, presentation.failure);
    reportRuntimeError({
        ...presentation,
        failure: presentation.failure,
        title,
        description: getErrorMessage(error),
    });
}

function guardStartupWarmup(promise: Promise<unknown>, title: string) {
    void promise.catch(error => reportStartupWarmupFailure(title, error));
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
    cancelPostReadyRecentGeometryWarmup?.();
    cancelPostReadyRecentGeometryWarmup = null;
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
    showRuntimeErrorDetails.value = false;
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
        style: `--app-ui-scale: ${uiEffectiveScale.value}; --app-toast-stack-max: ${APP_TOAST_STACK_MAX};`,
        class: [
            localeHead.value.htmlAttrs.class,
            settings.value.theme,
        ].filter(Boolean).join(' '),
    },
    meta: localeHead.value.meta,
    link: localeHead.value.link,
}));

function schedulePostReadyRecentGeometryWarmup(
    profile: IStartupWorkProfile,
): void {
    traceRendererStartup('post-ready recent geometry warmup scheduled');
    cancelPostReadyRecentGeometryWarmup = scheduleIdleWork(() => {
        const warmup = (async () => {
            try {
                await loadRecentFiles();
                const documentFiles = getDocumentFilesCapability();
                const djvu = getDjvuCapability();
                const readPdfOpeningGeometry = documentFiles.getPdfOpeningGeometry;
                await runPostReadyRecentGeometryPrewarm({
                    files: recentFiles.value,
                    ports: {
                        ...(readPdfOpeningGeometry
                            ? {readPdfOpeningGeometry}
                            : {}),
                        readDjvuSourceInfo: path => djvu.getPageSourceInfo(path, 1),
                    },
                    profile,
                    onError: (kind, path, error) => BrowserLogger.debug(
                        'recent-open',
                        `Application-level Recent ${kind.toUpperCase()} geometry warmup unavailable`,
                        {
                            path,
                            error: getErrorMessage(error),
                        },
                    ),
                });
                markStartupMetricOnce('evb:recent-pdf-geometry-prewarmed');
                traceRendererStartup('post-ready recent geometry warmup settled');
            } catch (error) {
                traceRendererStartup('post-ready recent geometry warmup failed');
                throw error;
            }
        })();
        guardStartupWarmup(warmup, t('errors.runtime.recentGeometryWarmupTitle'));
        return warmup;
    });
}

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
        BrowserLogger.error('dev-reload', 'Vite HMR error event received', payload, {
            code: 'RENDERER_DEVELOPMENT_HMR_FAILED',
            context: {},
        });
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
        if (bridgeResolution.shouldWait && !bridgeResolution.bridgeReady && isElectronUserAgent()) {
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
        if (await getSettingsCapability().getRecoveryNotice()) {
            toast.add({
                color: 'warning',
                title: t('settings.title'),
                description: t('errors.settings.recovered'),
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
        schedulePostReadyRecentGeometryWarmup(resolveStartupWorkProfile());
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

<style scoped>
.copy-report-button {
    transform-origin: center;
}

.runtime-error-reports {
    width: min(var(--app-runtime-report-width), calc(100vw - var(--app-runtime-report-viewport-gutter)));
}

/* Anchored under the top edge, bounded so its lower edge stops above the tallest
   toast stack Nuxt UI can render. A scan-cleanup failure toast and this card
   report different things and must both stay readable.

   `clamp()` rather than `min()`: on a window shorter than the reserve the
   remaining viewport is negative, and the floor is what keeps the report on
   screen there instead of collapsing it to nothing. */
.runtime-error-reports-card {
    max-height: clamp(
        var(--app-runtime-report-min-height),
        calc(100vh - var(--app-runtime-report-notification-reserve)),
        var(--app-runtime-report-max-height)
    );
}

.runtime-error-report-details {
    max-height: clamp(
        var(--app-runtime-report-min-height),
        calc(100vh - var(--app-runtime-report-details-reserve)),
        var(--app-runtime-report-details-max-height)
    );
}

.copy-report-button--success {
    color: var(--ui-success);
    animation: copy-report-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes copy-report-pop {
    0% {
        transform: scale(1);
    }

    45% {
        transform: scale(1.28);
    }

    100% {
        transform: scale(1);
    }
}

@media (prefers-reduced-motion: reduce) {
    .copy-report-button {
        transition: none;
    }

    .copy-report-button--success {
        animation: none;
    }
}
</style>
