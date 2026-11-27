import {hasElectronAPI, shouldPreferDesktopPlatform} from '@app/utils/platform';
import {logicNot} from '@vueuse/math';

export const useRuntimeEnvironment = () => {
    const route = useRoute();
    // The preload bridge is the one discovered fact: the server and the
    // hydrating client start without it, and a mounted consumer records it.
    const hasDesktopBridge =
        typeof useState === 'function' ? useState('runtime:has-desktop-bridge', hasElectronAPI) : ref(hasElectronAPI());
    if (getCurrentInstance()) {
        onMounted(() => {
            hasDesktopBridge.value = hasElectronAPI();
        });
    }
    const isDesktopRuntime = computed(() => shouldPreferDesktopPlatform(route.path, false, hasDesktopBridge.value));

    return {
        isDesktopRuntime,
        isBrowserRuntime: logicNot(isDesktopRuntime),
    };
};
