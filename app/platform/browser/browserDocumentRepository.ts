import {
    createDocument,
    type DocumentDirectory,
    forkDocument,
    type IDocumentStore,
    openDocument,
    type TDocumentInit,
    type TMutation,
} from '@document-store/documentDirectory';
import {
    saveDocument,
    type TSaveResult,
} from '@document-store/saveDocument';
import type { TExternalSource } from '@document-store/storePort';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    BROWSER_MAX_FULL_READ_BYTES,
} from '@app/platform/browser/browserDocumentConstants';
import {
    browserDocumentRefId,
    createBrowserDocumentRef,
    getBrowserDocumentFileName,
} from '@app/platform/browser/browserDocumentRefs';
import {
    BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
    BrowserDocumentReadError,
} from '@app/platform/browser/browserDocumentReadError';
import { emitBrowserDocumentPersistenceWarning } from '@app/platform/browser/browserDocumentPersistenceWarnings';
import { fileHandleStore } from '@app/platform/browser/browserFileHandleStore';
import { sameWitness } from '@document-store/contentWitness';
import {
    browserPublication,
    fileFact,
    handleDestination,
    handleKeyOf,
    rememberFileHandle,
    resolveFileHandle,
    storeFileHandle,
} from '@app/platform/browser/browserPublication';
import { BrowserRecentFilesStore } from '@app/platform/browser/browserRecentFilesStore';
import {
    createMemoryStorePort,
    openBrowserStorePort,
} from '@app/platform/browser/browserStorePort';
import { holdBrowserLock } from '@app/platform/browser/runBrowserLock';
import {
    createMissingRevisionError,
    createStaleRevisionError,
} from '@contracts/documentMutationErrors';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    requireDocumentRevisionToken,
    type IDocumentRevisionChangedEvent,
    type IDocumentRevisionInfo,
    type TDocumentRevisionChangeReason,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type { IRecentReadingView } from '@contracts/recentReadingView';
import { createEpochMs } from '@contracts/timestamps';

const DOCUMENT_LOCK_PREFIX = 'evb-document:';
/** How long a window waits for another to let go of a document it hands over, such as a moved tab's. */
const DOCUMENT_LOCK_WAIT_MS = 10_000;

export const browserDocumentLockName = (id: string) => `${DOCUMENT_LOCK_PREFIX}${id}`;

type TEntryKind = 'source' | 'working' | 'output';
type TRetention = 'durable' | 'transient';
type TSaveKind = 'pdf' | 'docx' | 'generic';

/**
 * One document this window has open. Its bytes are a store directory (`doc`), or, for a picked file that has
 * no bytes of its own, that file (`file`, read through `saveHandle` when it has one).
 */
export interface IBrowserDocumentEntry {
    ref: TDocumentRef;
    fileName: string;
    mimeType: string;
    kind: TEntryKind;
    retention: TRetention;
    saveKind: TSaveKind;
    saveName: string;
    /** The file a save or an output writes; for a handle-backed source, the file itself. */
    saveHandle: FileSystemFileHandle | null;
    sourceRef?: TDocumentRef;
    /** The browser refused storage: the document works without surviving a reload. */
    memoryOnly: boolean;
    fileSize: number;
    updatedAt: number;
    doc: DocumentDirectory | null;
    store: IDocumentStore | null;
    file: File | null;
    release: (() => void) | null;
    chunkSize?: number;
}

type TEntryMeta = {[K in keyof IBrowserDocumentEntry]?: IBrowserDocumentEntry[K] | undefined};

export interface IRegisterFileOptions {
    ref?: TDocumentRef;
    kind?: TEntryKind;
    retention?: TRetention;
    saveKind?: TSaveKind;
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
}

export interface ICreateStoredDocumentOptions {
    ref?: TDocumentRef | undefined;
    mimeType: string;
    saveKind?: TSaveKind;
    kind?: TEntryKind;
    retention?: TRetention;
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
    /** `handle`: the bytes are the file `saveHandle` names, written by the caller. */
    storageMode?: 'handle' | 'inline' | 'chunked';
    /** Copies the new document's bytes from this one instead of `data`. */
    contentFrom?: string;
}

interface IWriteOptions {
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
}

export class BrowserDocumentSourceChangedError extends Error {
    public constructor(ref: string) {
        super(`The file changed since this document opened: ${getBrowserDocumentFileName(ref)}. Save a copy with Save As.`);
        this.name = 'BrowserDocumentSourceChangedError';
    }
}

function extensionOf(fileName: string) {
    const match = /\.([A-Za-z0-9]{1,16})$/u.exec(fileName);
    return match ? match[1]!.toLowerCase() : 'bin';
}

function bytesBlob(data: Uint8Array | ArrayBuffer) {
    return new Blob([data instanceof Uint8Array ? data as Uint8Array<ArrayBuffer> : new Uint8Array(data)]);
}

function isQuotaError(error: unknown) {
    return error instanceof Error && error.name === 'QuotaExceededError';
}

