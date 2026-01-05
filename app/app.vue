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
});

// Expose for testing
if (typeof window !== 'undefined') {
    (window as any).__appReady = true;
    console.log('[SETUP] App setup complete, __appReady set');
}
</script>
