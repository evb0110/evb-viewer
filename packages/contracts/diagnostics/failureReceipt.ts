/* eslint-disable @typescript-eslint/naming-convention */

import {
    isEpochMs,
    type TEpochMs,
} from '@contracts/timestamps';

export type FailureSeverity = 'error' | 'fatal';

export interface LocalFailureDetail {
    source: string;
    message: string;
    cause?: unknown;
    data?: unknown;
}

/** `code` is a free-form tag such as `MAIN_SAVE_FAILED`; Sentry groups by stack. */
export interface CaptureFailureInput {
    code: string;
    severity?: FailureSeverity;
    local: LocalFailureDetail;
}

/**
 * The Error ID the UI shows and a user can quote. `eventId` is the Sentry
 * event ID when the report was sent, and a local ID of the same shape when it
 * was not.
 */
export interface FailureReceipt {
    eventId: string;
    code: string;
    occurredAt: TEpochMs;
    severity: FailureSeverity;
}

const FAILURE_RECEIPT_KEYS = [
    'eventId',
    'code',
    'occurredAt',
    'severity',
] as const;
const EVENT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,79}$/u;

export function isFailureEventId(value: unknown): value is string {
    return typeof value === 'string' && EVENT_ID_PATTERN.test(value);
}

export function isFailureCode(value: unknown): value is string {
    return typeof value === 'string' && CODE_PATTERN.test(value);
}

export function isFailureSeverity(value: unknown): value is FailureSeverity {
    return value === 'error' || value === 'fatal';
}

export function decodeFailureReceipt(value: unknown): FailureReceipt | null {
    if (!isPlainRecord(value)) {
        return null;
    }
    try {
        const keys = Reflect.ownKeys(value);
        if (
            keys.length !== FAILURE_RECEIPT_KEYS.length
            || !keys.every(key => typeof key === 'string' && FAILURE_RECEIPT_KEYS.some(allowedKey => allowedKey === key))
            || !isFailureEventId(value.eventId)
            || !isFailureCode(value.code)
            || !isEpochMs(value.occurredAt)
            || !isFailureSeverity(value.severity)
        ) {
            return null;
        }
        return {
            eventId: value.eventId,
            code: value.code,
            occurredAt: value.occurredAt,
            severity: value.severity,
        };
    } catch {
        return null;
    }
}

export function getFailureReceipt(value: unknown): FailureReceipt | undefined {
    if (typeof value !== 'object' || value === null || !('failure' in value)) {
        return undefined;
    }
    return decodeFailureReceipt(value.failure) ?? undefined;
}

export const EXPECTED_OUTCOME_CODES = [
    'canceled',
    'validation-rejected',
    'unsupported-input',
    'handled-absence',
    'temporarily-unavailable',
] as const;

export type ExpectedOutcomeCode = typeof EXPECTED_OUTCOME_CODES[number];

export interface ExpectedOutcome {
    kind: 'expected';
    code: ExpectedOutcomeCode;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

export function isExpectedOutcome(value: unknown): value is ExpectedOutcome {
    if (!isPlainRecord(value)) {
        return false;
    }
    try {
        const keys = Reflect.ownKeys(value);
        return keys.length === 2
            && keys.every(key => key === 'kind' || key === 'code')
            && Object.hasOwn(value, 'kind')
            && Object.hasOwn(value, 'code')
            && value.kind === 'expected'
            && typeof value.code === 'string'
            && EXPECTED_OUTCOME_CODES.some(code => code === value.code);
    } catch {
        return false;
    }
}
