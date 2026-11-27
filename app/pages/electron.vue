<template>
    <AppShellRoot v-if="hasDesktopBridge" />
</template>

<script setup lang="ts">
import {AppShellRoot} from '@app/modules/workspace-shell/public/component-exports/appShellRoot';
import {hasElectronPlatformBridge} from '@app/utils/electronPlatformBridge';
import {getOrCaptureRendererBootstrapFailure} from '@app/utils/getOrCaptureRendererBootstrapFailure';

const {t} = useTypedI18n();
const {setFatalRuntimeError} = useFatalRuntimeError();
const hasDesktopBridge = ref(false);

definePageMeta({
    preloadWorkspaceShell: false,
    keepalive: true,
});
if (import.meta.server) {
    useSeoMeta({robots: 'noindex, nofollow'});
}
useHead(() => ({title: t('app.title')}));

onMounted(() => {
    if (!hasElectronPlatformBridge()) {
        const presentation = getOrCaptureRendererBootstrapFailure({
            error: new Error('Electron preload bridge is unavailable during app bootstrap.'),
            key: 'electron-preload-bridge',
            message: 'App bootstrap failed',
            section: 'loader',
            title: t('errors.runtime.title'),
        });
        setFatalRuntimeError('startup', presentation);
        return;
    }

    hasDesktopBridge.value = true;
});
</script>
