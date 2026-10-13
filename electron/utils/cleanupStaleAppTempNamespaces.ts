import {
    lstat,
    readFile,
    readdir,
    rm,
} from 'fs/promises';
import {join} from 'path';
import {
    tmpdir,
    uptime,
} from 'os';
import {
    APP_TEMP_DIR_NAME,
    getAppStateDir,
    getAppTempNamespaceDirectoryName,
    getAppTempUserId,
} from '@node-runtime/appTempNamespace';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    APP_TEMP_NAMESPACE_OWNER_FILE,
    SAFE_NAMESPACE_PATTERN,
    getAppTempDir,
    getAppTempDirPath,
    getRetiredAppTempDirPath,
} from '@electron/utils/appTempDir';
import {getWorkingCopyJournalPath} from '@electron/file-access/workingCopyDirectory';
import {
    MANAGED_SCRATCH_RECORD_FILE,
    sweepStaleManagedScratchTempDirs,
} from '@electron/utils/managedScratchTemp';

// The startup owner of the profile namespaces: this profile's own scratch, and
// the namespaces of profiles that are gone, in the state folder and in the OS
// temp folder where releases before 2026-10 kept them. It depends on both the
// path owner and the scratch owner, which therefore never depend on it.
const APP_TEMP_NAMESPACE_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APP_TEMP_NAMESPACE_SCAN_LIMIT = 512;

interface IAppTempNamespaceOwner {
    namespace: string;
    userDataPath: string;
    pid: number;
    startedAt: number;
}

function parseAppTempNamespaceOwner(value: unknown): IAppTempNamespaceOwner | null {
    if (!isRecord(value)) {
        return null;
    }
    if (
        typeof value.namespace !== 'string'
        || !SAFE_NAMESPACE_PATTERN.test(value.namespace)
        || typeof value.userDataPath !== 'string'
        || value.userDataPath.trim().length === 0
        || typeof value.pid !== 'number'
        || !Number.isInteger(value.pid)
        || value.pid <= 0
        || typeof value.startedAt !== 'number'
        || !Number.isFinite(value.startedAt)
        || value.startedAt < 0
    ) {
        return null;
    }
    return {
        namespace: value.namespace,
        userDataPath: value.userDataPath,
        pid: value.pid,
        startedAt: value.startedAt,
    };
}

async function hasWorkspaceRecoveryCheckpoint(owner: IAppTempNamespaceOwner) {
    const records = await readdir(join(owner.userDataPath, 'workspace-recovery')).catch(() => []);
    return records.some(name => name.endsWith('.json'))
        || (await lstat(join(owner.userDataPath, 'workspace-checkpoint.json'))).isFile();
}

async function readAppTempNamespaceOwner(namespacePath: string) {
    try {
        const markerPath = join(namespacePath, APP_TEMP_NAMESPACE_OWNER_FILE);
        const markerStat = await lstat(markerPath);
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
            return null;
        }
        return parseAppTempNamespaceOwner(JSON.parse(await readFile(markerPath, 'utf8')));
    } catch {
        return null;
    }
}

// A namespace outlives a reboot and its owner's pid can be reused, so only an
// owner that started since the last boot can still be alive. This profile's
// own retired namespace has no live owner: this process holds the profile.
function isAppTempNamespaceOwnerAlive(namespacePath: string, owner: IAppTempNamespaceOwner) {
    if (namespacePath === getRetiredAppTempDirPath() || owner.startedAt < Date.now() - uptime() * 1000) {
        return false;
    }
    try {
        process.kill(owner.pid, 0);
        return true;
    } catch (error) {
        return isErrnoException(error) && error.code === 'EPERM';
    }
}

export interface ICleanupStaleAppTempNamespacesOptions {
    maxAgeMs?: number;
    maxEntries?: number;
}

export async function cleanupStaleAppTempNamespaces(
    options: ICleanupStaleAppTempNamespacesOptions = {},
) {
    const requestedMaxAgeMs = options.maxAgeMs;
    const maxAgeMs = typeof requestedMaxAgeMs === 'number'
        && Number.isFinite(requestedMaxAgeMs)
        && requestedMaxAgeMs >= 0
        ? requestedMaxAgeMs
        : APP_TEMP_NAMESPACE_STALE_MAX_AGE_MS;
    const requestedMaxEntries = options.maxEntries;
    const maxEntries = typeof requestedMaxEntries === 'number'
        && Number.isInteger(requestedMaxEntries)
        && requestedMaxEntries > 0
        ? requestedMaxEntries
        : APP_TEMP_NAMESPACE_SCAN_LIMIT;
    // This profile's own scratch: the records of a run that ended go back.
    await sweepStaleManagedScratchTempDirs(getAppTempDir());
    const currentNamespacePath = getAppTempDirPath();
    const entries = (await Promise.all([...new Set([
        getAppStateDir(),
        tmpdir(),
    ])].map(async baseDir => (await readdir(baseDir, {withFileTypes: true}).catch(() => []))
        .map(entry => ({
            baseDir,
            entry,
        }))))).flat();

    const namespacePrefix = `${APP_TEMP_DIR_NAME}-${getAppTempUserId()}-`;
    let removedCount = 0;
    const now = Date.now();
    const candidates = entries
        .filter(candidate => candidate.entry.isDirectory() && candidate.entry.name.startsWith(namespacePrefix))
        .slice(0, maxEntries);
    for (const {
        baseDir, entry,
    } of candidates) {
        const namespacePath = join(baseDir, entry.name);
        if (namespacePath === currentNamespacePath) {
            continue;
        }

        try {
            const namespaceStat = await lstat(namespacePath);
            if (!namespaceStat.isDirectory() || namespaceStat.isSymbolicLink()) {
                continue;
            }
            const owner = await readAppTempNamespaceOwner(namespacePath);
            // A marker is the ownership proof. Root mtime cannot tell us that
            // nested working-copy data is unused, so legacy or malformed roots
            // stay in place until an explicit profile-owned stop can verify and
            // reclaim them.
            if (!owner || getAppTempNamespaceDirectoryName(owner.namespace) !== entry.name) {
                continue;
            }
            if (isAppTempNamespaceOwnerAlive(namespacePath, owner)) {
                continue;
            }
            // Its export records go back first, whatever its age: one that
            // cannot be settled yet keeps the namespace, and the original it
            // names, for a later start. So does a save journal not yet finished:
            // the working-copy sweep finishes it, as for its own folders.
            await sweepStaleManagedScratchTempDirs(namespacePath);
            const scopes = await readdir(namespacePath);
            if ((await Promise.all(scopes.flatMap(scope => [
                join(namespacePath, scope, MANAGED_SCRATCH_RECORD_FILE),
                getWorkingCopyJournalPath(join(namespacePath, scope, 'document.pdf')),
            ]).map(path => lstat(path).then(() => true, () => false)))).includes(true)) {
                continue;
            }
            try {
                if (await hasWorkspaceRecoveryCheckpoint(owner)) {
                    continue;
                }
            } catch (error) {
                if (!isErrnoException(error) || error.code !== 'ENOENT') {
                    continue;
                }
            }
            const lastTouchedAt = Math.floor(Math.max(
                namespaceStat.mtimeMs,
                owner.startedAt,
            ));
            if (!Number.isFinite(lastTouchedAt) || now - lastTouchedAt < maxAgeMs) {
                continue;
            }
            await rm(namespacePath, {
                force: true,
                recursive: true,
            });
            removedCount += 1;
        } catch {
            // Another session may finish removing the namespace between the
            // directory scan and this cleanup attempt.
        }
    }
    return removedCount;
}
