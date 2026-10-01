import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
    resolve,
} from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
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
    'native-command-',
    'djvu-image-export-',
    'djvu-tiff-export-',
    'scan-cleanup-preview-',
] as const;
const MANAGED_SCRATCH_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MANAGED_SCRATCH_SWEEP_MAX_ENTRIES = 200;

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
        return !isErrnoException(error) || error.code !== 'ESRCH';
    }
}

export async function createManagedScratchTempDir(
    prefix: TManagedScratchPrefix,
    rootPath: string,
) {
    await mkdir(rootPath, {recursive: true});
    const rootStat = await lstat(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`Managed scratch root is not a directory: ${rootPath}`);
    }
    const tempDir = await mkdtemp(join(rootPath, prefix));
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

export async function removeManagedScratchTempDir(
    directoryPath: string,
    prefix: TManagedScratchPrefix,
    rootPath: string,
) {
    const resolvedDirectory = resolve(directoryPath);
    const resolvedRoot = resolve(rootPath);
    const normalizedDirectory = process.platform === 'win32'
        ? resolvedDirectory.toLowerCase()
        : resolvedDirectory;
    const normalizedRoot = process.platform === 'win32'
        ? resolvedRoot.toLowerCase()
        : resolvedRoot;
    let directoryStat;
    try {
        directoryStat = await lstat(resolvedDirectory);
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return true;
        }
        throw error;
    }
    if (!directoryStat.isDirectory()
        || directoryStat.isSymbolicLink()
        || dirname(normalizedDirectory) !== normalizedRoot
        || !basename(resolvedDirectory).startsWith(prefix)) {
        return false;
    }
    const marker = await readManagedScratchMarker(resolvedDirectory);
    if (marker?.prefix !== prefix) {
        return false;
    }
    await rm(resolvedDirectory, {
        force: true,
        recursive: true,
    });
    return true;
}

/**
 * Runs `run` in a fresh managed scratch directory and removes it afterwards,
 * unless `run` failed while a native child it started may still be alive: the
 * child may still read or write there, so the directory stays for the stale
 * sweep.
 */
export async function usingManagedScratchScope<T>(
    prefix: TManagedScratchPrefix,
    rootPath: string,
    run: (scratchPath: string) => Promise<T>,
): Promise<T> {
    const scratchPath = await createManagedScratchTempDir(prefix, rootPath);
    let unprovenTermination: string | undefined;
    try {
        return await run(scratchPath);
    } catch (error) {
        unprovenTermination = getUnprovenNativeTerminationDetail(error);
        throw error;
    } finally {
        if (unprovenTermination === undefined) {
            await rm(scratchPath, {
                force: true,
                recursive: true,
            });
        } else {
            logger.warn(`Keeping managed scratch "${scratchPath}" until a native child is proven gone: ${unprovenTermination}`);
        }
    }
}

export async function sweepStaleManagedScratchTempDirs(
    tempDir: string,
    maxAgeMs = MANAGED_SCRATCH_STALE_MAX_AGE_MS,
    maxEntries = MANAGED_SCRATCH_SWEEP_MAX_ENTRIES,
) {
    const now = Date.now();
    let deletedCount = 0;

    let entries: string[] = [];
    try {
        entries = await readdir(tempDir);
    } catch {
        return 0;
    }

    const managedEntries = entries.filter(entry => isManagedScratchDirectoryName(entry)
        && !entry.startsWith('native-command-'));
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
