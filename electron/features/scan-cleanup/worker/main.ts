import { getErrorMessage } from '@electron/utils/error';
import {
    parentPort,
    workerData,
} from 'worker_threads';
import {basename} from 'path';
import type {TScanCleanupProgress} from '@contracts/electronApiScanCleanup';
import { decodeScanCleanupRuntimePolicy } from '@contracts/resourcePolicies';
import { createLogger } from '@electron/utils/createLogger';
import { createWorkerTaskErrorFrame } from '@electron/utils/workerTask';
import { isAbortError } from '@electron/utils/abort';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import {openScanCleanupDetectionResultStoreDescriptor} from '@electron/features/scan-cleanup/detectionResultStoreDescriptor';
import {attachScanCleanupPageOverrideDefaults} from '@contracts/scanCleanupPageOverrides';
import type {IScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/types';
import {
    runScanCleanupPipeline,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
} from '@electron/features/scan-cleanup/worker/runScanCleanupPipeline';
import type {TScanCleanupWorkerRequest} from '@electron/features/scan-cleanup/runScanCleanupWorkerTask';

if (!parentPort) throw new Error('Scan cleanup worker started without a parent port');
const port = parentPort;
const data = workerData as {
    request: TScanCleanupWorkerRequest;
    paths: IScanCleanupWorkerPaths;
    runtimePolicy?: unknown;
};
const logger = createLogger('scan-cleanup-worker');
function logScanCleanupWorkerMessage(level: 'debug' | 'error' | 'info' | 'warn', message: string) {
    if (level === 'error') {
        logger.error(message, {
            code: 'MAIN_SCAN_CLEANUP_FAILED',
            context: {},
        });
        return;
    }
    logger[level](message);
}
const abortController = new AbortController();
const startedAt = performance.now();
let lastProgressStage: TScanCleanupProgress['stage'] | null = null;
port.on('message', message => {
    if ((message as {type?: string}).type === 'cancel') abortController.abort(new DOMException('Scan cleanup canceled', 'AbortError'));
});
let detectionResultStore: IScanCleanupDetectionResultStore | null = null;
try {
    const runtimePolicy = decodeScanCleanupRuntimePolicy(data.runtimePolicy);
    if (!runtimePolicy) throw new Error('Scan cleanup worker received an invalid runtime policy');
    const {
        detectionResultStoreDescriptor,
        ...requestWithoutDetectionResultStoreDescriptor
    } = data.request;
    detectionResultStore = detectionResultStoreDescriptor === undefined
        ? null
        : await openScanCleanupDetectionResultStoreDescriptor(detectionResultStoreDescriptor);
    const request: IRunScanCleanupPipelineRequest = {
        ...requestWithoutDetectionResultStoreDescriptor,
        ...(detectionResultStore === null ? {} : {detectionResultStore}),
    };
    attachScanCleanupPageOverrideDefaults(
        request.options.pageOverrides,
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
    logger.info(
        `Run started: source=${basename(data.request.sourcePdfPath)} `
        + `selectedPages=${String(data.request.sourcePageNumbers?.length ?? 'all')}`,
    );
    const result = await runScanCleanupPipeline(
        request,
        data.paths,
        abortController.signal,
        (progress: TScanCleanupProgress) => {
            if (progress.stage !== lastProgressStage) {
                lastProgressStage = progress.stage;
                logger.info(
                    `Phase started: stage=${progress.stage} `
                    + `completed=${String(progress.completedUnits)}/${String(progress.totalUnits)} `
                    + `percent=${progress.percent.toFixed(1)} `
                    + `completedPageNumbers=${JSON.stringify(progress.completedPageNumbers ?? null)}`,
                );
            }
            port.postMessage({
                type: 'progress',
                progress,
            });
        },
        runtimePolicy,
        logScanCleanupWorkerMessage,
    );
    port.postMessage({
        type: 'result',
        ok: true,
        data: result,
    });
    logger.info(
        `Run completed: inputPages=${String(result.inputPages)} `
        + `outputPages=${String(result.outputPages)} `
        + `durationMs=${String(Math.round(performance.now() - startedAt))}`,
    );
} catch (error) {
    const elapsedMs = String(Math.round(performance.now() - startedAt));
    // A cancelled run ends by throwing the abort reason. That is the requested
    // outcome, so it is reported as the end of the run and not as a failure.
    const unprovenTermination = getUnprovenNativeTerminationDetail(error);
    if (unprovenTermination !== undefined) {
        // Main quarantines the source working copy on this. It is a contained
        // outcome rather than an application fault, so it stays at warn.
        logger.warn(`Run stopped after ${elapsedMs} ms without proving its native tree died: ${unprovenTermination}`);
    } else if (abortController.signal.aborted || isAbortError(error)) {
        logger.info(`Run canceled after ${elapsedMs} ms`);
    } else {
        logger.error(
            `Run failed after ${elapsedMs} ms: `
            + (error instanceof Error ? `${getErrorMessage(error)}\n${error.stack ?? ''}` : String(error)),
            {
                code: 'MAIN_SCAN_CLEANUP_FAILED',
                context: {},
                cause: error,
            },
        );
    }
    port.postMessage({
        type: 'result',
        ok: false,
        error: getErrorMessage(error),
        errorFrame: createWorkerTaskErrorFrame(error, {source: 'scan-cleanup'}),
    });
} finally {
    await detectionResultStore?.close().catch(() => undefined);
}
