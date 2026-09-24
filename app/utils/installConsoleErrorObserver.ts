import {
    notifyRendererDiagnosticNotice,
    redactRendererDiagnosticSignature,
} from '@app/utils/rendererDiagnosticNotices';

type TConsoleError = (...args: unknown[]) => unknown;

export interface IConsoleErrorTarget {error: TConsoleError;}

export interface IConsoleErrorObserverHandle {cleanup: () => void;}

const activeObservers = new WeakMap<object, IConsoleErrorObserverHandle>();

/** The first stack frame outside the observer, never the console arguments. */
function readCallSite(observer: TConsoleError) {
    const holder: {stack?: string} = {};
    Error.captureStackTrace(holder, observer);
    const frame = holder.stack?.split('\n').find(line => line.trim().startsWith('at ')) ?? 'unknown';
    return frame.trim().replace(/^at /u, '');
}

/**
 * Wraps `console.error` so the renderer error guard's notice subscribers see
 * console errors. The original sink always runs with the untouched arguments.
 */
export function installConsoleErrorObserver(target: IConsoleErrorTarget = console): IConsoleErrorObserverHandle {
    const active = activeObservers.get(target);
    if (active) {
        return active;
    }
    const originalError = target.error;
    let reentrant = false;

    function observedConsoleError(this: unknown, ...args: unknown[]) {
        Reflect.apply(originalError, this ?? target, args);
        if (reentrant) {
            return;
        }
        reentrant = true;
        try {
            notifyRendererDiagnosticNotice({
                occurredAt: Date.now(),
                signature: redactRendererDiagnosticSignature(`console-error ${readCallSite(observedConsoleError)}`),
                source: 'console-error',
            });
        } catch {
            // The original console call already ran.
        } finally {
            reentrant = false;
        }
    }

    const handle: IConsoleErrorObserverHandle = {cleanup: () => {
        if (target.error === observedConsoleError) {
            target.error = originalError;
        }
        activeObservers.delete(target);
    }};
    target.error = observedConsoleError;
    activeObservers.set(target, handle);
    return handle;
}
