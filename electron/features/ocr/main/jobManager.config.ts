import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { getOcrRuntimePolicy } from '@electron/features/ocr/main/ocrRuntimePolicy';

export function getOcrWorkerPoolSize() {
    return getOcrRuntimePolicy().workerPoolSize;
}

export const OCR_QUEUE_MAX_SIZE = parseIntegerEnv('EVB_OCR_QUEUE_MAX_SIZE', 8, 1);
export const OCR_QUEUE_MAX_BUFFERED_BYTES = parseIntegerEnv('EVB_OCR_QUEUE_MAX_BUFFERED_MB', 768, 32) * 1024 * 1024;
export const OCR_QUEUE_MAX_AGE_MS = parseIntegerEnv('EVB_OCR_QUEUE_MAX_AGE_MS', 10 * 60 * 1000, 5_000);
export const OCR_RESULT_FILE_ACK_TTL_MS = parseIntegerEnv('EVB_OCR_RESULT_FILE_TTL_MS', 15 * 60 * 1000, 60_000);
export const OCR_JOB_IDLE_TIMEOUT_MS = parseIntegerEnv(
    'EVB_OCR_JOB_IDLE_TIMEOUT_MS',
    parseIntegerEnv('EVB_OCR_JOB_MAX_RUNTIME_MS', 15 * 60 * 1000, 15_000),
    15_000,
);
export const OCR_MODEL_PREP_TIMEOUT_MS = parseIntegerEnv('EVB_OCR_MODEL_PREP_TIMEOUT_MS', 2 * 60 * 1000, 10_000);
export const OCR_WORKER_TERMINATE_TIMEOUT_MS = parseIntegerEnv('EVB_OCR_WORKER_TERMINATE_TIMEOUT_MS', 10_000, 1_000);
