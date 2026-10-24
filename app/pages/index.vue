<template>
    <AppShellRoot />
</template>

<script setup lang="ts">
import { AppShellRoot } from '@app/modules/workspace-shell/public/component-exports/appShellRoot';
import { resolveInitialDesktopRuntime } from '@app/utils/platform';
import { useWebSeo } from '@app/composables/useWebSeo';
import { RECENT_FILES_PREPAINT_SCRIPT } from '@app/utils/recentFilesPrepaintScript';

const route = useRoute();

definePageMeta({keepalive: true});
useWebSeo();

if (import.meta.client && resolveInitialDesktopRuntime(route.path)) {
    await navigateTo('/electron', { replace: true });
} else {
    // The prerendered workspace's first paint; Electron's CSP admits only the
    // inline scripts of its built shell, and it reads Recent Files from main.
    useHead({script: [{
        key: 'recent-files-prepaint',
        innerHTML: RECENT_FILES_PREPAINT_SCRIPT,
        tagPosition: 'head',
    }]});
}
</script>
