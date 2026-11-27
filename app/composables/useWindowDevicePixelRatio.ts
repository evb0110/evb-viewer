import {useEventListener} from '@vueuse/core';

function readWindowDevicePixelRatio() {
    return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

export const useWindowDevicePixelRatio = () => {
    const pixelRatio = ref(readWindowDevicePixelRatio());
    let stopMediaListener: (() => void) | null = null;

    function installMediaListener() {
        stopMediaListener?.();
        stopMediaListener = null;
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return;
        }

        const mediaQuery = window.matchMedia(`(resolution: ${pixelRatio.value}dppx)`);
        stopMediaListener = useEventListener(mediaQuery, 'change', updatePixelRatio);
    }

    function updatePixelRatio() {
        const nextScale = readWindowDevicePixelRatio();
        if (pixelRatio.value === nextScale) {
            return;
        }

        pixelRatio.value = nextScale;
        installMediaListener();
    }

    if (typeof window !== 'undefined') {
        installMediaListener();
        useEventListener(window, 'resize', updatePixelRatio);
    }

    onScopeDispose(() => {
        stopMediaListener?.();
        stopMediaListener = null;
    });

    return pixelRatio;
};
