import {dirname} from 'path';
import {fileURLToPath} from 'url';
import type {
    TScanCleanupErrorCode,
    IScanCleanupScratchShortfall,
} from '@contracts/electronApiScanCleanup';
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
    if (error instanceof ScanCleanupNativeToolUnavailableError || error instanceof ScanCleanupInsufficientScratchError) {
        return error.code;
    }
    const errorCode = error && typeof error === 'object' && 'code' in error
        ? (error as {code?: unknown}).code
        : undefined;
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
    return error instanceof ScanCleanupInsufficientScratchError
        ? {scratchShortfall: {
            availableBytes: error.availableBytes,
            requiredBytes: error.requiredBytes,
        }}
        : {};
}

export const SCAN_CLEANUP_PREVIEW_RASTER_SLOT_RESIDENT_BYTES = 128 * 1024 * 1024;
const SCAN_CLEANUP_RASTER_BROKER_PROCESS_RESERVE = 1;

export interface IScanCleanupRasterAdmissionPolicy {
    rasterConcurrency: number;
    rasterStreaming: boolean;
}

export function resolveScanCleanupPreviewRasterAdmissionPolicy(
    capacity: IJobResourceVector = mainJobBroker.getSnapshot().capacity,
    supportsRasterStreaming = process.platform !== 'win32',
): IScanCleanupRasterAdmissionPolicy {
    const rasterStreaming = supportsRasterStreaming && capacity.nativeProcesses >= 3;
    const nativeProcessReserve = SCAN_CLEANUP_RASTER_BROKER_PROCESS_RESERVE + Number(rasterStreaming);
    return {
        rasterConcurrency: Math.max(
            1,
            Math.min(
                Math.floor(capacity.cpuTokens),
                capacity.nativeProcesses - nativeProcessReserve,
                Math.floor(capacity.estimatedResidentBytes / SCAN_CLEANUP_PREVIEW_RASTER_SLOT_RESIDENT_BYTES),
            ),
        ),
        rasterStreaming,
    };
}
