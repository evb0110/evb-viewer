import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';
import {
    cloneBytes,
    normalizeReadRange,
} from '@app/platform/browser/browserDocumentBytes';
import {
    createEntryFromPersistedRecord,
    createPersistedBrowserDocumentRecord,
    toPersistedDocumentRecord,
} from '@app/platform/browser/browserDocumentRecords';
import { buildBrowserDocumentFullReadError } from '@app/platform/browser/browserDocumentStoragePolicy';
import type { IBrowserDocumentEntry } from '@app/platform/browser/browserDocumentTypes';
import {
    deleteRecord,
    loadRecordAvailability,
    persistRecord,
} from '@app/platform/browser/browserDocumentIdb';
import {
    clearBrowserDocumentExternalChunkStorage,
    clearPendingBrowserDocumentChunks,
    readBrowserDocumentChunkedEntryBytes,
    readBrowserDocumentChunkedEntryRange,
} from '@app/platform/browser/browserDocumentChunkStorage';
import {
    cleanupBrowserEvictedRecentRefs,
    isBrowserRecentFileRef,
    loadBrowserPersistedDocumentRecords,
    loadBrowserPersistedDocumentRecordsResult,
    sweepBrowserDocumentMaintenance,
} from '@app/platform/browser/browserDocumentMaintenance';
import {
    createBrowserDocumentRevisionInfo,
    getBrowserDocumentEntryContentRevision,
} from '@app/platform/browser/browserDocumentRevision';
import { BrowserDocumentMutationQueue } from '@app/platform/browser/browserDocumentMutationQueue';
import { BrowserRecentFilesStore } from '@app/platform/browser/browserRecentFilesStore';
import {createBrowserFileContentWitness} from '@app/platform/browser/createBrowserFileContentWitness';
import type {
    IDocumentRevisionChangedEvent,
    IDocumentRevisionInfo,
    TDocumentRevisionChangeReason,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    createMissingRevisionError,
    createStaleRevisionError,
} from '@contracts/documentMutationErrors';

