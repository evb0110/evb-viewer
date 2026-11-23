import { getRawElectronPlatformApi } from '@app/utils/electronPlatformBridge';
import { readBrowserPerformanceModeSnapshot } from '@app/utils/browserSettingsPersistence';
import {
    HOST_TIER_HIGH_CPU_MIN,
    HOST_TIER_LOW_CPU_MAX,
    HOST_TIER_LOW_RAM_MAX_GIB,
    resolveDetectedHostResourceTier,
    usesSoftwareCanvasRendering,
    type IHostGpuStatusSnapshot,
    type THostResourceTier,
    type TPerformanceMode,
} from '@contracts/hostResourceProfile';

export const PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER = 2 ** 24;
export const PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT = 2 ** 25;
export const PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY = 2 ** 26;
export const PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION = 2 ** 27;
const PDF_BUFFER_PAGES_DEFAULT = 2;
export const PDF_BUFFER_PAGES_WORKSTATION = 4;
const PDF_BUFFER_PAGES_LOW_MEMORY = 1;
export const PDF_RENDER_CONCURRENCY_DEFAULT = 3;
export const PDF_RENDER_CONCURRENCY_LOW_CPU = 1;
const PDF_RENDER_CONCURRENCY_WORKSTATION_MAX = 6;
export const PDF_PAGE_PROXY_CACHE_DEFAULT = 48;
export const PDF_PAGE_PROXY_CACHE_WORKSTATION = 96;
export const PDF_PAGE_PROXY_CACHE_LOW_MEMORY = 16;
export const PDF_THUMBNAIL_CONCURRENCY_DEFAULT = 2;
export const PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE = 1;
export const PDF_THUMBNAIL_CONCURRENCY_WORKSTATION = 4;
export const PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT = 16_777_216;
export const PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY = 8_388_608;
export const PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION = 33_554_432;
// iOS and Android kill a browser tab far below desktop limits (iOS Jetsam), and
// a mobile browser reports no RAM to scale from.
export const MOBILE_RASTER_BUDGET_MAX_BYTES = 384 * 1024 ** 2;
// Required visible rasters are admitted over the budget, so the per-page canvas
// keeps two side-by-side visible RGBA pages inside the mobile ceiling.
const MOBILE_MAX_CANVAS_PIXELS = MOBILE_RASTER_BUDGET_MAX_BYTES / (2 * 4);

interface IPerformanceProfileNavigator extends Navigator {deviceMemory?: number;}

export interface IPerformanceProfileEnvironment {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    totalMemoryBytes?: number;
    gpuStatus?: IHostGpuStatusSnapshot;
    tier?: THostResourceTier;
    performanceMode?: TPerformanceMode;
    mobile?: boolean;
}

export interface IPerformanceProfile {
    performanceMode: TPerformanceMode;
    tier: THostResourceTier;
    /** A phone or tablet browser, whose tab the OS kills well below desktop memory limits. */
    mobile: boolean;
    lowMemory: boolean;
    lowCpu: boolean;
    pdfBufferPages: number;
    concurrentPdfRenders: number;
    maxCachedPdfPages: number;
    thumbnailBaseConcurrency: number;
    settledMaxCanvasPixels: number;
    maxBufferCanvasPixels: number;
}

let cachedPerformanceProfile: IPerformanceProfile | null = null;

function readNavigatorPerformanceEnvironment(): IPerformanceProfileEnvironment {
    // Only the desktop host reports hardware; the hosted build reads navigator.
    const resourceProfile = getRawElectronPlatformApi()?.host.getResourceProfile() ?? null;
    if (resourceProfile) {
        return {
            hardwareConcurrency: resourceProfile.logicalCpus,
            totalMemoryBytes: resourceProfile.totalRamBytes,
            ...(resourceProfile.gpuStatus === undefined ? {} : {gpuStatus: resourceProfile.gpuStatus}),
            tier: resourceProfile.tier,
            performanceMode: resourceProfile.performanceMode,
        };
    }

    const performanceMode = readBrowserPerformanceModeSnapshot();
    // Node also defines navigator, so server rendering would read its own CPUs.
    if (typeof window === 'undefined' || typeof document === 'undefined' || typeof navigator === 'undefined') {
        return { performanceMode };
    }

    const runtimeNavigator = navigator as IPerformanceProfileNavigator;
    const userAgent = runtimeNavigator.userAgent;
    const environment: IPerformanceProfileEnvironment = {
        performanceMode,
        // iPadOS Safari reports a Macintosh user agent; touch input tells it apart.
        mobile: /Android|iPhone|iPad|iPod|Mobi/u.test(userAgent)
            || (/Macintosh/u.test(userAgent) && runtimeNavigator.maxTouchPoints > 1),
    };
    if (typeof runtimeNavigator.deviceMemory === 'number') {
        environment.deviceMemory = runtimeNavigator.deviceMemory;
    }
    if (typeof runtimeNavigator.hardwareConcurrency === 'number') {
        environment.hardwareConcurrency = runtimeNavigator.hardwareConcurrency;
    }
    const memoryInfo = getRawElectronPlatformApi()?.system.getMemoryInfo() ?? null;
    if (typeof memoryInfo?.totalBytes === 'number') {
        environment.totalMemoryBytes = memoryInfo.totalBytes;
    }

    return environment;
}

function normalizePositiveNumber(value: number | undefined) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : null;
}

// The `workstation` super-profile (high tier + >=32 GiB + >=12 CPU) is a
// renderer-only PDF-canvas refinement: it widens render/prefetch/proxy budgets
// on genuinely large desktops. It is intentionally NOT a `THostResourceTier`
// case — the canonical host classifier stops at low/medium/high — so it must
// never be treated as a missing tier branch elsewhere in the codebase.
function resolveWorkstationProfile(
    tier: THostResourceTier,
    hardwareConcurrency: number | null,
    totalMemoryGiB: number | null,
) {
    return tier === 'high'
        && totalMemoryGiB !== null
        && totalMemoryGiB >= 32
        && hardwareConcurrency !== null
        && hardwareConcurrency >= 12;
}

