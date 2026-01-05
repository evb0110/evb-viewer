<template>
    <UApp>
        <NuxtPage />
    </UApp>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';

onMounted(() => {
    console.log('[HEALTH CHECK] App hydrated and ready');
    console.log('[HEALTH CHECK] window.__openFileDirect:', typeof window.__openFileDirect);
});
</script>
