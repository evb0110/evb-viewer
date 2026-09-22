import { BrowserLogger } from '@app/utils/browserLogger';

interface IDevPerfDetails { [key: string]: unknown; }

// A synchronous measurement this long drops frames; it is worth a warning in
// the dev terminal rather than a debug record.
const DEV_PERF_SLOW_MS = 50;
const DEV_PERF_WARN_INTERVAL_MS = 5_000;

function isDevPerfEnabled() {
    return import.meta.dev && typeof performance !== 'undefined';
}

function logDevPerf(label: string, startedAt: number, thresholdMs: number, details?: IDevPerfDetails) {
    if (!isDevPerfEnabled()) {
        return;
    }

    const durationMs = performance.now() - startedAt;
    if (durationMs < thresholdMs) {
        return;
    }

    const data = {
        durationMs: Math.round(durationMs * 100) / 100,
        ...details,
    };
    if (durationMs >= DEV_PERF_SLOW_MS) {
        BrowserLogger.warnThrottled('perf', label, DEV_PERF_WARN_INTERVAL_MS, `${label} was slow`, data);
        return;
    }
    BrowserLogger.debug('perf', label, data);
}

export function measureDevPerf<T>(
    label: string,
    run: () => T,
    options: {
        thresholdMs?: number;
        details?: IDevPerfDetails;
    } = {},
): T {
    if (!isDevPerfEnabled()) {
        return run();
    }

    const startedAt = performance.now();
    try {
        return run();
    } finally {
        logDevPerf(label, startedAt, options.thresholdMs ?? 16, options.details);
    }
}

export async function measureDevPerfAsync<T>(
    label: string,
    run: () => Promise<T>,
    options: {
        thresholdMs?: number;
        details?: IDevPerfDetails;
    } = {},
): Promise<T> {
    if (!isDevPerfEnabled()) {
        return run();
    }

    const startedAt = performance.now();
    try {
        return await run();
    } finally {
        logDevPerf(label, startedAt, options.thresholdMs ?? 16, options.details);
    }
}
