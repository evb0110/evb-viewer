import type {IPerformanceProfile} from '@app/utils/performanceProfile';

export type TPdfZoomGestureRasterMode = 'eager' | 'idle-once';
export type TPdfClampedVisibleRefineMode = 'immediate' | 'input-idle';

export interface IPdfRenderPerformancePolicy {
    readonly zoomGestureRasterMode: TPdfZoomGestureRasterMode;
    readonly outputScaleFloor: number;
    readonly clampedVisibleRefineMode: TPdfClampedVisibleRefineMode;
    readonly navigationAnchorRadius: number;
    readonly layoutPendingRadius: number;
}

const CONSTRAINED_PDF_RENDER_PERFORMANCE_POLICY = {
    zoomGestureRasterMode: 'idle-once',
    outputScaleFloor: 1,
    clampedVisibleRefineMode: 'input-idle',
    navigationAnchorRadius: 8,
    layoutPendingRadius: 12,
} as const satisfies IPdfRenderPerformancePolicy;

const NORMAL_PDF_RENDER_PERFORMANCE_POLICY = {
    zoomGestureRasterMode: 'eager',
    outputScaleFloor: 2,
    clampedVisibleRefineMode: 'immediate',
    navigationAnchorRadius: 18,
    layoutPendingRadius: 30,
} as const satisfies IPdfRenderPerformancePolicy;

export function resolvePdfRenderPerformancePolicy(profile: Pick<IPerformanceProfile, 'lowCpu' | 'lowMemory'>): IPdfRenderPerformancePolicy {
    const constrained = profile.lowCpu || profile.lowMemory;
    return constrained ? CONSTRAINED_PDF_RENDER_PERFORMANCE_POLICY : NORMAL_PDF_RENDER_PERFORMANCE_POLICY;
}
