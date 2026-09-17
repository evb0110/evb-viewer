import type {IScanCleanupPreviewResult} from '@contracts/scan-cleanup/ipc';
import {
    SCAN_CLEANUP_OUTPUT_MODES,
    SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS,
    type TScanCleanupOutputModeRecommendationReason,
} from '@contracts/scan-cleanup/domain';

export function isScanCleanupOutputMode(
    value: unknown,
): value is NonNullable<IScanCleanupPreviewResult['pageMetadata']['recommendedOutputMode']> {
    return SCAN_CLEANUP_OUTPUT_MODES.some(mode => mode === value);
}

export function isScanCleanupOutputModeRecommendationReason(
    value: unknown,
): value is TScanCleanupOutputModeRecommendationReason {
    return SCAN_CLEANUP_OUTPUT_MODE_RECOMMENDATION_REASONS.some(reason => reason === value);
}
