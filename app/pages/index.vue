<template>
    <AppShellRoot />
</template>

<script setup lang="ts">
import { AppShellRoot } from '@app/modules/workspace-shell/public/component-exports/appShellRoot';
import { resolveInitialDesktopRuntime } from '@app/utils/platform';
import { useWebSeo } from '@app/composables/useWebSeo';

const route = useRoute();

definePageMeta({keepalive: true});
useWebSeo();

if (import.meta.client && resolveInitialDesktopRuntime(route.path)) {
    await navigateTo('/electron', { replace: true });
}
</script>
