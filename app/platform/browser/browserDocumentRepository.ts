import {
    createDocument,
    type DocumentDirectory,
    forkDocument,
    type IDocumentStore,
    openDocument,
    type TDocumentInit,
    type TMutation,
    type TMutationResult,
} from '@document-store/documentDirectory';
import {
    saveDocument,
    type TSaveResult,
} from '@document-store/saveDocument';
import type {
    IStoreFile,
    TExternalSource,
} from '@document-store/storePort';
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
    canceledWrite,
    pushRevisionStream,
    streamWriter,
} from '@app/platform/browser/browserRevisionStream';
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
    isOpfsStorePort,
    openBrowserStorePort,
} from '@app/platform/browser/browserStorePort';
import { holdBrowserLock } from '@app/platform/browser/runBrowserLock';
import { opfsFileHandle } from '@app/platform/browser/opfsFileHandle';
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
    instance: symbol;
    closed?: boolean;
    /** Aborts the open `writeStream`, which holds the document until it ends. */
    endStream?: (reason: unknown) => Promise<void>;
    /** An edit appended to the current revision's file and not committed: its lease, base revision and end. */
    pendingAppend?: {lease: string; token: TDocumentRevisionToken; length: number} | undefined;
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
    storageMode?: 'handle';
}

interface IWriteOptions {
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
    /** Bytes an open made: not an edit, and without a file to save to the document's baseline in the same commit. */
    opened?: boolean;
    strictRevisionToken?: boolean;
    expectedByteRevision?: number | undefined;
    expectedInstance?: symbol;
}

export class BrowserDocumentSourceChangedError extends Error {
    public constructor(ref: string) {
        super(`The file changed since this document opened: ${getBrowserDocumentFileName(ref)}. Save a copy with Save As.`);
        this.name = 'BrowserDocumentSourceChangedError';
    }
}

