import {
    availableParallelism,
    cpus,
} from 'os';
import { limitAsync } from 'es-toolkit/promise';
import { clamp } from 'es-toolkit/math';

function parsePositiveInt(value: string | undefined) {
    if (!value) {
        return null;
    }
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function getCpuCount() {
    const count = typeof availableParallelism === 'function'
        ? availableParallelism()
        : cpus().length;
    return Math.max(1, count);
}

export function getOcrConcurrency(targetCount: number) {
    const configured = parsePositiveInt(process.env.OCR_CONCURRENCY);
    const safeTargetCount = Math.max(1, targetCount);
    if (configured) {
        return clamp(configured, 1, safeTargetCount);
    }
    const cpuCount = getCpuCount();
    const defaultConcurrency = Math.min(cpuCount, 8);
    return clamp(defaultConcurrency, 1, safeTargetCount);
}

export async function forEachConcurrent<T>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
) {
    if (items.length === 0) {
        return;
    }

    const workerCount = clamp(concurrency, 1, items.length);
    const limited = limitAsync(fn, workerCount);
    await Promise.all(items.map((item, index) => limited(item, index)));
}
