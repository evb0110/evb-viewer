interface IRendererStartupState {
    sequence: number;
    startedAtIso: string;
    startedAtPerfMs: number;
}

const STARTUP_STATE_KEY = '__evbRendererStartupState';
const STARTUP_TRACE_EVENTS_KEY = '__evbRendererStartupEvents';
const STARTUP_TRACE_ENABLED_KEY = '__EVB_STARTUP_TRACE__';

interface IStartupTraceEvent {
    sequence: number;
    stage: string;
    at: string;
    sinceStartupMs: number;
    sinceNavigationStartMs: number;
    startupStartedAt: string;
    details?: Record<string, unknown> | undefined;
}

function getStartupState() {
    if (typeof window === 'undefined') {
        return null;
    }

    const startupWindow = window as Window & {[STARTUP_STATE_KEY]?: IRendererStartupState};

    startupWindow[STARTUP_STATE_KEY] ??= {
        sequence: 0,
        startedAtIso: new Date().toISOString(),
        startedAtPerfMs: performance.now(),
    };

    return startupWindow[STARTUP_STATE_KEY];
}

function isStartupTraceEnabled() {
    if (typeof window === 'undefined') {
        return false;
    }

    const startupWindow = window as Window & {[STARTUP_TRACE_ENABLED_KEY]?: boolean};
    if (typeof startupWindow[STARTUP_TRACE_ENABLED_KEY] === 'boolean') {
        return startupWindow[STARTUP_TRACE_ENABLED_KEY];
    }

    return false;
}

function getStartupEvents() {
    const startupWindow = window as Window & {[STARTUP_TRACE_EVENTS_KEY]?: IStartupTraceEvent[]};

    startupWindow[STARTUP_TRACE_EVENTS_KEY] ??= [];

    return startupWindow[STARTUP_TRACE_EVENTS_KEY];
}

function stringifyDetails(details?: Record<string, unknown>) {
    if (!details) {
        return '';
    }

    try {
        return ` details=${JSON.stringify(details)}`;
    } catch {
        return ' details=<unserializable>';
    }
}

export function traceRendererStartup(stage: string, details?: Record<string, unknown>) {
    if (typeof window === 'undefined' || !isStartupTraceEnabled()) {
        return;
    }

    const state = getStartupState();
    if (!state) {
        return;
    }

    state.sequence += 1;

    const nowIso = new Date().toISOString();
    const nowPerfMs = performance.now();
    const sinceStartupMs = Math.round(nowPerfMs - state.startedAtPerfMs);

    console.info(
        `[${nowIso}] [startup][renderer][${state.sequence}] ${stage} ` +
            `(+${sinceStartupMs}ms from renderer-start, +${Math.round(nowPerfMs)}ms from navigationStart)` +
            stringifyDetails(details),
    );

    const events = getStartupEvents();
    events.push({
        sequence: state.sequence,
        stage,
        at: nowIso,
        sinceStartupMs,
        sinceNavigationStartMs: Math.round(nowPerfMs),
        startupStartedAt: state.startedAtIso,
        details,
    });

    if (events.length > 400) {
        events.shift();
    }
}
