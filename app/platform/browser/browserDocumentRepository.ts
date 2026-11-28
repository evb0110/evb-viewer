import {
    createDocument,
    type DocumentDirectory,
    forkDocument,
    type IDocumentStore,
    openDocument,
    type TDocumentInit,
    type TMutation,
} from '@document-store/documentDirectory';
import {createRevisionTokenCodec, OpenDocument, type TOpenMutationResult} from '@document-store/openDocument';
import type {TSaveResult} from '@document-store/saveDocument';
import type {IStoreFile} from '@document-store/storePort';
import {BROWSER_DOCUMENT_CHUNK_SIZE, BROWSER_MAX_FULL_READ_BYTES} from '@app/platform/browser/browserDocumentConstants';
import {browserDocumentRefId, createBrowserDocumentRef, getBrowserDocumentFileName} from '@app/platform/browser/browserDocumentRefs';
import {canceledWrite, pushRevisionStream, streamWriter} from '@app/platform/browser/browserRevisionStream';
import {BROWSER_DOCUMENT_FULL_READ_TOO_LARGE, BrowserDocumentReadError} from '@app/platform/browser/browserDocumentReadError';
import {emitBrowserDocumentPersistenceWarning} from '@app/platform/browser/browserDocumentPersistenceWarnings';
import {fileHandleStore} from '@app/platform/browser/browserFileHandleStore';
import {
    browserPublication,
    fileFact,
    handleDestination,
    handleKeyOf,
    rememberFileHandle,
    resolveFileHandle,
    storeFileHandle,
} from '@app/platform/browser/browserPublication';
import {BrowserRecentFilesStore} from '@app/platform/browser/browserRecentFilesStore';
import {createMemoryStorePort, isOpfsStorePort, openBrowserStorePort, storeFileBlob} from '@app/platform/browser/browserStorePort';
import {holdBrowserLock, runBrowserLock} from '@app/platform/browser/runBrowserLock';
import {createMissingRevisionError, createStaleRevisionError} from '@contracts/documentMutationErrors';
import {DocumentOpenRefusalError} from '@contracts/documentOpenErrors';
import {parseDocumentRef, type TDocumentRef} from '@contracts/documentRef';
import {
    requireDocumentRevisionToken,
    type IDocumentRevisionChangedEvent,
    type IDocumentRevisionInfo,
    type TDocumentRevisionChangeReason,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {IRecentReadingView} from '@contracts/recentReadingView';
import {createEpochMs} from '@contracts/timestamps';

const DOCUMENT_LOCK_PREFIX = 'evb-document:';
const DOCUMENT_LOCK_WAIT_MS = 10_000;
const BROWSER_REVISION_CODEC = createRevisionTokenCodec('browser');
export const browserDocumentLockName = (id: string) => `${DOCUMENT_LOCK_PREFIX}${id}`;

type TEntryKind = 'source' | 'working' | 'output';
type TRetention = 'durable' | 'transient';
type TSaveKind = 'pdf' | 'docx' | 'generic';
type TExpectedToken = TDocumentRevisionToken | null | undefined;
type TRevisionOptions = {strict?: boolean; expectedByteRevision?: number; expectedInstance?: symbol; allowStagedBase?: boolean};

export interface IBrowserDocumentEntry {
    ref: TDocumentRef;
    fileName: string;
    mimeType: string;
    kind: TEntryKind;
    retention: TRetention;
    saveKind: TSaveKind;
    saveName: string;
    saveHandle: FileSystemFileHandle | null;
    sourceRef?: TDocumentRef;
    memoryOnly: boolean;
    fileSize: number;
    updatedAt: number;
    doc: DocumentDirectory | null;
    session: OpenDocument | null;
    store: IDocumentStore | null;
    file: File | null;
    release: (() => void) | null;
    instance: symbol;
    byteRevisionOffset?: number;
    retainedRevisions?: readonly TDocumentRevisionToken[];
    closed?: boolean;
    endStream?: (reason: unknown) => Promise<void>;
}

type TEntryMeta = {[K in keyof IBrowserDocumentEntry]?: IBrowserDocumentEntry[K] | undefined};

interface IEntryOptions {
    kind?: TEntryKind;
    retention?: TRetention;
    saveKind?: TSaveKind;
    sourceRef?: string;
    saveHandle?: FileSystemFileHandle | null;
}

export interface IRegisterFileOptions extends IEntryOptions {
    ref?: TDocumentRef;
}

export interface ICreateStoredDocumentOptions extends IEntryOptions {
    ref?: TDocumentRef | undefined;
    mimeType: string;
    storageMode?: 'handle';
}

interface IWriteOptions {
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null | undefined;
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

const bytesBlob = (data: Uint8Array | ArrayBuffer | Blob) =>
    data instanceof Blob ? data : new Blob([data instanceof Uint8Array ? (data as Uint8Array<ArrayBuffer>) : new Uint8Array(data)]);
const isErrorName = (error: unknown, name: string) => error instanceof Error && error.name === name;
const entryMeta = (options: IEntryOptions, extra: TEntryMeta = {}): TEntryMeta => {
    const kind = options.kind ?? 'source';
    return {
        kind,
        retention: options.retention ?? (kind === 'working' ? 'transient' : 'durable'),
        ...(options.saveKind ? {saveKind: options.saveKind} : {}),
        ...(options.sourceRef ? {sourceRef: parseDocumentRef(options.sourceRef) ?? undefined} : {}),
        ...extra,
    };
};

async function assertReadPermission(handle: FileSystemFileHandle, prompt: boolean) {
    const {queryPermission, requestPermission} = handle as FileSystemFileHandle & {
        queryPermission?: (descriptor: {mode: 'read'}) => Promise<PermissionState>;
        requestPermission?: (descriptor: {mode: 'read'}) => Promise<PermissionState>;
    };
    if (
        !queryPermission ||
        (await queryPermission.call(handle, {mode: 'read'})) === 'granted' ||
        (prompt && (await requestPermission?.call(handle, {mode: 'read'})) === 'granted')
    ) {
        return;
    }
    throw new DOMException('Open the file again to restore read permission.', 'NotAllowedError');
}

export class BrowserDocumentStore {
    private readonly entries = new Map<string, IBrowserDocumentEntry>();
    private readonly hydrating = new Map<string, Promise<IBrowserDocumentEntry | null>>();
    private readonly fileRefs = new WeakMap<File, TDocumentRef>();
    private readonly namedSources = new Map<string, TDocumentRef>();
    private readonly revisionListeners = new Set<(event: IDocumentRevisionChangedEvent) => void>();
    private readonly removalListeners = new Set<(ref: string) => void>();
    private storesPromise: Promise<{durable: IDocumentStore | null; memory: IDocumentStore}> | null = null;
    private memoryStore: IDocumentStore | null = null;
    private hadDurable = false;
    private reopening: Promise<void> | null = null;
    private readonly recentFiles = new BrowserRecentFilesStore();
    public onDirectoryEdited: (id: string) => Promise<boolean | void> = async () => false;

    public constructor(private readonly createStoreWorker?: () => Worker) {}

    private async openDurableStore(onFault: () => void) {
        const opened = await openBrowserStorePort(this.createStoreWorker, onFault);
        return {opened, durable: opened.durable ? ({port: opened.port, publication: browserPublication} satisfies IDocumentStore) : null};
    }

    public async stores() {
        await this.reopening;
        const loading = (this.storesPromise ??= (async () => {
            let durable: IDocumentStore | null = null;
            const {opened, durable: d} = await this.openDurableStore(() => durable && void this.reopenDurableStore(durable));
            durable = d;
            this.hadDurable ||= durable !== null;
            this.memoryStore ??= {port: opened.durable ? createMemoryStorePort() : opened.port, publication: browserPublication};
            return {durable, memory: this.memoryStore};
        })());
        const res = await loading;
        if (!res.durable && this.hadDurable && this.storesPromise === loading) {
            this.storesPromise = null;
        }
        return res;
    }

    private durableEntries() {
        return [...this.entries.values()].filter((e) => e.doc && !e.memoryOnly && !e.closed);
    }

    private reopenDurableStore(failed?: IDocumentStore): Promise<void> {
        if (this.reopening) {
            return this.reopening
                .catch(() => undefined)
                .then(async () => {
                    const cur = (await this.storesPromise?.catch(() => null))?.durable ?? null;
                    if (failed ? cur === failed : cur !== null && this.durableEntries().some((e) => e.store !== cur)) {
                        await this.reopenDurableStore(failed);
                    }
                });
        }
        const pending = runBrowserLock('evb-viewer:browser-store-reopen', async () => {
            const current = await this.storesPromise?.catch(() => null);
            const durable = current?.durable ?? null;
            if (failed ? durable !== failed : !durable) {
                return;
            }
            const affected = this.durableEntries().filter((entry) => Boolean(failed) || entry.store !== durable);
            for (const entry of affected) {
                void entry.endStream?.(canceledWrite()).catch(() => undefined);
                await entry.doc?.close().catch(() => undefined);
            }
            if (!failed) {
                for (const entry of affected) {
                    const opened = await this.openReboundEntry(entry, durable!);
                    if (opened) {
                        this.installReopened(entry, opened.doc, opened.session, durable!);
                    }
                }
                return;
            }
            this.storesPromise = null;
            for (let attempt = 0; attempt < 3; attempt += 1) {
                let freshFaulted = false;
                let published: IDocumentStore | null = null;
                const {durable: candidate} = await this.openDurableStore(() => {
                    freshFaulted = true;
                    void (published && this.reopenDurableStore(published));
                });
                if (freshFaulted) {
                    continue;
                }
                if (!candidate) {
                    return;
                }
                const reopened: Array<{entry: IBrowserDocumentEntry; doc: DocumentDirectory; session: OpenDocument}> = [];
                for (const entry of affected) {
                    try {
                        const opened = await this.openReboundEntry(entry, candidate, () => freshFaulted);
                        if (opened) {
                            reopened.push({entry, ...opened});
                        }
                    } catch {
                        if (freshFaulted) {
                            break;
                        }
                    }
                }
                if (freshFaulted) {
                    await Promise.all(reopened.map(({doc}) => doc.close().catch(() => undefined)));
                    continue;
                }
                published = candidate;
                this.storesPromise = Promise.resolve({durable: candidate, memory: current!.memory});
                for (const {entry, doc, session} of reopened) {
                    this.installReopened(entry, doc, session, candidate);
                }
                return;
            }
        }).finally(() => void (this.reopening === pending && (this.reopening = null)));
        return (this.reopening = pending);
    }

    private async openReboundEntry(entry: IBrowserDocumentEntry, store: IDocumentStore, isFaulted = () => false) {
        for (let retry = 0; retry < 3 && !isFaulted() && this.isActiveEntry(entry) && entry.doc; retry += 1) {
            let doc: DocumentDirectory | null = null;
            try {
                doc = await openDocument(store, entry.doc.id);
                const session = this.createSession(entry, doc);
                if (entry.retainedRevisions) {
                    await doc.retain([
                        ...entry.retainedRevisions.map((t) => session.parseRevisionId(t)),
                        ...doc.state().history.map((r) => r.id),
                    ]);
                }
                return {doc, session};
            } catch (error) {
                await doc?.close().catch(() => undefined);
                if (isFaulted() || isErrorName(error, 'NotFoundError')) {
                    return null;
                }
                if (retry === 2) {
                    throw error;
                }
                await Promise.resolve();
            }
        }
        return null;
    }

    private installReopened(entry: IBrowserDocumentEntry, doc: DocumentDirectory, session: OpenDocument, store: IDocumentStore) {
        if (!this.isActiveEntry(entry)) {
            void doc.close().catch(() => undefined);
            return;
        }
        const previous = this.tokenOf(entry);
        const prev = entry.doc!.state();
        const next = doc.state();
        const prevEpoch = this.byteRevisionOf(entry) ?? 0;
        const sameBytes =
            session.token() === previous &&
            next.current?.file === prev.current?.file &&
            next.current?.length === prev.current?.length &&
            next.baseline === prev.baseline;
        Object.assign(entry, {doc, session, store, byteRevisionOffset: sameBytes ? prevEpoch : prevEpoch + 1});
        this.commitEntry(entry, next.current?.length ?? 0, previous, sameBytes ? undefined : 'write');
    }

    private async syncDurableStore(entry: IBrowserDocumentEntry) {
        const durable = entry.doc && !entry.memoryOnly && !entry.closed ? (await this.stores()).durable : null;
        if (durable && entry.store !== durable) {
            await this.reopenDurableStore();
        }
    }

    private byteRevisionOf(entry: IBrowserDocumentEntry) {
        return entry.doc ? (entry.byteRevisionOffset ?? 0) + entry.doc.state().byteRevision : undefined;
    }

    private localByteRevision(entry: IBrowserDocumentEntry, epoch: number | undefined) {
        return epoch === undefined ? undefined : epoch - (entry.byteRevisionOffset ?? 0);
    }

    private withReopen<T>(task: Promise<T>): Promise<T> {
        return task.catch(async (error: unknown) => {
            await this.reopening?.catch(() => undefined);
            throw error;
        });
    }

    public getRefForFile(file: File): TDocumentRef {
        const known = this.fileRefs.get(file);
        if (known && this.entries.has(known)) {
            return known;
        }
        const ref = createBrowserDocumentRef(file.name);
        this.attach(
            this.baseEntry(
                ref,
                {fileName: file.name, mimeType: file.type || undefined, retention: 'transient'},
                {file, fileSize: file.size},
            ),
        );
        this.fileRefs.set(file, ref);
        return ref;
    }

    public async registerFile(file: File, options: IRegisterFileOptions = {}) {
        return (await this.registerFileWithOwnership(file, options)).ref;
    }

    public async registerFileWithOwnership(file: File, options: IRegisterFileOptions = {}) {
        const known = this.fileRefs.get(file);
        const knownEntry = known ? this.entries.get(known) : undefined;
        const meta = entryMeta(options);
        const needsMore =
            (options.saveHandle && !knownEntry?.saveHandle) ||
            (meta.retention === 'durable' && !knownEntry?.doc && !knownEntry?.saveHandle);
        if (known && knownEntry && !needsMore) {
            return {ref: known, created: false};
        }
        const ref = options.ref ?? known ?? createBrowserDocumentRef(file.name);
        if (options.saveHandle) {
            await this.attachHandleSource(ref, options.saveHandle, file, meta);
        } else if (meta.retention === 'transient') {
            this.attach(this.baseEntry(ref, {...meta, fileName: file.name, mimeType: file.type || undefined}, {file, fileSize: file.size}));
        } else {
            await this.createEntry(
                ref,
                {source: file, imported: true},
                {...meta, fileName: file.name, mimeType: file.type || 'application/octet-stream'},
            );
        }
        this.fileRefs.set(file, ref);
        return {ref, created: true};
    }

    public async createStoredDocument(
        fileName: string,
        data: Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
        options: ICreateStoredDocumentOptions,
    ): Promise<TDocumentRef> {
        const ref = options.ref ?? createBrowserDocumentRef(fileName);
        const meta = entryMeta(options, {mimeType: options.mimeType, fileName});
        if (options.storageMode === 'handle' && options.saveHandle) {
            await this.attachHandleSource(ref, options.saveHandle, null, meta);
            return ref;
        }
        const source = data instanceof ReadableStream ? streamWriter(data) : bytesBlob(data);
        const entry = await this.createEntry(ref, {source, imported: meta.kind !== 'working'}, meta);
        entry.saveHandle = options.saveHandle ?? null;
        return ref;
    }

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
                if (!isErrorName(error, 'QuotaExceededError')) {
                    throw error;
                }
                // No room: copy into memory.
                await store.port.remove(`documents/${id}`).catch(() => undefined);
                entry = await this.createEntry(workingRef, {source: await this.readableBlob(source.ref), imported: true}, meta);
            }
            entry.file = source.doc.state().current ? null : source.file;
        } else {
            entry = await this.createEntry(workingRef, {source: await this.fileOf(source), imported: true}, meta);
        }
        if (data) {
            await this.mutate(entry, this.tokenOf(entry), {kind: 'rewrite', source: bytesBlob(data), drafts: 'clear'}, 'write');
        }
        return workingRef;
    }

    public async ensureEntry(ref: string): Promise<IBrowserDocumentEntry | null> {
        await this.reopening;
        const known = this.entries.get(ref);
        if (known) {
            await this.syncDurableStore(known);
            return known;
        }
        let hydration = this.hydrating.get(ref);
        if (!hydration) {
            hydration = this.hydrate(ref).finally(() => this.hydrating.delete(ref));
            this.hydrating.set(ref, hydration);
        }
        return hydration;
    }

    public async requireEntry(ref: string): Promise<IBrowserDocumentEntry> {
        const entry = await this.ensureEntry(ref);
        if (!entry) {
            throw new DocumentOpenRefusalError('not-found', `Browser document not found: ${ref}`, {
                fileName: getBrowserDocumentFileName(ref),
            });
        }
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
                `Browser document is too large to load fully into memory (${entry.fileName}: ` +
                    `${Math.floor(size / (1024 * 1024))}MB > ${Math.round(maxBytes / (1024 * 1024))}MB limit)`,
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

    public async getContentSnapshot(ref: string): Promise<{size: number; modifiedAt: number; contentSignature: string}> {
        const entry = await this.requireEntry(ref);
        await this.refreshPickedFile(entry);
        return {size: await this.sizeOf(entry), modifiedAt: entry.updatedAt, contentSignature: this.tokenOf(entry)};
    }

    public async getDocumentRevision(ref: string): Promise<IDocumentRevisionInfo> {
        const entry = await this.requireEntry(ref);
        await this.refreshPickedFile(entry);
        return this.revisionInfo(entry);
    }

    private verifyEntryRevision(entry: IBrowserDocumentEntry, expected: TExpectedToken, options: TRevisionOptions = {}) {
        if (options.expectedInstance !== undefined && !this.isActiveEntry(entry, entry.doc, options.expectedInstance)) {
            this.throwStale(entry, expected);
        }
        if (entry.session) {
            this.unwrapRevisionCheck(
                entry,
                expected,
                entry.session.checkRevision(expected, {
                    requireToken: entry.kind === 'working',
                    strict: options.strict ?? false,
                    allowStagedBase: options.allowStagedBase ?? false,
                    expectedByteRevision: this.localByteRevision(entry, options.expectedByteRevision),
                }),
            );
            return;
        }
        if (!expected) {
            if (entry.kind === 'working') {
                throw createMissingRevisionError({documentRef: entry.ref});
            }
            if (options.strict) {
                this.throwStale(entry, expected);
            }
        } else if (!this.isActiveEntry(entry, entry.doc) || expected !== this.tokenOf(entry)) {
            this.throwStale(entry, expected);
        }
    }

    public async assertDocumentRevisionCurrent(ref: string, expected: TExpectedToken, options: TRevisionOptions = {}) {
        const entry = await this.requireEntry(ref);
        await this.refreshPickedFile(entry);
        this.verifyEntryRevision(entry, expected, {
            ...options,
            allowStagedBase: options.allowStagedBase ?? entry.session?.hasPendingAppend() ?? false,
        });
    }

    public onDocumentRevisionChanged(listener: (event: IDocumentRevisionChangedEvent) => void) {
        this.revisionListeners.add(listener);
        return () => void this.revisionListeners.delete(listener);
    }

    public onDocumentRecordRemoved(listener: (ref: string) => void) {
        this.removalListeners.add(listener);
        return () => void this.removalListeners.delete(listener);
    }

    public async write(ref: string, data: Uint8Array | ArrayBuffer, options: IWriteOptions = {}) {
        const entry = await this.requireEntry(ref);
        const imported = options.opened === true && !entry.doc?.state().destination;
        await this.mutate(
            entry,
            options.expectedDocumentRevisionToken,
            {
                kind: 'rewrite',
                source: bytesBlob(data),
                drafts: 'clear',
                ...(imported ? {imported: true} : options.opened ? {openOnly: true} : {}),
            },
            options.opened ? 'open' : 'write',
            true,
            options,
        );
        return true;
    }

    public async rewrite(
        ref: string,
        token: TExpectedToken,
        write: (source: Blob, output: string | null) => Promise<Uint8Array | undefined>,
        {imported = false} = {},
    ) {
        const entry = await this.requireEntry(ref);
        const session = this.requireSession(entry);
        if (!imported) {
            await this.nameEdited(entry);
        }
        const pre = this.unwrapRevisionCheck(entry, token, session.checkRevision(token, {requireToken: entry.kind === 'working'}));
        const previous = requireDocumentRevisionToken(pre.currentToken);
        const capturedByteRevision = session.byteRevision();
        const capturedEpoch = this.byteRevisionOf(entry);
        const capturedInstance = entry.instance;
        const source = await this.readableBlob(ref);
        if (!session.isActive() || session.token() !== previous || session.byteRevision() !== capturedByteRevision) {
            this.throwStale(entry, token);
        }
        if (!isOpfsStorePort(entry.store!.port)) {
            const bytes = await write(source, null);
            if (!bytes) {
                throw new Error('The rewrite returned no bytes');
            }
            return this.mutate(entry, token, {kind: 'rewrite', source: bytesBlob(bytes), drafts: 'clear', imported}, 'write', true, {
                expectedByteRevision: capturedEpoch,
                expectedInstance: capturedInstance,
            });
        }
        const outcome = await this.withReopen(
            session.rewritePrepared(token, previous, capturedByteRevision, (output) => write(source, output).then(() => undefined), {
                imported,
            }),
        );
        return this.settleOutcome(entry, token, outcome, 'write');
    }

    /** The document's present bytes as a range-readable Blob until it next changes. */
    public async readableBlob(ref: string): Promise<Blob> {
        const entry = await this.requireEntry(ref);
        const current = entry.doc?.state().current;
        if (!entry.doc || !current) {
            return this.fileOf(entry);
        }
        return (await storeFileBlob(entry.store!.port, entry.doc.path(current.file))).slice(0, current.length);
    }

    /** Pairs `readableBlob` with its revision token, refusing as stale if the bytes changed meanwhile. */
    public async readableRevision(ref: string, expected?: {token: TExpectedToken}) {
        const entry = await this.requireEntry(ref);
        const instance = entry.instance;
        await this.refreshPickedFile(entry);
        if (expected) {
            this.verifyEntryRevision(entry, expected.token);
        }
        const token = this.tokenOf(entry);
        const epoch = this.byteRevisionOf(entry);
        const blob = await this.readableBlob(ref);
        if (!this.isActiveEntry(entry, entry.doc, instance) || this.tokenOf(entry) !== token || this.byteRevisionOf(entry) !== epoch) {
            this.throwStale(entry, token);
        }
        return {blob, token, byteRevision: epoch, instance};
    }

    public async writeStream(ref: string) {
        const entry = await this.requireEntry(ref);
        while (entry.endStream) {
            await entry.endStream(canceledWrite());
        }
        const stream = pushRevisionStream((source) =>
            this.mutate(entry, this.tokenOf(entry), {kind: 'rewrite', source, drafts: 'clear', imported: true}, 'write'),
        );
        entry.endStream = stream.abort;
        const ended = () => void (entry.endStream === stream.abort && delete entry.endStream);
        void stream.written.then(ended, ended);
        return stream;
    }

    public async replaceWithHandleBackedDocument(
        ref: string,
        options: {fileSize: number; saveHandle?: FileSystemFileHandle | null; saveName?: string},
    ) {
        const entry = await this.requireEntry(ref);
        const handle = options.saveHandle ?? entry.saveHandle;
        if (!handle) {
            throw new Error(`No file to back browser document ${ref}`);
        }
        const previous = this.tokenOf(entry);
        await this.closeEntry(entry, true);
        Object.assign(entry, {
            doc: null,
            session: null,
            store: null,
            file: await handle.getFile(),
            saveHandle: handle,
            updatedAt: Date.now(),
            closed: false,
            instance: Symbol('browser-document-entry'),
            ...(options.saveName ? {saveName: options.saveName, fileName: options.saveName} : {}),
        });
        await this.persistHandle(entry);
        this.attach(entry);
        this.emitRevision(entry, previous, 'replace-working-copy');
    }

    public async replaceContent(ref: string, fromRef: string) {
        const source = await this.readableBlob(fromRef);
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
        const {saveName, saveKind, saveHandle} = await this.requireEntry(ref);
        return {saveName, saveKind, saveHandle};
    }

    public async save(ref: string, token: TExpectedToken, options: {commit?: string; saveAs?: string} = {}): Promise<TSaveResult> {
        const entry = await this.requireEntry(ref);
        const session = this.requireSession(entry);
        const previous = this.tokenOf(entry);
        try {
            const checked = this.unwrapRevisionCheck(
                entry,
                token,
                await this.withReopen(
                    session.save(token, {
                        requireToken: entry.kind === 'working',
                        ...(options.commit !== undefined ? {commitLease: options.commit} : {}),
                        ...(options.saveAs !== undefined ? {saveAs: options.saveAs} : {}),
                    }),
                ),
            );
            if (checked.result.status === 'stale-revision') {
                this.throwStale(entry, token);
            }
            return checked.result;
        } finally {
            if (entry.session === session && this.tokenOf(entry) !== previous) {
                this.commitEntry(entry, session.doc.state().current?.length ?? entry.fileSize, previous, 'save-sync');
            }
        }
    }

    public async restoreRevision(ref: string, revision: TDocumentRevisionToken, token: TExpectedToken) {
        const entry = await this.requireEntry(ref);
        const outcome = this.unwrapRevisionCheck(
            entry,
            token,
            await this.withReopen(this.requireSession(entry).restore(token, revision, {requireToken: entry.kind === 'working'})),
        );
        if (outcome.status === 'conflict') {
            if (outcome.sourceBackingUnavailable) {
                throw Object.assign(
                    new Error('The document as it was opened could not be retained when it was saved, so it cannot be restored'),
                    {code: 'SOURCE_BACKING_UNAVAILABLE'},
                );
            }
            throw new BrowserDocumentSourceChangedError(entry.ref);
        }
        this.commitEntry(entry, await this.sizeOf(entry), requireDocumentRevisionToken(outcome.previousToken), 'write');
        return this.revisionInfo(entry);
    }

    public async retainRevisions(ref: string, revisions: readonly TDocumentRevisionToken[]) {
        const entry = await this.requireEntry(ref);
        entry.retainedRevisions = [...revisions];
        await this.withReopen(this.requireSession(entry).retain(revisions));
    }

    public async stageAppend(
        ref: string,
        token: TExpectedToken,
        append: (file: IStoreFile, base: number) => Promise<number | null>,
        {allowForeignBase = false}: {allowForeignBase?: boolean} = {},
    ) {
        const entry = await this.requireEntry(ref);
        const outcome = this.unwrapRevisionCheck(
            entry,
            token,
            await this.withReopen(
                this.requireSession(entry).stageAppend(token, append, {allowForeignBase, requireToken: entry.kind === 'working'}),
            ),
        );
        if (outcome.status === 'conflict') {
            throw new BrowserDocumentSourceChangedError(entry.ref);
        }
        return outcome.status === 'staged' ? outcome.lease : null;
    }

    public async commitAppend(ref: string, token: TExpectedToken, lease: string) {
        const entry = await this.requireEntry(ref);
        return this.settleOutcome(
            entry,
            token,
            await this.withReopen(this.requireSession(entry).commitAppend(token, lease, {requireToken: entry.kind === 'working'})),
            'write',
        );
    }

    public async discardAppend(ref: string, lease: string) {
        await this.entries.get(ref)?.session?.discardAppend(lease);
    }

    public async appendedContent(ref: string, lease: string): Promise<Blob> {
        const entry = await this.requireEntry(ref);
        return this.requireSession(entry).withPendingAppend(lease, async (path, length) =>
            (await storeFileBlob(entry.store!.port, path)).slice(0, length),
        );
    }

    public unload(ref: string) {
        const entry = this.entries.get(ref);
        if (entry?.doc && !entry.memoryOnly) {
            this.entries.delete(ref);
            void this.closeEntry(entry);
        }
    }

    public async remove(ref: string) {
        const entry = this.entries.get(ref);
        if (entry) {
            this.entries.delete(ref);
            await this.closeEntry(entry, true);
        }
        for (const listener of this.removalListeners) {
            listener(ref);
        }
        await this.removeRecentFile(ref);
    }

    public async cleanupDetachedDocument(ref: string) {
        const entry = this.entries.get(ref);
        if (!entry || (entry.retention === 'durable' && entry.kind !== 'working')) {
            if (entry) {
                this.unload(ref);
            }
            return false;
        }
        await this.remove(ref);
        return true;
    }

    public async release(ref: string) {
        const entry = this.entries.get(ref);
        if (entry) {
            this.entries.delete(ref);
            await this.closeEntry(entry);
        }
    }

    public nameSource(ref: string, sourceRef: TDocumentRef) {
        const entry = this.entries.get(ref);
        if (!entry) {
            this.namedSources.set(ref, sourceRef);
        } else if (sourceRef !== ref) {
            entry.sourceRef ??= sourceRef;
        }
    }

    public async documentOf(ref: string) {
        return (await this.ensureEntry(ref).catch(() => null))?.doc ?? null;
    }

    public openEntries() {
        return [...this.entries.values()];
    }

    public async touchRecentFile(ref: string) {
        const entry = await this.requireEntry(ref);
        if (entry.retention === 'transient' || entry.memoryOnly) {
            await this.recentFiles.remove(ref);
        } else {
            await this.recentFiles.touch(entry.ref, entry.saveName || entry.fileName, await this.sizeOf(entry).catch(() => entry.fileSize));
        }
    }

    private async hasStoredDoc(store: IDocumentStore | null, id: string) {
        return store !== null && (await store.port.list('documents')).includes(id);
    }

    public async isStored(ref: string) {
        const id = browserDocumentRefId(ref);
        return this.entries.has(ref) || Boolean(await fileHandleStore.get(id)) || this.hasStoredDoc((await this.stores()).durable, id);
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

    public async rememberRecentReadingView(workingCopy: string, view: IRecentReadingView) {
        const source = await this.admittedSource(workingCopy);
        if (source) {
            await this.recentFiles.rememberReadingView(source.sourceRef, source.witness, view);
        }
    }

    public async readRecentReadingView(workingCopy: string) {
        const source = await this.admittedSource(workingCopy);
        return source ? this.recentFiles.readReadingView(source.sourceRef, source.witness) : null;
    }

    private async admittedSource(ref: string) {
        const entry = await this.ensureEntry(ref).catch(() => null);
        if (!entry) {
            return null;
        }
        const sourceRef = entry.kind === 'working' ? entry.sourceRef : entry.ref;
        if (entry.doc) {
            const {baseline} = entry.doc.state();
            return sourceRef && baseline ? {sourceRef, witness: baseline} : null;
        }
        await this.refreshPickedFile(entry).catch(() => undefined);
        return {sourceRef: entry.ref, witness: fileFact(await this.fileOf(entry))};
    }

    private attach(entry: IBrowserDocumentEntry) {
        this.entries.set(entry.ref, entry);
        return entry;
    }

    public async nameEdited(entry: IBrowserDocumentEntry): Promise<boolean> {
        return Boolean(entry.doc && !entry.memoryOnly && (await this.onDirectoryEdited(entry.doc.id)) !== false);
    }

    private async hold(entry: IBrowserDocumentEntry) {
        this.attach(entry);
        try {
            if (entry.doc?.state().dirty) {
                await this.nameEdited(entry);
            }
            await this.syncDurableStore(entry);
            return entry;
        } catch (error) {
            if (this.entries.get(entry.ref) === entry) {
                this.entries.delete(entry.ref);
            }
            await entry.doc?.close().catch(() => undefined);
            throw error;
        }
    }

    private baseEntry(ref: TDocumentRef, meta: TEntryMeta, extra?: Partial<IBrowserDocumentEntry>): IBrowserDocumentEntry {
        const fileName = meta.fileName ?? getBrowserDocumentFileName(ref);
        return Object.assign(
            {
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
                session: null,
                store: null,
                file: null,
                release: null,
                instance: Symbol('browser-document-entry'),
            },
            extra,
        );
    }

    private createSession(entry: IBrowserDocumentEntry, doc: DocumentDirectory) {
        const instance = entry.instance;
        return new OpenDocument(doc, {
            codec: BROWSER_REVISION_CODEC,
            isActive: () => this.isActiveEntry(entry, doc, instance),
            beforeEdit: () => this.nameEdited(entry),
        });
    }

    private docEntry(ref: TDocumentRef, doc: DocumentDirectory, store: IDocumentStore, release: () => void, meta: TEntryMeta) {
        const entry = this.baseEntry(ref, meta, {doc, store, release, fileSize: doc.state().current?.length ?? 0});
        entry.session = this.createSession(entry, doc);
        return entry;
    }

    private async attachHandleSource(ref: TDocumentRef, handle: FileSystemFileHandle, file: File | null, meta: TEntryMeta) {
        const current = file ?? (await handle.getFile().catch(() => null));
        const entry = this.attach(
            this.baseEntry(
                ref,
                {fileName: handle.name, ...meta},
                {saveHandle: handle, saveName: handle.name, file: current, fileSize: current?.size ?? 0},
            ),
        );
        await this.persistHandle(entry);
        return entry;
    }

    private async persistHandle(entry: IBrowserDocumentEntry) {
        if (entry.saveHandle) {
            const key = browserDocumentRefId(entry.ref);
            await (entry.retention === 'durable' ? storeFileHandle : rememberFileHandle)(key, entry.saveHandle);
        }
    }

    private async lock(id: string, waitMs: number) {
        const release = await holdBrowserLock(browserDocumentLockName(id), waitMs);
        if (!release) {
            throw new Error('The document is open in another window');
        }
        return release;
    }

    private async createEntry(ref: TDocumentRef, init: Omit<TDocumentInit, 'ext' | 'id'>, meta: TEntryMeta) {
        const {durable, memory} = await this.stores();
        const id = browserDocumentRefId(ref);
        const release = await this.lock(id, 0);
        const fileName = meta.fileName ?? getBrowserDocumentFileName(ref);
        const documentInit = {...init, id, name: fileName} as TDocumentInit;
        let store = durable ?? memory;
        let doc: DocumentDirectory | null = null;
        let existedInStore = await this.hasStoredDoc(store, id).catch(() => false);
        const cleanNew = () => (!existedInStore ? store.port.remove(`documents/${id}`).catch(() => undefined) : undefined);
        try {
            try {
                doc = await createDocument(store, documentInit);
            } catch (error) {
                if (!durable || !isErrorName(error, 'QuotaExceededError')) {
                    throw error;
                }
                await cleanNew();
                store = memory;
                existedInStore = await this.hasStoredDoc(store, id).catch(() => false);
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
            await cleanNew();
            release();
            throw error;
        }
    }

    private async hydrate(ref: string): Promise<IBrowserDocumentEntry | null> {
        const parsed = parseDocumentRef(ref);
        let id: string;
        try {
            if (!parsed) {
                return null;
            }
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
        if (!durable || !(await this.hasStoredDoc(durable, id))) {
            return null;
        }
        const release = await this.lock(id, DOCUMENT_LOCK_WAIT_MS);
        try {
            const doc = await openDocument(durable, id);
            const sourceRef = this.namedSources.get(parsed);
            const meta: TEntryMeta = sourceRef
                ? {kind: 'working', retention: 'transient', ...(sourceRef === parsed ? {} : {sourceRef})}
                : {};
            const entry = await this.hold(this.docEntry(parsed, doc, durable, release, meta));
            const key = handleKeyOf(entry.doc?.state().destination ?? null);
            const handle = key !== null && !entry.doc?.state().current ? await resolveFileHandle(key) : null;
            if (handle) {
                await assertReadPermission(handle, true);
                entry.file = await handle.getFile();
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
            if (removeBytes) {
                if (entry.doc && entry.store) {
                    await entry.store.port.remove(`documents/${entry.doc.id}`);
                } else if (entry.saveHandle && entry.kind !== 'working') {
                    await fileHandleStore.delete(browserDocumentRefId(entry.ref)).catch(() => undefined);
                }
            }
        } finally {
            entry.release?.();
            entry.release = null;
        }
    }

    private requireSession(entry: IBrowserDocumentEntry) {
        if (!entry.session) {
            throw new Error(`Browser document has no stored bytes: ${entry.ref}`);
        }
        return entry.session;
    }

    private async fileOf(entry: IBrowserDocumentEntry) {
        if (entry.file) {
            return entry.file;
        }
        const key = handleKeyOf(entry.doc?.state().destination ?? null);
        const handle = (!entry.doc && entry.saveHandle) || (key === null ? null : await resolveFileHandle(key));
        if (!handle) {
            throw new Error(`Browser document has no readable bytes: ${entry.ref}`);
        }
        return (entry.file = await handle.getFile());
    }

    private async refreshPickedFile(entry: IBrowserDocumentEntry) {
        if (!entry.doc && entry.saveHandle) {
            const previous = this.tokenOf(entry);
            entry.file = await entry.saveHandle.getFile();
            entry.fileSize = entry.file.size;
            if (this.tokenOf(entry) !== previous) {
                entry.updatedAt = Date.now();
                this.emitRevision(entry, previous, 'browser-handle-refresh');
            }
        }
    }

    private async sizeOf(entry: IBrowserDocumentEntry) {
        return entry.doc?.state().current?.length ?? (await this.fileOf(entry)).size;
    }

    private async readEntryRange(entry: IBrowserDocumentEntry, offset: number, length: number) {
        if (entry.doc?.state().current) {
            return entry.doc.read(offset, length);
        }
        return new Uint8Array(await (await this.fileOf(entry)).slice(offset, offset + length).arrayBuffer());
    }

    public tokenOf(entry: IBrowserDocumentEntry) {
        return requireDocumentRevisionToken(
            entry.session
                ? entry.session.token()
                : `drt1:browser:${browserDocumentRefId(entry.ref)}:f${entry.file?.lastModified ?? 0}-${entry.file?.size ?? 0}`,
        );
    }

    private revisionInfo(entry: IBrowserDocumentEntry, documentRef = entry.ref): IDocumentRevisionInfo {
        return {
            version: 1,
            documentRef,
            authority: 'browser-document-store',
            token: this.tokenOf(entry),
            contentRevision: entry.session?.contentRevision() ?? 1,
            mintedAt: createEpochMs(entry.updatedAt),
        };
    }

    private throwStale(entry: IBrowserDocumentEntry, expected: TExpectedToken): never {
        throw createStaleRevisionError({
            documentRef: entry.ref,
            expectedRevision: requireDocumentRevisionToken(expected ?? 'none'),
            actualRevision: this.tokenOf(entry),
        });
    }

    private isActiveEntry(entry: IBrowserDocumentEntry, doc?: DocumentDirectory | null, expectedInstance?: symbol) {
        return (
            !entry.closed &&
            this.entries.get(entry.ref) === entry &&
            (doc === undefined || entry.doc === doc) &&
            (expectedInstance === undefined || entry.instance === expectedInstance)
        );
    }

    private unwrapRevisionCheck<T extends {status: string}>(
        entry: IBrowserDocumentEntry,
        expected: TExpectedToken,
        result: T,
    ): Exclude<T, {status: 'missing-revision' | 'stale-revision'}> {
        if (result.status === 'missing-revision') {
            throw createMissingRevisionError({documentRef: entry.ref});
        }
        if (result.status === 'stale-revision') {
            this.throwStale(entry, expected);
        }
        return result as Exclude<T, {status: 'missing-revision' | 'stale-revision'}>;
    }

    private async mutate(
        entry: IBrowserDocumentEntry,
        token: TExpectedToken,
        mutation: TMutation,
        reason: TDocumentRevisionChangeReason,
        announce = true,
        options: Pick<IWriteOptions, 'strictRevisionToken' | 'expectedByteRevision' | 'expectedInstance'> = {},
    ) {
        const session = this.requireSession(entry);
        if (options.expectedInstance !== undefined && !this.isActiveEntry(entry, entry.doc, options.expectedInstance)) {
            this.throwStale(entry, token);
        }
        const outcome = await this.withReopen(
            session.mutate(token, mutation, {
                requireToken: entry.kind === 'working',
                strict: options.strictRevisionToken ?? false,
                openOnly: reason === 'open',
                expectedByteRevision: this.localByteRevision(entry, options.expectedByteRevision),
            }),
        );
        return this.settleOutcome(entry, token, outcome, reason, announce);
    }

    private commitEntry(entry: IBrowserDocumentEntry, size: number, prev?: TDocumentRevisionToken, reason?: TDocumentRevisionChangeReason) {
        entry.file = null;
        entry.fileSize = size;
        entry.updatedAt = Date.now();
        if (reason) {
            this.emitRevision(entry, prev, reason);
        }
    }

    private settleOutcome(
        entry: IBrowserDocumentEntry,
        token: TExpectedToken,
        outcome: TOpenMutationResult,
        reason: TDocumentRevisionChangeReason,
        announce = true,
    ) {
        const checked = this.unwrapRevisionCheck(entry, token, outcome);
        if (checked.status === 'conflict') {
            throw new BrowserDocumentSourceChangedError(entry.ref);
        }
        const prev = requireDocumentRevisionToken(checked.previousToken);
        this.commitEntry(entry, checked.revision.length, prev, announce ? reason : undefined);
        return this.revisionInfo(entry);
    }

    private emitRevision(
        entry: IBrowserDocumentEntry,
        previousToken: TDocumentRevisionToken | undefined,
        reason: TDocumentRevisionChangeReason,
    ) {
        const event = {...this.revisionInfo(entry), ...(previousToken ? {previousToken} : {}), reason};
        for (const listener of this.revisionListeners) {
            listener(event);
        }
    }
}

export const browserDocumentStore = new BrowserDocumentStore();
