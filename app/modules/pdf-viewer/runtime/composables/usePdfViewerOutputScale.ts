import type { IPdfRenderPerformancePolicy } from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import { useWindowDevicePixelRatio } from '@app/composables/useWindowDevicePixelRatio';

export const usePdfViewerOutputScale = (performancePolicy: IPdfRenderPerformancePolicy) => {
    const pixelRatio = useWindowDevicePixelRatio();
    return computed(() => Math.max(performancePolicy.outputScaleFloor, pixelRatio.value));
};
