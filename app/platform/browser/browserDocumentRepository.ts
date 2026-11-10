import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    BROWSER_MAX_FULL_READ_BYTES,
    DOCUMENT_CHUNKS_STORE,
    DOCUMENTS_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import {
    cloneBytes,
    normalizePersistedWriteBytes,
    toUint8Array,
} from '@app/platform/browser/browserDocumentBytes';
import {
    createBrowserDocumentEntry,
    createEntryFromPersistedRecord,
    createPersistedBrowserDocumentRecord,
    toPersistedDocumentRecord,
} from '@app/platform/browser/browserDocumentRecords';
import { createBrowserDocumentRef } from '@app/platform/browser/browserDocumentRefs';
import {
    defaultRetentionForKind,
    resolveByteBackedStorageMode,
    resolveStoredDocumentStorageMode,
} from '@app/platform/browser/browserDocumentStoragePolicy';
import type {
    IBrowserDocumentEntry,
    IBrowserPersistedDocumentRecord,
    ICreateStoredDocumentOptions,
    IRegisterFileOptions,
    IWriteDocumentOptions,
} from '@app/platform/browser/browserDocumentTypes';
import {
    deleteRecord,
    queueBrowserDocumentRecordWrite,
    runObjectStoresTransaction,
} from '@app/platform/browser/browserDocumentIdb';
import { createChunkKey } from '@app/platform/browser/browserDocumentChunks';
import {
    assertBrowserDocumentChunkGenerationComplete,
    clearBrowserDocumentExternalChunkStorage,
    clearPendingBrowserDocumentChunkMetadata,
    clearPendingBrowserDocumentChunks,
    createBrowserDocumentChunkGeneration,
    deleteBrowserDocumentChunks,
    persistBrowserDocumentChunk,
    persistBrowserDocumentChunkGeneration,
} from '@app/platform/browser/browserDocumentChunkStorage';
import {
    readFileHandleMetadata,
    BrowserDocumentRecordStore,
} from '@app/platform/browser/browserDocumentRecordStore';
import {BrowserDocumentFileHandleRefs} from '@app/platform/browser/browserDocumentFileHandleRefs';
import {runSerializedRecentFilesStorageMutation} from '@app/platform/browser/browserRecentFilesStore';
import {
    captureBrowserDocumentEntryStorageState,
    restoreBrowserDocumentEntryStorageState,
} from '@app/platform/browser/browserDocumentEntryStorageState';
import {
    createBrowserDocumentContentToken,
    createBrowserDocumentRevisionInfo,
    updateBrowserDocumentEntryContentToken,
} from '@app/platform/browser/browserDocumentRevision';
import { emitBrowserDocumentPersistenceWarning } from '@app/platform/browser/browserDocumentPersistenceWarnings';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
    type IDocumentRevisionInfo,
} from '@contracts/documentRevision';
import {
    createBrowserFileContentWitness,
    createBrowserStoredBytesWitness,
} from '@app/platform/browser/createBrowserFileContentWitness';
import {runBrowserLock} from '@app/platform/browser/runBrowserLock';
import type {TDocumentRef} from '@contracts/documentRef';
export interface IBrowserDocumentMutation {
    write(
        data: Uint8Array | ArrayBuffer,
        options?: Omit<IWriteDocumentOptions, 'expectedDocumentRevisionToken' | 'skipDocumentRevisionCheckForBootstrap'>,
    ): Promise<IDocumentRevisionInfo>;
    assertPhysicalSourceBaseCurrent(): Promise<void>;
    acknowledgePhysicalSourceCommit(): Promise<IDocumentRevisionInfo>;
}
export interface IBrowserDocumentSourceMutation extends IBrowserDocumentMutation {
    /**
     * Gives a working copy that reads through its source its own copy of the
     * same bytes, so it keeps them when the save replaces the source.
     */
    materializeWorkingCopy(): Promise<void>;
    writeSource(data: Uint8Array | ArrayBuffer): Promise<boolean>;
    /** Replaces the source's bytes with the document's, read a chunk at a time. */
    writeSourceFromDocument(): Promise<boolean>;
}

function createBrowserFileDocumentEntry(
    ref: TDocumentRef,
    file: File,
    options: IRegisterFileOptions = {},
): IBrowserDocumentEntry {
    const kind = options.kind ?? 'source';
    return {
        ref,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        kind,
        retention: options.retention ?? defaultRetentionForKind(kind),
        ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
        data: new Uint8Array(),
        fileSize: file.size,
        fileLastModified: file.lastModified,
        updatedAt: Date.now(),
        contentToken: createBrowserDocumentContentToken(),
        fileSnapshot: file,
        pendingLoad: null,
        saveName: file.name,
        saveKind: options.saveKind ?? 'generic',
        saveHandle: options.saveHandle ?? null,
        ...(kind === 'source' && options.saveHandle ? { sourceWitness: true } : {}),
        storageMode: resolveByteBackedStorageMode(file.size),
        chunkCount: 0,
        chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE,
    };
}

interface IBrowserStagedCommitResult {
    targetEntry: IBrowserDocumentEntry;
    previousTargetRevisionToken: TDocumentRevisionToken;
}
function getPersistedDocumentRevisionToken(
    record: IBrowserPersistedDocumentRecord,
    sourceRecord: IBrowserPersistedDocumentRecord | null,
) {
    const revisionRecord = record.storageMode === 'source-proxy'
        ? sourceRecord
        : record;
    if (!revisionRecord) {
        return null;
    }

    const entry = createEntryFromPersistedRecord(revisionRecord);
    return createBrowserDocumentRevisionInfo(entry, entry.ref).token;
}
function queuePersistedChunkDeletes(
    store: IDBObjectStore,
    record: IBrowserPersistedDocumentRecord,
) {
    const chunkCount = record.chunkCount ?? 0;
    if (record.storageMode !== 'chunked' || chunkCount <= 0) {
        return;
    }

    for (let index = 0; index < chunkCount; index += 1) {
        store.delete(createChunkKey(record.ref, index, record.chunkGeneration));
    }
}

export class BrowserDocumentStore extends BrowserDocumentRecordStore {
    private readonly fileRefs = new WeakMap<File, TDocumentRef>();
    private readonly fileHandleRefs = new BrowserDocumentFileHandleRefs();

    protected override onDocumentRemoved(ref: string) {
        this.fileHandleRefs.forget(ref);
        super.onDocumentRemoved(ref);
    }

