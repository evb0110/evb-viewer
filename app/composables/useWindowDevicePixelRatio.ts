function readWindowDevicePixelRatio() {
    return typeof window !== 'undefined'
        ? window.devicePixelRatio || 1
        : 1;
}

export const useWindowDevicePixelRatio = () => {
    const pixelRatio = ref(readWindowDevicePixelRatio());
    let mediaQuery: MediaQueryList | null = null;

    function removeMediaListener() {
        if (!mediaQuery) {
            return;
        }

        mediaQuery.removeEventListener('change', updatePixelRatio);
        mediaQuery = null;
    }

    function installMediaListener() {
        removeMediaListener();
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return;
        }

        mediaQuery = window.matchMedia(`(resolution: ${pixelRatio.value}dppx)`);
        mediaQuery.addEventListener('change', updatePixelRatio);
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
        window.addEventListener('resize', updatePixelRatio);
    }

    onScopeDispose(() => {
        removeMediaListener();
        if (typeof window !== 'undefined') {
            window.removeEventListener('resize', updatePixelRatio);
        }
    });

    return pixelRatio;
};
