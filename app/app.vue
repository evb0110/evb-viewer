<template>
    <UApp>
        <NuxtPage />
    </UApp>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';

console.log('[SETUP] app.vue script setup executed');

onMounted(() => {
    console.log('[HEALTH CHECK] App hydrated and ready');
    console.log('[HEALTH CHECK] window.__openFileDirect:', typeof window.__openFileDirect);

    // Expose for testing (set after hydration/mount, not during module evaluation).
    if (typeof window !== 'undefined') {
        (window as Window & { __appReady?: boolean }).__appReady = true;
        console.log('[SETUP] App mounted, __appReady set');
    }
});
</script>
