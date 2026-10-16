import {
    getBrowserPageOpsWorkerRequestId,
    isBrowserWorkerResponseEnvelope,
} from '@contracts/browserPageOpsWorker';
import {
    isSerializableErrorEnvelope,
    SerializableError,
    type ISerializableErrorEnvelope,
} from '@contracts/serializableError';

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
    const responseId = getBrowserPageOpsWorkerRequestId(response);
    if (responseId === null) {
        return;
    }

    const pending = pendingRequests.get(responseId);
    if (!pending) {
        return;
    }

    pendingRequests.delete(responseId);
    if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
        pending.timeoutTimer = null;
    }
    if (!isBrowserWorkerResponseEnvelope(response)) {
        pending.reject(new Error('Browser worker returned an invalid response'));
        onSettled();
        return;
    }
    if (response.ok) {
        if (response.type !== pending.requestType) {
            pending.reject(new Error('Browser worker returned an invalid response'));
            onSettled();
            return;
        }
        if (!pending.resolveData(response.data as TResultData)) {
            pending.reject(new Error('Browser worker returned an invalid result'));
            onSettled();
            return;
        }
        onSettled();
        return;
    }

    const errorEnvelope = response.errorEnvelope;
    if (errorEnvelope !== undefined && !isErrorEnvelope(errorEnvelope)) {
        pending.reject(new Error('Browser worker returned an invalid response'));
        onSettled();
        return;
    }
    pending.reject(errorEnvelope
        ? new SerializableError(errorEnvelope)
        : new Error(response.error));
    onSettled();
}
