import { clamp } from 'es-toolkit/math';

export function displayProcessedCount(processed: number, total: number) {
    if (total <= 0) {
        return 0;
    }
    const rounded = Math.round(processed);
    return clamp(rounded, 0, total);
}

export function formatEtaDuration(etaMs: number | null) {
    if (etaMs === null || !Number.isFinite(etaMs) || etaMs <= 0) {
        return null;
    }
    const totalSeconds = Math.max(1, Math.round(etaMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

/** Elapsed time as a clock reading such as 0:07 or 1:02:30; digits need no translation. */
export function formatElapsedClock(durationMs: number) {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return hours > 0
        ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${String(minutes)}:${seconds}`;
}
