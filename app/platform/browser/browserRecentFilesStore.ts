import * as v from 'valibot';
import { sameWitness } from '@document-store/contentWitness';
import { getErrorMessage } from '@app/utils/error';
import type {TDocumentRef} from '@contracts/documentRef';
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
    serializeRecentFilesPayload,
} from '@app/utils/recentFilesPersistence';
import {runBrowserLock} from '@app/platform/browser/runBrowserLock';

export class BrowserRecentFilesStorageUnavailableError extends Error {
    public constructor(cause?: unknown) {
        super(`Browser Recent Files storage is unavailable${cause instanceof Error ? `: ${getErrorMessage(cause)}` : ''}`);
        this.name = 'BrowserRecentFilesStorageUnavailableError';
        this.cause = cause;
    }
}

export const BROWSER_RECENT_FILES_STORAGE_LOCK_KEY = '__evb_recent_files_storage_lock__';

// Where a reader left a Recent document, with the witness of the source file
// it was left on. As on desktop it rides on its Recent entry, so
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

/** Every window's Recent Files writes take one lock, so no window overwrites another's change. */
export async function runSerializedRecentFilesStorageMutation<T>(
    mutation: (currentFiles: IRecentFile[]) => IRecentFilesStorageMutation<T>,
) {
    return runBrowserLock(BROWSER_RECENT_FILES_STORAGE_LOCK_KEY, async () => commitRecentFilesStorageMutation(mutation));
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

/** Desktop's Recent for the browser: picked files reopen through their stored handles or stored copies. */
export class BrowserRecentFilesStore {
    public async touch(ref: TDocumentRef, fileName: string, fileSize: number) {
        await runSerializedRecentFilesStorageMutation(currentRecentFiles => {
            const nextRecentFiles = currentRecentFiles.filter(candidate => candidate.originalPath !== ref);
            nextRecentFiles.unshift({
                originalPath: ref,
                backend: 'browser',
                fileName,
                timestamp: createEpochMs(),
                fileSize,
                modifiedAt: createEpochMs(),
            });
            return {files: pruneRecentFiles(nextRecentFiles).recentFiles, value: undefined};
        });
    }

    public list() {
        expireLegacyRecentFilesCookie();
        return readRecentFilesFromStorage().slice(0, RECENT_FILES_LIMIT);
    }

    public async remove(ref: string) {
        return runSerializedRecentFilesStorageMutation(currentRecentFiles => {
            const nextRecentFiles = currentRecentFiles.filter(candidate => candidate.originalPath !== ref);
            return {files: nextRecentFiles, value: nextRecentFiles.length !== currentRecentFiles.length};
        });
    }

    /** Remembers where a reader left a document that is already in Recent; never adds an entry. */
    public async rememberReadingView(ref: string, sourceWitness: string, view: IRecentReadingView) {
        await runSerializedRecentFilesStorageMutation((currentFiles) => {
            const readingViews = readStoredReadingViews();
            if (currentFiles.some(file => file.originalPath === ref)) {
                readingViews.set(ref, {view, sourceWitness});
            }
            return {files: currentFiles, value: undefined, readingViews};
        });
    }

    /** The view a reader left `ref` at, if its source is still the file `sourceWitness` names. */
    public readReadingView(ref: string, sourceWitness: string) {
        const stored = readStoredReadingViews().get(ref);
        return stored && sameWitness(stored.sourceWitness, sourceWitness) ? stored.view : null;
    }

    public async clear() {
        await runSerializedRecentFilesStorageMutation(() => ({files: [], value: undefined}));
    }
}
