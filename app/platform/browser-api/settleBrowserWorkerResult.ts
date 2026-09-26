import { isRecord } from '@contracts/runtimeGuards';
import {
    isSerializableErrorEnvelope,
    SerializableError,
    type ISerializableErrorEnvelope,
} from '@contracts/serializableError';
import * as v from 'valibot';

export interface IPendingBrowserWorkerRequest {
    requestType: string;
    resolveData: (data: unknown) => boolean;
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}

export interface ITypedPendingBrowserWorkerRequest<
    TRequestType extends string,
    TResultData,
> {
    requestType: TRequestType;
    resolveData: (data: TResultData) => boolean;
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}

type TSerializableErrorEnvelopeGuard = (
    value: unknown,
) => value is ISerializableErrorEnvelope;

function getWorkerResponseId(response: unknown) {
    return isRecord(response) && typeof response.id === 'number'
        ? response.id
        : null;
}

export function settleBrowserWorkerResult<
    TRequestType extends string,
    TResultData,
    TPendingRequest extends ITypedPendingBrowserWorkerRequest<TRequestType, TResultData>,
>(
    pendingRequests: Map<number, TPendingRequest>,
    response: unknown,
    onSettled: () => void,
    isErrorEnvelope: TSerializableErrorEnvelopeGuard = isSerializableErrorEnvelope,
) {
    const responseId = getWorkerResponseId(response);
    if (responseId === null) {
        return;
    }

    const pending = pendingRequests.get(responseId);
    if (!pending) {
        return;
    }

    const result = v.safeParse(v.union([
        v.pipe(
            v.object({
                id: v.number(),
                ok: v.literal(true),
                type: v.string(),
                data: v.unknown(),
            }),
            // v.unknown accepts undefined; worker success responses require the data member.
            v.check(value => 'data' in value),
        ),
        v.object({
            id: v.number(),
            ok: v.literal(false),
            error: v.string(),
            errorEnvelope: v.optional(v.custom<ISerializableErrorEnvelope>(isErrorEnvelope)),
        }),
    ]), response, {abortEarly: true});

    pendingRequests.delete(responseId);
    if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
        pending.timeoutTimer = null;
    }
    if (!result.success) {
        pending.reject(new Error('Browser worker returned an invalid response'));
        onSettled();
        return;
    }
    if (result.output.ok) {
        if (result.output.type !== pending.requestType) {
            pending.reject(new Error('Browser worker returned an invalid response'));
            onSettled();
            return;
        }
        if (!pending.resolveData(result.output.data as TResultData)) {
            pending.reject(new Error('Browser worker returned an invalid result'));
            onSettled();
            return;
        }
        onSettled();
        return;
    }

    pending.reject(result.output.errorEnvelope
        ? new SerializableError(result.output.errorEnvelope)
        : new Error(result.output.error));
    onSettled();
}
