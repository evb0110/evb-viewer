import type {WebContents} from 'electron';
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

export function cancelIpcInvoke(sender: WebContents, requestId: TRequestId, reason = 'IPC invoke canceled') {
    const controller = activeInvokes.get(sender)?.get(requestId);
    if (!controller || controller.signal.aborted) {
        return;
    }
    controller.abort(new Error(reason));
}
