import type {ISystemMemoryInfo} from '@contracts/systemPlatformFeature';

export interface IElectronSystemMemoryInfo {
    available?: number | undefined;
    fileBacked?: number | undefined;
    free: number;
    purgeable?: number | undefined;
    total: number;
}

function normalizeMemoryKilobytes(value: number | undefined) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Decodes Electron's `process.getSystemMemoryInfo()` payload (KiB) into bytes.
 *
 * Platform semantics:
 * - Linux: prefers kernel `MemAvailable` (`available`) because `free` (`MemFree`)
 *   excludes reclaimable page cache.
 * - macOS: reports no `available`; combines `free + fileBacked + purgeable`
 *   (avoiding `os.freemem()`, which omits reclaimable memory and reports ~3% free
 *   on healthy hosts).
 * - Windows: reports no `available`, `fileBacked`, or `purgeable`; `free` is
 *   `ullAvailPhys` from `GlobalMemoryStatusEx`, which already includes standby
 *   reclaimable pages.
 */
export function decodeSystemMemoryInfo(memoryInfo: IElectronSystemMemoryInfo): ISystemMemoryInfo | null {
    const total = Number(memoryInfo.total);
    const free = Number(memoryInfo.free);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) {
        return null;
    }

    const reclaimable = normalizeMemoryKilobytes(memoryInfo.fileBacked) + normalizeMemoryKilobytes(memoryInfo.purgeable);
    const kernelAvailable = memoryInfo.available;
    const available = Math.min(
        total,
        typeof kernelAvailable === 'number' && Number.isFinite(kernelAvailable) && kernelAvailable >= 0
            ? kernelAvailable
            : free + reclaimable,
    );

    return {
        availableBytes: Math.round(available * 1024),
        totalBytes: Math.round(total * 1024),
        freeBytes: Math.round(free * 1024),
    };
}

export function readSystemMemoryInfo(): ISystemMemoryInfo | null {
    if (typeof process === 'undefined' || typeof process.getSystemMemoryInfo !== 'function') {
        return null;
    }
    try {
        return decodeSystemMemoryInfo(process.getSystemMemoryInfo());
    } catch {
        return null;
    }
}
