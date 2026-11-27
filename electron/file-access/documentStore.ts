import {randomUUID} from 'node:crypto';
import {
    createReadStream,
    createWriteStream,
    statSync,
    type BigIntStats,
} from 'node:fs';
import {
    mkdir,
    open,
    rm,
    stat,
    truncate,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    extname,
    join,
    relative,
} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {collectDocuments} from '@document-store/collectDocuments';
import {
    createDocument,
    decodeManifest,
    DocumentDirectory,
    DOCUMENTS_DIR,
    forkDocument,
    type IDocumentStore,
    type IPublicationPort,
    type IRevision,
    MANIFEST_NAME,
    openDocument,
    STORE_ID_PATTERN,
    type TReplacement,
    type TStaleRevision,
} from '@document-store/documentDirectory';
import {
    copyNewFile,
    createNodeStorePort,
} from '@document-store/nodeStorePort';
import {
    createRevisionTokenCodec,
    OpenDocument,
} from '@document-store/openDocument';
import type {TSaveResult} from '@document-store/saveDocument';
import {
    createMissingRevisionError,
    createStaleRevisionError,
} from '@contracts/documentMutationErrors';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseDocumentRevisionToken,
    requireDocumentRevisionToken,
    type IDocumentRevisionChangedEvent,
    type IDocumentRevisionInfo,
    type TDocumentRevisionChangeReason,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {IPdfNativePageGeometry} from '@contracts/electronApiDocuments';
