import { captureException } from '@sentry/core';
import type {
    FailureReceipt,
    FailureSeverity,
} from '@contracts/diagnostics/failureReceipt';
import { createEpochMs } from '@contracts/timestamps';

export interface IMainFailureInput {
    code: string;
    message: string;
    cause?: unknown;
    severity?: FailureSeverity;
}

/**
 * Reports a main-process failure. Until consent loads the SDK there is no
 * client and nothing is sent; the returned Error ID is still the one the UI
 * shows. Safe to import from worker bundles: it does not touch Electron.
 */
export function captureMainFailure(input: IMainFailureInput): FailureReceipt {
    const severity = input.severity ?? 'error';
    const error = input.cause instanceof Error ? input.cause : new Error(input.message);
    const eventId = captureException(error, {
        level: severity,
        tags: {diagnostic_code: input.code},
        fingerprint: [
            '{{ default }}',
            input.code,
        ],
    });
    return {
        eventId,
        code: input.code,
        occurredAt: createEpochMs(Date.now()),
        severity,
    };
}
