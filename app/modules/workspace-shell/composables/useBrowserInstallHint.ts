import {
    useStorage,
    useTimeoutFn,
} from '@vueuse/core';
import type { Ref } from 'vue';
import {
    BROWSER_INSTALL_HINT_STORAGE_KEY,
    migrateLegacyBrowserInstallHintCookie,
} from '@app/utils/browserRuntimePersistence';
import { getLocalStorageForVueUse } from '@app/utils/localStorage';
import type { TAnalyticsEventName } from '@contracts/analytics';

const BROWSER_INSTALL_HINT_AUTO_DISMISS_MS = 60_000;

interface IBrowserInstallHintAnalytics { track: (
    event: TAnalyticsEventName,
    properties?: Record<string, unknown>,
    options?: { includeReferrer?: boolean },
) => void; }

interface IUseBrowserInstallHintOptions {
    analytics: IBrowserInstallHintAnalytics;
    isBrowserRuntime: Ref<boolean>;
}

export const useBrowserInstallHint = (options: IUseBrowserInstallHintOptions) => {
    const runtimeConfig = useRuntimeConfig();
    const browserInstallHintDismissed = useStorage(
        BROWSER_INSTALL_HINT_STORAGE_KEY,
        false,
        getLocalStorageForVueUse(),
    );
    const isBrowserInstallHintClientReady = ref(false);
    const didTrackViewerSession = useState(
        'analytics:viewer-session-started',
        () => false,
    );
    const didTrackInstallHintShown = useState(
        'analytics:install-hint-shown',
        () => false,
    );
    const browserInstallUrl = computed(() => {
        if (!options.isBrowserRuntime.value) {
            return undefined;
        }

        const url = typeof runtimeConfig.public.landingUrl === 'string'
            ? runtimeConfig.public.landingUrl.trim()
            : '';
        return url || undefined;
    });
    const showBrowserInstallHint = computed(() => (
        options.isBrowserRuntime.value
        && isBrowserInstallHintClientReady.value
        && Boolean(browserInstallUrl.value)
        && !browserInstallHintDismissed.value
    ));

    function getBrowserInstallHost() {
        if (!browserInstallUrl.value) {
            return null;
        }

        try {
            return new URL(browserInstallUrl.value).host;
        } catch {
            return null;
        }
    }

    function trackBrowserInstallHint(action: 'shown' | 'clicked' | 'dismissed' | 'auto_dismissed') {
        options.analytics.track('browser_install_hint_interacted', {
            action,
            destinationHost: getBrowserInstallHost(),
        });
    }

    function handleBrowserInstallHintClick() {
        trackBrowserInstallHint('clicked');
    }

    function dismissBrowserInstallHint(reason: 'manual' | 'auto' = 'manual') {
        if (browserInstallHintDismissed.value) {
            return;
        }

        trackBrowserInstallHint(reason === 'auto' ? 'auto_dismissed' : 'dismissed');

        if (typeof window === 'undefined' || !options.isBrowserRuntime.value) {
            return;
        }

        browserInstallHintDismissed.value = true;
    }

    const { start: startBrowserInstallHintAutoDismiss } = useTimeoutFn(
        () => dismissBrowserInstallHint('auto'),
        BROWSER_INSTALL_HINT_AUTO_DISMISS_MS,
        { immediate: false },
    );

    onMounted(() => {
        if (migrateLegacyBrowserInstallHintCookie()) {
            browserInstallHintDismissed.value = true;
        }
        isBrowserInstallHintClientReady.value = true;

        if (options.isBrowserRuntime.value && !didTrackViewerSession.value) {
            didTrackViewerSession.value = true;
            options.analytics.track('viewer_session_started', {
                installHintVisible: showBrowserInstallHint.value,
                installHintDestinationHost: getBrowserInstallHost(),
            }, { includeReferrer: true });
        }

        if (!options.isBrowserRuntime.value || browserInstallHintDismissed.value) {
            return;
        }

        startBrowserInstallHintAutoDismiss();
    });

    watch(showBrowserInstallHint, (isVisible) => {
        if (!options.isBrowserRuntime.value || !isVisible || didTrackInstallHintShown.value) {
            return;
        }

        didTrackInstallHintShown.value = true;
        trackBrowserInstallHint('shown');
    }, { immediate: true });

    return {
        browserInstallUrl,
        dismissBrowserInstallHint,
        handleBrowserInstallHintClick,
        showBrowserInstallHint,
    };
};
