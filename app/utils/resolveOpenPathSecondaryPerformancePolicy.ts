import type { IPerformanceProfile } from '@app/utils/performanceProfile';

export type TInactiveDjvuLeasePolicy = 'warm-grace' | 'release-immediately';

export interface IOpenPathSecondaryPerformancePolicy {
    eagerAnnotationNameReadMaxBytes: number;
    interactiveAnnotationNameReadMaxBytes: number;
    maxInMemoryPdfBytes: number;
    maxDjvuJsDesktopSourceBytes: number;
    deferMediumHistoryBaseline: boolean;
    inactiveDjvuLeasePolicy: TInactiveDjvuLeasePolicy;
}

const MEBIBYTE = 1024 * 1024;

const NORMAL_OPEN_PATH_SECONDARY_PERFORMANCE_POLICY = {
    eagerAnnotationNameReadMaxBytes: 16 * MEBIBYTE,
    interactiveAnnotationNameReadMaxBytes: 64 * MEBIBYTE,
    maxInMemoryPdfBytes: 16 * MEBIBYTE,
    maxDjvuJsDesktopSourceBytes: 96 * MEBIBYTE,
    deferMediumHistoryBaseline: false,
    inactiveDjvuLeasePolicy: 'warm-grace',
} as const satisfies IOpenPathSecondaryPerformancePolicy;

export function resolveOpenPathSecondaryPerformancePolicy(
    profile: IPerformanceProfile,
): IOpenPathSecondaryPerformancePolicy {
    return {
        eagerAnnotationNameReadMaxBytes: profile.lowCpu || profile.lowMemory
            ? 4 * MEBIBYTE
            : NORMAL_OPEN_PATH_SECONDARY_PERFORMANCE_POLICY.eagerAnnotationNameReadMaxBytes,
        interactiveAnnotationNameReadMaxBytes: profile.lowCpu || profile.lowMemory
            ? 16 * MEBIBYTE
            : NORMAL_OPEN_PATH_SECONDARY_PERFORMANCE_POLICY.interactiveAnnotationNameReadMaxBytes,
        maxInMemoryPdfBytes: profile.lowMemory
            ? 4 * MEBIBYTE
            : NORMAL_OPEN_PATH_SECONDARY_PERFORMANCE_POLICY.maxInMemoryPdfBytes,
        maxDjvuJsDesktopSourceBytes: profile.lowMemory
            ? 24 * MEBIBYTE
            : NORMAL_OPEN_PATH_SECONDARY_PERFORMANCE_POLICY.maxDjvuJsDesktopSourceBytes,
        deferMediumHistoryBaseline: profile.lowMemory,
        inactiveDjvuLeasePolicy: profile.lowMemory
            ? 'release-immediately'
            : NORMAL_OPEN_PATH_SECONDARY_PERFORMANCE_POLICY.inactiveDjvuLeasePolicy,
    };
}