async function assertReadPermission(handle: FileSystemFileHandle, prompt: boolean) {
    const permissions = handle as FileSystemFileHandle & {
        queryPermission?: (descriptor: {mode: 'read'}) => Promise<PermissionState>;
        requestPermission?: (descriptor: {mode: 'read'}) => Promise<PermissionState>;
    };
    if (!permissions.queryPermission || await permissions.queryPermission({mode: 'read'}) === 'granted') return;
    if (prompt && await permissions.requestPermission?.({mode: 'read'}) === 'granted') return;
    throw new DOMException('Open the file again to restore read permission.', 'NotAllowedError');
}

/**
 * The browser's documents: one store directory per document with its bytes and unsaved state, locked by the
 * window that has it open, saved through the publication port. Picked files without bytes of their own are
 * read through their handles.
 */
export class BrowserDocumentStore {
    private readonly entries = new Map<string, IBrowserDocumentEntry>();
    private readonly hydrating = new Map<string, Promise<IBrowserDocumentEntry | null>>();
    private readonly fileRefs = new WeakMap<File, TDocumentRef>();
    /** The sources of working copies another window or a crashed session made, named before they are opened here. */
    private readonly namedSources = new Map<string, TDocumentRef>();
    private readonly revisionListeners = new Set<(event: IDocumentRevisionChangedEvent) => void>();
    private readonly removalListeners = new Set<(ref: string) => void>();
    private storesPromise: Promise<{durable: IDocumentStore | null; memory: IDocumentStore}> | null = null;
    private readonly recentFiles = new BrowserRecentFilesStore();

    /** The durable store (the origin private file system) when the browser offers one, and the memory store. */
    public stores() {
        this.storesPromise ??= (async () => {
            const store = (port: IDocumentStore['port']): IDocumentStore => ({port, publication: browserPublication, historyBudget: 0});
            const opened = await openBrowserStorePort();
            return {
                durable: opened.durable ? store(opened.port) : null,
                memory: store(opened.durable ? createMemoryStorePort() : opened.port),
            };
        })();
        return this.storesPromise;
    }

    // Registration -------------------------------------------------------------------------------------------

    /** A ref for a file before it is registered; the file is read in place until something needs it stored. */
    public getRefForFile(file: File): TDocumentRef {
        const known = this.fileRefs.get(file);
        if (known && this.entries.has(known)) return known;
        const ref = createBrowserDocumentRef(file.name);
        this.attach(this.fileEntry(ref, file, {retention: 'transient'}));
        this.fileRefs.set(file, ref);
        return ref;
    }

    public async registerFile(file: File, options: IRegisterFileOptions = {}) {
        return (await this.registerFileWithOwnership(file, options)).ref;
    }

    /**
     * A picked or dropped file. With a handle it is read and saved through that handle. Without one, a
     * document kept for Recent Files gets its own stored copy (imported, so it starts clean); a transient
     * input is read in place.
     */
    public async registerFileWithOwnership(file: File, options: IRegisterFileOptions = {}) {
        const known = this.fileRefs.get(file);
        const knownEntry = known ? this.entries.get(known) : undefined;
        const kind = options.kind ?? 'source';
        const retention = options.retention ?? (kind === 'working' ? 'transient' : 'durable');
        // A file registered again is the same document, unless it now needs a handle or stored bytes it lacks.
        const needsMore = (options.saveHandle && !knownEntry?.saveHandle)
            || (retention === 'durable' && !knownEntry?.doc && !knownEntry?.saveHandle);
        if (known && knownEntry && !needsMore) return {ref: known, created: false};
        const ref = options.ref ?? known ?? createBrowserDocumentRef(file.name);
        const meta = {
            kind,
            retention,
            ...(options.saveKind ? {saveKind: options.saveKind} : {}),
            ...(options.sourceRef ? {sourceRef: parseDocumentRef(options.sourceRef) ?? undefined} : {}),
        };
        if (options.saveHandle) {
            await this.attachHandleSource(ref, options.saveHandle, file, meta);
        } else if (retention === 'transient') {
            this.attach(this.fileEntry(ref, file, meta));
        } else {
            await this.createEntry(ref, {source: file, imported: true}, {...meta, fileName: file.name, mimeType: file.type || 'application/octet-stream'});
        }
        this.fileRefs.set(file, ref);
        return {ref, created: true};
    }

    public async createStoredDocument(
        fileName: string,
        data: Uint8Array | ArrayBuffer,
        options: ICreateStoredDocumentOptions,
    ): Promise<TDocumentRef> {
        const ref = options.ref ?? createBrowserDocumentRef(fileName);
        const kind = options.kind ?? 'source';
        const meta = {
            kind,
            retention: options.retention ?? (kind === 'working' ? 'transient' : 'durable'),
            mimeType: options.mimeType,
            fileName,
            ...(options.saveKind ? {saveKind: options.saveKind} : {}),
            ...(options.sourceRef ? {sourceRef: parseDocumentRef(options.sourceRef) ?? undefined} : {}),
        } as const;
        if (options.storageMode === 'handle' && options.saveHandle) {
            await this.attachHandleSource(ref, options.saveHandle, null, meta);
            return ref;
        }
        const source = options.contentFrom ? await this.externalSource(options.contentFrom) : bytesBlob(data);
        // Bytes the app made for a document to be edited are unsaved until saved; outputs start clean.
        const entry = await this.createEntry(ref, {source, imported: kind !== 'working'}, meta);
        entry.saveHandle = options.saveHandle ?? null;
        return ref;
    }