    /**
     * Attaches a freshly built entry and persists it, rolling the attachment and
     * any staged chunk generation back when persistence fails. `stageChunkBytes`
     * is null for entries whose bytes live in the record itself.
     */
    private async persistNewEntry(
        entry: IBrowserDocumentEntry,
        stageChunkBytes: ((offset: number, length: number) => Promise<Uint8Array>) | null,
        stagedFileSize: number,
    ) {
        this.attachEntry(entry);
        let stagedGeneration: string | undefined;
        let stagedChunkCount = 0;
        try {
            if (stageChunkBytes) {
                const stagedLayout = await persistBrowserDocumentChunkGeneration(
                    entry.ref,
                    stagedFileSize,
                    Math.max(1, entry.chunkSize),
                    stageChunkBytes,
                );
                stagedGeneration = stagedLayout.generation;
                stagedChunkCount = stagedLayout.chunkCount;
                entry.data = new Uint8Array();
                entry.chunkGeneration = stagedLayout.generation;
                entry.chunkCount = stagedLayout.chunkCount;
                entry.fileSize = stagedFileSize;
                entry.fileLastModified = undefined;
                entry.updatedAt = Date.now();
            }
            await this.persistEntry(entry);
            stagedGeneration = undefined;
            stagedChunkCount = 0;
        } catch (error) {
            this.dropLoadedEntry(entry.ref);
            if (stagedGeneration) {
                await deleteBrowserDocumentChunks(entry.ref, stagedChunkCount, stagedGeneration)
                    .catch(() => undefined);
            }
            await deleteRecord(entry.ref).catch(() => undefined);
            throw error;
        }
        return entry.ref;
    }

    private async createStoredEntry(
        fileName: string,
        data: Uint8Array | ArrayBuffer,
        options: ICreateStoredDocumentOptions & {ref?: TDocumentRef | undefined},
    ) {
        // Content taken from another document is staged chunk by chunk below and
        // read whole only when it is small enough to live inline.
        const contentEntry = options.contentFrom ? await this.requireEntry(options.contentFrom) : null;
        const size = options.contentFrom ? (await this.stat(options.contentFrom)).size : toUint8Array(data).byteLength;
        const storageMode = resolveStoredDocumentStorageMode(size, options.storageMode);
        const sourceBytes = !contentEntry
            ? toUint8Array(data)
            : storageMode === 'chunked' ? new Uint8Array() : await this.readEntryBytes(contentEntry, size);
        const bytes = storageMode === 'inline' ? cloneBytes(sourceBytes) : new Uint8Array();
        const kind = options.kind ?? 'source';
        if (contentEntry && storageMode === 'chunked' && kind === 'source' && options.saveHandle && !options.sourceBaseWitness) {
            throw new Error('A handle-backed source copied from another document needs its base witness');
        }
        const sourceBaseWitness = options.sourceBaseWitness
            ?? (kind === 'source' && options.saveHandle && (storageMode === 'inline' || storageMode === 'chunked')
                ? await createBrowserStoredBytesWitness(sourceBytes)
                : undefined);
        const entry = createBrowserDocumentEntry({
            ref: options.ref ?? createBrowserDocumentRef(fileName),
            fileName,
            mimeType: options.mimeType,
            kind,
            retention: options.retention ?? defaultRetentionForKind(kind),
            ...(options.sourceRef ? {sourceRef: options.sourceRef} : {}),
            data: bytes,
            fileSize: storageMode === 'chunked' ? size : bytes.byteLength,
            contentToken: createBrowserDocumentContentToken(),
            saveKind: options.saveKind ?? 'generic',
            saveHandle: options.saveHandle ?? null,
            ...(sourceBaseWitness ? {sourceBaseWitness} : {}),
            storageMode,
            chunkCount: options.chunkCount ?? 0,
            chunkSize: options.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
        });

        const readChunk = contentEntry
            ? (offset: number, length: number) => this.readEntryRange(contentEntry, offset, length)
            : (offset: number, length: number) => Promise.resolve(sourceBytes.slice(offset, offset + length));
        return this.persistNewEntry(
            entry,
            storageMode === 'chunked' && size > 0 ? readChunk : null,
            size,
        );
    }

    public getRefForFile(file: File): TDocumentRef {
        const existingRef = this.fileRefs.get(file);
        if (existingRef && this.hasLoadedEntry(existingRef)) {
            return existingRef;
        }

        const ref = createBrowserDocumentRef(file.name);
        const entry = createBrowserFileDocumentEntry(ref, file, {saveKind: /\.docx$/i.test(file.name) ? 'docx' : 'generic'});

        this.attachEntry(entry);
        this.fileRefs.set(file, ref);
        void this.consumeFileIntoEntry(entry, file)
            .catch(async (error: unknown) => {
                await this.retainFileInMemoryAfterPersistenceFailure(entry, file, error)
                    .catch(() => undefined);
            });
        return ref;
    }

    private async applyFileRegistrationOptions(
        ref: TDocumentRef,
        file: File,
        options: IRegisterFileOptions,
    ) {
        const entry = await this.requireEntry(ref);
        let changed = false;
        if (options.kind !== undefined && entry.kind !== options.kind) {
            entry.kind = options.kind;
            changed = true;
        }
        if (options.retention !== undefined && entry.retention !== options.retention) {
            entry.retention = options.retention;
            changed = true;
        }
        if (options.saveKind !== undefined && entry.saveKind !== options.saveKind) {
            entry.saveKind = options.saveKind;
            changed = true;
        }
        if (options.sourceRef !== undefined && entry.sourceRef !== options.sourceRef) {
            entry.sourceRef = options.sourceRef;
            changed = true;
        }
        if (options.saveHandle !== undefined && entry.saveHandle !== options.saveHandle) {
            entry.saveHandle = options.saveHandle;
            if (entry.kind === 'source') {
                entry.sourceWitness = Boolean(options.saveHandle);
            }
            changed = true;
        }
        this.fileRefs.set(file, ref);
        if (options.saveHandle !== undefined) {
            this.fileHandleRefs.update(ref, options.saveHandle);
        }
        if (changed) {
            await this.persistEntry(entry);
        }
    }

    public async registerFile(file: File, options: IRegisterFileOptions = {}) {
        return (await this.registerFileWithOwnership(file, options)).ref;
    }

