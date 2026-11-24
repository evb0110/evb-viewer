const DEFAULT_SCROLL_SETTLE_DELAY_MS = 120;
// Cap continuous deferral well below PDF_PAGE_TEXT_LAYER_TIMEOUT_MS (15_000 ms)
// so a sustained scroll over a single still-visible page never triggers a stage
// timeout toast.
const DEFAULT_MAX_DEFERRAL_MS = 2_000;

interface IScrollSettleWaiter {
    resolve: () => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
}

interface IViewportMotionState {
    settleTimer: ReturnType<typeof setTimeout> | null;
    waiters: Set<IScrollSettleWaiter>;
}

export interface IPdfViewportScrollActivity {
    isMotionActive: (container?: HTMLElement | null) => boolean;
    markMotion: (container: HTMLElement | null) => void;
    flushSettled: (container: HTMLElement | null) => void;
    waitUntilSettled: (container: HTMLElement | null, signal?: AbortSignal) => Promise<void>;
    observeViewport: (container: HTMLElement) => () => void;
    releaseViewport: (container: HTMLElement) => void;
    reset: () => void;
}

interface ICreatePdfViewportScrollActivityOptions {
    settleDelayMs?: number | undefined;
    maxDeferralMs?: number | undefined;
}

function createAbortError() {
    return new DOMException('Text layer rendering was cancelled', 'AbortError');
}

export function createPdfViewportScrollActivityTracker(
    options: ICreatePdfViewportScrollActivityOptions = {},
): IPdfViewportScrollActivity {
    const settleDelayMs = options.settleDelayMs ?? DEFAULT_SCROLL_SETTLE_DELAY_MS;
    const maxDeferralMs = options.maxDeferralMs ?? DEFAULT_MAX_DEFERRAL_MS;
    const activeByViewport = new Map<HTMLElement, IViewportMotionState>();
    const globalWaiters = new Set<IScrollSettleWaiter>();

    function resolveWaiters(waiters: Set<IScrollSettleWaiter>) {
        if (waiters.size === 0) {
            return;
        }
        const snapshot = [...waiters];
        waiters.clear();
        for (const waiter of snapshot) {
            waiter.cleanup();
            waiter.resolve();
        }
    }

    function settleViewport(container: HTMLElement) {
        const state = activeByViewport.get(container);
        if (!state) {
            return;
        }
        if (state.settleTimer !== null) {
            clearTimeout(state.settleTimer);
            state.settleTimer = null;
        }
        activeByViewport.delete(container);
        resolveWaiters(state.waiters);
        if (activeByViewport.size === 0) {
            resolveWaiters(globalWaiters);
        }
    }

    function pruneDisconnectedViewports() {
        for (const container of [...activeByViewport.keys()]) {
            if (container.isConnected === false) {
                settleViewport(container);
            }
        }
    }

    function isMotionActive(container?: HTMLElement | null) {
        pruneDisconnectedViewports();
        if (container) {
            return activeByViewport.has(container);
        }
        return activeByViewport.size > 0;
    }

    function markMotion(container: HTMLElement | null) {
        if (!container || container.isConnected === false) {
            return;
        }
        let state = activeByViewport.get(container);
        if (!state) {
            state = {
                settleTimer: null,
                waiters: new Set(),
            };
            activeByViewport.set(container, state);
        }
        if (state.settleTimer !== null) {
            clearTimeout(state.settleTimer);
        }
        state.settleTimer = setTimeout(() => {
            settleViewport(container);
        }, settleDelayMs);
    }

    function flushSettled(container: HTMLElement | null) {
        if (container) {
            settleViewport(container);
            return;
        }
        for (const activeContainer of [...activeByViewport.keys()]) {
            settleViewport(activeContainer);
        }
    }

    function waitUntilSettled(container: HTMLElement | null, signal?: AbortSignal) {
        if (signal?.aborted) {
            return Promise.reject(createAbortError());
        }
        if (!isMotionActive(container)) {
            return Promise.resolve();
        }
        const targetWaiters = container
            ? activeByViewport.get(container)?.waiters ?? globalWaiters
            : globalWaiters;
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                if (settled) {
                    return;
                }
                settled = true;
                targetWaiters.delete(waiter);
                clearTimeout(maxWaitTimer);
                signal?.removeEventListener('abort', onAbort);
            };
            const onAbort = () => {
                cleanup();
                reject(createAbortError());
            };
            const maxWaitTimer = setTimeout(() => {
                cleanup();
                resolve();
            }, maxDeferralMs);
            const waiter: IScrollSettleWaiter = {
                resolve: () => {
                    cleanup();
                    resolve();
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
                cleanup,
            };
            targetWaiters.add(waiter);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    function releaseViewport(container: HTMLElement) {
        settleViewport(container);
    }

    function observeViewport(container: HTMLElement) {
        const onScroll = () => {
            markMotion(container);
        };
        container.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            container.removeEventListener('scroll', onScroll);
            releaseViewport(container);
        };
    }

    function reset() {
        for (const container of [...activeByViewport.keys()]) {
            settleViewport(container);
        }
        resolveWaiters(globalWaiters);
    }

    return {
        isMotionActive,
        markMotion,
        flushSettled,
        waitUntilSettled,
        observeViewport,
        releaseViewport,
        reset,
    };
}

export const pdfViewportScrollActivity = createPdfViewportScrollActivityTracker();
