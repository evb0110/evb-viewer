import { getRawElectronPlatformApi } from '@app/utils/electronPlatformBridge';
import { readBrowserPerformanceModeSnapshot } from '@app/utils/browserSettingsPersistence';
import {
    HOST_TIER_HIGH_RAM_MIN_GIB,
    HOST_TIER_LOW_RAM_MAX_GIB,
    HOST_TIER_MODEST_CPU_MAX,
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
export const PDF_RENDER_CONCURRENCY_LOW_MEMORY = 2;
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

interface IPerformanceProfileNavigator extends Navigator {deviceMemory?: number;}

export interface IPerformanceProfileEnvironment {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    totalMemoryBytes?: number;
    gpuStatus?: IHostGpuStatusSnapshot;
    tier?: THostResourceTier;
    performanceMode?: TPerformanceMode;
}

export interface IPerformanceProfile {
    tier: THostResourceTier;
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
    if (typeof navigator === 'undefined') {
        return { performanceMode };
    }

    const runtimeNavigator = navigator as IPerformanceProfileNavigator;
    const environment: IPerformanceProfileEnvironment = { performanceMode };
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
): IPerformanceProfile {
    const workstationProfile = resolveWorkstationProfile(
        tier,
        hardwareConcurrency,
        totalMemoryGiB,
    );
    const lowTier = tier === 'low';

    return {
        tier,
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
        settledMaxCanvasPixels: workstationProfile
            ? PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION
            : tier === 'high'
                ? PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY
                : lowTier
                    ? PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER
                    : PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
        maxBufferCanvasPixels: workstationProfile
            ? PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION
            : lowTier
                ? PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY
                : PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
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

export function resolvePerformanceProfile(
    environment: IPerformanceProfileEnvironment = readNavigatorPerformanceEnvironment(),
): IPerformanceProfile {
    const deviceMemory = normalizePositiveNumber(environment.deviceMemory);
    const hardwareConcurrency = normalizePositiveNumber(environment.hardwareConcurrency);
    const totalMemoryBytes = normalizePositiveNumber(environment.totalMemoryBytes);
    const totalMemoryGiB = totalMemoryBytes === null
        ? null
        : totalMemoryBytes / (1024 ** 3);
    const effectiveTier = environment.tier
        ?? (environment.performanceMode === undefined || environment.performanceMode === 'auto'
            ? null
            : environment.performanceMode);
    if (effectiveTier !== null) {
        return applySoftwareCanvasConstraint(
            resolveCanonicalPerformanceProfile(
                effectiveTier,
                hardwareConcurrency,
                totalMemoryGiB,
            ),
            environment.gpuStatus,
        );
    }

    const lowMemory = totalMemoryGiB !== null
        ? totalMemoryGiB <= HOST_TIER_LOW_RAM_MAX_GIB
        : (deviceMemory ?? 4) <= 4;
    const highCanvasMemory = totalMemoryGiB !== null
        ? totalMemoryGiB >= HOST_TIER_HIGH_RAM_MIN_GIB
        : (deviceMemory ?? 0) >= 8;
    const workstationMemory = totalMemoryGiB !== null && totalMemoryGiB >= 32;
    const lowCpu = (hardwareConcurrency ?? 4) <= HOST_TIER_MODEST_CPU_MAX;
    const workstationCpu = hardwareConcurrency !== null && hardwareConcurrency >= 12;
    const workstationProfile = workstationMemory && workstationCpu;
    // The tier itself always comes from the canonical detection table so the
    // browser fallback can never drift from the host classifier; the flags
    // below stay as renderer-only canvas refinements.
    const tier: THostResourceTier = hardwareConcurrency !== null && totalMemoryBytes !== null
        ? resolveDetectedHostResourceTier({
            logicalCpus: hardwareConcurrency,
            totalRamBytes: totalMemoryBytes,
        })
        : lowMemory
            ? 'low'
            : highCanvasMemory
                ? 'high'
                : 'medium';
    const concurrentPdfRenders = workstationProfile
        ? Math.min(
            PDF_RENDER_CONCURRENCY_WORKSTATION_MAX,
            Math.max(PDF_RENDER_CONCURRENCY_DEFAULT + 1, Math.floor(hardwareConcurrency / 4)),
        )
        : lowCpu
            ? PDF_RENDER_CONCURRENCY_LOW_CPU
            : lowMemory
                ? PDF_RENDER_CONCURRENCY_LOW_MEMORY
                : PDF_RENDER_CONCURRENCY_DEFAULT;

    return applySoftwareCanvasConstraint({
        tier,
        lowMemory,
        lowCpu,
        pdfBufferPages: workstationProfile
            ? PDF_BUFFER_PAGES_WORKSTATION
            : lowMemory
                ? PDF_BUFFER_PAGES_LOW_MEMORY
                : PDF_BUFFER_PAGES_DEFAULT,
        concurrentPdfRenders,
        maxCachedPdfPages: workstationProfile
            ? PDF_PAGE_PROXY_CACHE_WORKSTATION
            : lowMemory
                ? PDF_PAGE_PROXY_CACHE_LOW_MEMORY
                : PDF_PAGE_PROXY_CACHE_DEFAULT,
        thumbnailBaseConcurrency: workstationProfile
            ? PDF_THUMBNAIL_CONCURRENCY_WORKSTATION
            : lowMemory || lowCpu
                ? PDF_THUMBNAIL_CONCURRENCY_LOW_PROFILE
                : PDF_THUMBNAIL_CONCURRENCY_DEFAULT,
        settledMaxCanvasPixels: tier === 'low'
            ? PDF_SETTLED_MAX_CANVAS_PIXELS_LOW_TIER
            : workstationMemory
                ? PDF_SETTLED_MAX_CANVAS_PIXELS_WORKSTATION
                : highCanvasMemory
                    ? PDF_SETTLED_MAX_CANVAS_PIXELS_HIGH_MEMORY
                    : PDF_SETTLED_MAX_CANVAS_PIXELS_DEFAULT,
        maxBufferCanvasPixels: workstationProfile
            ? PDF_BUFFER_MAX_CANVAS_PIXELS_WORKSTATION
            : lowMemory
                ? PDF_BUFFER_MAX_CANVAS_PIXELS_LOW_MEMORY
                : PDF_BUFFER_MAX_CANVAS_PIXELS_DEFAULT,
    }, environment.gpuStatus);
}

export function getPerformanceProfile() {
    cachedPerformanceProfile ??= resolvePerformanceProfile();
    return cachedPerformanceProfile;
}
