import { sumBy } from 'es-toolkit/math';
import {
    OCR_QUEUE_MAX_BUFFERED_BYTES,
    OCR_QUEUE_MAX_SIZE,
} from '@electron/features/ocr/main/jobManager.config';
import type {
    IOcrActiveJob,
    IOcrPreparingJob,
} from '@electron/features/ocr/main/jobManager.types';

interface IOcrQueueState {
    activeJobs: Iterable<IOcrActiveJob>;
    preparingJobs: ReadonlyMap<string, IOcrPreparingJob>;
}

interface IOcrQueueCapacityOptions {excludePreparingJobId?: string;}

export type TOcrQueueCapacityResult = {ok: true} | {
    ok: false;
    error: string
};

export function getBufferedOcrBytes(state: IOcrQueueState, options: IOcrQueueCapacityOptions = {}) {
    const preparing = sumBy([...state.preparingJobs.values()], job =>
        job.scopedJobId === options.excludePreparingJobId ? 0 : job.requestedBytes);
    return preparing
        + sumBy([...state.activeJobs], job => job.requestedBytes);
}

export function ensureOcrQueueCapacity(
    state: IOcrQueueState,
    additionalBytes: number,
    options: IOcrQueueCapacityOptions = {},
): TOcrQueueCapacityResult {
    const preparingCount = options.excludePreparingJobId === undefined
        ? state.preparingJobs.size
        : state.preparingJobs.size - (state.preparingJobs.has(options.excludePreparingJobId) ? 1 : 0);
    if (preparingCount >= OCR_QUEUE_MAX_SIZE) {
        return {
            ok: false,
            error: `OCR queue is full (${OCR_QUEUE_MAX_SIZE} jobs)`,
        };
    }
    if (getBufferedOcrBytes(state, options) + additionalBytes > OCR_QUEUE_MAX_BUFFERED_BYTES) {
        return {
            ok: false,
            error: `OCR queue is full (buffer cap ${Math.floor(OCR_QUEUE_MAX_BUFFERED_BYTES / (1024 * 1024))}MB reached)`,
        };
    }
    return {ok: true};
}
