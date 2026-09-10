import type { App } from 'electron';
import * as electron from 'electron';
import {randomUUID} from 'node:crypto';
import {
    chmodSync,
    closeSync,
    lstatSync,
    mkdirSync,
    openSync,
    renameSync,
    unlinkSync,
    writeSync,
} from 'fs';
import {
    lstat,
    readFile,
    readdir,
    rm,
} from 'fs/promises';
import {
    join,
    win32,
} from 'path';
import { tmpdir } from 'os';
import {
    APP_TEMP_DIR_NAME,
    createAppTempNamespace as createAppTempNamespaceForProfile,
    getAppTempNamespaceDirectoryName,
    getAppTempNamespacePath,
    getAppTempNamespacePathForNamespace,
    getAppTempUserId,
} from '@node-runtime/appTempNamespace';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';

const APP_TEMP_NAMESPACE_ENV = 'EVB_APP_TEMP_NAMESPACE';
const APP_TEMP_NAMESPACE_OWNER_FILE = '.evb-app-temp-owner.json';
const APP_TEMP_NAMESPACE_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const APP_TEMP_NAMESPACE_SCAN_LIMIT = 512;
const SAFE_NAMESPACE_PATTERN = /^[a-z\d][a-z\d-]{0,63}$/u;

let initializedAppTempNamespace: string | null = null;
let initializedAppTempUserDataPath: string | null = null;
let initializedAppTempNamespaceStartedAt = 0;
let ownerMarkerWritten = false;

export function createAppTempNamespace(userDataPath: string) {
    return createAppTempNamespaceForProfile(
        userDataPath,
        getAppTempUserId(),
        process.platform === 'win32',
    );
}

export function initializeAppTempNamespace(userDataPath: string) {
    const namespace = createAppTempNamespace(userDataPath);
    process.env[APP_TEMP_NAMESPACE_ENV] = namespace;
    initializedAppTempNamespace = namespace;
    initializedAppTempUserDataPath = userDataPath;
    initializedAppTempNamespaceStartedAt = Date.now();
    ownerMarkerWritten = false;
    return namespace;
}

function getAppTempNamespace() {
    const configuredNamespace = process.env[APP_TEMP_NAMESPACE_ENV]?.trim().toLowerCase();
    if (configuredNamespace && SAFE_NAMESPACE_PATTERN.test(configuredNamespace)) {
        return configuredNamespace;
    }

    const userDataPath = (electron as {app?: Pick<App, 'getPath'>}).app?.getPath('userData').trim();
    if (userDataPath) {
        return createAppTempNamespace(userDataPath);
    }

    return `${getAppTempUserId()}-fallback`;
}

function getOperatingSystemTempDir() {
    // Electron is unavailable inside Node worker_threads. Keep this utility
    // worker-safe because native document operations use it for managed
    // scratch output before publishing changes to a working copy.
    return (electron as {app?: Pick<App, 'getPath'>}).app?.getPath('temp') ?? tmpdir();
}

function joinTempDirectory(tempDir: string, directoryName: string) {
    return /^[a-zA-Z]:[\\/]/.test(tempDir) || tempDir.startsWith('\\\\')
        ? win32.join(tempDir, directoryName)
        : join(tempDir, directoryName);
}

/**
 * Returns the shared root used by releases predating per-profile temp
 * namespaces. It is exposed only for narrowly scoped migration cleanup; new
 * files and general temp-path authorization must use getAppTempDirPath().
 */
export function getLegacyAppTempDirPath() {
    return joinTempDirectory(getOperatingSystemTempDir(), APP_TEMP_DIR_NAME);
}

export function getAppTempDirPathForUserData(userDataPath: string, tempDir = tmpdir()) {
    return getAppTempNamespacePath(
        userDataPath,
        tempDir,
        getAppTempUserId(),
        process.platform === 'win32',
    );
}

export function getAppTempDirPath() {
    const tempDir = getOperatingSystemTempDir();
    return getAppTempNamespacePathForNamespace(tempDir, getAppTempNamespace());
}

function writeAppTempNamespaceOwner(tempDir: string) {
    const namespace = initializedAppTempNamespace;
    const userDataPath = initializedAppTempUserDataPath;
    if (!namespace || !userDataPath || ownerMarkerWritten || namespace !== getAppTempNamespace()) {
        return;
    }
    const markerPath = join(tempDir, APP_TEMP_NAMESPACE_OWNER_FILE);
    const temporaryMarkerPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
    const markerContents = `${JSON.stringify({
        namespace,
        userDataPath,
        pid: process.pid,
        startedAt: initializedAppTempNamespaceStartedAt,
    })}\n`;
    let markerFd: number | null = null;
    try {
        markerFd = openSync(temporaryMarkerPath, 'wx', 0o600);
        writeSync(markerFd, markerContents, undefined, 'utf8');
        closeSync(markerFd);
        markerFd = null;
        // Replacing the destination atomically replaces a symlink itself. It
        // never opens the symlink target, so an attacker cannot redirect the
        // owner marker write outside this namespace.
        renameSync(temporaryMarkerPath, markerPath);
        ownerMarkerWritten = true;
    } finally {
        if (markerFd !== null) {
            closeSync(markerFd);
        }
        try {
            unlinkSync(temporaryMarkerPath);
        } catch {
            // The atomic rename already moved it, or another cleanup removed it.
        }
    }
}

export function getAppTempDir() {
    const tempDir = getAppTempDirPath();
    try {
        if (lstatSync(tempDir).isSymbolicLink()) {
            throw new Error(`App temp directory must not be a symbolic link: ${tempDir}`);
        }
    } catch (error) {
        if (!isErrnoException(error) || error.code !== 'ENOENT') {
            throw error;
        }
    }
    mkdirSync(tempDir, { recursive: true });
    if (lstatSync(tempDir).isSymbolicLink()) {
        throw new Error(`App temp directory must not be a symbolic link: ${tempDir}`);
    }
    chmodSync(tempDir, 0o700);
    writeAppTempNamespaceOwner(tempDir);
    return tempDir;
}

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
    return (await lstat(
        joinTempDirectory(owner.userDataPath, 'workspace-checkpoint.json'),
    )).isFile();
}

async function readAppTempNamespaceOwner(namespacePath: string) {
    try {
        const markerPath = joinTempDirectory(namespacePath, APP_TEMP_NAMESPACE_OWNER_FILE);
        const markerStat = await lstat(markerPath);
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
            return null;
        }
        return parseAppTempNamespaceOwner(JSON.parse(await readFile(markerPath, 'utf8')));
    } catch {
        return null;
    }
}

function isAppTempNamespaceOwnerAlive(pid: number) {
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
    const tempDir = getOperatingSystemTempDir();
    const currentNamespacePath = getAppTempDirPath();
    let entries;
    try {
        entries = await readdir(tempDir, {withFileTypes: true});
    } catch {
        return 0;
    }

    const namespacePrefix = `${APP_TEMP_DIR_NAME}-${getAppTempUserId()}-`;
    let removedCount = 0;
    const now = Date.now();
    for (const entry of entries
        .filter(candidate => candidate.isDirectory() && candidate.name.startsWith(namespacePrefix))
        .slice(0, maxEntries)) {
        const namespacePath = joinTempDirectory(tempDir, entry.name);
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
            if (isAppTempNamespaceOwnerAlive(owner.pid)) {
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