async function ensureFileHandleReadPermission(handle: FileSystemFileHandle) {
    interface IFileSystemHandlePermissionDescriptor {mode: 'read';}

    const permissionHandle = handle as FileSystemFileHandle & {
        queryPermission?: (descriptor?: IFileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
        requestPermission?: (descriptor?: IFileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
    };
    const descriptor: IFileSystemHandlePermissionDescriptor = { mode: 'read' };

    if (typeof permissionHandle.queryPermission === 'function') {
        const currentPermission = await permissionHandle.queryPermission(descriptor);
        if (currentPermission === 'granted') {
            return;
        }
    }

    if (typeof permissionHandle.requestPermission === 'function') {
        const requestedPermission = await permissionHandle.requestPermission(descriptor);
        if (requestedPermission === 'granted') {
            return;
        }
    }
}

async function readFileHandleBytes(
    handle: FileSystemFileHandle,
    offset?: number,
    length?: number,
) {
    await ensureFileHandleReadPermission(handle);
    const file = await handle.getFile();
    if (typeof offset === 'number' && typeof length === 'number') {
        const start = Math.max(0, offset);
        const end = Math.max(start, start + Math.max(0, length));
        return {
            size: file.size,
            lastModified: file.lastModified,
            file,
            bytes: new Uint8Array(await file.slice(start, end).arrayBuffer()),
        };
    }

    return {
        size: file.size,
        lastModified: file.lastModified,
        file,
        bytes: new Uint8Array(await file.arrayBuffer()),
    };
}

export async function readFileHandleMetadata(handle: FileSystemFileHandle) {
    await ensureFileHandleReadPermission(handle);
    const file = await handle.getFile();
    return {
        size: file.size,
        lastModified: file.lastModified,
        file,
    };
}

function readFileSnapshotBytes(file: File, offset?: number, length?: number) {
    if (typeof offset === 'number' && typeof length === 'number') {
        const start = Math.max(0, offset);
        const end = Math.max(start, start + Math.max(0, length));
        return file.slice(start, end).arrayBuffer().then(bytes => new Uint8Array(bytes));
    }
    return file.arrayBuffer().then(bytes => new Uint8Array(bytes));
}

export class BrowserDocumentRecordStore {
    private readonly entries = new Map<string, IBrowserDocumentEntry>();
    private readonly mutationQueue = new BrowserDocumentMutationQueue();
    private readonly revisionListeners = new Set<(event: IDocumentRevisionChangedEvent) => void>();
    private readonly recentFilesStore = new BrowserRecentFilesStore({
        requireEntry: (ref) => this.requireEntry(ref),
        getAllPersistedRecords: () => loadBrowserPersistedDocumentRecordsResult(),
        cleanupEvictedRecentRefs: (refs) => cleanupBrowserEvictedRecentRefs(
            refs,
            async (ref) => {
                await this.cleanupDetachedPersistedRecord(ref, { allowDurable: true });
            },
        ),
    });
    private maintenancePromise: Promise<void> | null = null;
    private maintenanceComplete = false;

    protected hasLoadedEntry(ref: string) {
        return this.entries.has(ref);
    }

    protected attachEntry(entry: IBrowserDocumentEntry) {
        this.entries.set(entry.ref, entry);
    }

    protected async findPersistedFileHandleRef(handle: FileSystemFileHandle) {
        const result = await loadBrowserPersistedDocumentRecordsResult();
        if (!result.available) {
            return null;
        }

        for (const record of result.records) {
            if (record.kind !== 'source' || !record.saveHandle) {
                continue;
            }

            let sameEntry = record.saveHandle === handle;
            if (!sameEntry && typeof record.saveHandle.isSameEntry === 'function') {
                try {
                    sameEntry = await record.saveHandle.isSameEntry(handle);
                } catch {
                    sameEntry = false;
                }
            }
            if (!sameEntry && typeof handle.isSameEntry === 'function') {
                try {
                    sameEntry = await handle.isSameEntry(record.saveHandle);
                } catch {
                    sameEntry = false;
                }
            }
            if (!sameEntry) {
                continue;
            }

            const entry = await this.ensureEntry(record.ref);
            if (entry) {
                return record.ref;
            }
        }
        return null;
    }

    /**
     * Drops the in-memory record without touching persisted storage. Passing
     * `expectedEntry` makes the drop a no-op once a newer record took the ref.
     */
    protected dropLoadedEntry(
        ref: string,
        expectedEntry?: IBrowserDocumentEntry,
    ) {
        if (expectedEntry && this.entries.get(ref) !== expectedEntry) {
            return;
        }
        this.entries.delete(ref);
    }

    protected emitDocumentRevisionChanged(event: IDocumentRevisionChangedEvent) {
        for (const listener of this.revisionListeners) {
            listener(event);
        }
    }

    protected emitRevisionChangeForEntry(
        entry: IBrowserDocumentEntry,
        previousToken: TDocumentRevisionToken | undefined,
        reason: TDocumentRevisionChangeReason,
    ) {
        this.emitDocumentRevisionChanged({
            ...createBrowserDocumentRevisionInfo(entry),
            ...(previousToken ? { previousToken } : {}),
            reason,
        });
        for (const dependentEntry of this.entries.values()) {
            if (
                dependentEntry.ref !== entry.ref
                && dependentEntry.storageMode === 'source-proxy'
                && dependentEntry.sourceRef === entry.ref
            ) {
                this.emitDocumentRevisionChanged({
                    ...createBrowserDocumentRevisionInfo(entry, dependentEntry.ref),
                    ...(previousToken ? { previousToken } : {}),
                    reason,
                });
            }
        }
    }

    public async ensureEntryAvailability(ref: string): Promise<{
        available: boolean;
        entry: IBrowserDocumentEntry | null;
    }> {
        await this.ensureMaintenance();
        const inMemory = this.entries.get(ref);
        if (inMemory) {
            if (inMemory.pendingLoad) {
                await inMemory.pendingLoad;
            }
            return {
                available: true,
                entry: inMemory,
            };
        }

        const persistedResult = await loadRecordAvailability(ref);
        if (!persistedResult.available) {
            return {
                available: false,
                entry: null,
            };
        }

        const normalizedRecord = toPersistedDocumentRecord(persistedResult.value);
        if (!normalizedRecord) {
            return {
                available: true,
                entry: null,
            };
        }

        // A write (or another hydration) may have installed a fresher entry
        // while the IndexedDB read above was in flight. Installing the loaded
        // record unconditionally would overwrite those newer bytes, so re-check
        // the map and defer to whatever landed instead of clobbering it.
        const concurrent = this.entries.get(ref);
        if (concurrent) {
            if (concurrent.pendingLoad) {
                await concurrent.pendingLoad;
            }
            return {
                available: true,
                entry: concurrent,
            };
        }

        const entry = createEntryFromPersistedRecord(normalizedRecord);

        this.entries.set(ref, entry);
        return {
            available: true,
            entry,
        };
    }

    public async ensureEntry(ref: string): Promise<IBrowserDocumentEntry | null> {
        return (await this.ensureEntryAvailability(ref)).entry;
    }

    public async requireEntry(ref: string): Promise<IBrowserDocumentEntry> {
        const entry = await this.ensureEntry(ref);
        if (!entry) {
            throw new Error(`Browser document not found: ${ref}`);
        }
        return entry;
    }

    public async read(ref: string): Promise<Uint8Array> {
        const entry = await this.requireEntry(ref);
        if (entry.fileSize > BROWSER_MAX_FULL_READ_BYTES) {
            throw buildBrowserDocumentFullReadError(entry.fileName, entry.fileSize);
        }
        return this.readEntryBytes(entry);
    }
    public async readRange(
        ref: string,
        offset: number,
        length: number,
    ): Promise<Uint8Array> {
        const entry = await this.requireEntry(ref);
        return this.readEntryRange(entry, offset, length);
    }
    public async stat(ref: string): Promise<{
        size: number;
        modifiedAt: number
    }> {
        const entry = await this.requireEntry(ref);
        if (entry.storageMode === 'source-proxy' && entry.sourceRef) {
            return this.stat(entry.sourceRef);
        }
        if (entry.saveHandle && (entry.sourceWitness || entry.storageMode === 'handle')) {
            await this.refreshHandleBackedEntry(entry);
        }
        return {
            size: entry.fileSize,
            modifiedAt: entry.updatedAt,
        };
    }
    public async getContentSignature(ref: string): Promise<string> {
        const entry = await this.requireEntry(ref);
        if (entry.storageMode === 'source-proxy' && entry.sourceRef) {
            return this.getContentSignature(entry.sourceRef);
        }
        if (entry.saveHandle && (entry.sourceWitness || entry.storageMode === 'handle')) {
            await this.refreshHandleBackedEntry(entry);
        }

        return [
            entry.storageMode,
            entry.fileSize,
            entry.contentToken ?? 'legacy',
            entry.chunkGeneration ?? '',
            entry.chunkCount,
            entry.chunkSize,
        ].join(':');
    }

    public async getDocumentRevision(ref: string): Promise<IDocumentRevisionInfo> {
        const entry = await this.requireEntry(ref);
        if (entry.storageMode === 'source-proxy' && entry.sourceRef) {
            const sourceEntry = await this.requireEntry(entry.sourceRef);
            if (sourceEntry.saveHandle && (sourceEntry.sourceWitness || sourceEntry.storageMode === 'handle')) {
                await this.refreshHandleBackedEntry(sourceEntry);
            }
            return createBrowserDocumentRevisionInfo(sourceEntry, ref);
        }

        if (entry.saveHandle && (entry.sourceWitness || entry.storageMode === 'handle')) {
            await this.refreshHandleBackedEntry(entry);
        }

        return createBrowserDocumentRevisionInfo(entry);
    }

    public async assertDocumentRevisionCurrent(
        ref: string,
        expectedRevision: TDocumentRevisionToken | null | undefined,
    ) {
        const entry = await this.requireEntry(ref);
        if (!expectedRevision) {
            if (entry.kind === 'working') {
                throw createMissingRevisionError({documentRef: ref});
            }
            return;
        }
        const actualRevision = await this.getDocumentRevision(ref);
        if (actualRevision.token !== expectedRevision) {
            throw createStaleRevisionError({
                documentRef: ref,
                expectedRevision,
                actualRevision: actualRevision.token,
            });
        }
    }

    public onDocumentRevisionChanged(listener: (event: IDocumentRevisionChangedEvent) => void) {
        this.revisionListeners.add(listener);
        return () => {
            this.revisionListeners.delete(listener);
        };
    }

    public async readText(ref: string) {
        const bytes = await this.read(ref);
        return new TextDecoder().decode(bytes);
    }

    public async exists(ref: string) {
        return (await this.ensureEntry(ref)) !== null;
    }

    public async remove(ref: string) {
        await this.runRefMutation(ref, () => this.removeUnlocked(ref));
    }

    protected onDocumentRemoved(_ref: string) {}

    private async removeUnlocked(ref: string) {
        await this.removeDocumentRecordUnlocked(ref);
        await this.removeRecentFile(ref);
    }

    /** Removes a document record while its caller owns the mutation queue. */
    protected async removeDocumentRecordUnlocked(ref: string) {
        await this.ensureMaintenance();
        const entry = await this.ensureEntry(ref);
        if (entry) {
            await clearPendingBrowserDocumentChunks(entry);
            await clearBrowserDocumentExternalChunkStorage(entry);
        }
        this.onDocumentRemoved(ref);
        this.dropLoadedEntry(ref);
        await deleteRecord(ref);
    }

    public unload(ref: string) {
        if (this.entries.get(ref)?.memoryOnly) {
            return;
        }
        this.dropLoadedEntry(ref);
    }

    public async cleanupDetachedDocument(ref: string) {
        return this.cleanupDetachedPersistedRecord(ref, { allowDurable: true });
    }

    private async cleanupDetachedPersistedRecord(
        ref: string,
        options?: { allowDurable?: boolean },
    ) {
        return this.runRefMutation(ref, () => this.cleanupDetachedPersistedRecordUnlocked(ref, options));
    }

    private async cleanupDetachedPersistedRecordUnlocked(
        ref: string,
        options?: { allowDurable?: boolean },
    ) {
        await this.ensureMaintenance();
        const entry = await this.ensureEntry(ref);
        if (!entry) {
            return false;
        }

        if (entry.kind === 'working') {
            await this.removeUnlocked(ref);
            return true;
        }

        if (isBrowserRecentFileRef(ref)) {
            return false;
        }

        const records = await loadBrowserPersistedDocumentRecords();
        const hasDependents = records.some((record) => (
            record.ref !== ref
            && record.sourceRef === ref
        ));
        if (hasDependents) {
            return false;
        }

        if (entry.retention !== 'transient' && options?.allowDurable !== true) {
            return false;
        }

        await this.removeUnlocked(ref);
        return true;
    }

    public async touchRecentFile(ref: string) {
        await this.recentFilesStore.touchRecentFile(ref);
    }

    public getRecentFiles() {
        return this.recentFilesStore.getRecentFiles();
    }

    public async recoverRecentFilesIfStorageMissing() {
        return this.recentFilesStore.recoverRecentFilesIfStorageMissing();
    }

    public async removeRecentFile(ref: string) {
        await this.recentFilesStore.removeRecentFile(ref);
    }

    public async clearRecentFiles() {
        await this.recentFilesStore.clearRecentFiles();
    }

    protected async ensureMaintenance() {
        if (this.maintenanceComplete) {
            return;
        }

        this.maintenancePromise ??= sweepBrowserDocumentMaintenance(this.entries)
            .then(() => {
                this.maintenanceComplete = true;
            })
            .finally(() => {
                this.maintenancePromise = null;
            });

        await this.maintenancePromise;
    }

    protected runRefMutation<T>(
        ref: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        return this.mutationQueue.run(ref, operation);
    }

    protected runRefMutationMany<T>(
        refs: readonly string[],
        operation: () => Promise<T>,
    ): Promise<T> {
        return this.mutationQueue.runMany(refs, operation);
    }

    private async refreshHandleBackedEntry(
        entry: IBrowserDocumentEntry,
    ) {
        if (!entry.saveHandle) {
            return;
        }

        const resolvedMetadata = await readFileHandleMetadata(entry.saveHandle);
        const contentToken = await createBrowserFileContentWitness(resolvedMetadata.file);
        if (
            entry.fileSize === resolvedMetadata.size
            && entry.fileLastModified === resolvedMetadata.lastModified
            && entry.contentToken === contentToken
        ) {
            entry.fileSnapshot = resolvedMetadata.file;
            return;
        }

        const previousToken = createBrowserDocumentRevisionInfo(entry).token;
        entry.fileSize = resolvedMetadata.size;
        entry.fileLastModified = resolvedMetadata.lastModified;
        entry.updatedAt = Date.now();
        entry.contentToken = contentToken;
        entry.fileSnapshot = resolvedMetadata.file;
        entry.contentRevision = getBrowserDocumentEntryContentRevision(entry) + 1;
        await persistRecord(createPersistedBrowserDocumentRecord(entry, entry.data, false));
        this.emitRevisionChangeForEntry(entry, previousToken, 'browser-handle-refresh');
    }

    protected async readEntryBytes(entry: IBrowserDocumentEntry): Promise<Uint8Array> {
        switch (entry.storageMode) {
            case 'source-proxy':
                if (!entry.sourceRef) {
                    return new Uint8Array();
                }
                return this.read(entry.sourceRef);
            case 'handle': {
                if (
                    entry.fileSnapshot
                    && entry.fileSnapshot.size === entry.fileSize
                    && entry.fileSnapshot.lastModified === entry.fileLastModified
                ) {
                    return readFileSnapshotBytes(entry.fileSnapshot);
                }
                if (!entry.saveHandle) {
                    return cloneBytes(entry.data);
                }
                const {
                    file,
                    bytes,
                } = await readFileHandleBytes(entry.saveHandle);
                entry.fileSnapshot = file;
                entry.fileSize = file.size;
                entry.fileLastModified = file.lastModified;
                return bytes;
            }
            case 'chunked': {
                return readBrowserDocumentChunkedEntryBytes(entry);
            }
            case 'inline':
            default:
                return cloneBytes(entry.data);
        }
    }

    protected async readEntryRange(
        entry: IBrowserDocumentEntry,
        offset: number,
        length: number,
    ) {
        const {
            start,
            rangeLength,
            end,
        } = normalizeReadRange(offset, length);

        switch (entry.storageMode) {
            case 'source-proxy':
                if (!entry.sourceRef) {
                    return new Uint8Array();
                }
                return this.readRange(entry.sourceRef, start, rangeLength);
            case 'handle': {
                if (
                    entry.fileSnapshot
                    && entry.fileSnapshot.size === entry.fileSize
                    && entry.fileSnapshot.lastModified === entry.fileLastModified
                ) {
                    return readFileSnapshotBytes(entry.fileSnapshot, start, rangeLength);
                }
                if (!entry.saveHandle) {
                    return entry.data.slice(start, end);
                }
                const {
                    file,
                    bytes,
                } = await readFileHandleBytes(entry.saveHandle, start, rangeLength);
                entry.fileSnapshot = file;
                entry.fileSize = file.size;
                entry.fileLastModified = file.lastModified;
                return bytes;
            }
            case 'chunked': {
                return readBrowserDocumentChunkedEntryRange(entry, start, rangeLength, end);
            }
            case 'inline':
            default:
                return entry.data.slice(start, end);
        }
    }
}
