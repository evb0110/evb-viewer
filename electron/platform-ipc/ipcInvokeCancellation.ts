import type {WebContents} from 'electron';
import {createAbortError} from '@contracts/isAbortError';
import type {TRequestId} from '@contracts/shared';

interface IIpcInvokeCancellationRegistration {
    readonly signal: AbortSignal;
    complete: () => void;
}

// Keyed by sender so a renderer that goes away takes its entries with it, and
// so one renderer can never cancel another's invoke by guessing a request id.
const activeInvokes = new WeakMap<object, Map<TRequestId, AbortController>>();

export function beginIpcInvokeCancellation(
    sender: WebContents,
    requestId: TRequestId,
): IIpcInvokeCancellationRegistration {
    const senderInvokes = activeInvokes.get(sender) ?? new Map<TRequestId, AbortController>();
    const controller = new AbortController();
    senderInvokes.set(requestId, controller);
    activeInvokes.set(sender, senderInvokes);

    return {
        signal: controller.signal,
        complete: () => {
            if (senderInvokes.get(requestId) !== controller) {
                return;
            }
            senderInvokes.delete(requestId);
            if (senderInvokes.size === 0) {
                activeInvokes.delete(sender);
            }
        },
    };
}

function createIpcInvokeTimeoutError(reason: string) {
    const error = new Error(reason);
    error.name = 'TimeoutError';
    return error;
}

export function cancelIpcInvoke(
    sender: WebContents,
    requestId: TRequestId,
    reason?: string,
    options?: {timedOut?: boolean},
) {
    const controller = activeInvokes.get(sender)?.get(requestId);
    if (!controller || controller.signal.aborted) {
        return;
    }
    const timedOut = options?.timedOut === true;
    const effectiveReason = reason ?? (timedOut ? 'IPC invoke timed out' : 'IPC invoke canceled');
    controller.abort(timedOut ? createIpcInvokeTimeoutError(effectiveReason) : createAbortError(effectiveReason));
}