import {DocumentOpenRefusalError} from '@contracts/documentOpenErrors';
import {isErrnoException} from '@contracts/runtimeGuards';
import {createEpochMs} from '@contracts/timestamps';
import {createDesktopPublication} from '@electron/file-access/documentPublication';
import {normalizePathForLookup} from '@electron/file-access/normalizePathForLookup';
import type {TOpenPath} from '@electron/file-access/openPathCapabilities';
import {WorkingCopyMissingError} from '@electron/file-access/workingCopyMissingError';
import {
    drainWorkingCopyMutations,
    enqueueWorkingCopyMutation,
} from '@electron/file-access/workingCopyMutationQueue';
import {
    cancelMainOperationsForClosingWorkingCopy,
    snapshotCancellableWorkingCopyDependents,
    waitForMainOperationsSettled,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {
    isWorkingCopyQuarantined,
    quarantineWorkingCopy,
} from '@electron/file-access/workingCopyQuarantine';
import {
    getAppTempDirPath,
    PINNED_REVISIONS_DIR_NAME,
} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';

const log = createLogger('document-store');
const STORE_DIR = 'document-store';
/** The name a document's ref gives its bytes; nothing is stored under it. */
const REF_NAME = 'document';
const DESKTOP_REVISION_CODEC = createRevisionTokenCodec('numeric');

export class WorkingCopyMaterializationError extends Error {
    readonly code: 'SOURCE_BACKING_CHANGED' | 'SOURCE_BACKING_UNAVAILABLE';
    readonly retryable: boolean;

    constructor(code: WorkingCopyMaterializationError['code'], message: string, options: {cause?: unknown; retryable?: boolean} = {}) {
        super(message, options.cause === undefined ? undefined : {cause: options.cause});
        this.name = 'WorkingCopyMaterializationError';
        this.code = code;
        this.retryable = options.retryable ?? false;
    }
}

const sourceChangedError = () => new WorkingCopyMaterializationError(
    'SOURCE_BACKING_CHANGED',
    'The original document changed after it was opened',
);

const openedBytesNotKeptError = () => new WorkingCopyMaterializationError(
    'SOURCE_BACKING_UNAVAILABLE',
    'The document as it was opened could not be retained when it was saved, so it cannot be restored',
);

/**
 * One open document: a directory of the document store (its manifest, revision files and drafts) and the window
 * that owns it. Its `ref` is the path the renderer and the native tools name it by; nothing is stored there. The
 * bytes are the current revision file, or the destination while the document has none of its own.
 */
export interface IOpenDocument {
    readonly ref: string;
    readonly doc: DocumentDirectory;
    readonly session: OpenDocument;
    readonly registrationId: number;
    /** The file the document was opened from or last saved to; absent for one the app made. */
    originalPath?: string;
    ownerWebContentsId?: number;
    /**
     * The destination's identity when its witness was taken. Reads of a document that has no bytes of its own go
     * to the destination and require this to hold, so the person never sees bytes other than the baseline's.
     */
    admission?: BigIntStats;
    /** `snapshot` for a fork, such as a print copy: a lookup by the original file never finds it. */
    role: 'current' | 'snapshot';
    openingPageGeometry?: IPdfNativePageGeometry;
}

/** Every open document, by ref. The main process is the only owner of the store, so this is the registry. */
export const openDocuments = new Map<string, IOpenDocument>();
let nextRegistrationId = 1;
let storeRoot: string | null = null;
let store: IDocumentStore | null = null;
let collection: ReturnType<typeof collectDocuments> | null = null;
/** Names a document's directory in its window's workspace checkpoint; the checkpoint store provides it. */
let nameDirectory: (entry: IOpenDocument) => Promise<void> = () => Promise.resolve();
const revisionListeners = new Set<(event: IDocumentRevisionChangedEvent) => void>();

function getDocumentStoreRoot() {
    return storeRoot ?? join(getAppTempDirPath(), STORE_DIR);
}

/** Closes every document and points the store at another root, such as a test's temporary directory. */
export async function setDocumentStoreRootForTests(root: string | null) {
    await Promise.all([...openDocuments.values()].map(entry => entry.doc.close()));
    openDocuments.clear();
    await Promise.all([...pinnedRevisions.values()].map(endPin));
    storeRoot = root;
    store = null;
    collection = null;
}

/**
 * Sets how a document's directory is named in its window's workspace checkpoint. That happens before the document's
 * first edit, so a directory no checkpoint names holds at most what an open made, which collection may remove.
 */
export function setDocumentDirectoryNaming(name: (entry: IOpenDocument) => Promise<void>) {
    nameDirectory = name;
}

function absolute(storePath: string) {
    return join(getDocumentStoreRoot(), ...storePath.split('/'));
}

export function getDocumentStore(): IDocumentStore {
    store ??= {
        port: createNodeStorePort(getDocumentStoreRoot()),
        publication: createDesktopPublication(absolute),
    };
    return store;
}

function refFor(doc: DocumentDirectory) {
    return join(getDocumentStoreRoot(), DOCUMENTS_DIR, doc.id, `${REF_NAME}.${doc.snapshot().ext}`);
}

/** The directory id and entry name a path inside the store's documents names, or `null`. */
function parseStorePath(path: string) {
    const documents = normalizePathForLookup(join(getDocumentStoreRoot(), DOCUMENTS_DIR));
    const [id, name, ...rest] = relative(documents, normalizePathForLookup(path)).split(/[\\/]/u);
    return id && name && rest.length === 0 && STORE_ID_PATTERN.test(id) ? {id, name} : null;
}

function canUse(entry: IOpenDocument, senderId?: number) {
    return senderId === undefined || entry.ownerWebContentsId === undefined || entry.ownerWebContentsId === senderId;
}

function findByDirectory(id: string) {
    for (const entry of openDocuments.values()) {
        if (entry.doc.id === id) return entry;
    }
    return null;
}

/** The open document a ref, or a file inside its directory such as a staged revision, belongs to. */
export function getOpenDocument(path: string, senderId?: number) {
    const parsed = typeof path === 'string' ? parseStorePath(path) : null;
    const entry = parsed ? findByDirectory(parsed.id) : null;
    return entry && canUse(entry, senderId) ? entry : null;
}

export function requireOpenDocument(path: string, senderId?: number) {
    const entry = getOpenDocument(path, senderId);
    if (!entry) throw new WorkingCopyMissingError('Working copy path is not managed by this owner');
    return entry;
}

/** The open document `path` is the ref of; files inside its directory do not count. */
export function getWorkingCopyBackingEntry(path: string, senderId?: number) {
    const entry = getOpenDocument(path, senderId);
    return entry && parseStorePath(path)?.name === basename(entry.ref) ? entry : null;
}

/** Whether `path` names an open document or a file inside its directory that `senderId` may use. */
export function ensureWorkingCopyDirectory(path: string, senderId?: number) {
    return Promise.resolve(getOpenDocument(path, senderId) !== null);
}

export function requireManagedWorkingCopyPath(path: string, senderId?: number): Promise<TOpenPath> {
    const normalized = typeof path === 'string' ? path.trim() : '';
    if (!getWorkingCopyBackingEntry(normalized, senderId)) {
        return Promise.reject(new Error('Source path is not a managed working copy'));
    }
    return Promise.resolve(normalized as TOpenPath);
}

/** Whether `path` is a document's ref, the name native tools and search indexes key it by. */
export function isWorkingCopyDocumentPath(path: string) {
    return parseStorePath(path)?.name.startsWith(`${REF_NAME}.`) === true;
}

/** A rebuildable cache beside a document's revisions; recovery removes it with everything the manifest does not name. */
export function getWorkingCopyDerivedPath(ref: string, name: string) {
    return join(ref, '..', 'derived', name);
}

function register(doc: DocumentDirectory, options: Omit<IOpenDocument, 'ref' | 'doc' | 'session' | 'registrationId'>) {
    let entry!: IOpenDocument;
    const session = new OpenDocument(doc, {
        codec: DESKTOP_REVISION_CODEC,
        beforeEdit: () => nameDirectory(entry),
        beforeMutation: () => preservePinnedRevisions(entry),
    });
    entry = {
        ...options,
        ref: refFor(doc),
        doc,
        session,
        registrationId: nextRegistrationId++,
    };
    openDocuments.set(entry.ref, entry);
    return entry;
}

/** The store keeps a document's bytes under its file's extension, or `pdf` for a name without a usable one. */
export function extensionOf(path: string) {
    const ext = extname(path).slice(1).trim().toLowerCase();
    return /^[a-z0-9]{1,16}$/u.test(ext) ? ext : 'pdf';
}

const sameIdentity = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs;

/**
 * Opens the file at `destination` as a new document without copying it: its witness becomes the baseline and its
 * identity the admission reads require. `prepare` may give the document its first bytes before anyone reads it.
 */
export async function openDocumentFromFile(destination: string, options: {
    ownerWebContentsId?: number;
    originalPath?: string;
}) {
    await collected();
    let before: BigIntStats;
    try {
        before = await stat(destination, {bigint: true});
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            throw new DocumentOpenRefusalError('not-found', `File not found: ${destination}`, {
                cause: error,
                fileName: basename(destination),
            });
        }
        throw error;
    }
    const doc = await createDocument(getDocumentStore(), {destination, ext: extensionOf(destination)});
    const after = await stat(destination, {bigint: true}).catch(() => null);
    if (!after || !sameIdentity(before, after)) {
        await removeDirectory(doc);
        throw new DocumentOpenRefusalError('source-changed', 'The original document changed while it was being opened');
    }
    return register(doc, {
        originalPath: options.originalPath ?? destination,
        admission: after,
        role: 'current',
        ...(options.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: options.ownerWebContentsId}),
    });
}

/** A new document holding a copy of `source`, a file or bytes, with no destination: Save asks where. */
export async function createDocumentFromSource(source: string | Uint8Array, options: {
    ext: string;
    originalPath?: string;
    ownerWebContentsId?: number;
}) {
    await collected();
    return register(
        await createDocument(getDocumentStore(), {
            ext: options.ext,
            source: typeof source === 'string' ? source : new Blob([new Uint8Array(source)]),
        }),
        {
            role: 'current',
            ...(options.originalPath === undefined ? {} : {originalPath: options.originalPath}),
            ...(options.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: options.ownerWebContentsId}),
        },
    );
}

/** An independent copy of an open document, such as a view moved to another window (T4). */
export async function forkOpenDocument(entry: IOpenDocument, ownerWebContentsId?: number) {
    return register(
        await entry.doc.run(() => forkDocument(getDocumentStore(), entry.doc.id)),
        {
            role: 'snapshot',
            ...(entry.originalPath === undefined ? {} : {originalPath: entry.originalPath}),
            ...(entry.admission === undefined ? {} : {admission: entry.admission}),
            ...(ownerWebContentsId === undefined ? {} : {ownerWebContentsId}),
        },
    );
}

