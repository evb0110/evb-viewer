<template>
    <AppShellRoot v-if="hasDesktopBridge" />
</template>

<script setup lang="ts">
import { AppShellRoot } from '@app/modules/workspace-shell/public/component-exports/appShellRoot';
import {
    isElectronUserAgent,
    waitForDesktopPlatformBridge,
} from '@app/utils/platform';
import { getOrCaptureRendererBootstrapFailure } from '@app/utils/getOrCaptureRendererBootstrapFailure';

const { t } = useTypedI18n();
const { setFatalRuntimeError } = useFatalRuntimeError();
const hasDesktopBridge = ref(false);
const isDesktopRuntime = useState('runtime:is-desktop', () => true);

definePageMeta({ preloadWorkspaceShell: false });
if (import.meta.server) useSeoMeta({ robots: 'noindex, nofollow' });
useHead(() => ({ title: t('app.title') }));

onMounted(async () => {
    isDesktopRuntime.value = true;
    const bridgeAvailable = await waitForDesktopPlatformBridge({ shouldWait: true });

    if (!bridgeAvailable) {
        if (isElectronUserAgent()) {
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

        isDesktopRuntime.value = false;
        await navigateTo('/', { replace: true });
        return;
    }

    hasDesktopBridge.value = true;
});
</script>