    /**
     * A working copy of `sourceRef`. A picked file stays its destination: Save writes that file, checked
     * against the bytes read now, and the copy reads them until its first edit. A store document without a
     * file is forked. `data`, when given, is the copy's first edit, such as a transferred document's state.
     */
    public async cloneAsWorkingCopy(sourceRef: string, fileName?: string, ref?: TDocumentRef, data?: Uint8Array) {
        const source = await this.requireEntry(sourceRef);
        const name = fileName ?? source.fileName;
        const workingRef = ref ?? createBrowserDocumentRef(name);
        const meta = {
            kind: 'working',
            retention: 'transient',
            fileName: name,
            mimeType: source.mimeType,
            saveKind: 'pdf',
            sourceRef: source.kind === 'working' && source.sourceRef ? source.sourceRef : source.ref,
        } as const;
        let entry: IBrowserDocumentEntry;
        if (source.saveHandle) {
            const key = browserDocumentRefId(source.ref);
            await storeFileHandle(key, source.saveHandle);
            entry = await this.createEntry(workingRef, {destination: handleDestination(key)}, meta);
            entry.file = await source.saveHandle.getFile();
        } else if (source.doc && source.store) {
            const id = browserDocumentRefId(workingRef);
            const release = await this.lock(id, 0);
            try {
                const store = {...source.store, historyBudget: 0};
                entry = this.attach(this.docEntry(workingRef, await forkDocument(store, source.doc.id, id), store, release, meta));
            } catch (error) {
                release();
                throw error;
            }
            entry.memoryOnly = source.memoryOnly;
            entry.file = source.doc.state().current ? null : source.file;
        } else {
            entry = await this.createEntry(workingRef, {source: await this.fileOf(source), imported: true}, meta);
        }
        if (data) await this.mutate(entry, this.tokenOf(entry), {kind: 'rewrite', source: bytesBlob(data), drafts: 'clear'}, 'write');
        return workingRef;
    }

    // Reading ------------------------------------------------------------------------------------------------

    public async ensureEntryAvailability(ref: string): Promise<{available: boolean; entry: IBrowserDocumentEntry | null}> {
        try {
            return {available: true, entry: await this.ensureEntry(ref)};
        } catch {
            return {available: false, entry: null};
        }
    }

    public async ensureEntry(ref: string): Promise<IBrowserDocumentEntry | null> {
        const known = this.entries.get(ref);
        if (known) return known;
        let hydration = this.hydrating.get(ref);
        if (!hydration) {
            hydration = this.hydrate(ref).finally(() => this.hydrating.delete(ref));
            this.hydrating.set(ref, hydration);
        }
        return hydration;
    }

    public async requireEntry(ref: string): Promise<IBrowserDocumentEntry> {
        const entry = await this.ensureEntry(ref);
        if (!entry) throw new Error(`Browser document not found: ${ref}`);
        return entry;
    }

    public async exists(ref: string) {
        return (await this.ensureEntryAvailability(ref)).entry !== null;
    }

