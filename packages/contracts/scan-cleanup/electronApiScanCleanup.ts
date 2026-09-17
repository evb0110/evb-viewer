export type * from '@contracts/scan-cleanup/domain';
export type * from '@contracts/scan-cleanup/geometry';
export type * from '@contracts/scan-cleanup/ipc';
export type * from '@contracts/scan-cleanup/progress';
export type * from '@contracts/scan-cleanup/nativeProtocolV3';
export type * from '@contracts/scan-cleanup/outputMode';
export type {IScanCleanupCapability} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
export {resolveScanCleanupEffectiveOutputMode} from '@contracts/scan-cleanup/outputMode';
export {
    isScanCleanupErrorEnvelope,
    SCAN_CLEANUP_ERROR_CODES,
} from '@contracts/scan-cleanup/ipc';
export {SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION} from '@contracts/scan-cleanup/nativeProtocolV3';
export {SCAN_CLEANUP_MARGIN_MAX_MM} from '@contracts/scan-cleanup/geometry';
export {
    SCAN_CLEANUP_INPUT_MAX_ID_BYTES,
    SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES,
    SCAN_CLEANUP_INPUT_MAX_PAGE_NUMBER,
    SCAN_CLEANUP_INPUT_MAX_PATH_BYTES,
    SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES,
    SCAN_CLEANUP_INPUT_MAX_VERTICES,
    SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON,
    SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_PAGE,
    SCAN_CLEANUP_INPUT_MAX_ZONES,
    SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE,
    SCAN_CLEANUP_LEGACY_STORAGE_MAX_BYTES,
} from '@contracts/scan-cleanup/inputLimits';
export {
    SCAN_CLEANUP_ALIGNMENTS,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MAX,
    SCAN_CLEANUP_AUTO_DEWARP_DEPTH_MIN,
    SCAN_CLEANUP_MANUAL_SKEW_MAX_DEGREES,
    SCAN_CLEANUP_MANUAL_SKEW_MIN_DEGREES,
} from '@contracts/scan-cleanup/domain';
