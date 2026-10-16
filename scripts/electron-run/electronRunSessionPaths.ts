import {
    isAbsolute,
    join,
} from 'node:path';
import {
    getAppTempNamespacePath,
    getAppTempUserId,
} from '@node-runtime/appTempNamespace';
import { projectRoot } from '@scripts/electron-run/projectRoot';

let currentSessionName = 'default';

export function validateSessionName(name: string) {
    if (!name || name === '.' || name === '..') {
        throw new Error('Session name must not be empty, "." or ".."');
    }
    if (name.includes('/') || name.includes('\\') || name.includes('..') || isAbsolute(name)) {
        throw new Error('Session name must not contain path separators or traversal segments');
    }
    return name;
}

export function getCurrentSessionName() {
    return currentSessionName;
}

export function setCurrentSessionName(name: string) {
    currentSessionName = validateSessionName(name);
}

export function releaseCurrentSessionName(name: string) {
    const validatedName = validateSessionName(name);
    if (currentSessionName !== validatedName) {
        return false;
    }
    currentSessionName = 'default';
    return true;
}

export const sessionsBaseDir = join(projectRoot, '.devkit', 'sessions');

export function sessionDir(name = getCurrentSessionName()) {
    return join(sessionsBaseDir, validateSessionName(name));
}

export function sessionFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session.json');
}

export function sessionStartingFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session-starting.json');
}

export function sessionLogFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session.log');
}

/**
 * Marker the external stop path writes and the supervisor's own shutdown reads to
 * keep a session's Nuxt server alive for a fast restart. One owner for the name so
 * the writer and the reader cannot drift apart.
 */
export function sessionKeepNuxtMarkerPath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'keep-nuxt-on-stop');
}

export function sessionPreserveWorkspaceCheckpointMarkerPath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'preserve-workspace-checkpoint-on-stop');
}

export function electronUserDataPath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'electron-user-data');
}

/** The state folder a launch gives the app: the one the run names in EVB_APP_STATE_DIR, else the session's own. */
export function electronAppStatePath(name = getCurrentSessionName()) {
    const override = process.env.EVB_APP_STATE_DIR?.trim();
    if (override) {
        return override;
    }
    return join(sessionDir(name), 'app-state');
}

export function electronAppTempDirPath(name = getCurrentSessionName()) {
    return getAppTempNamespacePath(
        electronUserDataPath(name),
        electronAppStatePath(name),
        getAppTempUserId(),
        process.platform === 'win32',
    );
}

export function electronFileLogDir(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'electron-logs');
}

export function resolveAutomationFileLogDir(
    env: NodeJS.ProcessEnv,
    name = getCurrentSessionName(),
) {
    const override = env.EVB_FILE_LOG_DIR;
    return override === undefined || override === ''
        ? electronFileLogDir(name)
        : override;
}

export function screenshotDirPath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'screenshots');
}
