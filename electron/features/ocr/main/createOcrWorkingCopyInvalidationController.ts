import type {
    IOcrActiveJob,
    IOcrPreparingJob,
} from '@electron/features/ocr/main/jobManager.types';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';

interface IOcrWorkingCopyInvalidationLogger { info(message: string): void; }

interface IOcrWorkingCopyInvalidationControllerOptions {
    activeJobs: Map<string, IOcrActiveJob>;
    cancelJob: (scopedJobId: string, reason: string) => boolean;
    logger: IOcrWorkingCopyInvalidationLogger;
    preparingJobs: Map<string, IOcrPreparingJob>;
}

function getOcrSourcePathKey(sourcePdfPath: string) {
    return normalizePathForLookup(sourcePdfPath) || sourcePdfPath;
}

export function createOcrWorkingCopyInvalidationController(options: IOcrWorkingCopyInvalidationControllerOptions) {
    function cancelOcrJobsForWorkingCopy(workingCopyPath: string, reason: string) {
        const targetPathKey = getOcrSourcePathKey(workingCopyPath);
        let canceledCount = 0;

        for (const preparingJob of Array.from(options.preparingJobs.values())) {
            if (getOcrSourcePathKey(preparingJob.sourcePdfPath) !== targetPathKey) {
                continue;
            }

            if (options.cancelJob(preparingJob.scopedJobId, reason)) {
                canceledCount += 1;
                options.logger.info(`[${preparingJob.requestId}] Cancelled preparing OCR job for stale working copy: ${reason}`);
            }
        }

        const activeForWorkingCopy = Array.from(options.activeJobs.values())
            .filter(activeJob => getOcrSourcePathKey(activeJob.sourcePdfPath) === targetPathKey);
        for (const activeJob of activeForWorkingCopy) {
            if (options.cancelJob(activeJob.scopedJobId, reason)) {
                canceledCount += 1;
                options.logger.info(`[${activeJob.requestId}] Cancelled active OCR job for stale working copy: ${reason}`);
            }
        }

        return canceledCount;
    }

    return { cancelOcrJobsForWorkingCopy };
}
