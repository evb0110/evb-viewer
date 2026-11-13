import {
    readdirSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { electronAppTempDirPath } from '@scripts/electron-run/electronRunSessionPaths';

/** A session's document store keeps one checkpoint per window under `workspaces/`. */
export function workspaceCheckpointDirectory(name: string) {
    return join(electronAppTempDirPath(name), 'document-store', 'workspaces');
}

/** The checkpoint file of the window `windowId` in a session; a test writes one to stand for a window's workspace. */
export function workspaceCrashCheckpointPath(name: string, windowId = 'automation-window') {
    return join(workspaceCheckpointDirectory(name), `${windowId}.json`);
}

function listWorkspaceRecoveryRecordPaths(name: string) {
    const directory = workspaceCheckpointDirectory(name);
    try {
        return readdirSync(directory)
            .filter(entry => entry.endsWith('.json'))
            .map(entry => join(directory, entry));
    } catch {
        return [];
    }
}

/** The renderer checkpoint of each window that has a workspace to restore, newest first. */
export function readWorkspaceRecoveryRecords<T extends {checkpoint?: {capturedAt?: number}}>(name: string): T[] {
    return listWorkspaceRecoveryRecordPaths(name)
        .flatMap((path) => {
            try {
                const stored = JSON.parse(readFileSync(path, 'utf8')) as {layout?: {checkpoint?: unknown}};
                return stored.layout?.checkpoint ? [{checkpoint: stored.layout.checkpoint} as T] : [];
            } catch {
                return [];
            }
        })
        .sort((left, right) => (right.checkpoint?.capturedAt ?? 0) - (left.checkpoint?.capturedAt ?? 0));
}

export function hasWorkspaceCrashCheckpoint(name: string) {
    return listWorkspaceRecoveryRecordPaths(name).length > 0;
}

export function clearAutomationWorkspaceCrashCheckpoint(name: string) {
    const hadRecords = hasWorkspaceCrashCheckpoint(name);
    rmSync(workspaceCheckpointDirectory(name), {
        force: true,
        recursive: true,
    });
    return hadRecords;
}

/**
 * The unsaved annotations a checkpoint's `artifactId` names, as JSON, once the document's drafts hold them durably;
 * `null` before. They live with the document the tab shows, not in the checkpoint.
 */
export function readAnnotationRecoveryDraft(name: string, artifactId: string) {
    const documents = join(electronAppTempDirPath(name), 'document-store', 'documents');
    let directories: string[];
    try {
        directories = readdirSync(documents);
    } catch {
        return null;
    }
    for (const directory of directories) {
        let entries: string[];
        try {
            entries = readdirSync(join(documents, directory));
        } catch {
            continue;
        }
        for (const entry of entries.filter(file => file.startsWith('drafts-') && file.endsWith('.json'))) {
            try {
                const drafts = JSON.parse(readFileSync(join(documents, directory, entry), 'utf8')) as {annotationRecovery?: {artifactId?: string}};
                if (drafts.annotationRecovery?.artifactId === artifactId) return JSON.stringify(drafts.annotationRecovery);
            } catch {
                // A drafts file being replaced; the next look finds its successor.
            }
        }
    }
    return null;
}
