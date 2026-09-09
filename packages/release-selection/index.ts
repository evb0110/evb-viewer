export {
    buildClientProfile,
    detectArchitecture,
    detectPlatform,
    compareInstallersForSelect,
    formatArch,
    formatExtension,
    formatFileSize,
    formatInstallerArchLabel,
    formatInstallerLabel,
    formatInstallerMeta,
    formatInstallerVariantLabel,
    formatPlatform,
    getAssetExtension,
    INSTALLER_PLATFORM_ORDER,
    isInstallerAsset,
    isLegacyInstallerAsset,
    normalizeInstallers,
    parseArchitectureHint,
    parsePlatformHint,
    parseUserAgent,
    recommendInstaller,
    selectPreferredInstallers,
} from '@releaseSelection/releaseSelection';

export type {
    ILatestReleaseResponse,
    IReleaseInstaller,
    IReleaseSummary,
    IUserAgentProfile,
    TReleaseArch,
    TReleasePlatform,
} from '@contracts/release';

export {
    createReleaseCatalogLoader,
    fetchReleaseDataWithRetry,
    getReleaseFetchStatusCode,
    getMissingConfiguredReleaseTags,
    parseRetryAfterMs,
    shouldRetryReleaseFetch,
} from '@releaseSelection/latestReleaseRetry';

export {
    normalizeCanaryPercent,
    parseReleaseTagList,
    selectReleaseForRollout,
} from '@releaseSelection/releaseRolloutPolicy';
export type {
    IReleaseRolloutPolicy, IRolloutRelease,
} from '@releaseSelection/releaseRolloutPolicy';
