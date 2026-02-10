<template>
    <UApp>
        <NuxtPage />
    </UApp>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import type { TI18nComposer } from '@app/types/i18n';

const {
    load: loadSettings,
    settings,
} = useSettings();
const { setLocale } = useI18n() as TI18nComposer;
const colorMode = useColorMode();

console.log('[SETUP] app.vue script setup executed');

onMounted(async () => {
    const mountTime = Date.now();
    console.log('[HEALTH CHECK] App hydrated and ready', {
        timestamp: mountTime,
        windowReady: typeof window !== 'undefined',
        electronAPI: typeof window.electronAPI !== 'undefined',
    });
    console.log('[HEALTH CHECK] window.__openFileDirect:', typeof window.__openFileDirect);

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
        console.log('[SETUP] App mounted, __appReady set at', mountTime);
    }
});
</script>
