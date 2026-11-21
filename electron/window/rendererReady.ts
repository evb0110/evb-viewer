import type { BrowserWindow } from 'electron';
import type { TRendererStartupPhase } from '@contracts/windowTabsPlatformFeature';
import { WINDOW_RENDERER_READY_TIMEOUT_MS } from '@electron/config/constants';

/** The window's show lifecycle. */
export interface IWindowStartupConsumer {
    onPhase(phase: TRendererStartupPhase): void;
    /** Takes a focus request before the window's first reveal; false once it was revealed. */
    requestReveal(): boolean;
}

interface IWindowStartup {
    /** The current document's phase: none until it reports one or main records its failure. */
    phase: TRendererStartupPhase | null;
    consumer: IWindowStartupConsumer | null;
    /** Settles the initial startup and clears its deadline; null once it settled. */
    settleInitial: ((phase: TRendererStartupPhase, cause?: Error) => void) | null;
}

const windowStartups = new Map<number, IWindowStartup>();

function getWindowStartup(windowId: number) {
    let startup = windowStartups.get(windowId);
    if (!startup) {
        startup = {
            phase: null,
            consumer: null,
            settleInitial: null,
        };
        windowStartups.set(windowId, startup);
    }
    return startup;
}

export interface IWaitForInitialRendererReadyOptions {
    onInitialLoadFailure?: (error: Error) => void;
}

export function getWindowStartupPhase(windowId: number) {
    return windowStartups.get(windowId)?.phase ?? null;
}

/** The consumer gets the window's current phase at once, then each one published. */
export function subscribeWindowStartupPhase(windowId: number, consumer: IWindowStartupConsumer) {
    const startup = getWindowStartup(windowId);
    startup.consumer = consumer;
    if (startup.phase) {
        consumer.onPhase(startup.phase);
    }
}

/** Until a window's first reveal, focusing it means revealing it; false once it was revealed. */
export function requestInitialReveal(windowId: number) {
    return windowStartups.get(windowId)?.consumer?.requestReveal() ?? false;
}

export function publishWindowStartupPhase(windowId: number, phase: TRendererStartupPhase, cause?: Error) {
    const startup = getWindowStartup(windowId);
    // A document fails once, and a load failure is a startup failure only until
    // the initial startup settled; later ones belong to the load failure owner.
    if (phase.phase === 'failed'
        && (startup.phase?.phase === 'failed' || (phase.reason === 'load-failed' && !startup.settleInitial))) {
        return;
    }
    startup.phase = phase;
    startup.settleInitial?.(phase, cause);
    startup.consumer?.onPhase(phase);
}

/** A replaced main-frame document or a dead renderer has no phase until its successor reports one. */
export function resetWindowStartupPhase(windowId: number) {
    const startup = windowStartups.get(windowId);
    if (startup) {
        startup.phase = null;
    }
}

export function deleteWindowStartup(windowId: number) {
    windowStartups.delete(windowId);
}

/**
 * Armed for every initial window, and again for the reload a failure prompt
 * starts once that failure settled it: resolves when its shell becomes interactive
 * and rejects when its startup fails or when the window closes first. A
 * renderer exit that recovery takes over leaves it pending for the recovered
 * document; its one deadline publishes `failed` with `timed-out`.
 */
export function waitForInitialRendererReady(
    window: BrowserWindow,
    options: IWaitForInitialRendererReadyOptions = {},
) {
    const windowId = window.id;
    const startup = getWindowStartup(windowId);
    return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
            if (startup.settleInitial !== settleInitial) {
                return;
            }
            startup.settleInitial = null;
            clearTimeout(timeoutHandle);
            window.removeListener('closed', handleClosed);
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        const settleInitial = (phase: TRendererStartupPhase, cause?: Error) => {
            finish(phase.phase === 'shell-interactive'
                ? undefined
                : cause ?? new Error(`Renderer startup failed (${phase.reason})`));
        };

        const handleClosed = () => {
            finish(new Error('Window closed before renderer startup completed'));
        };

        const timeoutHandle = setTimeout(() => {
            const error = new Error(`Renderer startup timed out after ${WINDOW_RENDERER_READY_TIMEOUT_MS}ms`);
            try {
                options.onInitialLoadFailure?.(error);
            } catch {
                // Diagnostic reporting must not change the published failure.
            }
            publishWindowStartupPhase(windowId, {
                phase: 'failed',
                reason: 'timed-out',
            }, error);
        }, WINDOW_RENDERER_READY_TIMEOUT_MS);
        timeoutHandle.unref();

        startup.settleInitial = settleInitial;
        window.on('closed', handleClosed);
    });
}
