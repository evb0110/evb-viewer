import {dirname} from 'path';
import {fileURLToPath} from 'url';
import type {
    TScanCleanupErrorCode,
    IScanCleanupErrorEnvelope,
    IScanCleanupOptions,
    TScanCleanupOutputModeSetting,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {SCAN_CLEANUP_ERROR_CODES, SCAN_CLEANUP_SCRATCH_SHORTFALL_SCHEMA} from '@contracts/scan-cleanup/ipc';
import {isRecord} from '@contracts/runtimeGuards';
import * as v from 'valibot';
import type {IJobResourceVector} from '@electron/resources/jobBroker';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {resolveNativeToolPath} from '@electron/native-tools/resolveNativeToolPath';
import {runtimeConfig} from '@electron/runtimeConfig';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {SCAN_CLEANUP_PAGE_SCOPE_ERROR_CODE, ScanCleanupPageScopeError} from '@evb/scan-cleanup/core/pageScope';
import {ScanCleanupInsufficientScratchError, ScanCleanupNativeToolUnavailableError} from '@evb/scan-cleanup/core/errors';
import {partitionScanCleanupCpuBudget} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {
    SCAN_CLEANUP_MAX_BILEVEL_PIXELS,
    SCAN_CLEANUP_MAX_CONTINUOUS_TONE_PIXELS,
    resolveScanCleanupMatchedCanvasMaxPixels,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';

const currentDir = dirname(fileURLToPath(import.meta.url));

export function resolveScanCleanupPreviewPath() {
    return resolveNativeToolPath({
        binaryName: process.platform === 'win32' ? 'evb-scan-cleanup.exe' : 'evb-scan-cleanup',
        crateName: 'scan-cleanup',
        currentDir,
        envOverridePath: runtimeConfig.scanCleanupPath,
        isPackaged: currentDir.includes('app.asar'),
    });
}

export function classifyScanCleanupPreviewError(error: unknown, aborted: boolean): TScanCleanupErrorCode {
    if (aborted) {
        return 'canceled';
    }
    const errorCode = error && typeof error === 'object' && 'code' in error ? (error as {code?: unknown}).code : undefined;
    if (typeof errorCode === 'string' && SCAN_CLEANUP_ERROR_CODES.includes(errorCode as TScanCleanupErrorCode)) {
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

export function scanCleanupScratchShortfall(error: unknown): Pick<IScanCleanupErrorEnvelope, 'details'> {
    if (!isRecord(error)) {
        return {};
    }
    const detailsShortfall = isRecord(error.details) ? error.details.scratchShortfall : undefined;
    const scratchShortfall =
        detailsShortfall ??
        error.scratchShortfall ??
        (error.code === 'insufficient-scratch'
            ? {
                  availableBytes: error.availableBytes,
                  requiredBytes: error.requiredBytes,
              }
            : undefined);
    if (scratchShortfall === undefined) {
        return {};
    }
    const parsed = v.safeParse(SCAN_CLEANUP_SCRATCH_SHORTFALL_SCHEMA, scratchShortfall, {abortEarly: true});
    if (!parsed.success) {
        return {};
    }
    return {details: {scratchShortfall: parsed.output}};
}

export const SCAN_CLEANUP_EVENT_REPLAY_TTL_MS = 60_000;
export const SCAN_CLEANUP_TERMINAL_RECORD_TTL_MS = 60_000;
export const SCAN_CLEANUP_JOB_RETENTION_POLICY = {
    eventReplayTtlMs: SCAN_CLEANUP_EVENT_REPLAY_TTL_MS,
    terminalRecordTtlMs: SCAN_CLEANUP_TERMINAL_RECORD_TTL_MS,
} as const;

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
export function resolveScanCleanupPreviewRasterMaxPixels(options?: TScanCleanupRasterBudgetOptions) {
    const configuredModes: TScanCleanupOutputModeSetting[] = [
        options?.preserveOriginalQuality === true ? 'color' : (options?.outputMode ?? 'auto'),
        ...(options?.pageOverrideDefaults?.outputModeOverride === undefined ? [] : [options.pageOverrideDefaults.outputModeOverride]),
        ...Object.values(options?.pageOverrides ?? {}).flatMap((override) =>
            override.outputModeOverride === undefined ? [] : [override.outputModeOverride],
        ),
    ];
    const matchedCanvasMaxPixels = resolveScanCleanupMatchedCanvasMaxPixels(configuredModes);
    const mayResolveBilevel = configuredModes.some((mode) => mode === 'auto' || mode === 'bw');
    return Math.max(matchedCanvasMaxPixels, mayResolveBilevel ? SCAN_CLEANUP_MAX_BILEVEL_PIXELS : SCAN_CLEANUP_MAX_CONTINUOUS_TONE_PIXELS);
}

/**
 * The broker protects decoded output surfaces shared by concurrent Electron
 * jobs, so it reserves four RGBA bytes for every pixel in the largest canvas the
 * configured modes can admit. The native planner has a separate, calibrated
 * 40/80-bytes-per-pixel high-water model and cache reservation in
 * `native/scan-cleanup/src/engine/resource_planning.rs`; it limits workers
 * inside the native process rather than replacing this cross-job admission.
 */
export function resolveScanCleanupPreviewRasterSlotResidentBytes(options?: TScanCleanupRasterBudgetOptions, rasterMaxPixels?: number) {
    return (rasterMaxPixels ?? resolveScanCleanupPreviewRasterMaxPixels(options)) * SCAN_CLEANUP_PREVIEW_RASTER_BYTES_PER_PIXEL;
}

export interface IScanCleanupRasterAdmissionPolicy {
    rasterConcurrency: number;
    /** Partitioned Rayon thread cap for `evb-scan-cleanup` sidecar work. */
    sidecarThreads?: number;
    /** Total broker CPU tokens admitted for the bulk Scan Cleanup lease. */
    cpuTokens?: number;
    /** Total broker native process slots admitted (producers + concurrent sidecar when overlapping). */
    nativeProcesses?: number;
    /** Broker I/O weight admitted for bulk conversion while keeping preview headroom. */
    ioWeight?: number;
    /**
     * True when the broker budget leaves only 1 CPU token or 1 process slot
     * after reserving preview headroom, so producers and the sidecar must run
     * sequentially rather than overlapping.
     */
    serializeStages?: boolean;
    /** The per-page pixel cap paired with the broker's resident-byte reserve. */
    rasterMaxPixels?: number;
    /**
     * Host memory the native tool sizes its page workers from. Without it the
     * tool assumes a 4 GiB machine and analyzes a scanned book one page at a time.
     */
    totalRamBytes?: number;
}

export function resolveScanCleanupPreviewRasterAdmissionPolicy(
    capacity: IJobResourceVector = mainJobBroker.getSnapshot().capacity,
    options?: TScanCleanupRasterBudgetOptions,
    logicalCpus?: number,
    admissionOptions?: {overlapSidecarProcess?: boolean},
): IScanCleanupRasterAdmissionPolicy {
    const configuredRasterMaxPixels = resolveScanCleanupPreviewRasterMaxPixels(options);
    const capacityRasterMaxPixels = Math.floor(capacity.estimatedResidentBytes / SCAN_CLEANUP_PREVIEW_RASTER_BYTES_PER_PIXEL);
    const rasterMaxPixels = Math.max(1, Math.min(configuredRasterMaxPixels, capacityRasterMaxPixels));
    const rasterSlotResidentBytes = resolveScanCleanupPreviewRasterSlotResidentBytes(options, rasterMaxPixels);
    const brokerCpuBudget = Math.max(1, Math.floor(capacity.cpuTokens) - SCAN_CLEANUP_RASTER_BROKER_PROCESS_RESERVE);
    const hostCpuLimit =
        logicalCpus !== undefined && Number.isFinite(logicalCpus) && logicalCpus > 0
            ? Math.max(1, Math.floor(logicalCpus) - 1)
            : brokerCpuBudget;
    const cpuBudget = Math.max(1, Math.min(brokerCpuBudget, hostCpuLimit));
    const brokerProcessBudget = Math.max(1, Math.floor(capacity.nativeProcesses) - SCAN_CLEANUP_RASTER_BROKER_PROCESS_RESERVE);
    const brokerResidentBytesBudget = Math.max(rasterSlotResidentBytes, capacity.estimatedResidentBytes - rasterSlotResidentBytes);
    const memoryProducerCap = Math.max(1, Math.floor(brokerResidentBytesBudget / rasterSlotResidentBytes));
    const ioWeight = Math.max(1, Math.min(4, Math.floor(capacity.ioWeight) - SCAN_CLEANUP_RASTER_BROKER_PROCESS_RESERVE));
    const serializeStages = cpuBudget <= 1 || brokerProcessBudget <= 1;
    if (serializeStages) {
        return {
            rasterConcurrency: 1,
            sidecarThreads: cpuBudget,
            cpuTokens: Math.min(capacity.cpuTokens, cpuBudget),
            nativeProcesses: Math.min(capacity.nativeProcesses, 1),
            ioWeight: Math.min(capacity.ioWeight, ioWeight),
            serializeStages: true,
            rasterMaxPixels,
        };
    }
    const overlapSidecarProcess = admissionOptions?.overlapSidecarProcess === true;
    // When producers run concurrently with an active sidecar process (streaming
    // conversion), reserve 1 process slot inside `brokerProcessBudget` for the
    // sidecar itself and charge `producerConcurrency + 1` native processes so
    // the broker lease accurately covers every concurrent child process while
    // preserving 1 full slot for a concurrent visible preview.
    const producerProcessCap = overlapSidecarProcess ? Math.max(1, brokerProcessBudget - 1) : brokerProcessBudget;
    const maxProducers = Math.max(1, Math.min(producerProcessCap, memoryProducerCap));
    const partition = partitionScanCleanupCpuBudget(cpuBudget, maxProducers);
    return {
        rasterConcurrency: partition.producerConcurrency,
        sidecarThreads: partition.sidecarMaxThreads,
        cpuTokens: Math.min(capacity.cpuTokens, partition.totalCpuTokens),
        nativeProcesses: Math.min(brokerProcessBudget, partition.producerConcurrency + (overlapSidecarProcess ? 1 : 0)),
        ioWeight: Math.min(capacity.ioWeight, ioWeight),
        serializeStages: false,
        rasterMaxPixels,
    };
}
