import type {Dirent} from 'fs';
import {
    readFile,
    readdir,
    rm,
} from 'fs/promises';
import {join} from 'path';
import {isErrnoException} from '@contracts/runtimeGuards';

interface IAssistantChatSnapshotReference {
    type: 'session-snapshot-ref';
    blobFile: string;
}

function isSnapshotReference(value: unknown): value is IAssistantChatSnapshotReference {
    return typeof value === 'object'
        && value !== null
        && (value as {type?: unknown}).type === 'session-snapshot-ref'
        && typeof (value as {blobFile?: unknown}).blobFile === 'string';
}

function isMissingPathError(error: unknown) {
    return isErrnoException(error) && error.code === 'ENOENT';
}

function isAssistantChatSnapshotLog(entry: Dirent) {
    return entry.isFile() && entry.name.endsWith('.jsonl');
}

function isUnreferencedSnapshotBlob(entry: Dirent, references: ReadonlySet<string>) {
    return entry.isFile() && entry.name.endsWith('.json') && !references.has(entry.name);
}

function reportSnapshotBlobPruneError(
    filePath: string,
    error: unknown,
    onError?: (message: string, error: unknown) => void,
) {
    try {
        onError?.(`Failed to prune assistant chat snapshot blob "${filePath}"`, error);
    } catch {
        // Error reporting cannot stop the remaining housekeeping work.
    }
}

function addSnapshotBlobReferences(
    contents: string,
    parseRecord: (line: string) => unknown,
    references: Set<string>,
) {
    for (const rawLine of contents.split(/\r?\n/u)) {
        const record = parseRecord(rawLine.trim());
        if (isSnapshotReference(record)) {
            references.add(record.blobFile);
        }
    }
}

async function collectAssistantChatSnapshotBlobReferences(
    directories: readonly string[],
    parseRecord: (line: string) => unknown,
) {
    const references = new Set<string>();
    for (const directory of directories) {
        let entries;
        try {
            entries = await readdir(directory, {withFileTypes: true});
        } catch (error) {
            if (isMissingPathError(error)) {
                continue;
            }
            throw error;
        }
        for (const entry of entries) {
            if (!isAssistantChatSnapshotLog(entry)) {
                continue;
            }
            const filePath = join(directory, entry.name);
            try {
                addSnapshotBlobReferences(await readFile(filePath, 'utf8'), parseRecord, references);
            } catch (error) {
                if (isMissingPathError(error)) {
                    continue;
                }
                throw error;
            }
        }
    }
    return references;
}

export default async function pruneAssistantChatSnapshotBlobs(
    directories: readonly string[],
    blobsDir: string,
    parseRecord: (line: string) => unknown,
    onError?: (message: string, error: unknown) => void,
) {
    const referencedBlobFiles = await collectAssistantChatSnapshotBlobReferences(directories, parseRecord);
    let entries;
    try {
        entries = await readdir(blobsDir, {withFileTypes: true});
    } catch (error) {
        if (isMissingPathError(error)) {
            return;
        }
        throw error;
    }
    for (const entry of entries) {
        if (!isUnreferencedSnapshotBlob(entry, referencedBlobFiles)) {
            continue;
        }
        const filePath = join(blobsDir, entry.name);
        try {
            await rm(filePath, {force: true});
        } catch (error) {
            if (!isMissingPathError(error)) {
                reportSnapshotBlobPruneError(filePath, error, onError);
            }
        }
    }
}
