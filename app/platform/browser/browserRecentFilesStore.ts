import { getErrorMessage } from '@app/utils/error';
import {parseDocumentRef} from '@contracts/documentRef';
import type { IRecentFile } from '@contracts/shared';
import { createEpochMs } from '@contracts/timestamps';
import {
    readLocalStorageItem,
    safeSetLocalStorageItem,
} from '@app/utils/localStorage';
import { BROWSER_RECENT_FILES_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';
import {
    expireLegacyRecentFilesCookie,
    parseRecentFilesPayload,
    parseRecentFilesStorageSnapshot,
    serializeRecentFilesPayload,
} from '@app/utils/recentFilesPersistence';
import {
    BROWSER_MAX_RECENT_FILES,
    BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES,
    DOCUMENTS_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import {runObjectStoreTransaction} from '@app/platform/browser/browserDocumentIdb';
import { buildRecentFilesFromPersistedRecords } from '@app/platform/browser/buildRecentFilesFromPersistedRecords';
import type { IBrowserPersistedDocumentRecordsLoadResult } from '@app/platform/browser/browserPersistedDocumentRecordsLoadResult';

export class BrowserRecentFilesStorageUnavailableError extends Error {
    public constructor(cause?: unknown) {
        super(`Browser Recent Files storage is unavailable${cause instanceof Error ? `: ${getErrorMessage(cause)}` : ''}`);
        this.name = 'BrowserRecentFilesStorageUnavailableError';
        this.cause = cause;
    }
}

export const BROWSER_RECENT_FILES_STORAGE_LOCK_KEY = '__evb_recent_files_storage_lock__';

interface IRecentFilesStorageMutation<T> {
    files: IRecentFile[];
    value: T;
}

function commitRecentFilesStorageMutation<T>(
    mutation: (currentFiles: IRecentFile[]) => IRecentFilesStorageMutation<T>,
) {
    const currentFiles = readRecentFilesFromStorage();
    const next = mutation(currentFiles);
    if (!writeRecentFilesToStorage(next.files)) {
        throw new BrowserRecentFilesStorageUnavailableError();
    }
    return next.value;
}

export async function runSerializedRecentFilesStorageMutation<T>(
    mutation: (currentFiles: IRecentFile[]) => IRecentFilesStorageMutation<T>,
) {
    const transactionResult = await runObjectStoreTransaction<
        {value: T} | {error: unknown}
    >(
        DOCUMENTS_STORE,
        'readwrite',
        (store, setResult) => {
            const lockRead = store.get(BROWSER_RECENT_FILES_STORAGE_LOCK_KEY);
            lockRead.onsuccess = () => {
                try {
                    setResult({value: commitRecentFilesStorageMutation(mutation)});
                } catch (error) {
                    setResult({error});
                }
            };
        },
    );
    if (transactionResult) {
        if ('error' in transactionResult) {
            throw transactionResult.error;
        }
        return transactionResult.value;
    }

    // When IndexedDB exists but cannot open or commit, do not fall back to an
    // unlocked localStorage mutation. Two browser windows could otherwise
    // overwrite each other's Recent Files list while both report success.
    if (typeof indexedDB !== 'undefined') {
        throw new BrowserRecentFilesStorageUnavailableError();
    }
    return commitRecentFilesStorageMutation(mutation);
}

export function readRecentFilesFromStorage() {
    const result = readLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY);
    if (result.status === 'unavailable') {
        throw new BrowserRecentFilesStorageUnavailableError(result.error);
    }
    const raw = result.status === 'present' ? result.value : null;
    return parseRecentFilesPayload(raw);
}

/** Maintenance must fail closed when localStorage is unavailable. */
export function tryReadRecentFilesFromStorage() {
    try {
        return readRecentFilesFromStorage();
    } catch {
        return null;
    }
}

function hasRecentFilesStorageSnapshot() {
    const result = readLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY);
    if (result.status === 'unavailable') {
        throw new BrowserRecentFilesStorageUnavailableError(result.error);
    }
    if (result.status === 'absent') {
        return false;
    }
    const snapshot = parseRecentFilesStorageSnapshot(result.value);
    return snapshot.hasSnapshot && !snapshot.truncated;
}

/** Maintenance must not turn a storage outage into an empty-history write. */
export function tryHasRecentFilesStorageSnapshot() {
    try {
        return hasRecentFilesStorageSnapshot();
    } catch {
        return false;
    }
}

export function writeRecentFilesToStorage(recentFiles: IRecentFile[]) {
    const payload = serializeRecentFilesPayload(recentFiles);
    const committed = safeSetLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY, payload);
    if (!committed) {
        return false;
    }
    expireLegacyRecentFilesCookie();
    return true;
}

