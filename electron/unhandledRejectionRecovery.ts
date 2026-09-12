import { getErrorMessage } from '@electron/utils/error';
import { isAbortError } from '@electron/utils/abort';

export type TMainSubsystem = 'agent' | 'djvu' | 'documents' | 'ocr' | 'search' | 'unknown';
type TRecoverableMainSubsystem = Exclude<TMainSubsystem, 'unknown'>;

interface ISubsystemTaggedValue {subsystem: TRecoverableMainSubsystem;}

interface IUnhandledRejectionRecoveryOptions {
    threshold?: number;
    windowMs?: number;
    now?: () => number;
    recover(subsystem: TRecoverableMainSubsystem, reason: unknown): Promise<void> | void;
}

export type TUnhandledRejectionDecision =
    | {action: 'ignore'}
    | {action: 'report'}
    | {
        action: 'recover';
        subsystem: TRecoverableMainSubsystem;
    };

const SUBSYSTEM_MESSAGE_PATTERNS: Array<[TMainSubsystem, RegExp]> = [
    [
        'ocr',
        /(?:ocr job|tesseract)/iu,
    ],
    [
        'search',
        /search worker/iu,
    ],
    [
        'djvu',
        /(?:ddjvu|djvm)/iu,
    ],
    [
        'agent',
        /(?:^|[\s:])assistant(?:\s|$)|mcp server/imu,
    ],
    [
        'documents',
        /(?:working copy|pdf mutation)/iu,
    ],
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isRecoverableMainSubsystem(value: unknown): value is TRecoverableMainSubsystem {
    return value === 'agent'
        || value === 'djvu'
        || value === 'documents'
        || value === 'ocr'
        || value === 'search';
}

function isSubsystemTaggedValue(value: unknown): value is ISubsystemTaggedValue {
    return isRecord(value) && isRecoverableMainSubsystem(value.subsystem);
}

function readTaggedSubsystem(reason: unknown): TRecoverableMainSubsystem | null {
    const seen = new Set<unknown>();
    let current: unknown = reason;
    while (isRecord(current) && !seen.has(current)) {
        seen.add(current);
        if (isSubsystemTaggedValue(current)) {
            return current.subsystem;
        }
        current = current.cause;
    }
    return null;
}

function readStableSubsystemCode(reason: unknown): TRecoverableMainSubsystem | null {
    if (!isRecord(reason) || typeof reason.code !== 'string') {
        return null;
    }
    if (/^OCR_/u.test(reason.code)) {
        return 'ocr';
    }
    if (/^SEARCH_/u.test(reason.code)) {
        return 'search';
    }
    return null;
}

export function classifyUnhandledRejectionSubsystem(reason: unknown): TMainSubsystem {
    const taggedSubsystem = readTaggedSubsystem(reason) ?? readStableSubsystemCode(reason);
    if (taggedSubsystem) {
        return taggedSubsystem;
    }
    const details = reason instanceof Error
        ? `${getErrorMessage(reason)}\n${reason.stack ?? ''}`
        : getErrorMessage(reason);
    return SUBSYSTEM_MESSAGE_PATTERNS.find(([
        , pattern,
    ]) => pattern.test(details))?.[0] ?? 'unknown';
}

export function decideUnhandledRejection(reason: unknown): TUnhandledRejectionDecision {
    if (isAbortError(reason)) {
        return {action: 'ignore'};
    }

    const subsystem = classifyUnhandledRejectionSubsystem(reason);
    return subsystem === 'unknown'
        ? {action: 'report'}
        : {
            action: 'recover',
            subsystem,
        };
}

export function createUnhandledRejectionRecovery(options: IUnhandledRejectionRecoveryOptions) {
    const threshold = Math.max(2, options.threshold ?? 3);
    const windowMs = Math.max(1_000, options.windowMs ?? 60_000);
    const now = options.now ?? Date.now;
    const failures = new Map<TRecoverableMainSubsystem, number[]>();
    const recovering = new Set<TRecoverableMainSubsystem>();

    return async (subsystem: TRecoverableMainSubsystem, reason: unknown) => {
        const cutoff = now() - windowMs;
        const recent = (failures.get(subsystem) ?? []).filter(timestamp => timestamp >= cutoff);
        recent.push(now());
        failures.set(subsystem, recent);
        if (recent.length < threshold || recovering.has(subsystem)) {
            return {
                subsystem,
                recovered: false,
                count: recent.length,
            };
        }

        failures.delete(subsystem);
        recovering.add(subsystem);
        try {
            await options.recover(subsystem, reason);
            return {
                subsystem,
                recovered: true,
                count: recent.length,
            };
        } finally {
            recovering.delete(subsystem);
        }
    };
}
