import {
    appendFile,
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
    isAbsolute,
    join,
    resolve,
} from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { atomicReplace } from '@electron/utils/atomicReplace';
import {
    isSameFileIdentity,
    readFileIdentity,
    type IFileIdentity,
} from '@electron/utils/fileIdentity';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';

const logger = createLogger('managed-scratch-temp');
const MANAGED_SCRATCH_MARKER_FILE = '.evb-managed-scratch.json';
const MANAGED_SCRATCH_RECORD_FILE = '.evb-scratch-record';
// The names makeSiblingTempPath gives a temporary file beside a stage or target.
const MANAGED_SCRATCH_TEMP_NAME_PATTERN = /^\.[0-9a-f]{16}\.tmp$/u;
const MANAGED_SCRATCH_PREFIXES = [
    'pdfExport-',
    'pdfExport-scope-',
    'qpdfArgs-',
    'qpdfOutput-',
    'pdf-page-ops-',
    'native-command-',
    'djvu-export-',
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
    const comparable = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
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
        || dirname(comparable(resolvedDirectory)) !== comparable(resolve(rootPath))
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

interface IManagedScratchBackupEntry {
    kind: 'backup';
    path: string;
    target: string;
    original: IFileIdentity;
}

interface IManagedScratchPublishEntry {
    kind: 'publish';
    target: string;
    published: IFileIdentity;
}

// One line per record. Each entry is written before the file it names is
// created or replaced, so a crash leaves it for the next startup sweep. A null
// scratch path records nothing, which is how an export without a scratch runs.
type TManagedScratchRecordEntry =
    | {
        kind: 'stage' | 'writer';
        path: string
    }
    | IManagedScratchBackupEntry
    | IManagedScratchPublishEntry
    | {kind: 'complete'};

async function appendManagedScratchRecord(scratchPath: string | null, entry: TManagedScratchRecordEntry) {
    if (scratchPath) {
        await appendFile(join(scratchPath, MANAGED_SCRATCH_RECORD_FILE), `${JSON.stringify(entry)}\n`, 'utf8');
    }
}

export async function recordManagedScratchPath(scratchPath: string | null, kind: 'stage' | 'writer', path: string) {
    await appendManagedScratchRecord(scratchPath, {
        kind,
        path,
    });
}

export async function recordManagedScratchBackup(
    scratchPath: string | null,
    path: string,
    target: string,
    original: IFileIdentity,
) {
    await appendManagedScratchRecord(scratchPath, {
        kind: 'backup',
        path,
        target,
        original,
    });
}

export async function recordManagedScratchPublish(scratchPath: string | null, target: string, published: IFileIdentity) {
    await appendManagedScratchRecord(scratchPath, {
        kind: 'publish',
        target,
        published,
    });
}

export async function recordManagedScratchComplete(scratchPath: string | null) {
    await appendManagedScratchRecord(scratchPath, {kind: 'complete'});
}

function isFileIdentityRecord(value: unknown): value is IFileIdentity {
    return isRecord(value)
        && typeof value.dev === 'number'
        && typeof value.ino === 'number'
        && typeof value.size === 'number'
        && typeof value.mtimeMs === 'number';
}

function isAbsolutePath(value: unknown): value is string {
    return typeof value === 'string' && isAbsolute(value);
}

function isTempPath(value: unknown): value is string {
    return isAbsolutePath(value) && MANAGED_SCRATCH_TEMP_NAME_PATTERN.test(basename(value));
}

function parseManagedScratchRecordLine(line: string): TManagedScratchRecordEntry | null {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return null;
    }
    if (!isRecord(value)) {
        return null;
    }
    if (value.kind === 'stage' || value.kind === 'writer') {
        return isTempPath(value.path) ? {
            kind: value.kind,
            path: value.path,
        } : null;
    }
    if (value.kind === 'backup') {
        return isTempPath(value.path) && isAbsolutePath(value.target) && isFileIdentityRecord(value.original)
            ? {
                kind: 'backup',
                path: value.path,
                target: value.target,
                original: value.original,
            }
            : null;
    }
    if (value.kind === 'publish') {
        return isAbsolutePath(value.target) && isFileIdentityRecord(value.published)
            ? {
                kind: 'publish',
                target: value.target,
                published: value.published,
            }
            : null;
    }
    return value.kind === 'complete' ? {kind: 'complete'} : null;
}

export type TPublishedTargetOutcome = 'changed' | 'discarded' | 'gone' | 'removed' | 'restored';

