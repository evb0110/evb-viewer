import {
    isOneOf,
    isRecord,
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
