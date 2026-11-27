import {randomUUID} from 'node:crypto';
import type {FailureReceipt, FailureSeverity} from '@contracts/diagnostics/failureReceipt';
import {createEpochMs} from '@contracts/timestamps';

export interface IMainFailureInput {
    code: string;
    message: string;
    cause?: unknown;
    severity?: FailureSeverity;
}

export type TMainFailureCaptureSender = (
    error: Error,
    hint: {
        event_id: string;
        captureContext: {
            level: FailureSeverity;
            tags: {diagnostic_code: string};
            fingerprint: string[];
        };
    },
) => unknown;

let preference: 'unknown' | 'denied' | 'granted' = 'unknown';
let pendingLoad: Promise<void> | null = null;
let managedBySdk = false;
let captureSender: TMainFailureCaptureSender | null = null;
let fallbackSenderLoad: Promise<TMainFailureCaptureSender | null> | null = null;
let pendingCaptures: Array<{
    input: IMainFailureInput;
    eventId: string;
}> = [];

function loadFallbackCaptureSender() {
    fallbackSenderLoad ??= import('@sentry/core').then(
        (core) => {
            captureSender ??= core.captureException;
            return captureSender;
        },
        () => {
            fallbackSenderLoad = null;
            return null;
        },
    );
    return fallbackSenderLoad;
}

export function registerMainFailureCaptureSender(sender: TMainFailureCaptureSender | null) {
    captureSender = sender;
}

function dispatchCapture(sender: TMainFailureCaptureSender, input: IMainFailureInput, eventId: string) {
    const severity = input.severity ?? 'error';
    const error = input.cause instanceof Error ? input.cause : new Error(input.message);
    sender(error, {
        event_id: eventId,
        captureContext: {
            level: severity,
            tags: {diagnostic_code: input.code},
            fingerprint: ['{{ default }}', input.code],
        },
    });
}

function send(input: IMainFailureInput, eventId: string) {
    if (captureSender !== null) {
        dispatchCapture(captureSender, input, eventId);
        return;
    }
    if (managedBySdk) {
        return;
    }
    void loadFallbackCaptureSender().then((sender) => {
        if (sender !== null && preference === 'granted') {
            dispatchCapture(sender, input, eventId);
        }
    });
}

function flushPendingCaptures() {
    const captures = pendingCaptures;
    pendingCaptures = [];
    for (const capture of captures) {
        send(capture.input, capture.eventId);
    }
}

export function setMainFailureCaptureState(
    value: 'unknown' | 'denied' | 'granted',
    load: Promise<void> | null,
    options?: {managedBySdk?: boolean},
) {
    preference = value;
    pendingLoad = load;
    managedBySdk = options?.managedBySdk === true;
    if (value !== 'granted') {
        pendingCaptures = [];
        return;
    }
    if (!managedBySdk && captureSender === null) {
        void loadFallbackCaptureSender();
    }
    if (load === null) {
        if (pendingCaptures.length > 0) {
            if (managedBySdk && captureSender === null) {
                pendingCaptures = [];
            } else {
                flushPendingCaptures();
            }
        }
        return;
    }
    void load.then(
        () => {
            if (pendingLoad !== load || preference !== 'granted') {
                return;
            }
            pendingLoad = null;
            flushPendingCaptures();
        },
        () => {
            if (pendingLoad === load) {
                pendingLoad = null;
                pendingCaptures = [];
            }
        },
    );
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
