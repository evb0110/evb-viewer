import { getErrorMessage } from '@contracts/getErrorMessage';
import { isRecord } from '@contracts/runtimeGuards';
import {
    decodeSerializableErrorEnvelope,
    SERIALIZABLE_ERROR_ENVELOPE_SCHEMA,
} from '@contracts/serializableError';
import * as v from 'valibot';

export const MAIN_OPERATION_ERROR_PREFIX = 'EVB_MAIN_OPERATION_ERROR:';

export type TMainOperationErrorCode = 'shutting-down';

export const MAIN_OPERATION_ERROR_ENVELOPE_SCHEMA = v.object({
    ...SERIALIZABLE_ERROR_ENVELOPE_SCHEMA.entries,
    code: v.literal('shutting-down'),
});

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
    return `${MAIN_OPERATION_ERROR_PREFIX}${JSON.stringify(envelope)}`;
}

function decodeMainOperationErrorMessage(message: string): IMainOperationErrorEnvelope | null {
    const markerIndex = message.indexOf(MAIN_OPERATION_ERROR_PREFIX);
    if (markerIndex < 0) {
        return null;
    }
    const envelope = decodeSerializableErrorEnvelope(
        message.slice(markerIndex + MAIN_OPERATION_ERROR_PREFIX.length),
        MAIN_OPERATION_ERROR_ENVELOPE_SCHEMA,
        {allowBareJsonString: true},
    );
    if (envelope === null) {
        return null;
    }
    return {
        ...envelope,
        message: envelope.message.length > 0 ? envelope.message : 'Main process is shutting down',
    };
}

export function getMainOperationErrorEnvelope(error: unknown): IMainOperationErrorEnvelope | null {
    if (error instanceof MainOperationError) {
        return error.errorEnvelope;
    }
    if (isRecord(error)) {
        const parsedEnvelope = v.safeParse(MAIN_OPERATION_ERROR_ENVELOPE_SCHEMA, error.errorEnvelope, {abortEarly: true});
        if (parsedEnvelope.success) {
            return parsedEnvelope.output;
        }
        const causeEnvelope = getMainOperationErrorEnvelope(error.cause);
        if (causeEnvelope) {
            return causeEnvelope;
        }
    }
    return decodeMainOperationErrorMessage(getErrorMessage(error));
}

export function createMainOperationShuttingDownError(message = 'Main process is shutting down') {
    return new MainOperationError({
        code: 'shutting-down',
        message,
    });
}
