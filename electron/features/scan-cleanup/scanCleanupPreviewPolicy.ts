import {dirname} from 'path';
import {fileURLToPath} from 'url';
import type {
    TScanCleanupErrorCode,
    IScanCleanupScratchShortfall,
    IScanCleanupOptions,
    TScanCleanupOutputModeSetting,
} from '@contracts/electronApiScanCleanup';
import {
    decodeScanCleanupScratchShortfall,
    SCAN_CLEANUP_ERROR_CODES,
} from '@contracts/scan-cleanup/ipc';
import {isRecord} from '@contracts/runtimeGuards';
import type {IJobResourceVector} from '@electron/resources/jobBroker';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {resolveNativeToolPath} from '@electron/native-tools/resolveNativeToolPath';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {
    SCAN_CLEANUP_PAGE_SCOPE_ERROR_CODE,
    ScanCleanupPageScopeError,
} from '@evb/scan-cleanup/core/pageScope';
import {
    ScanCleanupInsufficientScratchError,
    ScanCleanupNativeToolUnavailableError,
} from '@evb/scan-cleanup/core/errors';
import {
    SCAN_CLEANUP_MAX_BILEVEL_PIXELS,
    SCAN_CLEANUP_MAX_CONTINUOUS_TONE_PIXELS,
    resolveScanCleanupMatchedCanvasMaxPixels,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import type {IMainJobErrorEnvelope} from '@electron/operation-lifecycle/createMainJobRegistry';

const currentDir = dirname(fileURLToPath(import.meta.url));

export function resolveScanCleanupPreviewPath() {
    return resolveNativeToolPath({
        binaryName: process.platform === 'win32' ? 'evb-scan-cleanup.exe' : 'evb-scan-cleanup',
        crateName: 'scan-cleanup',
        currentDir,
        envOverridePath: process.env.EVB_SCAN_CLEANUP_PATH,
        isPackaged: currentDir.includes('app.asar'),
    });
}

export function classifyScanCleanupPreviewError(error: unknown, aborted: boolean): TScanCleanupErrorCode {
    if (aborted) {
        return 'canceled';
    }
    const errorCode = error && typeof error === 'object' && 'code' in error
        ? (error as {code?: unknown}).code
        : undefined;
    if (typeof errorCode === 'string' && SCAN_CLEANUP_ERROR_CODES.includes(
        errorCode as TScanCleanupErrorCode,
    )) {
        return errorCode as TScanCleanupErrorCode;
    }
    if (error instanceof ScanCleanupNativeToolUnavailableError || error instanceof ScanCleanupInsufficientScratchError) {
        return error.code;
    }
    if (error instanceof ScanCleanupPageScopeError || errorCode === SCAN_CLEANUP_PAGE_SCOPE_ERROR_CODE) {
        return 'invalid-request';
    }
    if (hasNativeErrorCode(error)) {
        return error.code;
    }
    if (errorCode === 'ENOENT') {
        return 'tools-unavailable';
    }
    if (errorCode === 'SCAN_CLEANUP_INVALID_PAGE_SCOPE') {
        return 'invalid-request';
    }
    return 'internal';
}

export interface IScanCleanupJobErrorEnvelope extends IMainJobErrorEnvelope<TScanCleanupErrorCode> {scratchShortfall?: IScanCleanupScratchShortfall;}

export function scanCleanupScratchShortfall(
    error: unknown,
): Pick<IScanCleanupJobErrorEnvelope, 'scratchShortfall'> {
    if (error instanceof ScanCleanupInsufficientScratchError) {
        return {scratchShortfall: {
            availableBytes: error.availableBytes,
            requiredBytes: error.requiredBytes,
        }};
    }
    if (!isRecord(error)) {
        return {};
    }
    const scratchShortfall = error.scratchShortfall ?? (
        error.code === 'insufficient-scratch'
            ? {
                availableBytes: error.availableBytes,
                requiredBytes: error.requiredBytes,
            }
            : undefined
    );
    if (scratchShortfall === undefined) {
        return {};
    }
    try {
        return {scratchShortfall: decodeScanCleanupScratchShortfall(scratchShortfall)};
    } catch {
        return {};
    }
}

const SCAN_CLEANUP_RASTER_BROKER_PROCESS_RESERVE = 1;
const SCAN_CLEANUP_PREVIEW_RASTER_BYTES_PER_PIXEL = 4;

export type TScanCleanupRasterBudgetOptions = Pick<
    IScanCleanupOptions,
    'outputMode' | 'pageOverrides' | 'pageOverrideDefaults' | 'preserveOriginalQuality'
>;

/**
 * Return the largest raster a page can actually resolve to under the
 * document's settings. `resolveScanCleanupMatchedCanvasMaxPixels` deliberately
 * treats Auto as continuous tone because it plans the shared canvas; broker
 * admission has to be more conservative because Auto may resolve an individual
 * page to B&W, and a page override can do the same in an otherwise tonal book.
 */
export function resolveScanCleanupPreviewRasterMaxPixels(
    options?: TScanCleanupRasterBudgetOptions,
) {
    const configuredModes: TScanCleanupOutputModeSetting[] = [
        options?.preserveOriginalQuality === true ? 'color' : options?.outputMode ?? 'auto',
        ...(options?.pageOverrideDefaults?.outputModeOverride === undefined
            ? []
            : [options.pageOverrideDefaults.outputModeOverride]),
        ...Object.values(options?.pageOverrides ?? {}).flatMap(override => (
            override.outputModeOverride === undefined ? [] : [override.outputModeOverride]
        )),
    ];
    const matchedCanvasMaxPixels = resolveScanCleanupMatchedCanvasMaxPixels(configuredModes);
    const mayResolveBilevel = configuredModes.some(mode => mode === 'auto' || mode === 'bw');
    return Math.max(
        matchedCanvasMaxPixels,
        mayResolveBilevel
            ? SCAN_CLEANUP_MAX_BILEVEL_PIXELS
            : SCAN_CLEANUP_MAX_CONTINUOUS_TONE_PIXELS,
    );
}

/**
 * The broker protects decoded output surfaces shared by concurrent Electron
 * jobs, so it reserves four RGBA bytes for every pixel in the largest canvas the
 * configured modes can admit. The native planner has a separate, calibrated
 * 40/80-bytes-per-pixel high-water model and cache reservation in
 * `native/scan-cleanup/src/engine/resource_planning.rs`; it limits workers
 * inside the native process rather than replacing this cross-job admission.
 */
export function resolveScanCleanupPreviewRasterSlotResidentBytes(
    options?: TScanCleanupRasterBudgetOptions,
    rasterMaxPixels?: number,
) {
    return (rasterMaxPixels ?? resolveScanCleanupPreviewRasterMaxPixels(options))
        * SCAN_CLEANUP_PREVIEW_RASTER_BYTES_PER_PIXEL;
}

export interface IScanCleanupRasterAdmissionPolicy {
    rasterConcurrency: number;
    rasterStreaming: boolean;
    /** The per-page pixel cap paired with the broker's resident-byte reserve. */
    rasterMaxPixels?: number;
}

export function resolveScanCleanupPreviewRasterAdmissionPolicy(
    capacity: IJobResourceVector = mainJobBroker.getSnapshot().capacity,
    supportsRasterStreaming = process.platform !== 'win32',
    options?: TScanCleanupRasterBudgetOptions,
): IScanCleanupRasterAdmissionPolicy {
    const rasterStreaming = supportsRasterStreaming && capacity.nativeProcesses >= 3;
    const nativeProcessReserve = SCAN_CLEANUP_RASTER_BROKER_PROCESS_RESERVE + Number(rasterStreaming);
    const configuredRasterMaxPixels = resolveScanCleanupPreviewRasterMaxPixels(options);
    const capacityRasterMaxPixels = Math.floor(
        capacity.estimatedResidentBytes / SCAN_CLEANUP_PREVIEW_RASTER_BYTES_PER_PIXEL,
    );
    const rasterMaxPixels = Math.max(
        1,
        Math.min(configuredRasterMaxPixels, capacityRasterMaxPixels),
    );
    const rasterSlotResidentBytes = resolveScanCleanupPreviewRasterSlotResidentBytes(
        options,
        rasterMaxPixels,
    );
    return {
        rasterConcurrency: Math.max(
            1,
            Math.min(
                Math.floor(capacity.cpuTokens),
                capacity.nativeProcesses - nativeProcessReserve,
                Math.floor(capacity.estimatedResidentBytes / rasterSlotResidentBytes),
            ),
        ),
        rasterStreaming,
        rasterMaxPixels,
    };
}
