import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {
    isAbsolute,
    join,
    win32,
} from 'node:path';

export const APP_TEMP_DIR_NAME = 'evb-viewer';
// Not an app name: macOS keeps an Electron profile at Application Support/<app
// name>, and APFS ignores case, so "evb-viewer" is an older "EVB-Viewer" profile.
const APP_STATE_DIR_NAME = 'evb-viewer-state';

export function getAppTempUserId() {
    return typeof process.getuid === 'function'
        ? `u${String(process.getuid())}`
        : 'user';
}

/**
 * The per-user folder that holds each profile's namespace: working copies,
 * their save journals and the export recovery records. It survives a reboot,
 * which the OS temp folder does not (tmpfs on Linux, cleared at boot on
 * macOS), and stays on this machine: LOCALAPPDATA, not the roaming profile,
 * on Windows. EVB_APP_STATE_DIR replaces it for isolated tests, and an
 * automation profile keeps it inside itself, never in the person's folder.
 */
export function getAppStateDir(env = process.env, platform = process.platform, home = homedir()) {
    const override = env.EVB_APP_STATE_DIR?.trim();
    if (override) {
        return override;
    }
    const automationUserDataDir = env.EVB_AUTOMATION_USER_DATA_DIR?.trim();
    if (automationUserDataDir) {
        return joinTempDirectory(automationUserDataDir, APP_STATE_DIR_NAME);
    }
    if (platform === 'win32') {
        const localAppData = env.LOCALAPPDATA?.trim() ?? '';
        return win32.join(localAppData === '' ? win32.join(home, 'AppData', 'Local') : localAppData, APP_STATE_DIR_NAME);
    }
    if (platform === 'darwin') {
        return join(home, 'Library', 'Application Support', APP_STATE_DIR_NAME);
    }
    const stateHome = env.XDG_STATE_HOME?.trim();
    return join(stateHome && isAbsolute(stateHome) ? stateHome : join(home, '.local', 'state'), APP_STATE_DIR_NAME);
}

export function getAppTempNamespaceDirectoryName(namespace: string) {
    return `${APP_TEMP_DIR_NAME}-${namespace}`;
}

function joinTempDirectory(tempDir: string, directoryName: string) {
    return /^[a-zA-Z]:[\\/]/.test(tempDir) || tempDir.startsWith('\\\\')
        ? win32.join(tempDir, directoryName)
        : join(tempDir, directoryName);
}

export function createAppTempNamespace(
    userDataPath: string,
    userId: string,
    isWindows: boolean,
) {
    const normalizedPath = isWindows
        ? userDataPath.trim().replaceAll('\\', '/').toLowerCase()
        : userDataPath.trim();
    if (!normalizedPath) {
        throw new Error('App temp namespace requires a non-empty userData path.');
    }
    const profileHash = createHash('sha256').update(normalizedPath).digest('hex').slice(0, 16);
    return `${userId}-${profileHash}`;
}

export function getAppTempNamespacePath(
    userDataPath: string,
    tempDir: string,
    userId: string,
    isWindows: boolean,
) {
    return joinTempDirectory(
        tempDir,
        getAppTempNamespaceDirectoryName(createAppTempNamespace(userDataPath, userId, isWindows)),
    );
}

export function getAppTempNamespacePathForNamespace(namespace: string, baseDir = getAppStateDir()) {
    return joinTempDirectory(baseDir, getAppTempNamespaceDirectoryName(namespace));
}
