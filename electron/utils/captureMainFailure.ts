import { captureException } from '@sentry/core';
import { randomUUID } from 'node:crypto';
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

let preference: 'unknown' | 'denied' | 'granted' = 'unknown';
let pendingLoad: Promise<void> | null = null;
let pendingCaptures: Array<{
    input: IMainFailureInput;
    eventId: string
}> = [];

function send(input: IMainFailureInput, eventId: string) {
    const severity = input.severity ?? 'error';
    const error = input.cause instanceof Error ? input.cause : new Error(input.message);
    captureException(error, {
        event_id: eventId,
        captureContext: {
            level: severity,
            tags: {diagnostic_code: input.code},
            fingerprint: [
                '{{ default }}',
                input.code,
            ],
        },
    });
}

export function setMainFailureCaptureState(value: 'unknown' | 'denied' | 'granted', load: Promise<void> | null) {
    preference = value;
    pendingLoad = load;
    if (value !== 'granted') {
        pendingCaptures = [];
        return;
    }
    if (load !== null) {
        void load.then(() => {
            if (pendingLoad !== load || preference !== 'granted') {
                return;
            }
            pendingLoad = null;
            const captures = pendingCaptures;
            pendingCaptures = [];
            for (const capture of captures) {
                send(capture.input, capture.eventId);
            }
        }, () => {
            if (pendingLoad === load) {
                pendingLoad = null;
                pendingCaptures = [];
            }
        });
    }
}

/**
 * Reports a main-process failure. Until consent loads the SDK there is no
 * client and nothing is sent; the returned Error ID is still the one the UI
 * shows. Safe to import from worker bundles: it does not touch Electron.
 */
export function captureMainFailure(input: IMainFailureInput): FailureReceipt {
    const severity = input.severity ?? 'error';
    const eventId = randomUUID().replaceAll('-', '');
    if (preference === 'granted' && pendingLoad !== null) {
        pendingCaptures.push({
            input,
            eventId,
        });
    } else if (preference === 'granted') {
        send(input, eventId);
    }
    return {
        eventId,
        code: input.code,
        occurredAt: createEpochMs(Date.now()),
        severity,
    };
}
