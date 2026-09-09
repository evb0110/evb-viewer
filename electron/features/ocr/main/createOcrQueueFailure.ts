import type { TOcrErrorCode } from '@contracts/electronApiOcr';
import {
    requireJobId,
    type TJobId,
    type TRequestId,
} from '@contracts/shared';

export interface IOcrQueueStartResult {
    started: boolean;
    jobId: TJobId;
    error?: string;
    errorCode?: TOcrErrorCode;
}

export function createOcrQueueFailure(
    requestId: TRequestId,
    error: string,
    errorCode: TOcrErrorCode = 'OCR_INTERNAL_ERROR',
): IOcrQueueStartResult {
    return {
        started: false,
        jobId: requireJobId(requestId),
        error,
        errorCode,
    };
}
