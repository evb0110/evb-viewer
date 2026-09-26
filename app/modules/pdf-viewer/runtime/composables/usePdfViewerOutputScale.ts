import type { IPdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';

function readWindowOutputScale(outputScaleFloor: number) {
    return typeof window !== 'undefined'
        ? Math.max(outputScaleFloor, window.devicePixelRatio || 1)
        : outputScaleFloor;
}

export const usePdfViewerOutputScale = (performancePolicy: IPdfRenderPerformancePolicy) => {
    const outputScale = ref(readWindowOutputScale(performancePolicy.outputScaleFloor));
    let mediaQuery: MediaQueryList | null = null;

    function removeMediaListener() {
        if (!mediaQuery) {
            return;
        }

        mediaQuery.removeEventListener('change', updateOutputScale);
        mediaQuery = null;
    }

    function installMediaListener() {
        removeMediaListener();
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return;
        }

        mediaQuery = window.matchMedia(`(resolution: ${outputScale.value}dppx)`);
        mediaQuery.addEventListener('change', updateOutputScale);
    }

    function updateOutputScale() {
        const nextScale = readWindowOutputScale(performancePolicy.outputScaleFloor);
        if (outputScale.value === nextScale) {
            return;
        }

        outputScale.value = nextScale;
        installMediaListener();
    }

    if (typeof window !== 'undefined') {
        installMediaListener();
        window.addEventListener('resize', updateOutputScale);
    }

    onScopeDispose(() => {
        removeMediaListener();
        if (typeof window !== 'undefined') {
            window.removeEventListener('resize', updateOutputScale);
        }
    });

    return outputScale;
};