function normalizeRecentFileSize(fileSize: number | undefined) {
    if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize < 0) {
        return 0;
    }

    return Math.floor(fileSize);
}

export function pruneRecentFiles(recentFiles: IRecentFile[]) {
    const keptRecentFiles: IRecentFile[] = [];
    const evictedRefs = new Set<string>();
    const keptRefs = new Set<string>();
    let totalBytes = 0;

    for (const recentFile of recentFiles) {
        if (keptRefs.has(recentFile.originalPath)) {
            evictedRefs.add(recentFile.originalPath);
            continue;
        }

        const fileSize = normalizeRecentFileSize(recentFile.fileSize);
        const exceedsCountLimit = keptRecentFiles.length >= BROWSER_MAX_RECENT_FILES;
        const exceedsByteLimit = keptRecentFiles.length > 0
            && (totalBytes + fileSize) > BROWSER_MAX_RECENT_FILES_PERSISTED_BYTES;

        if (exceedsCountLimit || exceedsByteLimit) {
            evictedRefs.add(recentFile.originalPath);
            continue;
        }

        keptRecentFiles.push({
            ...recentFile,
            backend: 'browser',
            fileSize,
        });
        keptRefs.add(recentFile.originalPath);
        totalBytes += fileSize;
    }

    return {
        recentFiles: keptRecentFiles,
        evictedRefs: Array.from(evictedRefs),
    };
}

export interface IBrowserRecentFilesRepository {
    requireEntry: (ref: string) => Promise<{
        retention: 'durable' | 'transient';
        saveName?: string;
        fileName: string;
        fileSize: number;
        updatedAt: number;
    }>;
    getAllPersistedRecords: () => Promise<IBrowserPersistedDocumentRecordsLoadResult>;
    cleanupEvictedRecentRefs: (refs: string[]) => Promise<void>;
}

export class BrowserRecentFilesStore {
    public constructor(private readonly repository: IBrowserRecentFilesRepository) {}

    public async touchRecentFile(ref: string) {
        const entry = await this.repository.requireEntry(ref);
        if (entry.retention === 'transient') {
            await this.removeRecentFile(ref);
            return;
        }
        const evictedRefs = await runSerializedRecentFilesStorageMutation(currentRecentFiles => {
            const nextRecentFiles = currentRecentFiles.filter(
                (candidate) => candidate.originalPath !== ref,
            );

            const originalPath = parseDocumentRef(ref);
            if (originalPath === null) {
                throw new TypeError('Recent file reference is invalid');
            }
            nextRecentFiles.unshift({
                originalPath,
                backend: 'browser',
                fileName: entry.saveName ?? entry.fileName,
                timestamp: createEpochMs(),
                fileSize: entry.fileSize,
                modifiedAt: createEpochMs(entry.updatedAt),
            });

            const {
                recentFiles,
                evictedRefs,
            } = pruneRecentFiles(nextRecentFiles);
            return {
                files: recentFiles,
                value: evictedRefs,
            };
        });
        await this.repository.cleanupEvictedRecentRefs(evictedRefs);
    }

    public getRecentFiles() {
        expireLegacyRecentFilesCookie();
        return readRecentFilesFromStorage();
    }

    public async recoverRecentFilesIfStorageMissing() {
        if (hasRecentFilesStorageSnapshot()) {
            return this.getRecentFiles();
        }

        const {
            available,
            records,
        } = await this.repository.getAllPersistedRecords();
        if (!available) {
            return [];
        }
        const recentFiles = await runSerializedRecentFilesStorageMutation(currentRecentFiles => {
            if (hasRecentFilesStorageSnapshot()) {
                return {
                    files: currentRecentFiles,
                    value: currentRecentFiles,
                };
            }
            const {recentFiles: recoveredRecentFiles} = pruneRecentFiles(buildRecentFilesFromPersistedRecords(records));
            return {
                files: recoveredRecentFiles,
                value: recoveredRecentFiles,
            };
        });
        return recentFiles;
    }

    public async removeRecentFile(ref: string) {
        const removed = await runSerializedRecentFilesStorageMutation(currentRecentFiles => {
            const nextRecentFiles = currentRecentFiles.filter(
                (candidate) => candidate.originalPath !== ref,
            );
            return {
                files: nextRecentFiles,
                value: nextRecentFiles.length !== currentRecentFiles.length,
            };
        });
        if (removed) {
            await this.repository.cleanupEvictedRecentRefs([ref]);
        }
    }

    public async clearRecentFiles() {
        const evictedRefs = await runSerializedRecentFilesStorageMutation(currentRecentFiles => ({
            files: [],
            value: currentRecentFiles.map(candidate => candidate.originalPath),
        }));
        await this.repository.cleanupEvictedRecentRefs(evictedRefs);
    }
}
