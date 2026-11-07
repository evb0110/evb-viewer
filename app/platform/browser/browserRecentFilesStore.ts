import * as v from 'valibot';
import { getErrorMessage } from '@app/utils/error';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    RECENT_READING_VIEW_SCHEMA,
    type IRecentReadingView,
} from '@contracts/recentReadingView';
import {isRecord} from '@contracts/runtimeGuards';
import {safeJsonParse} from '@contracts/safeJsonParse';
import {
    RECENT_FILES_LIMIT,
    type IRecentFile,
} from '@contracts/shared';
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
import {DOCUMENTS_STORE} from '@app/platform/browser/browserDocumentConstants';
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

// Where a reader left a Recent document, with the content witness of the
// source bytes it was left on. As on desktop it rides on its Recent entry, so
// it goes when the entry goes; the list's parser drops it, so only this store
// reads it.
const STORED_READING_VIEW_SCHEMA = v.object({
    view: RECENT_READING_VIEW_SCHEMA,
    sourceWitness: v.pipe(v.string(), v.minLength(1)),
});
type TStoredReadingViews = Map<string, v.InferOutput<typeof STORED_READING_VIEW_SCHEMA>>;

function readStoredReadingViews(): TStoredReadingViews {
    const views: TStoredReadingViews = new Map();
    const result = readLocalStorageItem(BROWSER_RECENT_FILES_STORAGE_KEY);
    let parsed: unknown = null;
    try {
        parsed = result.status === 'present' ? safeJsonParse(result.value) : null;
    } catch {
        return views;
    }
    const files: unknown[] = Array.isArray(parsed) ? parsed : (isRecord(parsed) && Array.isArray(parsed.files) ? parsed.files : []);
    for (const file of files) {
        if (!isRecord(file) || typeof file.originalPath !== 'string') {
            continue;
        }
        const stored = v.safeParse(STORED_READING_VIEW_SCHEMA, file.readingView);
        if (stored.success) {
            views.set(file.originalPath, stored.output);
        }
    }
    return views;
}

interface IRecentFilesStorageMutation<T> {
    files: IRecentFile[];
    value: T;
    readingViews?: TStoredReadingViews;
}

function commitRecentFilesStorageMutation<T>(
    mutation: (currentFiles: IRecentFile[]) => IRecentFilesStorageMutation<T>,
) {
    const currentFiles = readRecentFilesFromStorage();
    const next = mutation(currentFiles);
    if (!writeRecentFilesToStorage(next.files, next.readingViews)) {
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

/** Writes the list; an entry that stays keeps its reading view. */
export function writeRecentFilesToStorage(recentFiles: IRecentFile[], readingViews = readStoredReadingViews()) {
    const payload = serializeRecentFilesPayload(recentFiles.map((file) => {
        const readingView = readingViews.get(file.originalPath);
        return readingView ? {
            ...file,
            readingView,
        } : file;
    }));
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

/**
 * Desktop's Recent: the newest distinct documents, as many as its limit. A
 * document's size is shown, never budgeted; storage admission governs bytes.
 */
export function pruneRecentFiles(recentFiles: IRecentFile[]) {
    const keptRecentFiles: IRecentFile[] = [];
    const keptRefs = new Set<string>();
    const evictedRefs = new Set<string>();
    for (const recentFile of recentFiles) {
        if (keptRefs.has(recentFile.originalPath)) continue;
        if (keptRecentFiles.length >= RECENT_FILES_LIMIT) {
            evictedRefs.add(recentFile.originalPath);
            continue;
        }
        keptRecentFiles.push({
            ...recentFile,
            backend: 'browser',
            fileSize: normalizeRecentFileSize(recentFile.fileSize),
        });
        keptRefs.add(recentFile.originalPath);
    }

    return {
        recentFiles: keptRecentFiles,
        evictedRefs: Array.from(evictedRefs),
    };
}

export interface IBrowserRecentFilesRepository {
    requireEntry: (ref: string) => Promise<{
        retention: 'durable' | 'transient';
        saveName?: string | undefined;
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
        return readRecentFilesFromStorage().slice(0, RECENT_FILES_LIMIT);
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
        return removed;
    }

    /** Remembers where a reader left a document that is already in Recent; never adds an entry. */
    public async rememberReadingView(ref: string, sourceWitness: string, view: IRecentReadingView) {
        await runSerializedRecentFilesStorageMutation((currentFiles) => {
            const readingViews = readStoredReadingViews();
            if (currentFiles.some(file => file.originalPath === ref)) {
                readingViews.set(ref, {
                    view,
                    sourceWitness,
                });
            }
            return {
                files: currentFiles,
                value: undefined,
                readingViews,
            };
        });
    }

    /** The view a reader left `ref` at, if its source is still the bytes `sourceWitness` names. */
    public readReadingView(ref: string, sourceWitness: string) {
        const stored = readStoredReadingViews().get(ref);
        return stored?.sourceWitness === sourceWitness ? stored.view : null;
    }

    public async clearRecentFiles() {
        const evictedRefs = await runSerializedRecentFilesStorageMutation(currentRecentFiles => ({
            files: [],
            value: currentRecentFiles.map(candidate => candidate.originalPath),
        }));
        await this.repository.cleanupEvictedRecentRefs(evictedRefs);
    }
}
