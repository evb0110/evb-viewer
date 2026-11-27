import type {NativeErrorCode} from '@contracts/scan-cleanup/nativeWire.generated';
import {
    isOneOf,
    isRecord,
    isSuppressedErrorLike,
} from '@contracts/runtimeGuards';
import {SERIALIZABLE_ERROR_ENVELOPE_SCHEMA} from '@contracts/serializableError';
import * as v from 'valibot';

export const NATIVE_ERROR_CODES = [
    'encrypted',
    'needs-password',
    'too-large',
    'corrupt-xref',
    'unsupported-filter',
    'invalid-request',
    'io',
    'timeout',
    'panic',
    'native-failure',
] as const satisfies readonly NativeErrorCode[];

export type TNativeErrorCode = typeof NATIVE_ERROR_CODES[number];

type TAssertNativeErrorCodeParity<T extends true> = T;
export type TNativeErrorCodeBidirectionalParity = TAssertNativeErrorCodeParity<
    [Exclude<NativeErrorCode, TNativeErrorCode>] extends [never] ? true : false
>;

export const NATIVE_ERROR_ENVELOPE_SCHEMA = v.object({
    ...SERIALIZABLE_ERROR_ENVELOPE_SCHEMA.entries,
    code: v.picklist(NATIVE_ERROR_CODES),
});

export type INativeErrorEnvelope = v.InferOutput<typeof NATIVE_ERROR_ENVELOPE_SCHEMA>;

export function isNativeErrorEnvelope(value: unknown): value is INativeErrorEnvelope {
    return v.safeParse(NATIVE_ERROR_ENVELOPE_SCHEMA, value, {abortEarly: true}).success;
}

export function hasNativeErrorCode(value: unknown): value is {code: TNativeErrorCode} {
    return isRecord(value) && isOneOf(NATIVE_ERROR_CODES, value.code);
}

/**
 * Termination is a request until something proves the target is gone. A process
 * group that outlives its kill, a `taskkill` that reports failure, and a
 * termination watchdog that fires before the tree is confirmed dead all leave
 * native readers holding the files the caller was about to reclaim.
 *
 * The layers that ask for termination cannot decide what to do about that; the
 * layer that owns the bytes can. So the outcome travels on the error the
 * termination produced, from the native adapter that observed it up to the
 * working-copy owner that would otherwise delete a directory a live child is
 * still reading.
 */
const UNPROVEN_NATIVE_TERMINATION = Symbol.for('evb.unprovenNativeTermination');

interface IUnprovenNativeTerminationCarrier {[UNPROVEN_NATIVE_TERMINATION]?: string | null;}

export function markUnprovenNativeTermination<T>(error: T, detail: string): T {
    if (typeof error === 'object' && error !== null) {
        const carrier = error as IUnprovenNativeTerminationCarrier;
        // First observation wins: the innermost adapter saw the process tree
        // itself, and re-labelling it from a wrapper would lose that detail.
        carrier[UNPROVEN_NATIVE_TERMINATION] ??= detail;
    }
    return error;
}

// An AggregateError or SuppressedError answers with the first mark among its
// members, so code that cannot import this module, or resource disposal that
// wraps an unproven-termination failure in a SuppressedError, cannot hide it.
export function getUnprovenNativeTerminationDetail(error: unknown): string | undefined {
    const seen = new Set<object>();
    const stack: unknown[] = [error];

    while (stack.length > 0) {
        const candidate = stack.pop();
        if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) {
            continue;
        }
        seen.add(candidate);

        const detail = (candidate as IUnprovenNativeTerminationCarrier)[UNPROVEN_NATIVE_TERMINATION];
        if (typeof detail === 'string') {
            return detail;
        }

        if (candidate instanceof AggregateError) {
            for (let index = candidate.errors.length - 1; index >= 0; index -= 1) {
                stack.push(candidate.errors[index]);
            }
        }
        if (isSuppressedErrorLike(candidate)) {
            // Check `.suppressed` (primary error) before `.error` (disposer error).
            stack.push(candidate.error);
            stack.push(candidate.suppressed);
        }
    }

    return undefined;
}
