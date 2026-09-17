import {
    lstat,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getErrorMessage } from '@electron/utils/error';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';

const logger = createLogger('managed-scratch-temp');
const MANAGED_SCRATCH_MARKER_FILE = '.evb-managed-scratch.json';
const MANAGED_SCRATCH_PREFIXES = [
    'pdfExport-',
    'pdfExport-scope-',
    'qpdfArgs-',
    'qpdfOutput-',
    'pdf-page-ops-',
    'djvu-image-export-',
    'djvu-tiff-export-',
    'scan-cleanup-preview-',
] as const;
const MANAGED_SCRATCH_STALE_MAX_AGE_MS = parseIntegerEnv(
    'EVB_MANAGED_SCRATCH_STALE_MAX_AGE_MS',
    24 * 60 * 60 * 1000,
    60_000,
);
const MANAGED_SCRATCH_SWEEP_MAX_ENTRIES = parseIntegerEnv(
    'EVB_MANAGED_SCRATCH_SWEEP_MAX_ENTRIES',
    200,
    1,
    5_000,
);

export type TManagedScratchPrefix = typeof MANAGED_SCRATCH_PREFIXES[number];

function isManagedScratchDirectoryName(entryName: string) {
    return MANAGED_SCRATCH_PREFIXES.some(prefix => entryName.startsWith(prefix));
}

interface IManagedScratchMarker {
    createdAt: number
    pid: number
    prefix: TManagedScratchPrefix
}

function parseManagedScratchMarker(value: unknown): IManagedScratchMarker | null {
    if (!isRecord(value)) {
        return null;
    }
    const prefix = typeof value.prefix === 'string' && MANAGED_SCRATCH_PREFIXES.includes(
        value.prefix as TManagedScratchPrefix,
    )
        ? value.prefix as TManagedScratchPrefix
        : null;
    if (
        !prefix
        || typeof value.createdAt !== 'number'
        || !Number.isFinite(value.createdAt)
        || value.createdAt < 0
        || typeof value.pid !== 'number'
        || !Number.isInteger(value.pid)
        || value.pid <= 0
    ) {
        return null;
    }
    return {
        createdAt: value.createdAt,
        pid: value.pid,
        prefix,
    };
}

async function readManagedScratchMarker(directoryPath: string) {
    try {
        const markerPath = join(directoryPath, MANAGED_SCRATCH_MARKER_FILE);
        const markerStat = await lstat(markerPath);
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
            return null;
        }
        return parseManagedScratchMarker(JSON.parse(await readFile(markerPath, 'utf8')));
    } catch {
        return null;
    }
}

function isProcessAlive(pid: number) {
    if (pid === process.pid) {
        return true;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return isErrnoException(error) && error.code === 'EPERM';
    }
}

export async function createManagedScratchTempDir(prefix: TManagedScratchPrefix) {
    const tempDir = await mkdtemp(join(getAppTempDir(), prefix));
    try {
        await writeFile(join(tempDir, MANAGED_SCRATCH_MARKER_FILE), `${JSON.stringify({
            createdAt: Date.now(),
            pid: process.pid,
            prefix,
        })}\n`, 'utf8');
    } catch (error) {
        await rm(tempDir, {
            force: true,
            recursive: true,
        }).catch(() => undefined);
        throw error;
    }
    return tempDir;
}

export async function usingManagedScratchScope<T>(
    prefix: TManagedScratchPrefix,
    run: (scratchPath: string) => Promise<T>,
): Promise<T> {
    const scratchPath = await createManagedScratchTempDir(prefix);
    try {
        return await run(scratchPath);
    } finally {
        await rm(scratchPath, {
            force: true,
            recursive: true,
        });
    }
}

export async function sweepStaleManagedScratchTempDirs(
    maxAgeMs = MANAGED_SCRATCH_STALE_MAX_AGE_MS,
    maxEntries = MANAGED_SCRATCH_SWEEP_MAX_ENTRIES,
) {
    const tempDir = getAppTempDir();
    const now = Date.now();
    let deletedCount = 0;

    let entries: string[] = [];
    try {
        entries = await readdir(tempDir);
    } catch {
        return 0;
    }

    const managedEntries = entries.filter(isManagedScratchDirectoryName);
    for (const entry of managedEntries.slice(0, maxEntries)) {
        const scratchPath = join(tempDir, entry);
        try {
            const scratchStat = await lstat(scratchPath);
            if (!scratchStat.isDirectory()) {
                continue;
            }
            const marker = await readManagedScratchMarker(scratchPath);
            if (!marker || !entry.startsWith(marker.prefix) || isProcessAlive(marker.pid)) {
                continue;
            }

            // Date.now() has integer-millisecond precision, while filesystem
            // timestamps can retain a fractional millisecond. Compare both
            // clocks at the same precision so a zero-age sweep does not treat
            // a same-millisecond directory timestamp as slightly in the future.
            const lastTouchedAt = Math.floor(Math.max(
                marker.createdAt,
                scratchStat.mtimeMs,
                scratchStat.ctimeMs,
            ));
            if (!Number.isFinite(lastTouchedAt) || now - lastTouchedAt < maxAgeMs) {
                continue;
            }

            await rm(scratchPath, {
                force: true,
                recursive: true,
            });
            deletedCount += 1;
        } catch (error) {
            logger.warn(`Failed to remove stale managed scratch directory "${scratchPath}": ${getErrorMessage(error)}`);
        }
    }

    if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} stale managed scratch director${deletedCount === 1 ? 'y' : 'ies'}`);
    }

    return deletedCount;
}
