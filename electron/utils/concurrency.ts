import {
    availableParallelism,
    cpus,
} from 'os';
import { clamp } from 'es-toolkit/math';

function parsePositiveInt(value: string | undefined): number | null {
    if (!value) {
        return null;
    }
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function getCpuCount(): number {
    const count = typeof availableParallelism === 'function'
        ? availableParallelism()
        : cpus().length;
    return Math.max(1, count);
}

export function getOcrConcurrency(targetCount: number): number {
    const configured = parsePositiveInt(process.env.OCR_CONCURRENCY);
    if (configured) {
        return Math.max(1, Math.min(configured, targetCount));
    }
    const cpuCount = getCpuCount();
    const defaultConcurrency = Math.min(cpuCount, 8);
    return Math.max(1, Math.min(defaultConcurrency, targetCount));
}

export function getTesseractThreadLimit(concurrency: number): number {
    const configured = parsePositiveInt(process.env.OCR_TESSERACT_THREADS);
    if (configured) {
        return configured;
    }
    const cpuCount = getCpuCount();
    return Math.max(1, Math.floor(cpuCount / Math.max(1, concurrency)));
}

export async function forEachConcurrent<T>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) {
                return;
            }
            await fn(items[index]!, index);
        }
    });

    await Promise.all(workers);
}

export function getSequentialProgressPage(
    pages: Array<{ pageNumber: number }>,
    processedCount: number,
): number {
    if (pages.length === 0) {
        return 0;
    }
    const index = clamp(processedCount, 0, pages.length - 1);
    return pages[index]?.pageNumber ?? 0;
}
