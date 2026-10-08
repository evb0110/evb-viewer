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

export function getTesseractThreadLimit(grantedCpuTokens: number) {
    const configured = parsePositiveInt(process.env.OCR_TESSERACT_THREADS);
    return Math.max(1, Math.min(configured ?? grantedCpuTokens, Math.floor(grantedCpuTokens)));
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

export function getSequentialProgressPage(
    pages: Array<{ pageNumber: number }>,
    processedCount: number,
) {
    if (pages.length === 0) {
        return 0;
    }
    const index = clamp(processedCount, 0, pages.length - 1);
    return pages[index]?.pageNumber ?? 0;
}
