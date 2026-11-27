import type {IScanCleanupOptions, IScanCleanupPageOverride, TScanCleanupOutputMode} from '@contracts/scan-cleanup/domain';

export interface IResolveScanCleanupEffectiveOutputModeInput {
    options: Pick<IScanCleanupOptions, 'outputMode' | 'preserveOriginalQuality'>;
    pageOverride: Pick<IScanCleanupPageOverride, 'outputModeOverride'>;
    /**
     * The settled per-page decision produced by document detection. This is
     * deliberately not called a fallback: when Auto is configured, it is the
     * decision preview and final rendering must share.
     */
    detectedOutputMode?: TScanCleanupOutputMode | undefined;
    /**
     * The concrete mode reported by a render that had to resolve Auto itself
     * before detection was available.
     */
    renderedOutputMode?: TScanCleanupOutputMode | undefined;
}

/**
 * The only precedence order for deciding what pixels a scan-cleanup page uses.
 *
 * `undefined` is meaningful: Auto has not been resolved yet. Callers must keep
 * showing the source raster or let native resolve Auto; they must never turn
 * that state into an implicit B&W render.
 */
export function resolveScanCleanupEffectiveOutputMode({
    options,
    pageOverride,
    detectedOutputMode,
    renderedOutputMode,
}: IResolveScanCleanupEffectiveOutputModeInput): TScanCleanupOutputMode | undefined {
    if (options.preserveOriginalQuality) {
        return 'color';
    }
    if (pageOverride.outputModeOverride !== undefined) {
        return pageOverride.outputModeOverride;
    }
    if (options.outputMode !== 'auto') {
        return options.outputMode;
    }
    return detectedOutputMode ?? renderedOutputMode;
}
