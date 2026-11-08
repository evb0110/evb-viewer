<template>
    <AppShellRoot />
</template>

<script setup lang="ts">
import { AppShellRoot } from '@app/modules/workspace-shell/public/component-exports/appShellRoot';
import { isBrowserExtensionPage } from '@app/utils/isBrowserExtensionPage';
import { resolveInitialDesktopRuntime } from '@app/utils/platform';
import { useWebSeo } from '@app/composables/useWebSeo';
import { RECENT_FILES_PREPAINT_SCRIPT } from '@app/utils/recentFilesPrepaintScript';

const route = useRoute();

definePageMeta({keepalive: true});
// The extension's page is not a web page anyone finds or shares.
if (!isBrowserExtensionPage()) useWebSeo();

if (import.meta.client && resolveInitialDesktopRuntime(route.path)) {
    await navigateTo('/electron', { replace: true });
} else if (!isBrowserExtensionPage()) {
    // The prerendered workspace's first paint; Electron's CSP admits only the
    // inline scripts of its built shell, and it reads Recent Files from main.
    // The extension's page is not prerendered and runs no inline script.
    useHead({script: [{
        key: 'recent-files-prepaint',
        innerHTML: RECENT_FILES_PREPAINT_SCRIPT,
        tagPosition: 'head',
    }]});
}
</script>
