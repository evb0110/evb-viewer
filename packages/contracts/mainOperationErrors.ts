import {
    encodeSerializableErrorEnvelope,
    findSerializableErrorEnvelope,
    SERIALIZABLE_ERROR_ENVELOPE_SCHEMA,
} from '@contracts/serializableError';
import * as v from 'valibot';

export const MAIN_OPERATION_ERROR_ENVELOPE_SCHEMA = v.object({
    ...SERIALIZABLE_ERROR_ENVELOPE_SCHEMA.entries,
    code: v.literal('shutting-down'),
});

const mainOperationErrorEnvelopeNormalizedSchema = v.pipe(
    MAIN_OPERATION_ERROR_ENVELOPE_SCHEMA,
    v.transform((envelope) => ({
        ...envelope,
        message: envelope.message.length > 0 ? envelope.message : 'Main process is shutting down',
    })),
);

export type IMainOperationErrorEnvelope = v.InferOutput<typeof MAIN_OPERATION_ERROR_ENVELOPE_SCHEMA>;

export class MainOperationError extends Error {
    readonly errorEnvelope: IMainOperationErrorEnvelope;

    constructor(envelope: IMainOperationErrorEnvelope) {
        super(encodeMainOperationErrorEnvelope(envelope));
        this.name = 'MainOperationError';
        this.errorEnvelope = envelope;
    }
}

export function encodeMainOperationErrorEnvelope(envelope: IMainOperationErrorEnvelope) {
    return encodeSerializableErrorEnvelope(envelope);
}

export function getMainOperationErrorEnvelope(error: unknown): IMainOperationErrorEnvelope | null {
    if (error instanceof MainOperationError) {
        return error.errorEnvelope;
    }
    return findSerializableErrorEnvelope(error, mainOperationErrorEnvelopeNormalizedSchema);
}

export function createMainOperationShuttingDownError(message = 'Main process is shutting down') {
    return new MainOperationError({
        code: 'shutting-down',
        message,
    });
}
