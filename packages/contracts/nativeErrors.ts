import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    SERIALIZABLE_ERROR_ENVELOPE_SCHEMA, findSerializableErrorEnvelope,
} from '@contracts/serializableError';
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
] as const;

export type TNativeErrorCode = typeof NATIVE_ERROR_CODES[number];

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

const PDF_STRUCTURE_REFUSAL_SCHEMA = v.object({
    ...NATIVE_ERROR_ENVELOPE_SCHEMA.entries,
    code: v.literal('invalid-request'),
    message: v.pipe(v.string(), v.check(message => message.startsWith('ERR_PDF_STRUCTURE_PRESERVATION:'))),
});

export function findPdfStructurePreservationRefusal(value: unknown) {
    return findSerializableErrorEnvelope(value, PDF_STRUCTURE_REFUSAL_SCHEMA);
}

export function isPdfStructurePreservationRefusal(value: unknown): boolean {
    return findPdfStructurePreservationRefusal(value) !== null;
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

// An AggregateError answers with the first mark among its members, so code that
// cannot import this module, such as the scan-cleanup package, can join failures in one.
export function getUnprovenNativeTerminationDetail(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }
    const detail = (error as IUnprovenNativeTerminationCarrier)[UNPROVEN_NATIVE_TERMINATION];
    if (typeof detail === 'string') {
        return detail;
    }
    return error instanceof AggregateError
        ? error.errors.map(getUnprovenNativeTerminationDetail).find(memberDetail => memberDetail !== undefined)
        : undefined;
}
