import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

export type TPdfRenderSupervisorWatchdogCause =
    | 'page-stage-timeout'
    | 'render-stall-recovery'
    | 'render-cancelled-retry'
    | 'navigation-paged-settle'
    | 'navigation-search-settle'
    | 'navigation-continuous-render'
    | 'navigation-continuous-target-fallback'
    | 'navigation-hold-ready-retry'
    | 'navigation-hold-recovery'
    | 'navigation-hold-abandon'
    | 'navigation-hold-still-waiting'
    | 'navigation-programmatic-release'
    | 'text-markup-presentation-repair';

export type TPdfRenderSupervisorExplicitCause =
    | 'annotation-editor-layer-render-failed'
    | 'annotation-editor-layer-quarantined'
    | 'pdfjs-compatibility-unsupported';

export type TPdfRenderSupervisorCause =
    | TPdfRenderSupervisorWatchdogCause
    | TPdfRenderSupervisorExplicitCause
    | 'stale-superseded';

export interface IPdfRenderSupervisorEvent {
    cause: TPdfRenderSupervisorCause;
    delayMs: number;
    elapsedMs: number;
    firedAtMs: number;
    metadata?: Record<string, unknown> | undefined;
    ownerKey: string;
    sourceCause?: TPdfRenderSupervisorWatchdogCause | undefined;
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
    replace?: boolean | undefined;
}

export interface IReportPdfRenderSupervisorEventOptions {
    cause: TPdfRenderSupervisorExplicitCause;
    key: string;
    metadata?: Record<string, unknown> | undefined;
}

export interface IPdfRenderSupervisor {
    armTimer: (options: IArmPdfRenderSupervisorTimerOptions) => IPdfRenderSupervisorTimer;
    clearTimer: (timer: IPdfRenderSupervisorTimer | null | undefined) => boolean;
    clearTimers: (timers: Array<IPdfRenderSupervisorTimer | null | undefined>) => void;
    isTimerCurrent: (timer: IPdfRenderSupervisorTimer | null | undefined) => boolean;
    reportEvent: (options: IReportPdfRenderSupervisorEventOptions) => IPdfRenderSupervisorEvent;
}

interface ICreatePdfRenderSupervisorOptions {
    clearTimeoutFn?: ((handle: ReturnType<typeof setTimeout>) => void) | undefined;
    now?: (() => number) | undefined;
    onEvent?: ((event: IPdfRenderSupervisorEvent) => void) | undefined;
    setTimeoutFn?: ((callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>) | undefined;
}

interface IActivePdfRenderSupervisorTimer {
    armedAtMs: number;
    cause: TPdfRenderSupervisorWatchdogCause;
    delayMs: number;
    handle: ReturnType<typeof setTimeout> | null;
    key: string;
    metadata?: Record<string, unknown> | undefined;
    onFire: (event: IPdfRenderSupervisorEvent) => void;
    token: number;
}

function buildEvent(
    activeTimer: IActivePdfRenderSupervisorTimer,
    cause: TPdfRenderSupervisorCause,
    now: () => number,
): IPdfRenderSupervisorEvent {
    const firedAtMs = now();
    return {
        cause,
        delayMs: activeTimer.delayMs,
        elapsedMs: Math.max(0, firedAtMs - activeTimer.armedAtMs),
        firedAtMs,
        metadata: activeTimer.metadata,
        ownerKey: activeTimer.key,
        sourceCause: cause === 'stale-superseded'
            ? activeTimer.cause
            : undefined,
        token: activeTimer.token,
    };
}

function buildExplicitEvent(
    options: IReportPdfRenderSupervisorEventOptions,
    now: () => number,
    token: number,
): IPdfRenderSupervisorEvent {
    return {
        cause: options.cause,
        delayMs: 0,
        elapsedMs: 0,
        firedAtMs: now(),
        metadata: options.metadata,
        ownerKey: options.key,
        token,
    };
}

export function createPdfRenderSupervisor(
    options: ICreatePdfRenderSupervisorOptions = {},
): IPdfRenderSupervisor {
    const activeTimers = new Map<string, IActivePdfRenderSupervisorTimer>();
    // One counter for every timer and event: a token is never reused, so no
    // history per key is kept and an old handle never matches a new timer.
    let lastToken = 0;
    const now = options.now ?? (() => Date.now());
    const setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const clearTimeoutFn = options.clearTimeoutFn ?? (handle => clearTimeout(handle));

    function emit(event: IPdfRenderSupervisorEvent) {
        logPdfRenderTrace('pdf-render-supervisor-watchdog', { ...event });
        options.onEvent?.(event);
    }

    function isActiveTimerCurrent(activeTimer: IActivePdfRenderSupervisorTimer) {
        return activeTimers.get(activeTimer.key) === activeTimer;
    }

    function fireTimer(activeTimer: IActivePdfRenderSupervisorTimer) {
        if (!isActiveTimerCurrent(activeTimer)) {
            emit(buildEvent(activeTimer, 'stale-superseded', now));
            return;
        }

        activeTimers.delete(activeTimer.key);
        const event = buildEvent(activeTimer, activeTimer.cause, now);
        emit(event);
        activeTimer.onFire(event);
    }

    function clearTimerKey(key: string, token?: number) {
        const activeTimer = activeTimers.get(key);
        if (!activeTimer || (token !== undefined && activeTimer.token !== token)) {
            return false;
        }

        if (activeTimer.handle !== null) {
            clearTimeoutFn(activeTimer.handle);
        }
        activeTimers.delete(key);
        return true;
    }

    function armTimer(armOptions: IArmPdfRenderSupervisorTimerOptions) {
        if (armOptions.replace !== false) {
            clearTimerKey(armOptions.key);
        }

        const token = ++lastToken;
        const activeTimer: IActivePdfRenderSupervisorTimer = {
            armedAtMs: now(),
            cause: armOptions.cause,
            delayMs: armOptions.delayMs,
            handle: null,
            key: armOptions.key,
            metadata: armOptions.metadata,
            onFire: armOptions.onFire,
            token,
        };
        activeTimer.handle = setTimeoutFn(() => fireTimer(activeTimer), armOptions.delayMs);
        activeTimers.set(armOptions.key, activeTimer);

        return {
            key: armOptions.key,
            token,
            clear: () => clearTimerKey(armOptions.key, token),
            isCurrent: () => isActiveTimerCurrent(activeTimer),
        };
    }

    function clearTimer(timer: IPdfRenderSupervisorTimer | null | undefined) {
        if (!timer) {
            return false;
        }

        return clearTimerKey(timer.key, timer.token);
    }

    function clearTimers(timers: Array<IPdfRenderSupervisorTimer | null | undefined>) {
        for (const timer of timers) {
            clearTimer(timer);
        }
    }

    function isTimerCurrent(timer: IPdfRenderSupervisorTimer | null | undefined) {
        return Boolean(
            timer
            && activeTimers.get(timer.key)?.token === timer.token,
        );
    }

    function reportEvent(reportOptions: IReportPdfRenderSupervisorEventOptions) {
        const event = buildExplicitEvent(
            reportOptions,
            now,
            ++lastToken,
        );
        emit(event);
        return event;
    }

    return {
        armTimer,
        clearTimer,
        clearTimers,
        isTimerCurrent,
        reportEvent,
    };
}
