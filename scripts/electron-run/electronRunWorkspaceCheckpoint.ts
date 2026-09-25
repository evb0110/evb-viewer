import {
    existsSync,
    readdirSync,
    readFileSync,
    rmSync,
    unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { electronUserDataPath } from '@scripts/electron-run/electronRunSessionPaths';

const WORKSPACE_CRASH_CHECKPOINT_FILE_NAME = 'workspace-checkpoint.json';
const WORKSPACE_RECOVERY_DIRECTORY_NAME = 'workspace-recovery';

/** The single-file journal of earlier versions; the app migrates it on start. */
export function workspaceCrashCheckpointPath(name: string) {
    return join(electronUserDataPath(name), WORKSPACE_CRASH_CHECKPOINT_FILE_NAME);
}

function workspaceRecoveryDirectory(name: string) {
    return join(electronUserDataPath(name), WORKSPACE_RECOVERY_DIRECTORY_NAME);
}

function listWorkspaceRecoveryRecordPaths(name: string) {
    const directory = workspaceRecoveryDirectory(name);
    try {
        return readdirSync(directory)
            .filter(entry => entry.endsWith('.json'))
            .map(entry => join(directory, entry));
    } catch {
        return [];
    }
}

/** One record per window that has recoverable work, newest first. */
export function readWorkspaceRecoveryRecords<T extends {checkpoint?: {capturedAt?: number}}>(name: string): T[] {
    return listWorkspaceRecoveryRecordPaths(name)
        .flatMap((path) => {
            try {
                return [JSON.parse(readFileSync(path, 'utf8')) as T];
            } catch {
                return [];
            }
        })
        .sort((left, right) => (right.checkpoint?.capturedAt ?? 0) - (left.checkpoint?.capturedAt ?? 0));
}

export function hasWorkspaceCrashCheckpoint(name: string) {
    return listWorkspaceRecoveryRecordPaths(name).length > 0
        || existsSync(workspaceCrashCheckpointPath(name));
}

export function clearAutomationWorkspaceCrashCheckpoint(name: string) {
    const hadRecords = listWorkspaceRecoveryRecordPaths(name).length > 0;
    rmSync(workspaceRecoveryDirectory(name), {
        force: true,
        recursive: true,
    });
    try {
        unlinkSync(workspaceCrashCheckpointPath(name));
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return hadRecords;
        }
        throw error;
    }
}
