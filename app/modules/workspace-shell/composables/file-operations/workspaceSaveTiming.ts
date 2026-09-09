import {BrowserLogger} from '@app/utils/browserLogger';

const SLOW_SAVE_PHASE_WARN_MS = 5_000;

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
        if (durationMs >= SLOW_SAVE_PHASE_WARN_MS) {
            BrowserLogger.warn('workspace', 'Slow PDF save phase', data);
        } else {
            BrowserLogger.debug('workspace', 'Completed PDF save phase', data);
        }
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
