export interface IRafCoalescedCallback<TArgs extends unknown[]> {
    schedule: (...args: TArgs) => void;
    flush: (...args: TArgs) => void;
    flushPending: () => void;
    cancel: () => void;
}

export interface IRafCoalescedCallbackEnvironment {
    requestAnimationFrame: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame: (handle: number) => void;
}

function getDefaultEnvironment(): IRafCoalescedCallbackEnvironment | null {
    return typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function' ? window : null;
}

export function createRafCoalescedCallback<TArgs extends unknown[]>(
    callback: (...args: TArgs) => void,
    environment = getDefaultEnvironment(),
): IRafCoalescedCallback<TArgs> {
    let frameHandle: number | null = null;
    let pendingArgs: TArgs | null = null;

    function invokePending() {
        const args = pendingArgs;
        pendingArgs = null;
        frameHandle = null;
        if (args) {
            callback(...args);
        }
    }

    function schedule(...args: TArgs) {
        pendingArgs = args;
        if (!environment) {
            invokePending();
            return;
        }
        if (frameHandle !== null) {
            return;
        }
        frameHandle = environment.requestAnimationFrame(invokePending);
    }

    function flushPending() {
        if (frameHandle !== null && environment) {
            environment.cancelAnimationFrame(frameHandle);
        }
        invokePending();
    }

    function flush(...args: TArgs) {
        pendingArgs = args;
        flushPending();
    }

    function cancel() {
        if (frameHandle !== null && environment) {
            environment.cancelAnimationFrame(frameHandle);
        }
        frameHandle = null;
        pendingArgs = null;
    }

    return {
        schedule,
        flush,
        flushPending,
        cancel,
    };
}