    public async read(ref: string, {maxBytes = BROWSER_MAX_FULL_READ_BYTES} = {}): Promise<Uint8Array> {
        const entry = await this.requireEntry(ref);
        const size = await this.sizeOf(entry);
        if (size > maxBytes) {
            throw new BrowserDocumentReadError(
                BROWSER_DOCUMENT_FULL_READ_TOO_LARGE,
                `Browser document is too large to load fully into memory (${entry.fileName}: `
                + `${Math.floor(size / (1024 * 1024))}MB > ${Math.round(maxBytes / (1024 * 1024))}MB limit)`,
                {maxBytes},
            );
        }
        const bytes = new Uint8Array(size);
        for (let offset = 0; offset < size; offset += BROWSER_DOCUMENT_CHUNK_SIZE) {
            bytes.set(await this.readEntryRange(entry, offset, Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, size - offset)), offset);
        }
        return bytes;
    }

    public async readRange(ref: string, offset: number, length: number) {
        return this.readEntryRange(await this.requireEntry(ref), Math.max(0, offset), Math.max(0, length));
    }

    public async readText(ref: string) {
        return new TextDecoder().decode(await this.read(ref));
    }

    public async stat(ref: string) {
        const {size, modifiedAt} = await this.getContentSnapshot(ref);
        return {size, modifiedAt};
    }

    public async getContentSignature(ref: string) {
        return (await this.getContentSnapshot(ref)).contentSignature;
    }

    /** Size and revision describe one state; a picked file is looked at again first. */
    public async getContentSnapshot(ref: string): Promise<{size: number; modifiedAt: number; contentSignature: string}> {
        const entry = await this.requireEntry(ref);
        await this.refreshPickedFile(entry);
        return {
            size: await this.sizeOf(entry),
            modifiedAt: entry.updatedAt,
            contentSignature: this.tokenOf(entry),
        };
    }

    public async getDocumentRevision(ref: string): Promise<IDocumentRevisionInfo> {
        const entry = await this.requireEntry(ref);
        await this.refreshPickedFile(entry);
        return this.revisionInfo(entry);
    }

    public async assertDocumentRevisionCurrent(ref: string, expected: TDocumentRevisionToken | null | undefined) {
        const entry = await this.requireEntry(ref);
        await this.refreshPickedFile(entry);
        this.expectedRevision(entry, expected);
    }

    public onDocumentRevisionChanged(listener: (event: IDocumentRevisionChangedEvent) => void) {
        this.revisionListeners.add(listener);
        return () => {
            this.revisionListeners.delete(listener);
        };
    }

    /** Calls `listener` with each document that leaves this window's store. */
    public onDocumentRecordRemoved(listener: (ref: string) => void) {
        this.removalListeners.add(listener);
        return () => {
            this.removalListeners.delete(listener);
        };
    }

    // Writing ------------------------------------------------------------------------------------------------

    /** Replaces the bytes. Unsaved drafts described the old bytes, so they go with them. */
    public async write(ref: string, data: Uint8Array | ArrayBuffer, options: IWriteOptions = {}) {
        await this.mutate(await this.requireEntry(ref), options.expectedDocumentRevisionToken, {kind: 'rewrite', source: bytesBlob(data), drafts: 'clear'}, 'write');
        return true;
    }

    /** Commits a staged output into `targetRef` when both are still the revisions it was staged against. */
    public async commitStagedDocument(
        stagedRef: string,
        targetRef: string,
        data: Uint8Array,
        expectedStagedRevisionToken: TDocumentRevisionToken,
        expectedTargetRevisionToken: TDocumentRevisionToken,
    ) {
        const staged = await this.requireEntry(stagedRef);
        if (stagedRef === targetRef || this.tokenOf(staged) !== expectedStagedRevisionToken || await this.sizeOf(staged) !== data.byteLength) {
            throw new Error('Browser staged artifact content or revision changed during commit');
        }
        await this.mutate(await this.requireEntry(targetRef), expectedTargetRevisionToken, {kind: 'rewrite', source: bytesBlob(data), drafts: 'clear'}, 'write');
        await this.remove(stagedRef);
        return true;
    }

    /** Streamed output: chunks are appended in order, and `finalizeChunkedDocument` checks the result. */
    public async prepareChunkedDocument(ref: string, options?: {chunkSize?: number}) {
        const entry = await this.requireEntry(ref);
        entry.chunkSize = options?.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE;
        if (await this.sizeOf(entry) > 0) await this.mutate(entry, this.tokenOf(entry), {kind: 'rewrite', source: new Blob(), drafts: 'clear'}, 'write');
    }

    public async writeChunk(ref: string, index: number, data: Uint8Array) {
        const entry = await this.requireEntry(ref);
        const offset = index * (entry.chunkSize ?? BROWSER_DOCUMENT_CHUNK_SIZE);
        if (offset !== await this.sizeOf(entry)) throw new Error(`Browser document chunk ${index} is out of order: ${ref}`);
        await this.mutate(entry, this.tokenOf(entry), {kind: 'append', bytes: data, drafts: 'keep'}, 'write', false);
    }

    public async finalizeChunkedDocument(ref: string, options: {fileSize: number; chunkCount: number; chunkSize?: number; saveName?: string}) {
        const entry = await this.requireEntry(ref);
        if (await this.sizeOf(entry) !== options.fileSize) throw new Error(`No complete browser document chunks are available: ${ref}`);
        if (options.saveName) entry.saveName = entry.fileName = options.saveName;
        delete entry.chunkSize;
        this.emitRevision(entry, undefined, 'write');
    }

    public async clearChunkedDocument(ref: string) {
        const entry = await this.ensureEntry(ref);
        if (entry?.doc && await this.sizeOf(entry) > 0) await this.mutate(entry, this.tokenOf(entry), {kind: 'rewrite', source: new Blob(), drafts: 'clear'}, 'write');
    }

    /** The caller wrote the document's bytes to `saveHandle`: from now on they are that file's. */
    public async replaceWithHandleBackedDocument(ref: string, options: {fileSize: number; saveHandle?: FileSystemFileHandle | null; saveName?: string}) {
        const entry = await this.requireEntry(ref);
        const handle = options.saveHandle ?? entry.saveHandle;
        if (!handle) throw new Error(`No file to back browser document ${ref}`);
        const previous = this.tokenOf(entry);
        await this.closeEntry(entry, true);
        Object.assign(entry, {doc: null, store: null, file: await handle.getFile(), saveHandle: handle, updatedAt: Date.now()});
        if (options.saveName) entry.saveName = entry.fileName = options.saveName;
        await this.persistHandle(entry);
        this.attach(entry);
        this.emitRevision(entry, previous, 'replace-working-copy');
    }

    /**
     * Imports `fromRef`'s bytes anew as `ref`'s, which then start clean: the file as it was last saved, or the
     * bytes an open made. The directory keeps its id and this window keeps its lock throughout.
     */
    public async replaceContent(ref: string, fromRef: string) {
        const entry = await this.requireEntry(ref);
        const doc = this.requireDoc(entry);
        const source = await this.externalSource(fromRef);
        const previous = this.tokenOf(entry);
        await doc.close();
        await entry.store!.port.remove(`documents/${doc.id}`);
        entry.doc = await createDocument(entry.store!, {id: doc.id, ext: extensionOf(entry.fileName), source, imported: true});
        entry.file = null;
        entry.fileSize = entry.doc.state().current?.length ?? 0;
        entry.updatedAt = Date.now();
        this.emitRevision(entry, previous, 'write');
    }

    public async setRetention(ref: string, retention: TRetention) {
        (await this.requireEntry(ref)).retention = retention;
    }

    public async getSourceRef(ref: string) {
        const entry = await this.requireEntry(ref);
        return entry.sourceRef ?? entry.ref;
    }

    public async getSaveTarget(ref: string) {
        const entry = await this.requireEntry(ref);
        return {saveName: entry.saveName, saveKind: entry.saveKind, saveHandle: entry.saveHandle};
    }

    /**
     * Save, or Save As with `saveAs`: commit `commit` into the bytes, check the destination against the
     * baseline, publish. The caller asked for write permission before; the document's lock is held.
     */
    public async save(ref: string, token: TDocumentRevisionToken | null | undefined, options: {commit?: Uint8Array; saveAs?: string} = {}): Promise<TSaveResult> {
        const entry = await this.requireEntry(ref);
        const doc = this.requireDoc(entry);
        const previous = this.tokenOf(entry);
        // The shell keeps a refused save's edits pending and stages them again for Save As, so a save the
        // file's change refuses must not commit them first. The core checks again under the write.
        const {destination, baseline} = doc.state();
        if (options.commit && !options.saveAs && baseline && handleKeyOf(destination) !== null
            && !sameWitness(await browserPublication.witness(destination!), baseline)) {
            return {status: 'conflict'};
        }
        // A save that commits the shell's edits and then fails puts the revision the shell knows back: its
        // edits stay pending there, and a retry must not apply them twice.
        const base = doc.snapshot().current?.id ?? doc.snapshot().next;
        const rollBack = async () => {
            if (options.commit && doc.state().current?.id !== base && doc.state().history.some(revision => revision.id === base)) {
                await doc.restore(base);
            }
        };
        let result: TSaveResult;
        entry.store!.historyBudget = options.commit ? Number.MAX_SAFE_INTEGER : 0;
        try {
            result = await saveDocument(doc, {
                expected: this.expectedRevision(entry, token),
                ...(options.commit ? {commit: {kind: 'rewrite', source: bytesBlob(options.commit), drafts: 'clear'} satisfies TMutation} : {}),
                ...(options.saveAs ? {saveAs: options.saveAs} : {}),
            });
        } catch (error) {
            await rollBack();
            throw error;
        } finally {
            entry.store!.historyBudget = 0;
        }
        if (result.status !== 'saved') {
            await rollBack();
            if (result.status === 'stale-revision') this.throwStale(entry, token);
            return result;
        }
        entry.updatedAt = Date.now();
        if (this.tokenOf(entry) !== previous) this.emitRevision(entry, previous, 'save-sync');
        return result;
    }

    // Lifecycle ----------------------------------------------------------------------------------------------

    /** Lets go of a document this window keeps no view of; its bytes stay in the store. */
    public unload(ref: string) {
        const entry = this.entries.get(ref);
        if (!entry?.doc || entry.memoryOnly) return;
        this.entries.delete(ref);
        void this.closeEntry(entry);
    }

    /** Removes the document and its bytes. A handle-backed file is only forgotten. */
    public async remove(ref: string) {
        const entry = this.entries.get(ref);
        if (entry) {
            this.entries.delete(ref);
            await this.closeEntry(entry, true);
        }
        for (const listener of this.removalListeners) listener(ref);
        await this.removeRecentFile(ref);
    }

    /** Removes a closed document unless Recent Files keeps it. */
    public async cleanupDetachedDocument(ref: string) {
        const entry = this.entries.get(ref);
        if (!entry) return false;
        if (entry.retention === 'durable' && entry.kind !== 'working') {
            this.unload(ref);
            return false;
        }
        await this.remove(ref);
        return true;
    }

    /** Hands a document to another window: closes it here and releases its lock, keeping its bytes. */
    public async release(ref: string) {
        const entry = this.entries.get(ref);
        if (!entry) return;
        this.entries.delete(ref);
        await this.closeEntry(entry);
    }

    /** Names the source of a working copy this window opens later: a moved tab's or a recovered one's. */
    public nameSource(ref: string, sourceRef: TDocumentRef) {
        const entry = this.entries.get(ref);
        if (!entry) this.namedSources.set(ref, sourceRef);
        else if (sourceRef !== ref) entry.sourceRef ??= sourceRef;
    }

    /** The store document behind `ref`, for the window's recovery writer. */
    public async documentOf(ref: string) {
        const entry = await this.ensureEntry(ref).catch(() => null);
        return entry?.doc ?? null;
    }

    public revisionTokenOf(entry: IBrowserDocumentEntry) {
        return this.tokenOf(entry);
    }

    public openEntries() {
        return [...this.entries.values()];
    }

    // Recent Files -------------------------------------------------------------------------------------------

    public async touchRecentFile(ref: string) {
        const entry = await this.requireEntry(ref);
        if (entry.retention === 'transient' || entry.memoryOnly) {
            await this.recentFiles.remove(ref);
            return;
        }
        // A file whose handle refuses reading now is still the person's Recent file, at its last known size.
        await this.recentFiles.touch(entry.ref, entry.saveName || entry.fileName, await this.sizeOf(entry).catch(() => entry.fileSize));
    }

    /** Whether `ref` still has its file handle or its stored copy, without opening it. */
    public async isStored(ref: string) {
        const id = browserDocumentRefId(ref);
        if (this.entries.has(ref) || await fileHandleStore.get(id)) return true;
        const {durable} = await this.stores();
        return durable !== null && (await durable.port.list('documents')).includes(id);
    }

    public getRecentFiles() {
        return this.recentFiles.list();
    }

    public async removeRecentFile(ref: string) {
        return this.recentFiles.remove(ref);
    }

    public async clearRecentFiles() {
        await this.recentFiles.clear();
    }

    /** Remembers the view with the Recent entry of the source `workingCopy` was opened from. */
    public async rememberRecentReadingView(workingCopy: string, view: IRecentReadingView) {
        const source = await this.admittedSource(workingCopy);
        if (source) await this.recentFiles.rememberReadingView(source.sourceRef, source.witness, view);
    }

    /** The view a reader left the source of `workingCopy` at, if that source still has the bytes it was left on. */
    public async readRecentReadingView(workingCopy: string) {
        const source = await this.admittedSource(workingCopy);
        return source ? this.recentFiles.readReadingView(source.sourceRef, source.witness) : null;
    }

    // Internals ----------------------------------------------------------------------------------------------

    /** The source a reading view belongs to, with the witness of the file it was opened on. */
    private async admittedSource(ref: string) {
        const entry = await this.ensureEntry(ref).catch(() => null);
        if (!entry) return null;
        const sourceRef = entry.kind === 'working' ? entry.sourceRef : entry.ref;
        if (entry.doc) {
            const baseline = entry.doc.state().baseline;
            return sourceRef && baseline ? {sourceRef, witness: baseline} : null;
        }
        // A picked file read in place, as a DjVu is, is its own source: its present bytes decide.
        await this.refreshPickedFile(entry).catch(() => undefined);
        return {sourceRef: entry.ref, witness: fileFact(await this.fileOf(entry))};
    }

    private attach(entry: IBrowserDocumentEntry) {
        this.entries.set(entry.ref, entry);
        return entry;
    }

    private baseEntry(ref: TDocumentRef, meta: TEntryMeta): IBrowserDocumentEntry {
        const fileName = meta.fileName ?? getBrowserDocumentFileName(ref);
        return {
            ref,
            fileName,
            mimeType: meta.mimeType ?? (/\.pdf$/iu.test(fileName) ? 'application/pdf' : 'application/octet-stream'),
            kind: meta.kind ?? 'source',
            retention: meta.retention ?? 'durable',
            saveKind: meta.saveKind ?? (/\.docx$/iu.test(fileName) ? 'docx' : /\.pdf$/iu.test(fileName) ? 'pdf' : 'generic'),
            saveName: fileName,
            saveHandle: null,
            ...(meta.sourceRef ? {sourceRef: meta.sourceRef} : {}),
            memoryOnly: false,
            fileSize: 0,
            updatedAt: Date.now(),
            doc: null,
            store: null,
            file: null,
            release: null,
        };
    }

    private fileEntry(ref: TDocumentRef, file: File, meta: TEntryMeta) {
        return Object.assign(this.baseEntry(ref, {fileName: file.name, mimeType: file.type || undefined, ...meta}), {file, fileSize: file.size});
    }

    private docEntry(ref: TDocumentRef, doc: DocumentDirectory, store: IDocumentStore, release: () => void, meta: TEntryMeta) {
        const entry = this.baseEntry(ref, meta);
        return Object.assign(entry, {doc, store, release, fileSize: doc.state().current?.length ?? 0});
    }

    private async attachHandleSource(ref: TDocumentRef, handle: FileSystemFileHandle, file: File | null, meta: TEntryMeta) {
        const entry = this.baseEntry(ref, {fileName: handle.name, ...meta});
        entry.saveHandle = handle;
        entry.saveName = handle.name;
        entry.file = file ?? await handle.getFile().catch(() => null);
        entry.fileSize = entry.file?.size ?? 0;
        this.attach(entry);
        await this.persistHandle(entry);
        return entry;
    }

    /** Recent Files and documents saved to the file reopen it after a reload through the stored handle. */
    private async persistHandle(entry: IBrowserDocumentEntry) {
        if (!entry.saveHandle) return;
        const key = browserDocumentRefId(entry.ref);
        if (entry.retention === 'durable') await storeFileHandle(key, entry.saveHandle);
        else rememberFileHandle(key, entry.saveHandle);
    }

    private async lock(id: string, waitMs: number) {
        const release = await holdBrowserLock(browserDocumentLockName(id), waitMs);
        if (!release) throw new Error('The document is open in another window');
        return release;
    }

    /**
     * Creates a store document under its lock, taken before the directory exists so that no other window's
     * startup collection can take it for an abandoned one. A store that refuses the bytes (full, unavailable)
     * leaves the document in memory, which is said once.
     */
    private async createEntry(ref: TDocumentRef, init: Omit<TDocumentInit, 'ext' | 'id'>, meta: TEntryMeta) {
        const {durable, memory} = await this.stores();
        const id = browserDocumentRefId(ref);
        const release = await this.lock(id, 0);
        const fileName = meta.fileName ?? getBrowserDocumentFileName(ref);
        const documentInit = {...init, id, ext: extensionOf(fileName)} as TDocumentInit;
        try {
            // Each document has its own store record, so a Save can keep its base revision for a rollback.
            let store = {...(durable ?? memory)};
            let doc: DocumentDirectory;
            try {
                doc = await createDocument(store, documentInit);
            } catch (error) {
                if (!durable || !isQuotaError(error)) throw error;
                await store.port.remove(`documents/${id}`).catch(() => undefined);
                store = {...memory};
                doc = await createDocument(store, documentInit);
            }
            const entry = this.attach(this.docEntry(ref, doc, store, release, {...meta, fileName}));
            if (store.port === memory.port) {
                entry.memoryOnly = true;
                emitBrowserDocumentPersistenceWarning({fileName, error: new Error('The browser refused to store this document')});
            }
            return entry;
        } catch (error) {
            release();
            throw error;
        }
    }

    /** A ref this window did not open: a stored handle, or a store directory another window let go of. */
    private async hydrate(ref: string): Promise<IBrowserDocumentEntry | null> {
        const parsed = parseDocumentRef(ref);
        if (!parsed) return null;
        let id: string;
        try {
            id = browserDocumentRefId(parsed);
        } catch {
            return null;
        }
        const stored = await fileHandleStore.get(id).catch(() => undefined);
        if (stored) {
            await assertReadPermission(stored.handle, true);
            return this.attachHandleSource(parsed, stored.handle, null, {saveKind: /\.pdf$/iu.test(stored.name) ? 'pdf' : 'generic'});
        }
        const {durable} = await this.stores();
        if (!durable || !(await durable.port.list('documents')).includes(id)) return null;
        const release = await this.lock(id, DOCUMENT_LOCK_WAIT_MS);
        try {
            const store = {...durable};
            const doc = await openDocument(store, id);
            const sourceRef = this.namedSources.get(parsed);
            // A named directory is a working copy; one opened from Recent Files is a stored source.
            const entry = this.attach(this.docEntry(parsed, doc, store, release, sourceRef
                ? {kind: 'working', retention: 'transient', ...(sourceRef === parsed ? {} : {sourceRef})}
                : {}));
            const key = handleKeyOf(doc.state().destination);
            if (key !== null && !doc.state().current) {
                const handle = await resolveFileHandle(key);
                if (handle) {
                    await assertReadPermission(handle, true);
                    entry.file = await handle.getFile();
                }
            }
            return entry;
        } catch (error) {
            release();
            throw error;
        }
    }

    private async closeEntry(entry: IBrowserDocumentEntry, removeBytes = false) {
        try {
            await entry.doc?.close();
            if (removeBytes && entry.doc && entry.store) await entry.store.port.remove(`documents/${entry.doc.id}`);
            if (removeBytes && entry.saveHandle && !entry.doc && entry.kind !== 'working') {
                await fileHandleStore.delete(browserDocumentRefId(entry.ref)).catch(() => undefined);
            }
        } finally {
            entry.release?.();
            entry.release = null;
        }
    }

    private requireDoc(entry: IBrowserDocumentEntry) {
        if (!entry.doc) throw new Error(`Browser document has no stored bytes: ${entry.ref}`);
        return entry.doc;
    }

    /** What a new document copied from `ref` reads: a store path within one store, otherwise a Blob. */
    private async externalSource(ref: string): Promise<TExternalSource> {
        const entry = await this.requireEntry(ref);
        const current = entry.doc?.state().current;
        if (entry.doc && current) {
            const parts: Blob[] = [];
            for (let offset = 0; offset < current.length; offset += BROWSER_DOCUMENT_CHUNK_SIZE) {
                parts.push(bytesBlob(await entry.doc.read(offset, Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, current.length - offset))));
            }
            return new Blob(parts);
        }
        return this.fileOf(entry);
    }

    private async fileOf(entry: IBrowserDocumentEntry) {
        if (entry.file) return entry.file;
        if (entry.saveHandle && !entry.doc) {
            entry.file = await entry.saveHandle.getFile();
            return entry.file;
        }
        const key = handleKeyOf(entry.doc?.state().destination ?? null);
        const handle = key === null ? null : await resolveFileHandle(key);
        if (!handle) throw new Error(`Browser document has no readable bytes: ${entry.ref}`);
        entry.file = await handle.getFile();
        return entry.file;
    }

    /** A picked file read in place is looked at again; a store document never changes behind its manifest. */
    private async refreshPickedFile(entry: IBrowserDocumentEntry) {
        if (entry.doc || !entry.saveHandle) return;
        const previous = this.tokenOf(entry);
        entry.file = await entry.saveHandle.getFile();
        entry.fileSize = entry.file.size;
        if (this.tokenOf(entry) !== previous) {
            entry.updatedAt = Date.now();
            this.emitRevision(entry, previous, 'browser-handle-refresh');
        }
    }

    private async sizeOf(entry: IBrowserDocumentEntry) {
        const current = entry.doc?.state().current;
        if (current) return current.length;
        return (await this.fileOf(entry)).size;
    }

    private async readEntryRange(entry: IBrowserDocumentEntry, offset: number, length: number) {
        if (entry.doc?.state().current) return entry.doc.read(offset, length);
        const file = await this.fileOf(entry);
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    }

    /** A store document's revision is its directory and the revision its manifest names. */
    private tokenOf(entry: IBrowserDocumentEntry) {
        if (entry.doc) {
            const manifest = entry.doc.snapshot();
            return requireDocumentRevisionToken(`drt1:browser:${entry.doc.id}:${manifest.current?.id ?? manifest.next}`);
        }
        return requireDocumentRevisionToken(`drt1:browser:${browserDocumentRefId(entry.ref)}:f${entry.file?.lastModified ?? 0}-${entry.file?.size ?? 0}`);
    }

    private revisionInfo(entry: IBrowserDocumentEntry, documentRef = entry.ref): IDocumentRevisionInfo {
        const manifest = entry.doc?.snapshot();
        return {
            version: 1,
            documentRef,
            authority: 'browser-document-store',
            token: this.tokenOf(entry),
            contentRevision: manifest ? manifest.current?.id ?? manifest.next : 1,
            mintedAt: createEpochMs(entry.updatedAt),
        };
    }

    private throwStale(entry: IBrowserDocumentEntry, expected: TDocumentRevisionToken | null | undefined): never {
        throw createStaleRevisionError({
            documentRef: entry.ref,
            expectedRevision: requireDocumentRevisionToken(expected ?? 'none'),
            actualRevision: this.tokenOf(entry),
        });
    }

    /** The core's expected revision for a caller's token; a working copy's edits must name the revision they saw. */
    private expectedRevision(entry: IBrowserDocumentEntry, token: TDocumentRevisionToken | null | undefined) {
        if (!token) {
            if (entry.kind === 'working') throw createMissingRevisionError({documentRef: entry.ref});
        } else if (token !== this.tokenOf(entry)) {
            this.throwStale(entry, token);
        }
        return entry.doc?.state().current?.id ?? null;
    }

    private async mutate(
        entry: IBrowserDocumentEntry,
        token: TDocumentRevisionToken | null | undefined,
        mutation: TMutation,
        reason: TDocumentRevisionChangeReason,
        announce = true,
    ) {
        const doc = this.requireDoc(entry);
        const previous = this.tokenOf(entry);
        const result = await doc.mutate(this.expectedRevision(entry, token), mutation);
        if (result.status === 'stale-revision') this.throwStale(entry, token);
        if (result.status === 'conflict') throw new BrowserDocumentSourceChangedError(entry.ref);
        entry.file = null;
        entry.fileSize = result.revision.length;
        entry.updatedAt = Date.now();
        if (announce) this.emitRevision(entry, previous, reason);
        return this.revisionInfo(entry);
    }

    private emitRevision(entry: IBrowserDocumentEntry, previousToken: TDocumentRevisionToken | undefined, reason: TDocumentRevisionChangeReason) {
        const event = {...this.revisionInfo(entry), ...(previousToken ? {previousToken} : {}), reason};
        for (const listener of this.revisionListeners) listener(event);
    }
}

export const browserDocumentStore = new BrowserDocumentStore();