// Settles one target that an export published, or was about to publish. A backup
// goes back over a target the export replaced, or over a missing target, with the
// rename the rollback uses. A backup whose target still has its original is only
// a copy and is discarded. A target the export made new is removed. Anything else
// was changed by someone else, so nothing is touched. The in-process rollback and
// the startup recovery both settle through here.
export async function settlePublishedTarget(
    target: string,
    backupPath: string | null,
    original: IFileIdentity | null,
    published: IFileIdentity | null,
): Promise<TPublishedTargetOutcome> {
    const current = await readFileIdentity(target);
    // Only a file that still has the identity the export published is the export's.
    // Null means nothing was published, so an edited target is never overwritten.
    const owned = isSameFileIdentity(current, published);
    if (backupPath !== null) {
        if (current === null || owned) {
            if ((await readFileIdentity(backupPath)) === null) {
                throw new Error(`Backup is missing: ${backupPath}`);
            }
            await atomicReplace(backupPath, target);
            return 'restored';
        }
        if (isSameFileIdentity(current, original)) {
            await rm(backupPath, {force: true});
            return 'discarded';
        }
        return 'changed';
    }
    if (current === null) {
        return 'gone';
    }
    if (!owned) {
        return 'changed';
    }
    await rm(target, {force: true});
    return 'removed';
}

// A dead owner's record is applied whatever the age of its scratch. Only complete
// lines count, since a crash can cut the last append short. Stages and writer
// temporaries are removed. A completed export keeps its published files and
// loses its backups. An unfinished export is rolled back: each replaced target
// gets its original back, and each new target is removed. A record stays when an
// action fails, so the next start tries again.
async function applyManagedScratchRecord(scratchPath: string) {
    const recordPath = join(scratchPath, MANAGED_SCRATCH_RECORD_FILE);
    const text = await readFile(recordPath, 'utf8').catch(() => null);
    if (text === null) {
        return;
    }
    const entries: TManagedScratchRecordEntry[] = [];
    for (const line of text.split('\n').slice(0, -1)) {
        const entry = parseManagedScratchRecordLine(line);
        if (entry) {
            entries.push(entry);
        }
    }
    const complete = entries.some(entry => entry.kind === 'complete');
    const publishes = new Map<string, IManagedScratchPublishEntry>();
    const backedUp = new Set<string>();
    for (const entry of entries) {
        if (entry.kind === 'publish') {
            publishes.set(entry.target, entry);
        }
        if (entry.kind === 'backup') {
            backedUp.add(entry.target);
        }
    }
    let settled = true;
    const attempt = async (path: string, action: () => Promise<unknown>) => {
        try {
            await action();
        } catch (error) {
            settled = false;
            logger.warn(`Failed to recover "${path}" from its managed scratch record: ${getErrorMessage(error)}`);
        }
    };
    for (const entry of entries) {
        if (entry.kind === 'stage' || entry.kind === 'writer') {
            // rm removes the entry itself, never a symlink's target, and fails on a directory.
            await attempt(entry.path, () => rm(entry.path, {force: true}));
        } else if (entry.kind === 'backup') {
            await attempt(entry.path, async () => {
                if (complete) {
                    await rm(entry.path, {force: true});
                    return;
                }
                const publish = publishes.get(entry.target);
                const outcome = await settlePublishedTarget(entry.target, entry.path, entry.original, publish?.published ?? null);
                if (outcome === 'changed') {
                    logger.warn(`Kept backup "${entry.path}": "${entry.target}" changed after the export`);
                }
            });
        } else if (entry.kind === 'publish' && !complete && !backedUp.has(entry.target)) {
            await attempt(entry.target, () => settlePublishedTarget(entry.target, null, null, entry.published));
        }
    }
    if (settled) {
        await rm(recordPath, {force: true});
    }
}

/**
 * Runs `run` in a fresh managed scratch directory and removes it afterwards,
 * unless `run` failed while a native child it started may still be alive: the
 * child may still read or write there, so the directory stays for the stale
 * sweep. A failed removal also leaves it to the sweep instead of replacing the
 * outcome of `run`.
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
        const keepReason = unprovenTermination ?? await rm(scratchPath, {
            force: true,
            recursive: true,
        }).then(() => undefined, (error: unknown) => `removal failed: ${getErrorMessage(error)}`);
        if (keepReason !== undefined) {
            logger.warn(`Keeping managed scratch "${scratchPath}" for the stale sweep: ${keepReason}`);
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
            await applyManagedScratchRecord(scratchPath);

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
