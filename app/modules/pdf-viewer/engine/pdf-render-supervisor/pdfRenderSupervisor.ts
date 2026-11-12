import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

/** The only watchdog: a render stage that made no progress for its window. */
export type TPdfRenderSupervisorWatchdogCause = 'page-stage-timeout';

export interface IPdfRenderSupervisorEvent {
    cause: TPdfRenderSupervisorWatchdogCause;
    delayMs: number;
    elapsedMs: number;
    firedAtMs: number;
    metadata?: Record<string, unknown> | undefined;
    ownerKey: string;
    token: number;
}

export interface IPdfRenderSupervisorTimer {
    clear: () => boolean;
    isCurrent: () => boolean;
    key: string;
    token: number;
}

export interface IArmPdfRenderSupervisorTimerOptions {
    cause: TPdfRenderSupervisorWatchdogCause;
    delayMs: number;
    key: string;
    metadata?: Record<string, unknown> | undefined;
    onFire: (event: IPdfRenderSupervisorEvent) => void;
}

export interface IPdfRenderSupervisor {
    armTimer: (options: IArmPdfRenderSupervisorTimerOptions) => IPdfRenderSupervisorTimer;
}

interface ICreatePdfRenderSupervisorOptions {
    clearTimeoutFn?: ((handle: ReturnType<typeof setTimeout>) => void) | undefined;
    now?: (() => number) | undefined;
    onEvent?: ((event: IPdfRenderSupervisorEvent) => void) | undefined;
    setTimeoutFn?: ((callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>) | undefined;
}

interface IActivePdfRenderSupervisorTimer {
    armedAtMs: number;
    handle: ReturnType<typeof setTimeout> | null;
    options: IArmPdfRenderSupervisorTimerOptions;
    token: number;
}

/** One timer per key: arming a key replaces its timer, whose callback then never runs. */
export function createPdfRenderSupervisor(
    options: ICreatePdfRenderSupervisorOptions = {},
): IPdfRenderSupervisor {
    const activeTimers = new Map<string, IActivePdfRenderSupervisorTimer>();
    let lastToken = 0;
    const now = options.now ?? (() => Date.now());
    const setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const clearTimeoutFn = options.clearTimeoutFn ?? (handle => clearTimeout(handle));

    function clearTimer(timer: IActivePdfRenderSupervisorTimer) {
        if (activeTimers.get(timer.options.key) !== timer) {
            return false;
        }
        if (timer.handle !== null) {
            clearTimeoutFn(timer.handle);
        }
        activeTimers.delete(timer.options.key);
        return true;
    }

    function fireTimer(timer: IActivePdfRenderSupervisorTimer) {
        if (activeTimers.get(timer.options.key) !== timer) {
            return;
        }
        activeTimers.delete(timer.options.key);
        const firedAtMs = now();
        const event: IPdfRenderSupervisorEvent = {
            cause: timer.options.cause,
            delayMs: timer.options.delayMs,
            elapsedMs: Math.max(0, firedAtMs - timer.armedAtMs),
            firedAtMs,
            metadata: timer.options.metadata,
            ownerKey: timer.options.key,
            token: timer.token,
        };
        logPdfRenderTrace('pdf-render-supervisor-watchdog', { ...event });
        options.onEvent?.(event);
        timer.options.onFire(event);
    }

    function armTimer(armOptions: IArmPdfRenderSupervisorTimerOptions): IPdfRenderSupervisorTimer {
        const previous = activeTimers.get(armOptions.key);
        if (previous) {
            clearTimer(previous);
        }
        const timer: IActivePdfRenderSupervisorTimer = {
            armedAtMs: now(),
            handle: null,
            options: armOptions,
            token: ++lastToken,
        };
        timer.handle = setTimeoutFn(() => fireTimer(timer), armOptions.delayMs);
        activeTimers.set(armOptions.key, timer);
        return {
            key: armOptions.key,
            token: timer.token,
            clear: () => clearTimer(timer),
            isCurrent: () => activeTimers.get(armOptions.key) === timer,
        };
    }

    return { armTimer };
}
