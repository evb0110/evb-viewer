import {randomUUID} from 'node:crypto';
import {basename} from 'node:path';
import type {
    TScanCleanupProgress,
    TScanCleanupSummary,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {
    runScanCleanupPipeline,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
} from '@electron/features/scan-cleanup/worker/runScanCleanupPipeline';
import {reclaimScanCleanupCheckpointOwner} from '@evb/scan-cleanup/core/conversionCheckpoint';
import {
    getWorkerTaskFailureReceipt,
    rememberWorkerTaskFailureReceipt,
} from '@electron/utils/workerTask';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
import {createLogger} from '@electron/utils/createLogger';
import type {
    IJobBrokerRunContext,
    TTerminationProofSink,
} from '@electron/resources/jobBroker';

const logger = createLogger('scan-cleanup-runner');

export type TScanCleanupWorkerRequest = IRunScanCleanupPipelineRequest;

function logScanCleanupMessage(jobId: string, level: 'debug' | 'error' | 'info' | 'warn', message: string) {
    if (level === 'error') {
        logger.error('Scan cleanup reported an error', {code: 'MAIN_SCAN_CLEANUP_FAILED'}, {
            jobId,
            message,
        });
        return;
    }
    logger[level]('Scan cleanup reported a message', {
        jobId,
        message,
    });
}

export async function runScanCleanupWorkerTask(
    request: TScanCleanupWorkerRequest,
    paths: IScanCleanupWorkerPaths,
    runtimePolicy: IScanCleanupRuntimePolicy,
    signal: AbortSignal,
    onProgress: (progress: TScanCleanupProgress) => void,
    jobId: string,
    options?: {
        onCheckpointReady?: (entryDir: string) => void;
        /**
         * The owning broker run context. The pipeline's native children
         * run under that lease, so a stop that cannot prove them gone keeps it
         * charged.
         */
        brokerRun?: IJobBrokerRunContext;
        onTerminationProof?: TTerminationProofSink;
    },
): Promise<TScanCleanupSummary> {
    const checkpointOwnerId = `${jobId}-${randomUUID()}`;
    const workerPaths: IScanCleanupWorkerPaths = paths.checkpointDir === undefined
        ? paths
        : {
            ...paths,
            checkpointOwnerId,
        };
    const startedAt = performance.now();
    let lastProgressStage: TScanCleanupProgress['stage'] | null = null;
    let lastProgressStageStartedAt = startedAt;
    logger.info('Scan cleanup run started', {
        jobId,
        source: basename(request.sourcePdfPath),
        selectedPages: request.sourcePageNumbers?.length ?? 'all',
    });
    try {
        const result = await runScanCleanupPipeline(
            request,
            workerPaths,
            signal,
            progress => {
                if (progress.stage !== lastProgressStage) {
                    const now = performance.now();
                    logger.info('Scan cleanup phase started', {
                        jobId,
                        stage: progress.stage,
                        previousStage: lastProgressStage,
                        previousStageMs: lastProgressStage === null ? null : Math.round(now - lastProgressStageStartedAt),
                        completedUnits: progress.completedUnits,
                        totalUnits: progress.totalUnits,
                        percent: progress.percent,
                        completedPageNumbers: progress.completedPageNumbers ?? null,
                    });
                    lastProgressStage = progress.stage;
                    lastProgressStageStartedAt = now;
                }
                onProgress(progress);
            },
            runtimePolicy,
            (level, message) => logScanCleanupMessage(jobId, level, message),
            undefined,
            {
                ...(options?.onCheckpointReady === undefined
                    ? {}
                    : {onCheckpointReadyForCleanup: options.onCheckpointReady}),
                ...(options?.brokerRun === undefined
                    ? {}
                    : {brokerRun: options.brokerRun}),
                ...(options?.onTerminationProof === undefined
                    ? {}
                    : {onTerminationProof: options.onTerminationProof}),
            },
        );
        logger.info('Scan cleanup run completed', {
            jobId,
            lastStage: lastProgressStage,
            lastStageMs: Math.round(performance.now() - lastProgressStageStartedAt),
            inputPages: result.inputPages,
            outputPages: result.outputPages,
            durationMs: Math.round(performance.now() - startedAt),
        });
        return result;
    } catch (error) {
        const elapsedMs = Math.round(performance.now() - startedAt);
        const detail = error instanceof Error ? (error.stack ?? getErrorMessage(error)) : String(error);
        const unprovenTermination = getUnprovenNativeTerminationDetail(error);
        if (unprovenTermination !== undefined) {
            logger.warn('Scan cleanup run stopped without proving native termination', {
                jobId,
                elapsedMs,
                detail: unprovenTermination,
            });
        } else if (signal.aborted || isAbortError(error)) {
            logger.info('Scan cleanup run canceled', {
                jobId,
                stage: lastProgressStage,
                elapsedMs,
            });
        } else if (getWorkerTaskFailureReceipt(error) !== undefined) {
            logger.debug('Scan cleanup task rejected (already reported)', {
                jobId,
                detail,
            });
        } else {
            rememberWorkerTaskFailureReceipt(
                error,
                logger.error('Scan cleanup run failed', {
                    code: 'MAIN_SCAN_CLEANUP_FAILED',
                    cause: error,
                }, {
                    jobId,
                    stage: lastProgressStage,
                    elapsedMs,
                    errorMessage: getErrorMessage(error),
                    detail,
                }),
            );
        }
        throw error;
    } finally {
        if (paths.checkpointDir !== undefined) {
            await reclaimScanCleanupCheckpointOwner(paths.checkpointDir, checkpointOwnerId).catch(reclaimError => {
                logger.warn('Failed to reclaim scan cleanup checkpoint owner artifacts', {
                    jobId,
                    checkpointOwnerId,
                    error: getErrorMessage(reclaimError),
                });
            });
        }
    }
}