/** Reopens a document directory a checkpoint names, after a crash or a restart, through the store's recovery steps. */
export async function reopenStoredDocument(id: string, options: {ownerWebContentsId?: number; originalPath?: string}) {
    await collected();
    const existing = findByDirectory(id);
    if (existing) {
        if (options.ownerWebContentsId !== undefined) existing.ownerWebContentsId = options.ownerWebContentsId;
        return existing;
    }
    const doc = await openDocument(getDocumentStore(), id);
    const {destination} = doc.state();
    const originalPath = destination ?? options.originalPath;
    // A clean document without bytes of its own reads its destination again from here on.
    const admission = destination !== null && !doc.state().current
        ? await stat(destination, {bigint: true}).catch(() => undefined)
        : undefined;
    return register(doc, {
        role: 'current',
        ...(originalPath === undefined ? {} : {originalPath}),
        ...(options.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: options.ownerWebContentsId}),
        ...(admission === undefined ? {} : {admission}),
    });
}

// Revisions

export function documentRevisionToken(entry: IOpenDocument): TDocumentRevisionToken {
    // A document without bytes of its own and its first copy of the destination hold the same bytes: revision 1.
    return requireDocumentRevisionToken(entry.session.token());
}

export function getDocumentRevisionInfo(entry: IOpenDocument): IDocumentRevisionInfo {
    const token = documentRevisionToken(entry);
    return {
        version: 1,
        token,
        documentRef: requireDocumentRef(entry.ref),
        authority: 'electron-working-copy',
        contentRevision: entry.session.contentRevision(),
        mintedAt: createEpochMs(),
    };
}

function staleRevisionError(entry: IOpenDocument, expected: TDocumentRevisionToken | null, current: IRevision | null) {
    return createStaleRevisionError({
        documentRef: requireDocumentRef(entry.ref),
        expectedRevision: expected,
        actualRevision: requireDocumentRevisionToken(DESKTOP_REVISION_CODEC.format(entry.doc.id, current?.id ?? 1, current?.foreign)),
    });
}

export function onDocumentRevisionChanged(listener: (event: IDocumentRevisionChangedEvent) => void) {
    revisionListeners.add(listener);
    return () => {
        revisionListeners.delete(listener);
    };
}

function notifyRevisionChanged(entry: IOpenDocument, previousToken: TDocumentRevisionToken, reason: TDocumentRevisionChangeReason) {
    const event: IDocumentRevisionChangedEvent = {...getDocumentRevisionInfo(entry), previousToken, reason};
    if (event.token === previousToken) return event;
    for (const listener of revisionListeners) {
        try {
            listener(event);
        } catch (error) {
            log.debug(`Failed to notify a document revision listener: ${getErrorMessage(error)}`);
        }
    }
    return event;
}

export function normalizeExpectedDocumentRevisionToken(
    options?: {expectedDocumentRevisionToken?: TDocumentRevisionToken | null} | null,
): TDocumentRevisionToken | null {
    const token = options?.expectedDocumentRevisionToken;
    if (token === undefined || token === null) return null;
    const parsed = parseDocumentRevisionToken(token);
    if (parsed === null) throw new TypeError('expectedDocumentRevisionToken must be a non-empty string');
    return parsed;
}

/** Throws unless `token` names the current revision of the document `path` belongs to. */
export function assertWorkingCopyRevisionCurrent(path: string, token: TDocumentRevisionToken, senderId?: number) {
    const entry = requireOpenDocument(path, senderId);
    if (entry.session.checkRevision(token).status !== 'ok') throw staleRevisionError(entry, token, entry.doc.state().current);
    return Promise.resolve();
}

/** A mutation must name the revision it was planned on. */
export function assertQueuedWorkingCopyMutationPreconditions(path: string, token?: TDocumentRevisionToken | null) {
    const entry = requireOpenDocument(path);
    const check = entry.session.checkRevision(token, {requireToken: true});
    if (check.status === 'missing-revision') {
        return Promise.reject(createMissingRevisionError({documentRef: requireDocumentRef(entry.ref)}));
    }
    if (check.status === 'stale-revision') {
        return Promise.reject(staleRevisionError(entry, token ?? null, entry.doc.state().current));
    }
    return Promise.resolve();
}

export function getWorkingCopyRevision(path: string, senderId?: number) {
    return Promise.resolve(getDocumentRevisionInfo(requireOpenDocument(path, senderId)));
}

// Reads

async function assertAdmission(entry: IOpenDocument, destination: string) {
    const now = await stat(destination, {bigint: true}).catch((error: unknown) => {
        throw new WorkingCopyMaterializationError('SOURCE_BACKING_UNAVAILABLE', 'The original document is unavailable', {
            cause: error,
            retryable: true,
        });
    });
    if (!entry.admission || !sameIdentity(now, entry.admission)) throw sourceChangedError();
}

function revisionPath(entry: IOpenDocument, revision: IRevision) {
    return absolute(entry.doc.path(revision.file));
}