    /**
     * Rebind a Recent Files source when its persisted file handle now points
     * at different bytes. Keep the old ref so dirty dependents retain their
     * immutable source and revision authority.
     */
    public async refreshSourceVersionIfChanged(ref: TDocumentRef): Promise<TDocumentRef> {
        const entry = await this.requireEntry(ref);
        if (!entry.saveHandle || (!entry.sourceWitness && entry.storageMode !== 'handle')) {
            return ref;
        }
        // Explicit Recent Files reopen may ask; save-time reads remain nonprompting.
        const handle = entry.saveHandle as FileSystemFileHandle & {
            queryPermission?: (descriptor: {mode: 'read'}) => Promise<PermissionState>;
            requestPermission?: (descriptor: {mode: 'read'}) => Promise<PermissionState>;
        };
        if (handle.queryPermission && await handle.queryPermission({mode: 'read'}) !== 'granted'
            && await handle.requestPermission?.({mode: 'read'}) !== 'granted') {
            throw new DOMException('Open the file again to restore read permission.', 'NotAllowedError');
        }
        const metadata = await readFileHandleMetadata(entry.saveHandle);
        const contentToken = await createBrowserFileContentWitness(metadata.file);
        const openingWitness = entry.sourceBaseWitness ?? entry.contentToken;
        if (
            entry.fileSize === metadata.size
            && entry.fileLastModified === metadata.lastModified
            && openingWitness === contentToken
        ) {
            return ref;
        }
        const freshRef = await this.registerFile(metadata.file, {
            kind: 'source',
            saveKind: entry.saveKind,
            saveHandle: entry.saveHandle,
        });
        await runSerializedRecentFilesStorageMutation(currentFiles => ({
            files: currentFiles.filter(candidate => candidate.originalPath !== ref),
            value: undefined,
        }));
        return freshRef;
    }

    public async registerFileWithOwnership(file: File, options: IRegisterFileOptions = {}) {
        await this.ensureMaintenance();
        const knownRef = this.fileRefs.get(file);
        if (knownRef && this.hasLoadedEntry(knownRef)) {
            await this.applyFileRegistrationOptions(knownRef, file, options);
            return {
                ref: knownRef,
                created: false,
            };
        }
        // A fresh selection owns a new source version; dirty dependents keep
        // their immutable opening bytes and overwrite authority.
        const ref = options.ref ?? createBrowserDocumentRef(file.name);
        const entry = createBrowserFileDocumentEntry(ref, file, options);

        this.attachEntry(entry);
        this.fileRefs.set(file, ref);
        this.fileHandleRefs.update(ref, options.saveHandle ?? null);
        try {
            await this.consumeFileIntoEntry(entry, file);
        } catch (error) {
            await this.retainFileInMemoryAfterPersistenceFailure(entry, file, error);
        }
        return {
            ref,
            created: true,
        };
    }

    public async createStoredDocument(
        fileName: string,
        data: Uint8Array | ArrayBuffer,
        options: ICreateStoredDocumentOptions & {ref?: TDocumentRef | undefined},
    ): Promise<TDocumentRef> {
        await this.ensureMaintenance();
        const create = () => this.createStoredEntry(fileName, data, options);
        const sourceRef = options.sourceRef;
        if (sourceRef) {
            return this.runRefMutation(sourceRef, async () => {
                await this.requireEntry(sourceRef);
                return create();
            });
        }
        return create();
    }

    private async resolveSourceBaseWitness(
        entry: IBrowserDocumentEntry,
        options: {allowHandleRead: boolean},
    ): Promise<string | undefined> {
        if (entry.sourceBaseWitness) {
            return entry.sourceBaseWitness;
        }

        if (entry.storageMode === 'source-proxy' && entry.sourceRef) {
            return this.resolveSourceBaseWitness(
                await this.requireEntry(entry.sourceRef),
                options,
            );
        }

        if (entry.storageMode === 'inline' || entry.storageMode === 'chunked') {
            if (/^(?:content-v2|file|bytes):/u.test(entry.contentToken ?? '')) {
                return entry.contentToken;
            }
            if (entry.storageMode === 'inline' && entry.fileSize === entry.data.byteLength) {
                return createBrowserStoredBytesWitness(entry.data);
            }
            return undefined;
        }

        if (!options.allowHandleRead || !entry.saveHandle) {
            return undefined;
        }

        if (
            entry.fileSnapshot
            && entry.fileSnapshot.size === entry.fileSize
            && entry.fileSnapshot.lastModified === entry.fileLastModified
        ) {
            return createBrowserFileContentWitness(entry.fileSnapshot);
        }

        const metadata = await readFileHandleMetadata(entry.saveHandle);
        entry.fileSnapshot = metadata.file;
        entry.fileSize = metadata.size;
        entry.fileLastModified = metadata.lastModified;
        return createBrowserFileContentWitness(metadata.file);
    }

    public async cloneAsWorkingCopy(sourceRef: string, fileName?: string, ref?: TDocumentRef) {
        const sourceEntry = await this.requireEntry(sourceRef);
        const nextName = fileName ?? sourceEntry.fileName;
        try {
            return await this.runRefMutation(sourceRef, async () => {
                const currentSourceEntry = await this.requireEntry(sourceRef);
                const sourceBaseWitness = await this.resolveSourceBaseWitness(currentSourceEntry, {allowHandleRead: true});
                return this.createStoredEntry(nextName, new Uint8Array(), {
                    ref,
                    mimeType: currentSourceEntry.mimeType,
                    kind: 'working',
                    sourceRef,
                    saveKind: 'pdf',
                    storageMode: 'source-proxy',
                    ...(sourceBaseWitness ? {sourceBaseWitness} : {}),
                });
            });
        } catch (error) {
            const currentSourceEntry = await this.requireEntry(sourceRef);
            if (!currentSourceEntry.memoryOnly) {
                throw error;
            }

            const workingRef = ref ?? createBrowserDocumentRef(nextName);
            const sourceBaseWitness = await this.resolveSourceBaseWitness(currentSourceEntry, {allowHandleRead: false});
            this.attachEntry({
                ref: workingRef,
                fileName: nextName,
                mimeType: currentSourceEntry.mimeType,
                kind: 'working',
                retention: 'transient',
                sourceRef,
                data: new Uint8Array(),
                fileSize: currentSourceEntry.fileSize,
                ...(currentSourceEntry.fileLastModified === undefined ? {} : {fileLastModified: currentSourceEntry.fileLastModified}),
                updatedAt: Date.now(),
                contentToken: createBrowserDocumentContentToken(),
                memoryOnly: true,
                pendingLoad: null,
                saveName: nextName,
                saveKind: 'pdf',
                saveHandle: null,
                storageMode: 'source-proxy',
                ...(sourceBaseWitness ? {sourceBaseWitness} : {}),
                chunkCount: 0,
                chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE,
            });
            return workingRef;
        }
    }

