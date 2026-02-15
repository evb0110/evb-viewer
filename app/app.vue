<template>
    <UApp>
        <NuxtPage />
    </UApp>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { BrowserLogger } from '@app/utils/browser-logger';
import { hasElectronAPI } from '@app/utils/electron';

const {
    load: loadSettings,
    settings,
} = useSettings();
const { setLocale } = useTypedI18n();
const colorMode = useColorMode();

if (import.meta.dev) {
    BrowserLogger.debug('setup', 'app.vue script setup executed');
}

onMounted(async () => {
    const mountTime = Date.now();
    if (import.meta.dev) {
        BrowserLogger.debug('health-check', 'App hydrated and ready', {
            timestamp: mountTime,
            windowReady: typeof window !== 'undefined',
            electronAPI: hasElectronAPI(),
        });
        BrowserLogger.debug('health-check', 'window.__openFileDirect', typeof window.__openFileDirect);
    }

    // Load persisted settings and apply locale + theme
    await loadSettings();
    if (settings.value.locale) {
        await setLocale(settings.value.locale);
    }
    if (settings.value.theme) {
        colorMode.preference = settings.value.theme;
    }

    // Expose for testing (set after hydration/mount, not during module evaluation).
    if (typeof window !== 'undefined') {
        (window as Window & {
            __appReady?: boolean;
            __appReadyAt?: number
        }).__appReady = true;
        (window as Window & {
            __appReady?: boolean;
            __appReadyAt?: number
        }).__appReadyAt = mountTime;
        if (import.meta.dev) {
            BrowserLogger.debug('setup', 'App mounted, __appReady set at', mountTime);
        }
    }
});
</script>