function bytesBlob(data: Uint8Array | ArrayBuffer | Blob) {
    if (data instanceof Blob) return data;
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
    /** Awaited before a directory takes its first change that is not part of opening it: its window names it for recovery. */
    public onDirectoryEdited = async (_id: string) => {};

    /** The durable store (the origin private file system) when the browser offers one, and the memory store. */
    public stores() {
        this.storesPromise ??= (async () => {
            const store = (port: IDocumentStore['port']): IDocumentStore => ({port, publication: browserPublication});
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

    /** A new stored document of `data`; a stream is written as it arrives (see `streamWriter`). */
    public async createStoredDocument(
        fileName: string,
        data: Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
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
        const source = data instanceof ReadableStream ? streamWriter(data) : bytesBlob(data);
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
    public async cloneAsWorkingCopy(sourceRef: string, fileName?: string, ref?: TDocumentRef, data?: Uint8Array | Blob) {
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
            const store = source.store;
            try {
                const forked = this.docEntry(workingRef, await forkDocument(store, source.doc.id, id), store, release, meta);
                forked.memoryOnly = source.memoryOnly;
                entry = await this.hold(forked);
            } catch (error) {
                release();
                if (!isQuotaError(error)) throw error;
                // No room: copy into memory.
                await store.port.remove(`documents/${id}`).catch(() => undefined);
                entry = await this.createEntry(workingRef, {source: await this.externalSource(source.ref), imported: true}, meta);
            }
            entry.file = source.doc.state().current ? null : source.file;
        } else {
            entry = await this.createEntry(workingRef, {source: await this.fileOf(source), imported: true}, meta);
        }
        if (data) await this.mutate(entry, this.tokenOf(entry), {kind: 'rewrite', source: bytesBlob(data), drafts: 'clear'}, 'write');
        return workingRef;
    }

    // Reading ------------------------------------------------------------------------------------------------

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
        return (await this.ensureEntry(ref).catch(() => null)) !== null;
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

    public async stat(ref: string) {
        const {size, modifiedAt} = await this.getContentSnapshot(ref);
        return {size, modifiedAt};
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

    public async assertDocumentRevisionCurrent(
        ref: string,
        expected: TDocumentRevisionToken | null | undefined,
        options: {strict?: boolean; expectedByteRevision?: number; expectedInstance?: symbol; allowStagedBase?: boolean} = {},
    ) {
        const entry = await this.requireEntry(ref);
        await this.refreshPickedFile(entry);
        if (options.strict) {
            if (!expected && entry.kind === 'working') throw createMissingRevisionError({documentRef: entry.ref});
            if (
                !expected
                || !this.isActiveEntry(entry, entry.doc, options.expectedInstance)
                || expected !== this.tokenOf(entry)
                || (options.expectedByteRevision !== undefined && entry.doc?.state().byteRevision !== options.expectedByteRevision)
            ) {
                this.throwStale(entry, expected);
            }
            return;
        }
        if (options.expectedInstance !== undefined && !this.isActiveEntry(entry, entry.doc, options.expectedInstance)) {
            this.throwStale(entry, expected);
        }
        this.expectedRevision(entry, expected, {allowStagedBase: options.allowStagedBase ?? entry.pendingAppend !== undefined});
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
        const entry = await this.requireEntry(ref);
        const imported = options.opened === true && !entry.doc?.state().destination;
        await this.mutate(
            entry,
            options.expectedDocumentRevisionToken,
            {kind: 'rewrite', source: bytesBlob(data), drafts: 'clear', imported},
            options.opened ? 'open' : 'write',
            true,
            {
                ...(options.strictRevisionToken === true ? {strictRevisionToken: true} : {}),
                ...(options.expectedByteRevision !== undefined ? {expectedByteRevision: options.expectedByteRevision} : {}),
                ...(options.expectedInstance !== undefined ? {expectedInstance: options.expectedInstance} : {}),
            },
        );
        return true;
    }

    /**
     * Commits a revision that `write` makes from `source`, the document's present bytes read in place: it writes
     * the new revision file at the store path `output`, or returns the bytes when the document's store is not
     * the origin private file system (`output` null), such as a window's memory store. As on desktop, a document without bytes of its own is read from its file, which must
     * still hold the bytes the person saw when the revision commits; no copy of it is made first. `imported`:
     * the new bytes are the document's baseline in the same commit, as for bytes the person supplied, so it stays
     * clean; a document with a file keeps its file's.
     */
    public async rewrite(
        ref: string,
        token: TDocumentRevisionToken | null | undefined,
        write: (source: Blob, output: string | null) => Promise<Uint8Array | undefined>,
        {imported = false} = {},
    ) {
        const entry = await this.requireEntry(ref);
        const doc = this.requireDoc(entry);
        const instance = entry.instance;
        if (!imported) await this.nameEdited(entry);
        if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
        const previous = this.tokenOf(entry);
        const capturedByteRevision = doc.state().byteRevision;
        this.expectedRevision(entry, token);
        const source = await this.readableBlob(ref);
        if (!this.isActiveEntry(entry, doc, instance) || this.tokenOf(entry) !== previous || doc.state().byteRevision !== capturedByteRevision) {
            this.throwStale(entry, token);
        }
        let info: IDocumentRevisionInfo;
        if (!isOpfsStorePort(entry.store!.port)) {
            const bytes = await write(source, null);
            if (!bytes) throw new Error('The rewrite returned no bytes');
            info = await this.mutate(
                entry,
                token,
                {kind: 'rewrite', source: bytesBlob(bytes), drafts: 'clear', imported},
                'write',
                true,
                {expectedByteRevision: capturedByteRevision, expectedInstance: instance},
            );
        } else {
            try {
                info = this.settle(entry, token, previous, await doc.run(async (): Promise<TMutationResult> => {
                    const manifest = doc.snapshot();
                    if (!this.isActiveEntry(entry, doc, instance) || this.tokenOf(entry) !== previous || doc.state().byteRevision !== capturedByteRevision) {
                        return {status: 'stale-revision', current: manifest.current ?? null};
                    }
                    const {current, next, ext} = manifest;
                    const name = `r${current ? next : next + 1}.${ext}`;
                    const output = doc.path(name);
                    let committed = false;
                    try {
                        await write(source, output);
                        const afterWrite = doc.snapshot();
                        if (
                            !this.isActiveEntry(entry, doc, instance)
                            || this.tokenOf(entry) !== previous
                            || doc.state().byteRevision !== capturedByteRevision
                            || Boolean(afterWrite.current) !== Boolean(current)
                            || afterWrite.next !== next
                            || afterWrite.ext !== ext
                        ) {
                            return {status: 'stale-revision', current: afterWrite.current ?? null};
                        }
                        // A first copy of the file made meanwhile is revision `next`, and `name` is its next revision.
                        if (afterWrite.current) {
                            const outcome = await doc.applyMutation(afterWrite.current.id, {kind: 'rewrite', source: () => Promise.resolve(), drafts: 'clear', imported});
                            committed = outcome.status === 'committed';
                            return outcome;
                        }
                        if (!sameWitness(await browserPublication.witness(afterWrite.destination!), afterWrite.baseline)) return {status: 'conflict'};
                        const file = await entry.store!.port.open(output);
                        let revision: {id: number; file: string; length: number};
                        try {
                            revision = {id: next + 1, file: name, length: await file.size()};
                            await file.flush();
                        } catch (error) {
                            await file.close().catch(() => undefined);
                            throw error;
                        }
                        await doc.commit({...afterWrite, next: revision.id + 1, current: revision, drafts: undefined}, file);
                        committed = true;
                        return {status: 'committed', revision};
                    } finally {
                        if (!committed) {
                            const latest = doc.snapshot();
                            const stillReferenced = latest.current?.file === name
                                || latest.history.some(rev => 'file' in rev && rev.file === name);
                            if (!stillReferenced) await entry.store!.port.remove(output).catch(() => undefined);
                        }
                    }
                }), 'write');
            } catch (error) {
                if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
                throw error;
            }
        }
        return info;
    }

    /**
     * The document's present bytes as a Blob read in place, for a worker that reads them by range: its current
     * revision's file, or its file before it has bytes of its own. Valid until the document next changes.
     */
    public async readableBlob(ref: string): Promise<Blob> {
        const entry = await this.requireEntry(ref);
        const current = entry.doc?.state().current;
        if (!entry.doc || !current) return this.fileOf(entry);
        if (!isOpfsStorePort(entry.store!.port)) return this.externalSource(ref) as Promise<Blob>;
        return (await (await opfsFileHandle(entry.doc.path(current.file))).getFile()).slice(0, current.length);
    }

    /**
     * `readableBlob` with the revision token that names its bytes. A change made while the Blob is prepared, even
     * one undone again, refuses as stale, so the pair never joins one revision's token to another's bytes. With
     * `expected`, they are that revision's or the call refuses, as `assertDocumentRevisionCurrent` does.
     */
    public async readableRevision(ref: string, expected?: {token: TDocumentRevisionToken | null | undefined}) {
        const entry = await this.requireEntry(ref);
        const instance = entry.instance;
        await this.refreshPickedFile(entry);
        if (expected) this.expectedRevision(entry, expected.token);
        const token = this.tokenOf(entry);
        // Revision ids come back on undo; the directory's epoch moves on every change of its bytes.
        const epoch = entry.doc?.state().byteRevision;
        const blob = await this.readableBlob(ref);
        if (!this.isActiveEntry(entry, entry.doc, instance) || this.tokenOf(entry) !== token || entry.doc?.state().byteRevision !== epoch) this.throwStale(entry, token);
        return {blob, token, byteRevision: epoch, instance};
    }

    /**
     * Bytes the app makes, such as a converted or exported document, written as they come. When `close` resolves
     * they are the document's and its baseline, as an import's are: it starts clean and names no work of the
     * person's, so a window that goes away later offers none for recovery. Until then, and after `abort` or a
     * failed write, the document keeps the bytes it had (see `pushRevisionStream`). The stream holds the document
     * until it ends, so closing the entry aborts it, and a new stream ends the one before.
     */
    public async writeStream(ref: string) {
        const entry = await this.requireEntry(ref);
        // Calls that start together each wait for the stream before theirs to end, so none is left holding the document.
        while (entry.endStream) await entry.endStream(canceledWrite());
        const stream = pushRevisionStream(source => this.mutate(entry, this.tokenOf(entry), {kind: 'rewrite', source, drafts: 'clear', imported: true}, 'write'));
        entry.endStream = stream.abort;
        const ended = () => {
            if (entry.endStream === stream.abort) delete entry.endStream;
        };
        void stream.written.then(ended, ended);
        return stream;
    }

    /** The caller wrote the document's bytes to `saveHandle`: from now on they are that file's. */
    public async replaceWithHandleBackedDocument(ref: string, options: {fileSize: number; saveHandle?: FileSystemFileHandle | null; saveName?: string}) {
        const entry = await this.requireEntry(ref);
        const handle = options.saveHandle ?? entry.saveHandle;
        if (!handle) throw new Error(`No file to back browser document ${ref}`);
        const previous = this.tokenOf(entry);
        await this.closeEntry(entry, true);
        Object.assign(entry, {doc: null, store: null, file: await handle.getFile(), saveHandle: handle, updatedAt: Date.now(), closed: false, instance: Symbol('browser-document-entry')});
        if (options.saveName) entry.saveName = entry.fileName = options.saveName;
        await this.persistHandle(entry);
        this.attach(entry);
        this.emitRevision(entry, previous, 'replace-working-copy');
    }

    /**
     * Imports `fromRef`'s bytes anew as `ref`'s, the file as it was last saved: one commit makes them current and
     * the baseline, with no history, so the document starts clean; the old bytes go once no manifest names them.
     */
    public async replaceContent(ref: string, fromRef: string) {
        const source = await this.externalSource(fromRef);
        const entry = await this.requireEntry(ref);
        await this.mutate(entry, this.tokenOf(entry), {kind: 'rewrite', source, drafts: 'clear', imported: true}, 'write');
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
     * baseline, publish. The caller asked for write permission before; the document's lock is held. Every window
     * learns of a revision the Save committed whatever happens after the commit: the edits are in the working
     * copy, unsaved until a Save publishes them, so a retry or Save As writes them once.
     */
    public async save(ref: string, token: TDocumentRevisionToken | null | undefined, options: {commit?: string; saveAs?: string} = {}): Promise<TSaveResult> {
        const entry = await this.requireEntry(ref);
        const doc = this.requireDoc(entry);
        const instance = entry.instance;
        const previous = this.tokenOf(entry);
        try {
            let expected = this.expectedRevision(entry, token, {allowStagedBase: true});
            const {commit} = options;
            if (commit !== undefined) {
                await this.nameEdited(entry);
                if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
                const committed = await doc.run(() => this.commitPendingAppend(entry, token, commit, instance));
                if (committed.status === 'stale-revision') this.throwStale(entry, token);
                if (committed.status === 'conflict') return committed;
                expected = committed.revision.id;
            }
            if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
            const result = await saveDocument(doc, {
                expected,
                ...(options.saveAs ? {saveAs: options.saveAs} : {}),
            });
            if (result.status === 'stale-revision') this.throwStale(entry, token);
            return result;
        } catch (error) {
            if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
            throw error;
        } finally {
            if (this.tokenOf(entry) !== previous) {
                entry.file = null;
                entry.fileSize = doc.state().current?.length ?? entry.fileSize;
                entry.updatedAt = Date.now();
                this.emitRevision(entry, previous, 'save-sync');
            }
        }
    }

    /** Undo or redo: makes `revision`, which the document keeps for its undo history, current again. Nothing is copied. */
    public async restoreRevision(ref: string, revision: TDocumentRevisionToken, token: TDocumentRevisionToken | null | undefined) {
        const entry = await this.requireEntry(ref);
        const doc = this.requireDoc(entry);
        const instance = entry.instance;
        const capturedByteRevision = doc.state().byteRevision;
        this.expectedRevision(entry, token);
        await this.nameEdited(entry);
        if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
        const previous = this.tokenOf(entry);
        let result;
        try {
            result = await doc.run(async () => {
                if (
                    !this.isActiveEntry(entry, doc, instance)
                    || (token && token !== this.tokenOf(entry))
                    || doc.state().byteRevision !== capturedByteRevision
                ) {
                    return {status: 'stale-revision' as const, current: doc.snapshot().current ?? null};
                }
                return doc.applyRestore(this.expectedRevision(entry, token), this.revisionIdOf(doc, revision));
            });
        } catch (error) {
            if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
            throw error;
        }
        if (result.status === 'stale-revision') this.throwStale(entry, token);
        if (result.status === 'conflict') {
            const {history, baseline} = doc.state();
            const target = history.find(item => item.id === this.revisionIdOf(doc, revision));
            if (target && !('file' in target) && !sameWitness(target.witness, baseline)) {
                throw Object.assign(new Error('The document as it was opened could not be retained when it was saved, so it cannot be restored'), {code: 'SOURCE_BACKING_UNAVAILABLE'});
            }
            throw new BrowserDocumentSourceChangedError(entry.ref);
        }
        entry.file = null;
        entry.fileSize = await this.sizeOf(entry);
        entry.updatedAt = Date.now();
        this.emitRevision(entry, previous, 'write');
        return this.revisionInfo(entry);
    }

    /** Keeps exactly the revisions `revisions` names for undo and redo; the files no revision names any more go. */
    public async retainRevisions(ref: string, revisions: readonly TDocumentRevisionToken[]) {
        const doc = this.requireDoc(await this.requireEntry(ref));
        await doc.retain(revisions.map(revision => this.revisionIdOf(doc, revision)));
    }

    private revisionIdOf(doc: DocumentDirectory, revision: TDocumentRevisionToken) {
        const match = /^drt1:browser:([^:]+):(\d+)(?::([fs]))?$/u.exec(revision);
        if (!match || match[1] !== doc.id) return -1;
        const id = Number(match[2]);
        const foreign = match[3] === 'f' ? 'committed' : match[3] === 's' ? 'staged' : undefined;
        return Number.isSafeInteger(id) && this.revisionToken(doc, id, foreign) === revision ? id : -1;
    }

    // In-place edits -----------------------------------------------------------------------------------------

    /**
     * Lets `append` write past the bytes of revision `token` in the document's own file, without committing
     * what it writes: readers keep reading that revision. `append` returns the file's new length, or null when
     * it appended nothing. The returned lease names the appended bytes until `save` or `commitAppend` commits
     * them or `discardAppend` cuts them; one append is pending per document, and a new one cuts the one before.
     * A document without own bytes copies its file in first as it is now: Save refuses a changed one, Save As rescues it.
     */
    public async stageAppend(
        ref: string,
        token: TDocumentRevisionToken | null | undefined,
        append: (file: IStoreFile, base: number) => Promise<number | null>,
    ) {
        const entry = await this.requireEntry(ref);
        const doc = this.requireDoc(entry);
        const instance = entry.instance;
        this.expectedRevision(entry, token, {allowStagedBase: true});
        try {
            return await doc.run(async () => {
                if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
                this.expectedRevision(entry, token, {allowStagedBase: true});
                if (await doc.ensureCurrent(true) === null) throw new BrowserDocumentSourceChangedError(entry.ref);
                if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
                await doc.applyOwnCurrentFile();
                if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
                this.expectedRevision(entry, token, {allowStagedBase: true});
                entry.pendingAppend = undefined;
                const base = doc.state().current!.length;
                const file = doc.currentFile();
                let lease: string | null = null;
                try {
                    if (await file.size() > base) await file.truncate(base);
                    const length = await append(file, base);
                    if (length === null) return null;
                    if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
                    lease = crypto.randomUUID();
                    entry.pendingAppend = {lease, token: this.tokenOf(entry), length};
                    return lease;
                } finally {
                    if (lease === null) await file.truncate(base).catch(() => undefined);
                }
            });
        } catch (error) {
            if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
            throw error;
        }
    }

    /** Commits the pending append `lease` names as the document's next revision; drafts described the bytes before it. */
    public async commitAppend(ref: string, token: TDocumentRevisionToken | null | undefined, lease: string) {
        const entry = await this.requireEntry(ref);
        const doc = this.requireDoc(entry);
        const instance = entry.instance;
        await this.nameEdited(entry);
        if (!this.isActiveEntry(entry, doc, instance)) this.throwStale(entry, token);
        const previous = this.tokenOf(entry);
        return this.settle(entry, token, previous, await doc.run(() => this.commitPendingAppend(entry, token, lease, instance)), 'write');
    }

    /** Cuts the pending append `lease` names; nothing when another append or revision followed it. */
    public async discardAppend(ref: string, lease: string) {
        const entry = this.entries.get(ref);
        const doc = entry?.doc;
        if (!doc || entry.pendingAppend?.lease !== lease) return;
        await doc.run(async () => {
            const pending = entry.pendingAppend;
            const current = doc.state().current;
            if (pending?.lease !== lease || !current) return;
            entry.pendingAppend = undefined;
            if (pending.token === this.tokenOf(entry) && await doc.currentFile().size() === pending.length) {
                await doc.currentFile().truncate(current.length);
                await doc.currentFile().flush();
            }
        });
    }

    /** The document's bytes with the pending append `lease` names, read in place; valid while the lease lasts. */
    public async appendedContent(ref: string, lease: string): Promise<Blob> {
        const entry = await this.requireEntry(ref);
        const doc = this.requireDoc(entry);
        return doc.run(async () => {
            const {length} = this.requirePendingAppend(entry, lease);
            const file = doc.currentFile();
            if (isOpfsStorePort(entry.store!.port)) return (await (await opfsFileHandle(doc.path(doc.state().current!.file))).getFile()).slice(0, length);
            const parts: Blob[] = [];
            for (let offset = 0; offset < length; offset += BROWSER_DOCUMENT_CHUNK_SIZE) {
                parts.push(bytesBlob(await file.readAt(offset, Math.min(BROWSER_DOCUMENT_CHUNK_SIZE, length - offset))));
            }
            return new Blob(parts);
        });
    }

    private requirePendingAppend(entry: IBrowserDocumentEntry, lease: string) {
        const pending = entry.pendingAppend;
        if (pending?.lease !== lease || pending.token !== this.tokenOf(entry)) {
            throw new Error('The edit staged for this document is no longer its next revision');
        }
        return pending;
    }

    /** Runs in the document's queue: the pending append, still where it was written, becomes the next revision. */
    private async commitPendingAppend(
        entry: IBrowserDocumentEntry,
        token: TDocumentRevisionToken | null | undefined,
        lease: string,
        expectedInstance?: symbol,
    ) {
        const doc = this.requireDoc(entry);
        if (!this.isActiveEntry(entry, doc, expectedInstance)) return {status: 'stale-revision', current: doc.state().current ?? null} as const;
        const expected = this.expectedRevision(entry, token, {allowStagedBase: true});
        const {length} = this.requirePendingAppend(entry, lease);
        if (await doc.currentFile().size() !== length) throw new Error('The edit staged for this document is no longer its next revision');
        entry.pendingAppend = undefined;
        return doc.applyMutation(expected, {kind: 'extend', drafts: 'clear'});
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

    /** Has this window name `entry`'s directory for recovery: before a change that is not part of opening it, as desktop does. */
    public async nameEdited(entry: IBrowserDocumentEntry) {
        if (entry.doc && !entry.memoryOnly) await this.onDirectoryEdited(entry.doc.id);
    }

    /** A directory this window takes with unsaved work in it (recovered, handed over, made from unsaved bytes) is named at once. */
    private async hold(entry: IBrowserDocumentEntry) {
        if (entry.doc?.state().dirty) await this.nameEdited(entry);
        return this.attach(entry);
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
            instance: Symbol('browser-document-entry'),
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
     * leaves the document in memory, which is said once. A creation that fails for any other reason, such as a
     * download that breaks part way, removes what it wrote before letting go of the lock.
     */
    private async createEntry(ref: TDocumentRef, init: Omit<TDocumentInit, 'ext' | 'id'>, meta: TEntryMeta) {
        const {durable, memory} = await this.stores();
        const id = browserDocumentRefId(ref);
        const release = await this.lock(id, 0);
        const fileName = meta.fileName ?? getBrowserDocumentFileName(ref);
        const documentInit = {...init, id, name: fileName} as TDocumentInit;
        let store = durable ?? memory;
        let doc: DocumentDirectory | null = null;
        let existedInStore = (await store.port.list('documents').catch((): string[] => [])).includes(id);
        try {
            try {
                doc = await createDocument(store, documentInit);
            } catch (error) {
                if (!durable || !isQuotaError(error)) throw error;
                if (!existedInStore) await store.port.remove(`documents/${id}`).catch(() => undefined);
                store = memory;
                existedInStore = (await store.port.list('documents').catch((): string[] => [])).includes(id);
                doc = await createDocument(store, documentInit);
            }
            const entry = this.docEntry(ref, doc, store, release, {...meta, fileName});
            if (store.port === memory.port) {
                entry.memoryOnly = true;
                emitBrowserDocumentPersistenceWarning({fileName, error: new Error('The browser refused to store this document')});
            }
            return await this.hold(entry);
        } catch (error) {
            await doc?.close().catch(() => undefined);
            if (!existedInStore) await store.port.remove(`documents/${id}`).catch(() => undefined);
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
            const store = durable;
            const doc = await openDocument(store, id);
            const sourceRef = this.namedSources.get(parsed);
            // A named directory is a working copy; one opened from Recent Files is a stored source.
            const entry = await this.hold(this.docEntry(parsed, doc, store, release, sourceRef
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
        entry.closed = true;
        try {
            await entry.endStream?.(canceledWrite());
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

    /** A store document's revision is its directory and the revision its manifest names; 1 is its destination's bytes. */
    public tokenOf(entry: IBrowserDocumentEntry) {
        if (entry.doc) {
            const current = entry.doc.state().current;
            return this.revisionToken(entry.doc, current?.id ?? 1, current?.foreign);
        }
        return requireDocumentRevisionToken(`drt1:browser:${browserDocumentRefId(entry.ref)}:f${entry.file?.lastModified ?? 0}-${entry.file?.size ?? 0}`);
    }

    private revisionToken(doc: DocumentDirectory, revisionId: number, foreign?: 'staged' | 'committed') {
        const suffix = foreign === 'committed' ? ':f' : foreign === 'staged' ? ':s' : '';
        return requireDocumentRevisionToken(`drt1:browser:${doc.id}:${revisionId}${suffix}`);
    }

    private revisionInfo(entry: IBrowserDocumentEntry, documentRef = entry.ref): IDocumentRevisionInfo {
        return {
            version: 1,
            documentRef,
            authority: 'browser-document-store',
            token: this.tokenOf(entry),
            contentRevision: entry.doc?.state().current?.id ?? 1,
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

    private isActiveEntry(entry: IBrowserDocumentEntry, doc?: DocumentDirectory | null, expectedInstance?: symbol) {
        return !entry.closed
            && this.entries.get(entry.ref) === entry
            && (doc === undefined || entry.doc === doc)
            && (expectedInstance === undefined || entry.instance === expectedInstance);
    }

    /** The core's expected revision for a caller's token; a working copy's edits must name the revision they saw. */
    private expectedRevision(
        entry: IBrowserDocumentEntry,
        token: TDocumentRevisionToken | null | undefined,
        options: {allowStagedBase?: boolean} = {},
    ) {
        if (!token) {
            if (entry.kind === 'working') throw createMissingRevisionError({documentRef: entry.ref});
        } else if (
            token !== this.tokenOf(entry)
            && !(options.allowStagedBase && entry.doc?.state().current?.foreign === 'staged' && token === this.revisionToken(entry.doc, 1))
        ) {
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
        options: {strictRevisionToken?: boolean; expectedByteRevision?: number; expectedInstance?: symbol} = {},
    ) {
        const doc = this.requireDoc(entry);
        const expectedInstance = options.expectedInstance ?? entry.instance;
        const capturedByteRevision = options.expectedByteRevision ?? doc.state().byteRevision;
        const isCurrent = () => {
            if (!this.isActiveEntry(entry, doc, expectedInstance)) return false;
            if (options.strictRevisionToken) {
                return Boolean(token)
                    && token === this.tokenOf(entry)
                    && entry.pendingAppend === undefined
                    && doc.state().byteRevision === capturedByteRevision;
            }
            if (token) {
                return token === this.tokenOf(entry)
                    && doc.state().byteRevision === capturedByteRevision;
            }
            return true;
        };
        if (!token && entry.kind === 'working') throw createMissingRevisionError({documentRef: entry.ref});
        if (!isCurrent()) this.throwStale(entry, token);
        // An open's bytes and imported ones hold no work of the person's.
        if (reason !== 'open' && !(mutation.kind === 'rewrite' && mutation.imported)) await this.nameEdited(entry);
        if (!this.isActiveEntry(entry, doc, expectedInstance)) this.throwStale(entry, token);
        let previous = this.tokenOf(entry);
        const result = await doc.run(async (): Promise<TMutationResult> => {
            previous = this.tokenOf(entry);
            if (!isCurrent()) {
                return {status: 'stale-revision', current: doc.state().current ?? null};
            }
            return doc.applyMutation(doc.state().current?.id ?? null, mutation);
        });
        return this.settle(entry, token, previous, result, reason, announce);
    }

    private settle(
        entry: IBrowserDocumentEntry,
        token: TDocumentRevisionToken | null | undefined,
        previous: TDocumentRevisionToken,
        result: TMutationResult,
        reason: TDocumentRevisionChangeReason,
        announce = true,
    ) {
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
