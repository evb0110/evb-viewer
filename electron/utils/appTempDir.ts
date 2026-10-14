import type { App } from 'electron';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
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
    dirname,
    join,
    win32,
} from 'path';
import { tmpdir } from 'os';
import {
    APP_TEMP_DIR_NAME,
    createAppTempNamespace as createAppTempNamespaceForProfile,
    getAppStateDir,
    getAppTempNamespacePath,
    getAppTempNamespacePathForNamespace,
    getAppTempUserId,
} from '@node-runtime/appTempNamespace';
import {isErrnoException} from '@contracts/runtimeGuards';
import {runtimeConfig} from '@electron/runtimeConfig';
import {fsyncDirectorySync} from '@electron/utils/fsyncPath';
import {getOwnStartTime} from '@electron/utils/processIdentity';

export const APP_TEMP_NAMESPACE_OWNER_FILE = '.evb-app-temp-owner.json';
export const SAFE_NAMESPACE_PATTERN = /^[a-z\d][a-z\d-]{0,63}$/u;
const electronRequire = createRequire(import.meta.url);

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
    process.env.EVB_APP_TEMP_NAMESPACE = namespace;
    initializedAppTempNamespace = namespace;
    initializedAppTempUserDataPath = userDataPath;
    initializedAppTempNamespaceStartedAt = Date.now();
    ownerMarkerWritten = false;
    void getOwnStartTime();
    return namespace;
}

function getAppTempNamespace() {
    const configuredNamespace = runtimeConfig.appTempNamespace;
    if (configuredNamespace && SAFE_NAMESPACE_PATTERN.test(configuredNamespace)) {
        return configuredNamespace;
    }

    const userDataPath = (electronRequire('electron') as {app?: Pick<App, 'getPath'>}).app?.getPath('userData').trim();
    if (userDataPath) {
        return createAppTempNamespace(userDataPath);
    }

    return `${getAppTempUserId()}-fallback`;
}

// os.tmpdir(), not app.getPath('temp'): on macOS Electron's temp path ignores
// TMPDIR while os.tmpdir() honors it. Only earlier releases' roots live here.
function getOperatingSystemTempDir() {
    return tmpdir();
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

export function getAppTempDirPathForUserData(userDataPath: string, baseDir = getAppStateDir()) {
    return getAppTempNamespacePath(
        userDataPath,
        baseDir,
        getAppTempUserId(),
        process.platform === 'win32',
    );
}

/** This profile's namespace in the persistent per-user folder getAppStateDir() names. */
export function getAppTempDirPath() {
    return getAppTempNamespacePathForNamespace(getAppTempNamespace());
}

/**
 * This profile's namespace in the OS temp folder, where releases before
 * 2026-10 kept it. Its working copies stay readable and its records are
 * settled at startup, then the namespace cleanup removes it; nothing new is
 * written there. Remove once no supported release upgrades from one of those.
 */
export function getRetiredAppTempDirPath() {
    return getAppTempNamespacePathForNamespace(getAppTempNamespace(), getOperatingSystemTempDir());
}

/** Where this profile's working copies can be: its namespace and the retired one. Every check of that reads this. */
export function getManagedAppTempRoots() {
    return [
        getAppTempDirPath(),
        getRetiredAppTempDirPath(),
    ];
}

function writeAppTempNamespaceOwner(tempDir: string, startTime: string | null) {
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
        startTime,
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
    const created = mkdirSync(tempDir, { recursive: true });
    // A power cut must not lose the folder that holds the durable journals:
    // every folder this call made gets its entry on disk.
    for (let directory = tempDir; created !== undefined; directory = dirname(directory)) {
        fsyncDirectorySync(dirname(directory));
        if (directory === created || dirname(directory) === directory) break;
    }
    if (created !== undefined && created !== tempDir && process.platform === 'darwin') {
        // Working copies need no Time Machine copy. The sticky exclusion is an
        // attribute on the folder, set once where the folder is made; a failure
        // costs only backup space.
        execFile('/usr/bin/tmutil', [
            'addexclusion',
            getAppStateDir(),
        ], () => undefined);
    }
    if (lstatSync(tempDir).isSymbolicLink()) {
        throw new Error(`App temp directory must not be a symbolic link: ${tempDir}`);
    }
    chmodSync(tempDir, 0o700);
    // Until this process's start time is read, the namespace has no owner, and
    // other profiles' starts leave it alone.
    if (initializedAppTempNamespace) {
        void getOwnStartTime().then(startTime => writeAppTempNamespaceOwner(tempDir, startTime)).catch(() => undefined);
    }
    return tempDir;
}
