import {useRuntimeEnvironment} from '@app/composables/useRuntimeEnvironment';
import {canUseBrowserOcr} from '@app/utils/browserOcrSupport';

/**
 * Whether the workspace offers OCR: always on desktop, and in the browser
 * when it can run the WebAssembly engine. Read after mount, since the server
 * render cannot test the browser.
 */
export const useCanUseOcr = () => {
    const {isDesktopRuntime} = useRuntimeEnvironment();
    const browserCanRunOcr = ref(false);
    onMounted(() => {
        browserCanRunOcr.value = canUseBrowserOcr();
    });
    return computed(() => isDesktopRuntime.value || browserCanRunOcr.value);
};