function resolveCanonicalPerformanceProfile(
    tier: THostResourceTier,
    hardwareConcurrency: number | null,
    totalMemoryGiB: number | null,
    performanceMode: TPerformanceMode,
    mobile: boolean,
): IPerformanceProfile {
    const workstationProfile = resolveWorkstationProfile(
        tier,
        hardwareConcurrency,
        totalMemoryGiB,
    );
    const lowTier = tier === 'low';
    const canvasPixelCeiling = mobile ? MOBILE_MAX_CANVAS_PIXELS : Number.POSITIVE_INFINITY;

    return {
        performanceMode,
        tier,
        mobile,
        lowMemory: lowTier,
        lowCpu: lowTier,
        pdfBufferPages: workstationProfile
            ? PDF_BUFFER_PAGES_WORKSTATION
            : lowTier
                ? PDF_BUFFER_PAGES_LOW_MEMORY
                : PDF_BUFFER_PAGES_DEFAULT,
        concurrentPdfRenders: workstationProfile
            ? Math.min(
                PDF_RENDER_CONCURRENCY_WORKSTATION_MAX,
                Math.max(
                    PDF_RENDER_CONCURRENCY_DEFAULT + 1,
                    Math.floor((hardwareConcurrency ?? 0) / 4),
                ),
            )
            : lowTier
                ? PDF_RENDER_CONCURRENCY_LOW_CPU
                : PDF_RENDER_CONCURRENCY_DEFAULT,
        maxCachedPdfPages: workstationProfile
            ? PDF_PAGE_PROXY_CACHE_WORKSTATION
            : lowTier
                ? PDF_PAGE_PROXY_CACHE_LOW_MEMORY
                : PDF_PAGE_PROXY_CACHE_DEFAULT,
        thumbnailBaseConcurrency: workstationProfile
            ? PDF_THUMBNAIL_CONCURRENCY_WORKSTATION
            : lowTier
                ? PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE
                : PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
        settledMaxCanvasPixels: Math.min(canvasPixelCeiling, workstationProfile
            ? PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION
            : tier === 'high'
                ? PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY
                : lowTier
                    ? PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER
                    : PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT),
        maxBufferCanvasPixels: Math.min(canvasPixelCeiling, workstationProfile
            ? PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION
            : lowTier
                ? PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY
                : PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT),
    };
}

function applySoftwareCanvasConstraint(
    profile: IPerformanceProfile,
    gpuStatus: IHostGpuStatusSnapshot | undefined,
): IPerformanceProfile {
    if (!usesSoftwareCanvasRendering(gpuStatus)) {
        return profile;
    }
    return {
        ...profile,
        lowCpu: true,
        concurrentPdfRenders: PDF_RENDER_CONCURRENCY_LOW_CPU,
        thumbnailBaseConcurrency: PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE,
        // Software rasterization pays for every deep-zoom pixel on the CPU, so the
        // settled canvas keeps the low-tier cap regardless of installed RAM.
        settledMaxCanvasPixels: Math.min(
            profile.settledMaxCanvasPixels,
            PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER,
        ),
    };
}

/**
 * The tier `auto` detects. Host RAM goes through the shared host classifier.
 * A browser reports no RAM: Safari and Firefox omit `navigator.deviceMemory`
 * and Chrome caps it at 8, so the browser is low only on evidence of a small
 * device, high only when Chrome's top memory bucket meets a high CPU count,
 * and medium otherwise.
 */
function resolveDetectedTier(
    environment: IPerformanceProfileEnvironment,
    hardwareConcurrency: number | null,
    totalMemoryBytes: number | null,
): THostResourceTier {
    if (totalMemoryBytes !== null) {
        return resolveDetectedHostResourceTier({
            logicalCpus: hardwareConcurrency ?? 0,
            totalRamBytes: totalMemoryBytes,
        });
    }
    const deviceMemory = normalizePositiveNumber(environment.deviceMemory);
    if (
        environment.mobile === true
        || (hardwareConcurrency !== null && hardwareConcurrency <= HOST_TIER_LOW_CPU_MAX)
        || (deviceMemory !== null && deviceMemory < HOST_TIER_LOW_RAM_MAX_GIB)
    ) {
        return 'low';
    }
    return deviceMemory !== null && hardwareConcurrency !== null && hardwareConcurrency >= HOST_TIER_HIGH_CPU_MIN
        ? 'high'
        : 'medium';
}

export function resolvePerformanceProfile(
    environment: IPerformanceProfileEnvironment = readNavigatorPerformanceEnvironment(),
): IPerformanceProfile {
    const hardwareConcurrency = normalizePositiveNumber(environment.hardwareConcurrency);
    const totalMemoryBytes = normalizePositiveNumber(environment.totalMemoryBytes);
    const performanceMode = environment.performanceMode ?? 'auto';
    const tier = environment.tier
        ?? (performanceMode === 'auto'
            ? resolveDetectedTier(environment, hardwareConcurrency, totalMemoryBytes)
            : performanceMode);

    return applySoftwareCanvasConstraint(
        resolveCanonicalPerformanceProfile(
            tier,
            hardwareConcurrency,
            totalMemoryBytes === null ? null : totalMemoryBytes / (1024 ** 3),
            performanceMode,
            environment.mobile === true,
        ),
        environment.gpuStatus,
    );
}

export function getPerformanceProfile() {
    cachedPerformanceProfile ??= resolvePerformanceProfile();
    return cachedPerformanceProfile;
}
