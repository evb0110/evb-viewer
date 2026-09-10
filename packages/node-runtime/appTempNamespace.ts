import {createHash} from 'node:crypto';
import {
    join,
    win32,
} from 'node:path';

export const APP_TEMP_DIR_NAME = 'evb-viewer';

export function getAppTempUserId() {
    return typeof process.getuid === 'function'
        ? `u${String(process.getuid())}`
        : 'user';
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

export function getAppTempNamespacePathForNamespace(tempDir: string, namespace: string) {
    return joinTempDirectory(tempDir, getAppTempNamespaceDirectoryName(namespace));
}
