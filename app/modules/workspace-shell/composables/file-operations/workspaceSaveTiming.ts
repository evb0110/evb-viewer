import {BrowserLogger} from '@app/utils/browserLogger';

export function nowMs() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export async function timedSavePhase<T>(
    phase: string,
    operation: () => Promise<T>,
    describeResult?: (result: T) => Record<string, unknown>,
) {
    const startedAtMs = nowMs();
    try {
        const result = await operation();
        const durationMs = Math.round(nowMs() - startedAtMs);
        const data = {
            ...describeResult?.(result),
            phase,
            durationMs,
        };
        BrowserLogger.debug('workspace', 'Completed PDF save phase', data);
        return result;
    } catch (error) {
        BrowserLogger.warn('workspace', 'PDF save phase failed', {
            error,
            phase,
            durationMs: Math.round(nowMs() - startedAtMs),
        });
        throw error;
    }
}
