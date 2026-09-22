import { createLogger } from '@electron/utils/createLogger';

interface IElectronPerfDetails { [key: string]: unknown; }

const perfLogger = createLogger('perf');

function canMeasurePerf() {
    return typeof performance !== 'undefined';
}

function isDevPerfEnabled() {
    return process.env.NODE_ENV !== 'production' && canMeasurePerf();
}

function logElectronPerf(label: string, startedAt: number, thresholdMs: number, details?: IElectronPerfDetails) {
    if (!isDevPerfEnabled()) {
        return;
    }

    const durationMs = performance.now() - startedAt;
    if (durationMs < thresholdMs) {
        return;
    }

    perfLogger.debug('Electron performance threshold exceeded', {
        label,
        durationMs: Math.round(durationMs * 100) / 100,
        thresholdMs,
        ...(details === undefined ? {} : {details}),
    });
}

export async function measureElectronPerfAsync<T>(
    label: string,
    run: () => Promise<T>,
    options: {
        thresholdMs?: number;
        details?: IElectronPerfDetails;
    } = {},
): Promise<T> {
    if (!isDevPerfEnabled()) {
        return run();
    }

    const startedAt = performance.now();
    try {
        return await run();
    } finally {
        logElectronPerf(label, startedAt, options.thresholdMs ?? 16, options.details);
    }
}
