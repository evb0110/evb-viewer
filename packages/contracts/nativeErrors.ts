import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import type {ISerializableErrorEnvelope} from '@contracts/serializableError';

export const NATIVE_ERROR_CODES = [
    'encrypted',
    'needs-password',
    'too-large',
    'corrupt-xref',
    'unsupported-filter',
    'invalid-request',
    'io',
    'panic',
    'native-failure',
] as const;

export type TNativeErrorCode = typeof NATIVE_ERROR_CODES[number];

export interface INativeErrorEnvelope extends ISerializableErrorEnvelope<TNativeErrorCode> {}

export function isNativeErrorEnvelope(value: unknown): value is INativeErrorEnvelope {
    return isRecord(value)
        && isOneOf(NATIVE_ERROR_CODES, value.code)
        && typeof value.message === 'string';
}

export function hasNativeErrorCode(value: unknown): value is {code: TNativeErrorCode} {
    return isRecord(value) && isOneOf(NATIVE_ERROR_CODES, value.code);
}
