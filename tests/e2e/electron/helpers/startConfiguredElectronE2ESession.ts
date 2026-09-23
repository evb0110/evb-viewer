import type {TPerformanceMode} from '@contracts/hostResourceProfile';
import {DEFAULT_SETTINGS} from '@contracts/settings';
import {
    BROWSER_SETTINGS_COOKIE_KEY,
    serializeBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import {
    stabilizeSharedRendererClient,
    startElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';

// The emulation lives on the page's own session so it survives the reload
// below; one set on a separate CDP session ends when that session detaches.
async function setReducedMotionPreference(page: Parameters<typeof stabilizeSharedRendererClient>[0]) {
    await page.emulateMediaFeatures([{
        name: 'prefers-reduced-motion',
        value: 'no-preference',
    }]);
}

export async function startConfiguredElectronE2ESession(
    baseName: string,
    performanceMode: TPerformanceMode,
    extraEnv: Record<string, string> = {},
) {
    // The env override drives the main-process profile; the settings cookie
    // drives the renderer fallback used by harness-adopted windows that carry
    // no host-profile launch argument.
    const session = await startElectronE2ESession(baseName, {
        clean: true,
        extraEnv: {
            ...extraEnv,
            EVB_E2E_FORCE_NO_REDUCED_MOTION: '1',
            EVB_TEST_PERFORMANCE_MODE: performanceMode,
        },
    });
    await session.page.evaluate((payload: {
        cookieKey: string;
        settingsPayload: string;
    }) => {
        document.cookie = `${payload.cookieKey}=${encodeURIComponent(payload.settingsPayload)}; path=/`;
    }, {
        cookieKey: BROWSER_SETTINGS_COOKIE_KEY,
        settingsPayload: serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            performanceMode,
        }),
    });
    // Apply the neutral media baseline before the configured reload. The
    // performance-profile plugin reads matchMedia during module startup, so
    // changing the emulation after reload leaves the initial root class stale
    // on runners whose host preferences request reduced motion.
    await setReducedMotionPreference(session.page);
    await session.page.reload({waitUntil: 'domcontentloaded'});
    await stabilizeSharedRendererClient(session.page);
    return session;
}
