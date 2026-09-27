import {isRecord} from '@contracts/runtimeGuards';
import * as v from 'valibot';

export const SERIALIZABLE_ERROR_PREFIX = 'EVB_SERIALIZABLE_ERROR:';

export const SERIALIZABLE_ERROR_ENVELOPE_SCHEMA = v.object({
    code: v.pipe(v.string(), v.minLength(1)),
    message: v.string(),
    details: v.optional(v.unknown()),
    retryable: v.optional(v.boolean()),
});

type TSerializableErrorEnvelope = v.InferOutput<typeof SERIALIZABLE_ERROR_ENVELOPE_SCHEMA>;

export type ISerializableErrorEnvelope<TCode extends string = string, TDetails = unknown> =
    Readonly<Omit<TSerializableErrorEnvelope, 'code' | 'details'>> & {
        code: TCode;
        details?: TDetails;
    };

export function isSerializableErrorEnvelope(value: unknown): value is ISerializableErrorEnvelope {
    return v.safeParse(SERIALIZABLE_ERROR_ENVELOPE_SCHEMA, value, {abortEarly: true}).success;
}

type TSerializableErrorEnvelopeSchema<TEnvelope extends ISerializableErrorEnvelope> =
    v.GenericSchema<unknown, TEnvelope>;

interface IDecodeSerializableErrorEnvelopeOptions {allowBareJsonString?: boolean;}

function decodeSerializableErrorPayload(
    value: unknown,
    options: IDecodeSerializableErrorEnvelopeOptions,
): unknown {
    if (typeof value !== 'string') {
        return value;
    }
    const markerIndex = value.indexOf(SERIALIZABLE_ERROR_PREFIX);
    if (markerIndex < 0 && options.allowBareJsonString !== true) {
        return null;
    }
    const encoded = markerIndex >= 0
        ? value.slice(markerIndex + SERIALIZABLE_ERROR_PREFIX.length).trim()
        : value.trim();
    if (!encoded.startsWith('{')) {
        return null;
    }
    try {
        return JSON.parse(encoded) as unknown;
    } catch {
        return null;
    }
}

export function encodeSerializableErrorEnvelope(envelope: ISerializableErrorEnvelope) {
    return `${SERIALIZABLE_ERROR_PREFIX}${JSON.stringify(envelope)}`;
}

export function decodeSerializableErrorEnvelope<TEnvelope extends ISerializableErrorEnvelope>(
    value: unknown,
    schema: TSerializableErrorEnvelopeSchema<TEnvelope>,
    options: IDecodeSerializableErrorEnvelopeOptions = {},
): TEnvelope | null {
    const decoded = decodeSerializableErrorPayload(value, options);
    const result = v.safeParse(schema, decoded, {abortEarly: true});
    return result.success ? result.output : null;
}

export function findSerializableErrorEnvelope<TEnvelope extends ISerializableErrorEnvelope>(
    value: unknown,
    schema: TSerializableErrorEnvelopeSchema<TEnvelope>,
): TEnvelope | null {
    const seen = new Set<object>();
    let candidate: unknown = value;
    while (candidate !== null && candidate !== undefined) {
        const decoded = decodeSerializableErrorEnvelope(candidate, schema);
        if (decoded) {
            return decoded;
        }
        if (!isRecord(candidate) || seen.has(candidate)) {
            return null;
        }
        seen.add(candidate);
        const ownEnvelope = decodeSerializableErrorEnvelope(candidate.errorEnvelope, schema);
        if (ownEnvelope) {
            return ownEnvelope;
        }
        const messageEnvelope = decodeSerializableErrorEnvelope(candidate.message, schema);
        if (messageEnvelope) {
            return messageEnvelope;
        }
        candidate = candidate.cause;
    }
    return null;
}

export class SerializableError<TEnvelope extends ISerializableErrorEnvelope> extends Error {
    readonly errorEnvelope: TEnvelope;
    readonly code: TEnvelope['code'];

    constructor(envelope: TEnvelope) {
        super(envelope.message);
        this.name = 'SerializableError';
        this.errorEnvelope = envelope;
        this.code = envelope.code;
    }
}