/** Reads the document's bytes: its current revision, or its destination while it has none of its own. */
export async function readOpenDocument(entry: IOpenDocument, offset: number, length: number) {
    const {current, destination} = entry.doc.state();
    if (current) return entry.doc.read(offset, length);
    if (destination === null) throw new WorkingCopyMissingError();
    await assertAdmission(entry, destination);
    const handle = await open(destination, 'r');
    let bytes: Uint8Array;
    try {
        const buffer = new Uint8Array(Math.max(0, Math.min(length, Number(entry.admission!.size) - offset)));
        const {bytesRead} = await handle.read(buffer, 0, buffer.byteLength, offset);
        bytes = buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
    await assertAdmission(entry, destination);
    return bytes;
}

/** Size and modification time of the document's bytes. Synchronous on purpose (ADR 0001). */
export function statOpenDocument(entry: IOpenDocument) {
    const {current, destination} = entry.doc.state();
    if (current) {
        return {
            size: current.length,
            modifiedAt: Math.trunc(statSync(revisionPath(entry, current)).mtimeMs),
        };
    }
    const now = destination === null ? null : statSync(destination, {bigint: true});
    if (!now || !entry.admission || !sameIdentity(now, entry.admission)) throw sourceChangedError();
    return {
        size: Number(now.size),
        modifiedAt: Math.trunc(Number(now.mtimeNs / 1_000_000n)),
    };
}

/** The file holding the document's current bytes, copying the destination in first when it has none. */
export async function requireDocumentFile(entry: IOpenDocument) {
    const current = await entry.doc.materialize();
    if (!current) throw sourceChangedError();
    return revisionPath(entry, current);
}

/**
 * The physical file behind a ref, copied in when the document has no bytes of its own, by the call shape native
 * readers use; `reason` names the reader in logs.
 */
export async function ensureWorkingCopyMaterialized(path: string, options: {
    ownerWebContentsId?: number | undefined;
    reason?: string;
    signal?: AbortSignal | undefined;
}) {
    options.signal?.throwIfAborted();
    return {physicalWorkingCopyPath: await requireDocumentFile(requireOpenDocument(path, options.ownerWebContentsId))};
}

/**
 * Runs a read of the bytes behind `ref` from a file: the current revision, or the destination while the document
 * has none of its own, checked unchanged before and after.
 */
export async function runWithWorkingCopyReadBacking<TResult>(
    ref: string,
    operation: (physicalReadPath: string, assertOriginalUnchanged: () => Promise<void>) => Promise<TResult>,
    options: {ownerWebContentsId?: number} = {},
) {
    if (isPinnedRevisionPath(ref)) return readPinnedRevision(ref, operation, options.ownerWebContentsId);
    const entry = getWorkingCopyBackingEntry(ref, options.ownerWebContentsId);
    if (!entry) throw new Error('Working copy path is not managed');
    const {current, destination} = entry.doc.state();
    if (current) return operation(revisionPath(entry, current), () => Promise.resolve());
    if (destination === null) throw new WorkingCopyMissingError();
    const assertUnchanged = () => assertAdmission(entry, destination);
    await assertUnchanged();
    const result = await operation(destination, assertUnchanged);
    await assertUnchanged();
    return result;
}

// Mutations

/** Removes what an interrupted native tool left at the next revision's path, in the directory's call order. */
function clearNextRevision(entry: IOpenDocument) {
    return entry.doc.run(() => rm(absolute(entry.doc.nextRevisionPath()), {force: true}));
}

function throwFailedMutation(entry: IOpenDocument, token: TDocumentRevisionToken | null, result: TStaleRevision | {status: 'conflict'}): never {
    if (result.status === 'stale-revision') throw staleRevisionError(entry, token, result.current);
    throw sourceChangedError();
}

/**
 * Commits `mutation` on top of revision `token` (`null`: whatever is current) and tells every window. Every
 * content mutation clears the drafts: the renderer binds them to a revision and sends them again for the new one.
 */
export async function commitDocumentMutation(
    entry: IOpenDocument,
    token: TDocumentRevisionToken | null,
    change: TReplacement,
    reason: TDocumentRevisionChangeReason,
) {
    const outcome = await entry.session.mutate(token, {...change, drafts: 'clear'}, {
        beforeRun: () => clearNextRevision(entry),
    });
    if (outcome.status === 'stale-revision') throw staleRevisionError(entry, token, entry.doc.state().current);
    if (outcome.status === 'conflict') throw sourceChangedError();
    if (outcome.status === 'missing-revision') throw createMissingRevisionError({documentRef: requireDocumentRef(entry.ref)});
    return notifyRevisionChanged(entry, requireDocumentRevisionToken(outcome.previousToken), reason);
}

/**
 * Runs `rewrite`, which reads the document's bytes at `input` (its current revision, or its destination while it has
 * none of its own) and writes a new file at `output`, then commits that file as the next revision. Nothing is copied
 * first: the tool's output is the revision, and the destination's bytes stay revision 1. A failure leaves the
 * document as it was. The rewrite an open makes (`reason` `open`) is not an edit: it leaves the directory unnamed.
 */
export async function rewriteDocument(
    entry: IOpenDocument,
    rewrite: (input: string, output: string) => Promise<void>,
    reason: TDocumentRevisionChangeReason,
) {
    if (reason !== 'open') await nameDirectory(entry);
    await preservePinnedRevisions(entry);
    const previous = documentRevisionToken(entry);
    // The tool reads its input to the end, where an append no one committed may still be.
    const current = await entry.doc.ownCurrentFile();
    const {destination} = entry.doc.state();
    const input = current ? revisionPath(entry, current) : destination;
    if (input === null) throw new WorkingCopyMissingError();
    const output = absolute(entry.doc.nextRevisionPath());
    const removeOutput = () => entry.doc.run(() => rm(output, {force: true}));
    await removeOutput();
    try {
        if (!current) await assertAdmission(entry, input);
        await rewrite(input, output);
        if (!(await stat(output).catch(() => null))?.size) throw new Error('The rewrite wrote no revision');
        const result = await entry.doc.mutate(entry.session.resolveExpectedId(previous), {
            kind: 'rewrite',
            source: () => Promise.resolve(),
            drafts: 'clear',
            ...(reason === 'open' ? {openOnly: true} : {}),
        });
        if (result.status !== 'committed') throwFailedMutation(entry, previous, result);
    } catch (error) {
        await removeOutput();
        throw error;
    }
    return notifyRevisionChanged(entry, previous, reason);
}

/**
 * The file a native tool appends an incremental update of the document to: its current revision file, copied in from
 * the destination first when it has none and holding exactly that revision's bytes. Commit what the tool appended
 * with an `extend`; `discardDocumentAppend` cuts it otherwise. Call it, the tool and the commit in the document's
 * mutation queue. With `asItIs`, for a Save, a destination another program changed is copied as it is now (see
 * `DocumentDirectory.ensureCurrent`); one that cannot be read refuses with that.
 */
export async function prepareDocumentAppend(entry: IOpenDocument, asItIs = false) {
    const revision = await entry.session.prepareInPlaceAppend(asItIs).catch((error: unknown) => {
        if (entry.doc.state().current !== null) throw error;
        throw new WorkingCopyMaterializationError('SOURCE_BACKING_UNAVAILABLE', `The original file cannot be read: ${getErrorMessage(error)}`, {cause: error, retryable: true});
    });
    if (!revision) throw sourceChangedError();
    return revisionPath(entry, revision);
}

/**
 * Ends an append that `error` stopped before its commit, so no reader of the document's file meets its bytes: they are
 * cut, or, when the tool may still be writing, the document moves to a copy of its file and leaves the tool that one.
 */
export function discardDocumentAppend(entry: IOpenDocument, error?: unknown) {
    return entry.session.discardInPlaceAppend(getUnprovenNativeTerminationDetail(error) !== undefined);
}

/**
 * Ends the receipt of an append a native tool made to `path`, the document's file, when it looked like `staged`: in the
 * document's queue, cuts what no commit claimed, unless the file has changed since (a later append owns its end).
 */
export function endDocumentAppend(entry: IOpenDocument, path: string, staged: BigIntStats) {
    return enqueueWorkingCopyMutation(entry.ref, async () => {
        const now = await stat(path, {bigint: true}).catch(() => null);
        if (now && now.size === staged.size && now.mtimeNs === staged.mtimeNs && now.ctimeNs === staged.ctimeNs) await discardDocumentAppend(entry);
    }, {kind: 'document-append-end'}).catch(() => undefined);
}

/**
 * Runs `append`, a native tool that appends an incremental update to the PDF at the path it is given (its input and
 * output are the same file, see `prepareDocumentAppend`), and commits it. A failure leaves the document as it was.
 */
export async function appendToDocument(
    entry: IOpenDocument,
    append: (input: string, output: string) => Promise<void>,
    reason: TDocumentRevisionChangeReason,
) {
    await nameDirectory(entry);
    const previous = documentRevisionToken(entry);
    const path = await prepareDocumentAppend(entry);
    try {
        await append(path, path);
        const result = await entry.doc.mutate(entry.session.resolveExpectedId(previous), {kind: 'extend', drafts: 'clear'});
        if (result.status !== 'committed') throwFailedMutation(entry, previous, result);
    } catch (error) {
        await discardDocumentAppend(entry, error);
        throw error;
    }
    return notifyRevisionChanged(entry, previous, reason);
}

/** Runs a native tool that edits a private clone of the document's bytes in place, and commits the result. */
export function rewriteOpenDocument(
    entry: IOpenDocument,
    rewrite: (stagedPath: string) => Promise<void>,
    reason: TDocumentRevisionChangeReason,
) {
    return rewriteDocument(entry, async (input, output) => {
        await copyNewFile(input, output);
        await rewrite(output);
    }, reason);
}

/**
 * Undo or redo: makes revision `token`, which the document's history keeps, current again on top of revision
 * `expected`. Back on revision 1 without a file, the document reads its destination again. Undoing an append that
 * extended the current file moves the redo revision to a copy (a clone where the volume can).
 */
export async function restoreOpenDocumentRevision(entry: IOpenDocument, token: TDocumentRevisionToken, expected: TDocumentRevisionToken | null) {
    const outcome = await entry.session.restore(expected, token, {ownCurrentFileAfterRestore: true});
    if (outcome.status === 'conflict') {
        if (outcome.sourceBackingUnavailable) throw openedBytesNotKeptError();
        throw sourceChangedError();
    }
    if (outcome.status === 'stale-revision') throw staleRevisionError(entry, expected, entry.doc.state().current);
    if (outcome.status === 'missing-revision') throw createMissingRevisionError({documentRef: requireDocumentRef(entry.ref)});
    if (!outcome.revision) entry.admission = await stat(entry.doc.state().destination!, {bigint: true});
    return notifyRevisionChanged(entry, requireDocumentRevisionToken(outcome.previousToken), 'write');
}

/** Keeps exactly the revisions `tokens` names for undo and redo; the files no revision names any more go. */
export function retainOpenDocumentRevisions(entry: IOpenDocument, tokens: readonly TDocumentRevisionToken[]) {
    return entry.session.retain(tokens);
}

/** Stores the unsaved state that is not in the bytes yet, for revision `token`. */
export async function setOpenDocumentDrafts(entry: IOpenDocument, token: string | null, drafts: unknown) {
    return (await entry.session.setDrafts(token, drafts)).status;
}

/**
 * Save: commit `commit` into the working bytes, check the destination, publish, acknowledge. With `saveAs` the
 * document's destination becomes that file. The result tells a conflict and a stale revision apart; nothing retries.
 * Every window learns of a committed revision whatever happens after the commit, since the edits are in it.
 */
export async function saveOpenDocument(entry: IOpenDocument, token: TDocumentRevisionToken | null, options: {
    commit?: TReplacement;
    saveAs?: string;
} = {}): Promise<TSaveResult> {
    const previous = documentRevisionToken(entry);
    try {
        const outcome = await entry.session.save(token, {
            ...(options.commit ? {commitReplacement: options.commit} : {}),
            ...(options.saveAs === undefined ? {} : {saveAs: options.saveAs}),
            beforeSave: () => clearNextRevision(entry),
        });
        if (outcome.status !== 'result') {
            return {status: 'stale-revision', current: entry.doc.state().current ?? null};
        }
        if (outcome.result.status === 'saved' && options.saveAs !== undefined) {
            entry.originalPath = options.saveAs;
            entry.role = 'current';
        }
        return outcome.result;
    } finally {
        notifyRevisionChanged(entry, previous, 'save-sync');
    }
}

// Pinned revisions

/** The bytes a pin names until it is copied: the destination as admitted, or the first `length` bytes of a revision file. */
type TPinBacking =
    | {readonly kind: 'destination'; readonly destination: string; readonly admission: BigIntStats}
    | {readonly kind: 'revision'; readonly file: string; readonly length: number};

interface IPinnedRevision {
    /** The path its reader is given once the bytes are copied there. */
    readonly ref: string;
    readonly entry: IOpenDocument;
    readonly ownerWebContentsId: number | undefined;
    readonly revisionToken: TDocumentRevisionToken;
    readonly backing: TPinBacking;
    /** `pinned` copies nothing; `materialized` holds the bytes at `ref`; `unavailable` could not keep them. */
    state: 'pinned' | 'materialized' | 'unavailable' | 'released';
    error?: unknown;
    materializing?: Promise<void>;
    readers: number;
}

/** Every pin, by its normalized ref. Pins live in memory only: the startup collection removes what an earlier run left. */
const pinnedRevisions = new Map<string, IPinnedRevision>();

/** Where pinned revisions are kept once copied: beside the store, in the folder no generic path check admits. */
function pinnedRevisionsDirectory() {
    return join(getDocumentStoreRoot(), '..', PINNED_REVISIONS_DIR_NAME);
}

function pinKey(ref: string) {
    return normalizePathForLookup(ref) || ref;
}

function isPinnedRevisionPath(path: string) {
    return typeof path === 'string' && pinKey(dirname(path)) === pinKey(pinnedRevisionsDirectory());
}

async function preparePinDirectory() {
    const directory = pinnedRevisionsDirectory();
    await mkdir(directory, {recursive: true});
    return directory;
}

/**
 * Pins revision `expectedRevisionToken` of the document `workingPath` names, for `senderId`, without copying it: an
 * immutable ref that a native reader can read later, such as the source of original text-box appearances. The bytes
 * are copied to the ref only before a change to the document could alter, cut or remove them. In the document's
 * mutation queue, so no mutation runs between the revision check and the pin's record.
 */
export async function pinOpenDocumentRevision(workingPath: string, expectedRevisionToken: TDocumentRevisionToken, senderId?: number) {
    const entry = requireOpenDocument(workingPath, senderId);
    return enqueueWorkingCopyMutation(entry.ref, async ({signal}) => {
        const assertCurrent = () => {
            // A window that ended while this waited released its pins then, so none is recorded for it now.
            signal.throwIfAborted();
            if (openDocuments.get(entry.ref) !== entry || !canUse(entry, senderId)) throw new WorkingCopyMissingError();
            const {current} = entry.doc.state();
            if (documentRevisionToken(entry) !== expectedRevisionToken) throw staleRevisionError(entry, expectedRevisionToken, current);
            // A Save that built on a PDF another program changed copied those bytes in as revision 1; they are not
            // the bytes the renderer parsed as revision 1.
            if (current?.foreign !== undefined) throw sourceChangedError();
        };
        assertCurrent();
        const directory = await preparePinDirectory();
        const {current, destination} = entry.doc.state();
        if (!current) {
            if (destination === null) throw new WorkingCopyMissingError();
            await assertAdmission(entry, destination);
        }
        // Synchronous from here: what is recorded is what was checked.
        assertCurrent();
        const state = entry.doc.state();
        let backing: TPinBacking;
        if (state.current) {
            backing = {kind: 'revision', file: revisionPath(entry, state.current), length: state.current.length};
        } else if (state.destination !== null && entry.admission) {
            backing = {kind: 'destination', destination: state.destination, admission: entry.admission};
        } else {
            throw sourceChangedError();
        }
        const ref = join(directory, `${randomUUID()}.${entry.doc.snapshot().ext}`);
        pinnedRevisions.set(pinKey(ref), {
            ref,
            entry,
            ownerWebContentsId: senderId,
            revisionToken: expectedRevisionToken,
            backing,
            state: 'pinned',
            readers: 0,
        });
        return requireDocumentRef(ref);
    }, {kind: 'document-revision-pin', ...(senderId === undefined ? {} : {ownerWebContentsId: senderId})});
}

/** Copies exactly `[0, length)` of `source` to the new file `target`: a clone when that is the whole file. */
async function copyRevisionPrefix(source: string, target: string, length: number) {
    const {size} = await stat(source);
    if (size < length) throw new WorkingCopyMaterializationError('SOURCE_BACKING_UNAVAILABLE', 'The pinned revision file was cut short');
    if (size === length) {
        await copyNewFile(source, target);
    } else {
        await pipeline(createReadStream(source, {start: 0, end: Math.max(0, length - 1)}), createWriteStream(target, {flags: 'wx'}));
    }
    // A native tool may have appended to the source during a clone: those bytes belong to a later revision.
    const copied = await stat(target);
    if (copied.size > length) await truncate(target, length);
    else if (copied.size < length) throw new WorkingCopyMaterializationError('SOURCE_BACKING_UNAVAILABLE', 'The pinned revision could not be copied whole');
}

/**
 * Copies the file `source` names to the new file `target` through one open handle that holds `admission` before and
 * after the copy: whatever `source` names meanwhile, the bytes come from the file that was admitted.
 */
async function copyAdmittedFile(source: string, admission: BigIntStats, target: string) {
    const handle = await open(source, 'r').catch((error: unknown) => {
        throw new WorkingCopyMaterializationError('SOURCE_BACKING_UNAVAILABLE', 'The original document is unavailable', {
            cause: error,
            retryable: true,
        });
    });
    try {
        const assertAdmitted = async () => {
            if (!sameIdentity(await handle.stat({bigint: true}), admission)) throw sourceChangedError();
        };
        await assertAdmitted();
        await pipeline(handle.createReadStream({start: 0, autoClose: false}), createWriteStream(target, {flags: 'wx'}));
        await assertAdmitted();
    } finally {
        await handle.close();
    }
    if (BigInt((await stat(target)).size) !== admission.size) throw sourceChangedError();
}

/**
 * Copies a pin's bytes to its ref. A destination is copied from the file it was admitted as; one another program
 * changed, or a copy that fails, leaves the pin unavailable rather than blocking the change that asked for the copy.
 */
function materializePin(pin: IPinnedRevision) {
    pin.materializing ??= (async () => {
        try {
            const {backing} = pin;
            if (backing.kind === 'destination') {
                await copyAdmittedFile(backing.destination, backing.admission, pin.ref);
            } else {
                await copyRevisionPrefix(backing.file, pin.ref, backing.length);
            }
            if (pin.state === 'pinned') pin.state = 'materialized';
        } catch (error) {
            await rm(pin.ref, {force: true}).catch(() => undefined);
            if (pin.state === 'pinned') {
                pin.state = 'unavailable';
                pin.error = error;
            }
            log.warn(`A pinned document revision could not be kept: ${getErrorMessage(error)}`, {ref: pin.entry.ref, revision: pin.revisionToken});
        }
    })();
    return pin.materializing;
}

/** Copies out every pin of `entry` that still names the document's own bytes, before a change can alter them. */
async function preservePinnedRevisions(entry: IOpenDocument) {
    await Promise.all([...pinnedRevisions.values()].filter(pin => pin.entry === entry && pin.state === 'pinned').map(materializePin));
}

function requirePinnedRevision(ref: string, senderId: number | undefined) {
    const pin = pinnedRevisions.get(pinKey(ref));
    if (!pin) throw new WorkingCopyMissingError('Pinned document revision is missing or was released');
    if (senderId !== undefined && pin.ownerWebContentsId !== senderId) {
        throw new WorkingCopyMissingError('Pinned document revision is not managed by this owner');
    }
    return pin;
}

function unavailablePinError(pin: IPinnedRevision) {
    return new WorkingCopyMaterializationError(
        'SOURCE_BACKING_UNAVAILABLE',
        'The document as it was opened is no longer available',
        {cause: pin.error},
    );
}

/** Read again after an await: a release can end the pin while its reader runs. */
const isReleased = (pin: IPinnedRevision) => pin.state === 'released';

/** Reads a pin from its own copy, never from the file a native tool may be appending to. */
async function readPinnedRevision<TResult>(
    ref: string,
    operation: (physicalReadPath: string, assertOriginalUnchanged: () => Promise<void>) => Promise<TResult>,
    senderId: number | undefined,
) {
    const pin = requirePinnedRevision(ref, senderId);
    await materializePin(pin);
    if (pin.state === 'released') throw new WorkingCopyMissingError('Pinned document revision is missing or was released');
    if (pin.state !== 'materialized') throw unavailablePinError(pin);
    pin.readers += 1;
    try {
        return await operation(pin.ref, () => Promise.resolve());
    } catch (error) {
        // Before the copy can go below: a reader that did not provably stop may still hold it.
        const unprovenTermination = getUnprovenNativeTerminationDetail(error);
        if (unprovenTermination !== undefined) quarantineWorkingCopy(pin.ref, unprovenTermination);
        throw error;
    } finally {
        pin.readers -= 1;
        if (isReleased(pin) && pin.readers === 0) await removePinFile(pin);
    }
}

async function removePinFile(pin: IPinnedRevision) {
    await pin.materializing;
    // A native reader that did not provably stop may still hold the copy; the next start removes it.
    if (!isWorkingCopyQuarantined(pin.ref)) await rm(pin.ref, {force: true}).catch(() => undefined);
}

function endPin(pin: IPinnedRevision) {
    if (pinnedRevisions.get(pinKey(pin.ref)) === pin) pinnedRevisions.delete(pinKey(pin.ref));
    pin.state = 'released';
    return pin.readers === 0 ? removePinFile(pin) : Promise.resolve();
}

async function endPins(matches: (pin: IPinnedRevision) => boolean) {
    await Promise.all([...pinnedRevisions.values()].filter(matches).map(endPin));
}

/** Ends a pin `senderId` made; `false` for a pin that is gone or another window's. */
export async function releasePinnedDocumentRevision(ref: string, senderId?: number) {
    const pin = typeof ref === 'string' ? pinnedRevisions.get(pinKey(ref)) : undefined;
    if (!pin || (senderId !== undefined && pin.ownerWebContentsId !== senderId)) return false;
    await endPin(pin);
    return true;
}

/** Ends every pin of a window that is gone. */
export function releasePinnedDocumentRevisionsForSender(senderId: number) {
    return endPins(pin => pin.ownerWebContentsId === senderId);
}

/** What a test can observe of a pin without reading its bytes. */
export function getPinnedRevisionStateForTests(ref: string) {
    return pinnedRevisions.get(pinKey(ref))?.state ?? null;
}

// Ownership and lifetime

async function removeDirectory(doc: DocumentDirectory) {
    await doc.close().catch(() => undefined);
    await getDocumentStore().port.remove(`${DOCUMENTS_DIR}/${doc.id}`);
}

/**
 * Ends a document: the person closed it or discarded it, or a fork such as a print copy is done. A document a
 * native reader may still hold is quarantined: it closes, and only its manifest goes, so the next start collects
 * the rest as an aborted creation rather than offering its work again.
 */
export async function discardOpenDocument(entry: IOpenDocument) {
    if (openDocuments.get(entry.ref) !== entry) return false;
    openDocuments.delete(entry.ref);
    await endPins(pin => pin.entry === entry);
    const current = entry.doc.state().current;
    if (isWorkingCopyQuarantined(entry.ref) || (current && isWorkingCopyQuarantined(revisionPath(entry, current)))) {
        await entry.doc.close();
        await getDocumentStore().port.remove(entry.doc.path(MANIFEST_NAME));
        return true;
    }
    await removeDirectory(entry.doc);
    return true;
}

const CLOSING_REASON = 'Working copy is closing';
const DEPENDENT_SETTLEMENT_TIMEOUT_MS = 30_000;
const MAX_DEPENDENT_CANCELLATION_ROUNDS = 4;

/**
 * Stops the operations that read a closing document and waits for them, a few rounds, since one can start while
 * another stops. `false` when one would not stop or the document was replaced meanwhile.
 */
async function stopDependents(entry: IOpenDocument) {
    const ownership = {isRegistrationCurrent: () => openDocuments.get(entry.ref) === entry};
    for (let round = 0; round < MAX_DEPENDENT_CANCELLATION_ROUNDS; round += 1) {
        const canceled = cancelMainOperationsForClosingWorkingCopy(entry.ref, CLOSING_REASON, ownership);
        if (canceled === null) return false;
        if (canceled.length === 0) return true;
        if (!(await waitForMainOperationsSettled(canceled, {timeoutMs: DEPENDENT_SETTLEMENT_TIMEOUT_MS})).settled) return false;
    }
    return snapshotCancellableWorkingCopyDependents(entry.ref).length === 0;
}

/**
 * Closes the document `ref` names for `senderId`: its queued changes finish, the operations reading it stop, then
 * its directory goes. A document whose readers would not stop keeps its files for the next start to collect.
 */
export async function cleanupWorkingCopy(ref: string, senderId?: number) {
    const entry = getWorkingCopyBackingEntry(ref, senderId);
    if (!entry) return false;
    await drainWorkingCopyMutations(entry.ref);
    if (!await stopDependents(entry)) {
        log.warn('Retained a closing document whose readers did not stop', {ref: entry.ref});
        return false;
    }
    await drainWorkingCopyMutations(entry.ref);
    return discardOpenDocument(entry);
}

/** Closes every document at a normal quit: those in `keep` stay in the store for the next start, the rest go. */
export async function clearAllWorkingCopies(options: {skipPaths?: ReadonlySet<string>} = {}) {
    await endPins(() => true);
    await Promise.allSettled([...openDocuments.values()].map(async (entry) => {
        if (options.skipPaths?.has(entry.ref)) {
            openDocuments.delete(entry.ref);
            await entry.doc.close();
        } else {
            await discardOpenDocument(entry);
        }
    }));
}

/**
 * At quit: lets every queued store operation finish, so no commit is cut short, then closes each document's file.
 * Directories and checkpoints stay; the quit's later steps or the next start decide what to keep.
 */
export async function settleOpenDocuments() {
    await Promise.allSettled([...openDocuments.values()].map(entry => entry.doc.close()));
}

/**
 * The startup collection, run once before the store opens anything, so no document changes owner while it runs:
 * settles saves a crash interrupted, then removes the directories nothing needs (see `collectDocuments`). Unsaved
 * work is never removed: the unsaved directories no window holds are the next workspace claim's to offer.
 */
function collected() {
    collection ??= (async () => {
        // No pin outlives its run, so every copy there is one a crash or a reader that would not stop left.
        await rm(pinnedRevisionsDirectory(), {recursive: true, force: true})
            .catch((error: unknown) => log.warn(`Kept pinned revisions an earlier run left: ${getErrorMessage(error)}`));
        const docStore = getDocumentStore();
        for (const id of await docStore.port.list(DOCUMENTS_DIR)) {
            if (!STORE_ID_PATTERN.test(id)) continue;
            // A manifest that cannot be read is the collection's to report.
            const manifest = await docStore.port.read(`${DOCUMENTS_DIR}/${id}/${MANIFEST_NAME}`).then(decodeManifest).catch(() => null);
            if (!manifest?.pendingPublish && !manifest?.unsettled) continue;
            const kept = (error: unknown) => log.warn(`Document ${DOCUMENTS_DIR}/${id} kept an interrupted save for later: ${getErrorMessage(error)}`);
            // Opening keeps a save it cannot settle recorded without failing; the reason is told here. Desktop
            // publication always settles.
            const {publication} = docStore;
            const settling: IPublicationPort = {...publication, settle: async (record, baseline) => {
                try {
                    return await publication.settle!(record, baseline);
                } catch (error) {
                    kept(error);
                    throw error;
                }
            }};
            await openDocument({...docStore, publication: settling}, id).then(doc => doc.close()).catch(kept);
        }
        // Nothing is open yet, so every directory is the collection's to decide.
        const result = await collectDocuments(docStore, () => Promise.resolve(() => undefined));
        for (const {path, error} of result.unreadable) log.warn(`Kept recovery data that cannot be read: ${path}: ${getErrorMessage(error)}`);
        return result;
    })().catch((error: unknown) => {
        log.warn(`Document collection stopped: ${getErrorMessage(error)}`);
        return {removed: [], unsaved: [], held: [], unreadable: []};
    });
    return collection;
}

/** Runs the startup collection, if no open has yet, and returns how many directories it removed. */
export async function collectStaleDocuments() {
    return (await collected()).removed.length;
}

/**
 * The unsaved directories the startup collection kept that no window holds now, and those whose manifest it could
 * not read, for the recovery offer.
 */
export async function unheldUnsavedDocuments() {
    const {unsaved, unreadable} = await collected();
    return [...unsaved, ...unreadable.flatMap(entry => entry.directory ?? [])].filter(id => findByDirectory(id) === null);
}

// Lookups by the file a document was opened from

/** The document `ref` names, with the file it was opened from or saved to. */
export function getWorkingCopyOriginalPath(ref: string, senderId?: number) {
    const entry = getWorkingCopyBackingEntry(ref, senderId);
    return entry?.originalPath === undefined ? null : {originalPath: entry.originalPath};
}

/** The newest current document opened from `originalPath` that `senderId` may use. */
export function findWorkingCopyPathByOriginalPath(originalPath: string, senderId?: number): TDocumentRef | null {
    const key = normalizePathForLookup(originalPath);
    let found: IOpenDocument | null = null;
    for (const entry of openDocuments.values()) {
        if (entry.role === 'current' && entry.originalPath !== undefined && canUse(entry, senderId)
            && normalizePathForLookup(entry.originalPath) === key
            && (found === null || entry.registrationId > found.registrationId)) found = entry;
    }
    return found ? requireDocumentRef(found.ref) : null;
}

export function isWorkingCopyOriginalPathRegistered(originalPath: string) {
    return findWorkingCopyPathByOriginalPath(originalPath) !== null;
}

export function getWorkingCopyOwnerWebContentsId(ref: string) {
    return getWorkingCopyBackingEntry(ref)?.ownerWebContentsId;
}

/**
 * The size and modification time of the file version the document last read from or saved to, named by the metadata
 * fact of its baseline witness: what a remembered reading view is bound to. `null` for a document without one.
 */
export function getBaselineFileVersion(ref: string, senderId?: number) {
    const fact = /(?:^| )file-v2:(\d+):(\d+):/u.exec(getWorkingCopyBackingEntry(ref, senderId)?.doc.state().baseline ?? '');
    return fact ? {size: BigInt(fact[1]!), mtimeNs: BigInt(fact[2]!)} : null;
}

/** The revision of the open document whose directory holds `path`, such as a native tool's staged output. */
export function readWorkingCopyRevision(path: string) {
    const entry = getOpenDocument(path);
    return entry ? {token: documentRevisionToken(entry)} : null;
}

/** A tab move hands the document to `targetOwner` at once; the returned registration id ends the move. */
export function grantWorkingCopyTransferAccess(ref: string, sourceOwner: number, targetOwner: number): number | false {
    const entry = getWorkingCopyBackingEntry(ref);
    if (!entry || entry.ownerWebContentsId !== sourceOwner) return false;
    entry.ownerWebContentsId = targetOwner;
    return entry.registrationId;
}

export function commitWorkingCopyTransferAccess(ref: string, sourceOwner: number, targetOwner: number, registrationId: number) {
    const entry = getWorkingCopyBackingEntry(ref);
    return entry?.registrationId === registrationId && entry.ownerWebContentsId === targetOwner && sourceOwner !== targetOwner;
}

/** A move that did not finish gives the document back to the window it came from. */
export function revokeWorkingCopyTransferAccess(ref: string, sourceOwner: number, targetOwner: number, registrationId: number) {
    const entry = getWorkingCopyBackingEntry(ref);
    if (entry?.registrationId === registrationId && entry.ownerWebContentsId === targetOwner) {
        entry.ownerWebContentsId = sourceOwner;
    }
}