    public async cloneStoredDocument(
        sourceRef: string,
        options: {
            ref?: TDocumentRef;
            fileName?: string;
            kind?: IBrowserDocumentEntry['kind'];
            retention?: IBrowserDocumentEntry['retention'];
            sourceRef?: string;
            saveKind?: IBrowserDocumentEntry['saveKind'];
            saveHandle?: FileSystemFileHandle | null;
        } = {},
    ) {
        const nextSourceRef = options.sourceRef;
        if (nextSourceRef) {
            return this.runRefMutation(nextSourceRef, async () => {
                await this.requireEntry(nextSourceRef);
                return this.cloneStoredDocumentUnlocked(sourceRef, options);
            });
        }
        return this.cloneStoredDocumentUnlocked(sourceRef, options);
    }

    private async cloneStoredDocumentUnlocked(
        sourceRef: string,
        options: NonNullable<Parameters<BrowserDocumentStore['cloneStoredDocument']>[1]>,
    ) {
        const sourceEntry = await this.requireEntry(sourceRef);
        const nextName = options.fileName ?? sourceEntry.fileName;
        const nextKind = options.kind ?? sourceEntry.kind;
        const nextRetention = options.retention ?? defaultRetentionForKind(nextKind);
        const nextSaveKind = options.saveKind ?? sourceEntry.saveKind;
        const nextSaveHandle = options.saveHandle ?? null;
        const nextSourceRef = options.sourceRef;

        if (sourceEntry.storageMode === 'chunked' || sourceEntry.storageMode === 'source-proxy' || sourceEntry.storageMode === 'handle') {
            const {size} = await this.stat(sourceRef);
            const ref = options.ref ?? createBrowserDocumentRef(nextName);
            const entry: IBrowserDocumentEntry = {
                ref,
                fileName: nextName,
                mimeType: sourceEntry.mimeType,
                kind: nextKind,
                retention: nextRetention,
                ...(nextSourceRef ? { sourceRef: nextSourceRef } : {}),
                data: new Uint8Array(),
                fileSize: size,
                updatedAt: Date.now(),
                contentToken: createBrowserDocumentContentToken(),
                pendingLoad: null,
                saveName: nextName,
                saveKind: nextSaveKind,
                saveHandle: nextSaveHandle,
                ...(nextKind === 'source' && nextSaveHandle ? { sourceWitness: true } : {}),
                ...(sourceEntry.sourceBaseWitness ? {sourceBaseWitness: sourceEntry.sourceBaseWitness} : {}),
                storageMode: 'chunked',
                chunkCount: 0,
                chunkSize: sourceEntry.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE,
            };

            return this.persistNewEntry(
                entry,
                (offset, length) => this.readEntryRange(sourceEntry, offset, length),
                size,
            );
        }

        const bytes = await this.readEntryBytes(sourceEntry);
        return this.createStoredEntry(nextName, bytes, {
            ref: options.ref,
            mimeType: sourceEntry.mimeType,
            kind: nextKind,
            retention: nextRetention,
            ...(nextSourceRef ? { sourceRef: nextSourceRef } : {}),
            saveKind: nextSaveKind,
            saveHandle: nextSaveHandle,
            ...(sourceEntry.sourceBaseWitness ? {sourceBaseWitness: sourceEntry.sourceBaseWitness} : {}),
        });
    }

    public async write(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        options: IWriteDocumentOptions = {},
    ) {
        return this.runRefMutation(ref, async () => Boolean(await this.writeUnlocked(ref, data, options)));
    }

