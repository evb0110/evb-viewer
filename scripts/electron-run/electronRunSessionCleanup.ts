import {
    existsSync,
    rmSync,
} from 'node:fs';
import {
    electronAppTempDirPath,
    electronUserDataPath,
    getCurrentSessionName,
    sessionPreserveWorkspaceCheckpointMarkerPath,
} from '@scripts/electron-run/electronRunSessionPaths';
import {findSessionOwnedElectronPids} from '@scripts/electron-run/electronRunProcessIdentity';
import {hasWorkspaceCrashCheckpoint} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';

export function hasWorkspaceRecoveryEvidence(name = getCurrentSessionName()) {
    return existsSync(sessionPreserveWorkspaceCheckpointMarkerPath(name))
        || hasWorkspaceCrashCheckpoint(name);
}

/**
 * Remove only the app-temp namespace owned by one isolated Electron session.
 * Callers must first establish that the session's Electron processes have
 * stopped, and must skip this operation when workspace recovery is preserved.
 */
export function cleanupSessionAppTemp(name = getCurrentSessionName()) {
    rmSync(electronAppTempDirPath(name), {
        recursive: true,
        force: true,
    });
}

/**
 * Recheck the profile before deleting a namespace during recovery. A missing
 * session file is not enough to establish that Electron stopped.
 */
export function cleanupSessionAppTempIfUnowned(name = getCurrentSessionName()) {
    const ownedElectronPids = findSessionOwnedElectronPids({
        kind: 'electron',
        sessionName: name,
        electronUserDataDir: electronUserDataPath(name),
    });
    if (ownedElectronPids.length > 0) {
        return false;
    }
    cleanupSessionAppTemp(name);
    return true;
}
