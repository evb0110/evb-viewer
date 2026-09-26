import { getErrorMessage } from '@electron/utils/error';
import {dirname} from 'path';
import { fileURLToPath } from 'url';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    TScanCleanupProgress,
    TScanCleanupSummary,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {SCAN_CLEANUP_SUMMARY_SCHEMA} from '@contracts/scan-cleanup/ipc';
import {SCAN_CLEANUP_PROGRESS_SCHEMA} from '@contracts/scan-cleanup/progress';
import type { IScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import type {
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
} from '@electron/features/scan-cleanup/worker/runScanCleanupPipeline';
import type {IScanCleanupDetectionResultStoreDescriptor} from '@electron/features/scan-cleanup/detectionResultStoreDescriptor';
import {
    getWorkerTaskFailureReceipt,
    rememberWorkerTaskFailureReceipt,
    resolveUnpackedWorkerPath,
    startStreamingWorkerTask,
} from '@electron/utils/workerTask';
import {isAbortError} from '@electron/utils/abort';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import {createLogger} from '@electron/utils/createLogger';
import * as v from 'valibot';

const currentDir = dirname(fileURLToPath(import.meta.url));
const workerFileName = WORKER_BUNDLES_BY_ID['scan-cleanup'].fileName;
const logger = createLogger('scan-cleanup-worker-task');

/** Request data that can cross the worker_threads structured-clone boundary. */
export type TScanCleanupWorkerRequest = Omit<IRunScanCleanupPipelineRequest, 'detectionResultStore'> & {detectionResultStoreDescriptor?: IScanCleanupDetectionResultStoreDescriptor;};

type TDecodedProgress =
    | {kind: 'not-progress'}
    | {kind: 'invalid'}
    | {
        kind: 'progress';
        value: TScanCleanupProgress;
    };

function decodeProgress(value: unknown): TDecodedProgress {
    if (!isRecord(value) || value.type !== 'progress') {
        return {kind: 'not-progress'};
    }
    try {
        return {
            kind: 'progress',
            value: v.parse(SCAN_CLEANUP_PROGRESS_SCHEMA, value.progress, {abortEarly: true}),
        };
    } catch (error) {
        logger.error('Rejected scan cleanup worker progress', {
            code: 'MAIN_SCAN_CLEANUP_FAILED',
            severity: 'error',
            cause: error,
        }, {
            value,
            errorMessage: getErrorMessage(error),
        });
        return {kind: 'invalid'};
    }
}

function decodeSummary(value: unknown): TScanCleanupSummary | null {
    try {
        return SCAN_CLEANUP_SUMMARY_SCHEMA.decode(value);
    } catch {
        return null;
    }
}

export async function runScanCleanupWorkerTask(
    request: TScanCleanupWorkerRequest,
    paths: IScanCleanupWorkerPaths,
    runtimePolicy: IScanCleanupRuntimePolicy,
    signal: AbortSignal,
    onProgress: (progress: TScanCleanupProgress) => void,
) {
    const task = startStreamingWorkerTask<TScanCleanupSummary>({
        workerPath: resolveUnpackedWorkerPath(currentDir, workerFileName),
        workerData: {
            request,
            paths,
            runtimePolicy,
        },
        invalidPayloadMessage: 'Scan cleanup worker returned an invalid payload',
        invalidResultMessage: 'Scan cleanup worker returned an invalid summary',
        createStartupError: message => new Error(`Scan cleanup worker startup failed: ${message}`),
        createWorkerExitError: code => new Error(`Scan cleanup worker exited with code ${code}`),
        // A high-DPI book can legitimately take longer than an hour while
        // still completing pages continuously. Guard against a stalled worker
        // without canceling healthy long-running cleanup jobs.
        inactivityTimeoutMs: 60 * 60 * 1000,
        resourceLimits: {
            maxOldGenerationSizeMb: 256,
            maxYoungGenerationSizeMb: 64,
            stackSizeMb: 4,
        },
        signal,
        // AbortSignal is the transport. This worker adapter translates abort to
        // a cooperative message and lets the worker-task harness force terminate
        // after the grace period. Generation counters are never used to cancel.
        createCancelMessage: () => ({type: 'cancel'}),
        cooperativeCancelDelayMs: 5_000,
        onProgressMessage: value => {
            const decoded = decodeProgress(value);
            if (decoded.kind === 'not-progress') {
                return false;
            }
            if (decoded.kind === 'progress') onProgress(decoded.value);
            return true;
        },
        decodeResult: decodeSummary,
    });
    try {
        return await task.promise;
    } catch (error) {
        const detail = error instanceof Error ? (error.stack ?? getErrorMessage(error)) : String(error);
        if (signal.aborted || isAbortError(error)) {
            logger.info('Scan cleanup worker task canceled');
        } else if (getWorkerTaskFailureReceipt(error) !== undefined) {
            // The generic worker-task layer already reported this exact
            // rejection at error level. Repeating it at error level would make
            // the renderer count one fault twice, so keep the scan-cleanup
            // context below the reporting threshold.
            logger.warn(`Scan cleanup worker task rejected (already reported): ${detail}`);
        } else {
            rememberWorkerTaskFailureReceipt(
                error,
                logger.error(`Scan cleanup worker task rejected: ${detail}`, {
                    code: 'MAIN_SCAN_CLEANUP_FAILED',
                    cause: error,
                }),
            );
        }
        throw error;
    }
}