    /**
     * Promotes a staged browser record in one IndexedDB transaction. The
     * revision checks and both record mutations share the transaction, so a
     * concurrent tab cannot replace the staged bytes between validation and
     * cleanup.
     */
    // fallow-ignore-next-line unused-class-member -- called through the staged-artifact store contract.
    public async commitStagedDocument(
        stagedRef: string,
        targetRef: string,
        data: Uint8Array,
        expectedStagedRevisionToken: TDocumentRevisionToken,
        expectedTargetRevisionToken: TDocumentRevisionToken,
    ) {
        const committedBytes = data.slice();
        if (parseDocumentRevisionToken(expectedStagedRevisionToken) === null) {
            throw new Error('Browser staged commit requires a staged document revision token');
        }
        if (parseDocumentRevisionToken(expectedTargetRevisionToken) === null) {
            throw new Error('Browser staged commit requires a target document revision token');
        }

        const committed = await this.runRefMutationMany([
            stagedRef,
            targetRef,
        ], async () => {
            const result = await runObjectStoresTransaction<IBrowserStagedCommitResult | false>(
                [
                    DOCUMENTS_STORE,
                    DOCUMENT_CHUNKS_STORE,
                ],
                'readwrite',
                (transaction, setResult) => {
                    const documents = transaction.objectStore(DOCUMENTS_STORE);
                    const chunks = transaction.objectStore(DOCUMENT_CHUNKS_STORE);
                    const rawRecords = new Map<string, unknown>();
                    let stagedRead = false;
                    let targetRead = false;
                    let sourceReadsScheduled = false;
                    let settled = false;

                    const finish = (value: IBrowserStagedCommitResult | false) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        setResult(value);
                    };
                    const loadSourceRecordsAndCommit = () => {
                        if (!stagedRead || !targetRead || settled) {
                            return;
                        }

                        const stagedRecord = toPersistedDocumentRecord(rawRecords.get(stagedRef));
                        const targetRecord = toPersistedDocumentRecord(rawRecords.get(targetRef));
                        if (!stagedRecord || !targetRecord) {
                            finish(false);
                            return;
                        }
                        if (
                            stagedRecord.ref !== stagedRef
                            || targetRecord.ref !== targetRef
                            || stagedRef === targetRef
                        ) {
                            finish(false);
                            return;
                        }

                        const sourceRefs = [
                            stagedRecord,
                            targetRecord,
                        ]
                            .filter((record) => record.storageMode === 'source-proxy' && record.sourceRef)
                            .map((record) => record.sourceRef as string)
                            .filter((ref, index, refs) => refs.indexOf(ref) === index);
                        if (!sourceReadsScheduled) {
                            sourceReadsScheduled = true;
                            for (const sourceRef of sourceRefs) {
                                if (rawRecords.has(sourceRef)) {
                                    continue;
                                }
                                const sourceRequest = documents.get(sourceRef) as IDBRequest<unknown>;
                                sourceRequest.onsuccess = () => {
                                    rawRecords.set(sourceRef, sourceRequest.result);
                                    loadSourceRecordsAndCommit();
                                };
                                sourceRequest.onerror = () => finish(false);
                            }
                        }
                        if (sourceRefs.some((sourceRef) => !rawRecords.has(sourceRef))) {
                            return;
                        }

                        const stagedSourceRecord = stagedRecord.storageMode === 'source-proxy'
                            ? toPersistedDocumentRecord(rawRecords.get(stagedRecord.sourceRef ?? ''))
                            : null;
                        const targetSourceRecord = targetRecord.storageMode === 'source-proxy'
                            ? toPersistedDocumentRecord(rawRecords.get(targetRecord.sourceRef ?? ''))
                            : null;
                        const stagedRevisionToken = getPersistedDocumentRevisionToken(
                            stagedRecord,
                            stagedSourceRecord,
                        );
                        const targetRevisionToken = getPersistedDocumentRevisionToken(
                            targetRecord,
                            targetSourceRecord,
                        );
                        if (
                            stagedRevisionToken !== expectedStagedRevisionToken
                            || targetRevisionToken !== expectedTargetRevisionToken
                            || stagedRecord.fileSize !== committedBytes.byteLength
                        ) {
                            finish(false);
                            return;
                        }

                        const targetEntry = createEntryFromPersistedRecord(targetRecord);
                        const previousTargetRevisionToken = expectedTargetRevisionToken;
                        targetEntry.storageMode = 'inline';
                        targetEntry.chunkCount = 0;
                        targetEntry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
                        targetEntry.fileSize = committedBytes.byteLength;
                        targetEntry.updatedAt = Date.now();
                        targetEntry.data = committedBytes;
                        delete targetEntry.chunkGeneration;
                        updateBrowserDocumentEntryContentToken(targetEntry);

                        queuePersistedChunkDeletes(chunks, stagedRecord);
                        Object.assign(targetEntry, queueBrowserDocumentRecordWrite(
                            transaction,
                            createPersistedBrowserDocumentRecord(targetEntry, committedBytes, false),
                        ), {data: committedBytes});
                        documents.delete(stagedRef);
                        finish({
                            targetEntry,
                            previousTargetRevisionToken,
                        });
                    };

                    const stagedRequest = documents.get(stagedRef) as IDBRequest<unknown>;
                    stagedRequest.onsuccess = () => {
                        rawRecords.set(stagedRef, stagedRequest.result);
                        stagedRead = true;
                        loadSourceRecordsAndCommit();
                    };
                    stagedRequest.onerror = () => finish(false);

                    const targetRequest = documents.get(targetRef) as IDBRequest<unknown>;
                    targetRequest.onsuccess = () => {
                        rawRecords.set(targetRef, targetRequest.result);
                        targetRead = true;
                        loadSourceRecordsAndCommit();
                    };
                    targetRequest.onerror = () => finish(false);
                },
            );

            if (result === null) {
                throw new Error('IndexedDB browser staged commit did not commit');
            }
            if (result === false) {
                throw new Error('Browser staged artifact content or revision changed during commit');
            }

            this.attachEntry(result.targetEntry);
            this.dropLoadedEntry(stagedRef);
            this.emitRevisionChangeForEntry(
                result.targetEntry,
                result.previousTargetRevisionToken,
                'write',
            );
            return true;
        });
        if (committed) {
            // Remove a stale recent-file entry after releasing the document
            // locks. The recent-file cleanup can inspect this same ref.
            await this.removeRecentFile(stagedRef);
        }
        return committed;
    }

    public async writeForBootstrap(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        reason: string,
        options: Omit<IWriteDocumentOptions, 'expectedDocumentRevisionToken' | 'skipDocumentRevisionCheckForBootstrap'> = {},
    ) {
        if (reason.trim().length === 0) {
            throw new TypeError('bootstrap write reason must be a non-empty string');
        }
        return this.runRefMutation(ref, async () => this.writeUnlocked(ref, data, {
            ...options,
            skipDocumentRevisionCheckForBootstrap: true,
        })).then(Boolean);
    }

    public runDocumentMutationWithSource<T>(
        ref: string,
        sourceRef: string,
        expectedRevision: TDocumentRevisionToken | null | undefined,
        operation: (mutation: IBrowserDocumentSourceMutation) => Promise<T>,
        options: {signal?: AbortSignal} = {},
    ) {
        const {signal} = options;
        const mutation = () => this.runRefMutationMany([
            ref,
            sourceRef,
        ], async () => {
            // A lock that cannot abort its wait still runs nothing after an abort.
            signal?.throwIfAborted();
            if (await this.getSourceRef(ref) !== sourceRef) {
                throw new Error('Browser document source changed while the save target was being selected.');
            }
            await this.assertDocumentRevisionCurrent(ref, expectedRevision);
            return operation({
                materializeWorkingCopy: async () => {
                    const entry = await this.requireEntry(ref);
                    if (entry.storageMode !== 'source-proxy' && entry.storageMode !== 'handle') return;
                    // A proxy's revision is its source's; the copy keeps that identity,
                    // so the same bytes change no revision.
                    const base = entry.storageMode === 'source-proxy' && entry.sourceRef
                        ? await this.requireEntry(entry.sourceRef)
                        : entry;
                    const size = (await this.stat(ref)).size;
                    await this.replaceContentUnlocked(
                        ref,
                        size,
                        (offset, length) => this.readEntryRange(entry, offset, length),
                        () => this.readEntryBytes(entry, size),
                        {
                            contentToken: base.contentToken,
                            contentRevision: base.contentRevision,
                            updatedAt: base.updatedAt,
                        },
                    );
                },
                write: (data, options = {}) => this.writeUnlocked(ref, data, options, true),
                assertPhysicalSourceBaseCurrent: () => this.assertPhysicalSourceBaseCurrent(ref, sourceRef),
                writeSource: async data => Boolean(await this.writeUnlocked(sourceRef, data, {}, true)),
                writeSourceFromDocument: async () => {
                    const source = await this.requireEntry(ref);
                    const {size} = await this.stat(ref);
                    await this.replaceContentUnlocked(
                        sourceRef,
                        size,
                        (offset, length) => this.readEntryRange(source, offset, length),
                        () => this.readEntryBytes(source, size),
                    );
                    return true;
                },
                acknowledgePhysicalSourceCommit: () => this.acknowledgePhysicalSourceCommitUnlocked(ref, sourceRef),
            });
        });
        // Source refs are per open File, so two windows that opened one physical
        // file hold different refs and different names. A context cannot name the
        // file itself, so every physical save takes this origin-wide lock. The base
        // check inside it then sees the bytes an earlier save committed.
        return runBrowserLock('evb-viewer:browser-physical-save', mutation, signal);
    }

    private async assertPhysicalSourceBaseCurrent(workingRef: string, sourceRef: string) {
        const workingEntry = await this.requireEntry(workingRef);
        const sourceEntry = await this.requireEntry(sourceRef);
        if (!sourceEntry.saveHandle) return;
        // A sampled or missing baseline cannot prove that all opening bytes survived.
        if (workingEntry.sourceBaseWitness?.startsWith('content-v2:')) {
            const metadata = await readFileHandleMetadata(sourceEntry.saveHandle);
            if (await createBrowserFileContentWitness(metadata.file) === workingEntry.sourceBaseWitness) return;
        }
        throw new Error(`Browser physical source changed since this working copy opened: ${sourceRef}`);
    }

    // A committed save makes the written bytes this source version. Its
    // opening witness and file metadata advance with the working copy's base,
    // so neither the next Save nor a Recent reopen takes our own write for an
    // external edit. Without a file the identity is the stored bytes'.
    private async acknowledgePhysicalSourceCommitUnlocked(workingRef: string, sourceRef: string) {
        const workingEntry = await this.requireEntry(workingRef);
        const sourceEntry = await this.requireEntry(sourceRef);
        let witness: string | undefined;
        if (sourceEntry.saveHandle) {
            const metadata = await readFileHandleMetadata(sourceEntry.saveHandle);
            witness = await createBrowserFileContentWitness(metadata.file);
            if (sourceEntry.storageMode === 'handle') sourceEntry.fileSize = metadata.size;
            sourceEntry.fileLastModified = metadata.lastModified;
            sourceEntry.fileSnapshot = metadata.file;
        } else if (sourceEntry.fileSize <= BROWSER_MAX_FULL_READ_BYTES) {
            witness = await createBrowserStoredBytesWitness(await this.readEntryBytes(sourceEntry));
        }
        for (const entry of [
            sourceEntry,
            workingEntry,
        ]) {
            if (witness) entry.sourceBaseWitness = witness;
            else delete entry.sourceBaseWitness;
            await this.persistEntry(entry);
        }
        return createBrowserDocumentRevisionInfo(workingEntry.storageMode === 'source-proxy' ? sourceEntry : workingEntry, workingEntry.ref);
    }

    private async writeUnlocked(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        options: IWriteDocumentOptions = {},
        revisionAlreadyChecked = false,
    ) {
        if (!revisionAlreadyChecked && options.skipDocumentRevisionCheckForBootstrap !== true) {
            await this.assertDocumentRevisionCurrent(ref, options.expectedDocumentRevisionToken);
        }
        const bytes = options.unloadAfterPersist
            ? normalizePersistedWriteBytes(data, false)
            : normalizePersistedWriteBytes(data);
        const documentRevision = await this.replaceContentUnlocked(
            ref,
            bytes.byteLength,
            (offset, length) => Promise.resolve(bytes.slice(offset, offset + length)),
            () => Promise.resolve(bytes),
        );

        if (options.unloadAfterPersist) this.dropLoadedEntry(ref);
        return documentRevision;
    }

    // A chunked result is staged from `readChunk`; only an inline one is read whole.
    private async replaceContentUnlocked(
        ref: string,
        size: number,
        readChunk: (offset: number, length: number) => Promise<Uint8Array>,
        readAll: () => Promise<Uint8Array>,
        retainedIdentity?: Pick<IBrowserDocumentEntry, 'contentToken' | 'contentRevision' | 'updatedAt'>,
    ) {
        const entry = await this.requireEntry(ref);
        const nextStorageMode = resolveByteBackedStorageMode(size);
        const previousEntryState = captureBrowserDocumentEntryStorageState(entry);
        const previousChunkGeneration = entry.chunkGeneration;
        let stagedGeneration: string | undefined;
        let stagedChunkCount = 0;

        try {
            let bytes: Uint8Array | undefined;
            if (nextStorageMode === 'chunked') {
                const stagedLayout = await persistBrowserDocumentChunkGeneration(
                    entry.ref,
                    size,
                    BROWSER_DOCUMENT_CHUNK_SIZE,
                    readChunk,
                );
                stagedGeneration = stagedLayout.generation;
                stagedChunkCount = stagedLayout.chunkCount;
                entry.storageMode = 'chunked';
                entry.data = new Uint8Array();
                entry.chunkCount = stagedLayout.chunkCount;
                entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
                entry.chunkGeneration = stagedLayout.generation;
                entry.fileSize = size;
            } else {
                bytes = await readAll();
                entry.storageMode = nextStorageMode;
                entry.chunkCount = 0;
                entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
                entry.fileSize = bytes.byteLength;
                delete entry.chunkGeneration;
            }
            const previousToken = retainedIdentity ? null : updateBrowserDocumentEntryContentToken(entry);
            Object.assign(entry, retainedIdentity ?? {updatedAt: Date.now()});
            await this.persistEntry(entry, bytes);
            if (bytes) entry.data = bytes;
            if (previousToken) this.emitRevisionChangeForEntry(entry, previousToken, 'write');
            stagedGeneration = undefined;
            stagedChunkCount = 0;
            return createBrowserDocumentRevisionInfo(entry);
        } catch (error) {
            restoreBrowserDocumentEntryStorageState(entry, previousEntryState);
            if (stagedGeneration && stagedGeneration !== previousChunkGeneration) {
                await deleteBrowserDocumentChunks(entry.ref, stagedChunkCount, stagedGeneration)
                    .catch(() => undefined);
            }
            throw error;
        }
    }

    public async assignSaveTarget(
        ref: string,
        saveName: string,
        saveKind: IBrowserDocumentEntry['saveKind'],
        saveHandle?: FileSystemFileHandle | null,
    ) {
        const entry = await this.requireEntry(ref);
        entry.saveName = saveName;
        entry.saveKind = saveKind;
        entry.saveHandle = saveHandle ?? null;
        this.fileHandleRefs.update(ref, entry.saveHandle);
        entry.sourceWitness = entry.kind === 'source' && Boolean(entry.saveHandle);
        await this.persistEntry(entry);
    }

    public async setRetention(
        ref: string,
        retention: IBrowserDocumentEntry['retention'],
    ) {
        const entry = await this.requireEntry(ref);
        entry.retention = retention;
        await this.persistEntry(entry);
    }

    public async getSourceRef(ref: string) {
        const entry = await this.requireEntry(ref);
        return entry.sourceRef ?? ref;
    }

    public async ensureByteBackedSource(ref: string) {
        const entry = await this.requireEntry(ref);
        if (entry.storageMode === 'source-proxy' && entry.sourceRef) {
            await this.ensureByteBackedSource(entry.sourceRef);
            return;
        }

        if (
            entry.kind !== 'source'
            || entry.storageMode !== 'handle'
            || !entry.saveHandle
        ) {
            return;
        }

        const {file} = await readFileHandleMetadata(entry.saveHandle);
        const previousEntryState = captureBrowserDocumentEntryStorageState(entry);
        try {
            entry.sourceWitness = true;
            entry.storageMode = resolveByteBackedStorageMode(file.size);
            entry.chunkCount = 0;
            entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
            entry.fileSize = file.size;
            await this.consumeFileIntoEntry(entry, file, { deleteRecordOnFailure: false });
        } catch (error) {
            restoreBrowserDocumentEntryStorageState(entry, previousEntryState);
            throw error;
        }
    }

    public async getSaveTarget(ref: string): Promise<{
        saveName: string;
        saveKind: IBrowserDocumentEntry['saveKind'];
        saveHandle: FileSystemFileHandle | null;
    }> {
        const entry = await this.requireEntry(ref);
        return {
            saveName: entry.saveName ?? entry.fileName,
            saveKind: entry.saveKind,
            saveHandle: entry.saveHandle ?? null,
        };
    }

    public async replaceWithHandleBackedDocument(
        ref: string,
        options: {
            fileSize: number;
            saveHandle?: FileSystemFileHandle | null;
            saveName?: string;
        },
    ) {
        const entry = await this.requireEntry(ref);
        // The handle-backed record is built aside and adopted only once it is
        // stored: a failed store leaves the entry, its content and everything
        // reading through it, such as a working copy's proxy, as they were.
        const next: IBrowserDocumentEntry = {
            ...entry,
            data: new Uint8Array(),
            storageMode: 'handle',
            chunkCount: 0,
            chunkSize: BROWSER_DOCUMENT_CHUNK_SIZE,
            fileSize: options.fileSize,
            fileLastModified: undefined,
            updatedAt: Date.now(),
        };
        delete next.fileSnapshot;
        const previousToken = updateBrowserDocumentEntryContentToken(next);
        if (options.saveHandle !== undefined) {
            next.saveHandle = options.saveHandle;
        }
        next.sourceWitness = next.kind === 'source' && Boolean(next.saveHandle);
        if (next.kind === 'source' && next.saveHandle) {
            const metadata = await readFileHandleMetadata(next.saveHandle);
            next.contentToken = await createBrowserFileContentWitness(metadata.file);
        }
        if (options.saveName) {
            next.saveName = options.saveName;
            next.fileName = options.saveName;
        }
        await this.persistEntry(next);
        delete entry.fileSnapshot;
        Object.assign(entry, next);
        if (options.saveHandle !== undefined) {
            this.fileHandleRefs.update(ref, options.saveHandle);
        }
        this.emitRevisionChangeForEntry(entry, previousToken, 'replace-working-copy');
    }

    public async prepareChunkedDocument(
        ref: string,
        options?: { chunkSize?: number },
    ) {
        await this.runRefMutation(ref, async () => {
            const entry = await this.requireEntry(ref);
            await clearPendingBrowserDocumentChunks(entry);
            entry.pendingChunkGeneration = createBrowserDocumentChunkGeneration();
            entry.pendingChunkCount = 0;
            entry.pendingChunkSize = options?.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
            entry.pendingFileSize = 0;
            entry.pendingChunkUpdatedAt = Date.now();
            await this.persistEntry(entry);
        });
    }

    public async writeChunk(
        ref: string,
        index: number,
        data: Uint8Array,
    ) {
        await this.runRefMutation(ref, async () => {
            const entry = await this.requireEntry(ref);
            if (!entry.pendingChunkGeneration) {
                entry.pendingChunkGeneration = createBrowserDocumentChunkGeneration();
                entry.pendingChunkCount = 0;
                entry.pendingChunkSize = entry.pendingChunkSize ?? entry.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
                entry.pendingFileSize = 0;
            }
            const generation = entry.pendingChunkGeneration;
            await persistBrowserDocumentChunk(ref, index, generation, data);
            entry.pendingChunkCount = Math.max(entry.pendingChunkCount ?? 0, index + 1);
            entry.pendingFileSize = Math.max(
                entry.pendingFileSize ?? 0,
                (index * Math.max(1, entry.pendingChunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE)) + data.byteLength,
            );
            entry.pendingChunkUpdatedAt = Date.now();
            await this.persistEntry(entry);
        });
    }

    public async finalizeChunkedDocument(
        ref: string,
        options: {
            fileSize: number;
            chunkCount: number;
            chunkSize?: number;
            saveName?: string;
        },
    ) {
        await this.runRefMutation(ref, async () => {
            const entry = await this.requireEntry(ref);
            const stagedGeneration = entry.pendingChunkGeneration;
            if (!stagedGeneration) {
                throw new Error(`No staged browser document chunks available: ${ref}`);
            }
            const chunkSize = options.chunkSize ?? entry.pendingChunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
            await assertBrowserDocumentChunkGenerationComplete(
                ref,
                stagedGeneration,
                options.chunkCount,
            );
            const previousEntryState = captureBrowserDocumentEntryStorageState(entry);
            const previousFileName = entry.fileName;
            const previousSaveName = entry.saveName;
            const pendingChunkCount = entry.pendingChunkCount ?? options.chunkCount;
            entry.data = new Uint8Array();
            entry.storageMode = 'chunked';
            entry.chunkCount = options.chunkCount;
            entry.chunkSize = chunkSize;
            entry.chunkGeneration = stagedGeneration;
            entry.fileSize = options.fileSize;
            entry.updatedAt = Date.now();
            const previousToken = updateBrowserDocumentEntryContentToken(entry);
            if (options.saveName) {
                entry.saveName = options.saveName;
                entry.fileName = options.saveName;
            }
            clearPendingBrowserDocumentChunkMetadata(entry);
            try {
                await this.persistEntry(entry);
            } catch (error) {
                restoreBrowserDocumentEntryStorageState(entry, previousEntryState);
                entry.fileName = previousFileName;
                if (previousSaveName) {
                    entry.saveName = previousSaveName;
                } else {
                    delete entry.saveName;
                }
                await deleteBrowserDocumentChunks(
                    ref,
                    pendingChunkCount,
                    stagedGeneration,
                ).catch(() => undefined);
                clearPendingBrowserDocumentChunkMetadata(entry);
                throw error;
            }
            this.emitRevisionChangeForEntry(entry, previousToken, 'write');
            const extraPendingChunks = Math.max(0, pendingChunkCount - options.chunkCount);
            if (extraPendingChunks > 0) {
                await deleteBrowserDocumentChunks(
                    ref,
                    extraPendingChunks,
                    stagedGeneration,
                    options.chunkCount,
                ).catch(() => undefined);
            }
            clearPendingBrowserDocumentChunkMetadata(entry);
        });
    }

    public async clearChunkedDocument(ref: string) {
        await this.runRefMutation(ref, async () => {
            const entry = await this.ensureEntry(ref);
            if (!entry) {
                return;
            }
            if (entry.pendingChunkGeneration) {
                await clearPendingBrowserDocumentChunks(entry);
                await this.persistEntry(entry);
                return;
            }
            if (entry.storageMode !== 'chunked') {
                return;
            }
            await clearBrowserDocumentExternalChunkStorage(entry);
            entry.storageMode = 'inline';
            entry.chunkCount = 0;
            entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
            delete entry.chunkGeneration;
            entry.data = new Uint8Array();
            entry.fileSize = 0;
            entry.updatedAt = Date.now();
            const previousToken = updateBrowserDocumentEntryContentToken(entry);
            await this.persistEntry(entry);
            this.emitRevisionChangeForEntry(entry, previousToken, 'write');
        });
    }

    private async consumeFileIntoEntry(
        entry: IBrowserDocumentEntry,
        file: File,
        options: { deleteRecordOnFailure?: boolean } = {},
    ) {
        const previousChunkGeneration = entry.chunkGeneration;
        const pendingLoad = (async () => {
            if (entry.storageMode === 'chunked') {
                const stagedLayout = await persistBrowserDocumentChunkGeneration(
                    entry.ref,
                    file.size,
                    BROWSER_DOCUMENT_CHUNK_SIZE,
                    async (offset, length) => new Uint8Array(
                        await file.slice(offset, offset + length).arrayBuffer(),
                    ),
                );
                entry.data = new Uint8Array();
                entry.chunkCount = stagedLayout.chunkCount;
                entry.chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE;
                entry.chunkGeneration = stagedLayout.generation;
                entry.fileSize = file.size;
                entry.fileLastModified = file.lastModified;
                entry.updatedAt = Date.now();
                const previousToken = updateBrowserDocumentEntryContentToken(entry);
                entry.contentToken = await createBrowserFileContentWitness(file);
                if (entry.kind === 'source' && entry.saveHandle && !entry.sourceBaseWitness) {
                    entry.sourceBaseWitness = entry.contentToken;
                }
                await this.persistEntry(entry);
                this.emitRevisionChangeForEntry(entry, previousToken, 'open');
            } else {
                const bytes = new Uint8Array(await file.arrayBuffer());
                entry.data = bytes;
                entry.fileSize = bytes.byteLength;
                entry.fileLastModified = file.lastModified;
                entry.updatedAt = Date.now();
                const previousToken = updateBrowserDocumentEntryContentToken(entry);
                entry.contentToken = await createBrowserFileContentWitness(file, bytes);
                if (entry.kind === 'source' && entry.saveHandle && !entry.sourceBaseWitness) {
                    entry.sourceBaseWitness = entry.contentToken;
                }
                await this.persistEntry(entry);
                this.emitRevisionChangeForEntry(entry, previousToken, 'open');
            }
            entry.memoryOnly = false;
            entry.pendingLoad = null;
        })();

        entry.pendingLoad = pendingLoad;
        try {
            await pendingLoad;
        } catch (error) {
            if (entry.pendingLoad === pendingLoad) {
                entry.pendingLoad = null;
            }
            if (entry.storageMode === 'chunked') {
                if (entry.chunkGeneration && entry.chunkGeneration !== previousChunkGeneration) {
                    await deleteBrowserDocumentChunks(
                        entry.ref,
                        entry.chunkCount,
                        entry.chunkGeneration,
                    ).catch(() => undefined);
                }
                await clearPendingBrowserDocumentChunks(entry)
                    .catch(() => undefined);
                if (options.deleteRecordOnFailure !== false) {
                    await deleteRecord(entry.ref).catch(() => undefined);
                }
            }
            throw error;
        }
    }

    private async retainFileInMemoryAfterPersistenceFailure(
        entry: IBrowserDocumentEntry,
        file: File,
        error: unknown,
    ) {
        if (file.size > BROWSER_MAX_FULL_READ_BYTES) {
            entry.data = new Uint8Array();
            entry.storageMode = 'handle';
            entry.fileSnapshot = file;
            entry.memoryOnly = true;
            entry.fileSize = file.size;
            entry.fileLastModified = file.lastModified;
            entry.updatedAt = Date.now();
            entry.chunkCount = 0;
            entry.pendingLoad = null;
            delete entry.chunkGeneration;
            delete entry.pendingChunkGeneration;
            delete entry.pendingChunkCount;
            delete entry.pendingChunkSize;
            delete entry.pendingFileSize;
            delete entry.pendingChunkUpdatedAt;
            emitBrowserDocumentPersistenceWarning({
                fileName: entry.fileName,
                error,
            });
            return;
        }
        try {
            entry.data = new Uint8Array(await file.arrayBuffer());
        } catch {
            this.dropLoadedEntry(entry.ref, entry);
            throw error;
        }

        entry.storageMode = 'inline';
        entry.fileSnapshot = file;
        entry.memoryOnly = true;
        entry.fileSize = entry.data.byteLength;
        entry.fileLastModified = file.lastModified;
        entry.updatedAt = Date.now();
        entry.contentToken = await createBrowserFileContentWitness(file, entry.data);
        entry.chunkCount = 0;
        entry.pendingLoad = null;
        delete entry.chunkGeneration;
        delete entry.pendingChunkGeneration;
        delete entry.pendingChunkCount;
        delete entry.pendingChunkSize;
        delete entry.pendingFileSize;
        delete entry.pendingChunkUpdatedAt;
        emitBrowserDocumentPersistenceWarning({
            fileName: entry.fileName,
            error,
        });
    }
}

export const browserDocumentStore = new BrowserDocumentStore();
