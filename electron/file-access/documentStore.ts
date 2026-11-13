import {
    constants,
    statSync,
    type BigIntStats,
} from 'node:fs';
import {
    copyFile,
    open,
    rm,
    stat,
} from 'node:fs/promises';
import {
    basename,
    extname,
    join,
    relative,
} from 'node:path';
import {collectDocuments} from '@document-store/collectDocuments';
import {sameWitness} from '@document-store/contentWitness';
import {
    createDocument,
    decodeManifest,
    DocumentDirectory,
    DOCUMENTS_DIR,
    forkDocument,
    type IDocumentStore,
    type IRevision,
    MANIFEST_NAME,
    openDocument,
    STORE_ID_PATTERN,
    type TMutation,
    type TMutationResult,
} from '@document-store/documentDirectory';
import {createNodeStorePort} from '@document-store/nodeStorePort';
import {
    saveDocument,
    type TSaveResult,
} from '@document-store/saveDocument';
import {readWorkspaceCheckpoints} from '@document-store/workspaceCheckpoint';
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
import type {
    IPdfNativePageGeometry,
    TWorkingCopyBackingFailureCode,
} from '@contracts/electronApiDocuments';
import {DocumentOpenRefusalError} from '@contracts/documentOpenErrors';
import {createEpochMs} from '@contracts/timestamps';
import {
    createDesktopPublication,
    recoverInterruptedPublish,
} from '@electron/file-access/documentPublication';
import {normalizePathForLookup} from '@electron/file-access/normalizePathForLookup';
import type {TOpenPath} from '@electron/file-access/openPathCapabilities';
import {WorkingCopyMissingError} from '@electron/file-access/workingCopyMissingError';
import {drainWorkingCopyMutations} from '@electron/file-access/workingCopyMutationQueue';
import {
    cancelMainOperationsForClosingWorkingCopy,
    snapshotCancellableWorkingCopyDependents,
    waitForMainOperationsSettled,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {isWorkingCopyQuarantined} from '@electron/file-access/workingCopyQuarantine';
import {getAppTempDirPath} from '@electron/utils/appTempDir';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';

const log = createLogger('document-store');
const STORE_DIR = 'document-store';
/** The name a document's ref gives its bytes; nothing is stored under it. */
const REF_NAME = 'document';

export class WorkingCopyMaterializationError extends Error {
    readonly code: TWorkingCopyBackingFailureCode;
    readonly retryable: boolean;

    constructor(code: TWorkingCopyBackingFailureCode, message: string, options: {cause?: unknown; retryable?: boolean} = {}) {
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

/**
 * One open document: a directory of the document store (its manifest, revision files and drafts) and the window
 * that owns it. Its `ref` is the path the renderer and the native tools name it by; nothing is stored there. The
 * bytes are the current revision file, or the destination while the document has none of its own.
 */
export interface IOpenDocument {
    readonly ref: string;
    readonly doc: DocumentDirectory;
    readonly registrationId: number;
    /** The file the document was opened from or last saved to; absent for one the app made. */
    originalPath?: string;
    ownerWebContentsId?: number;
    /**
     * The destination's identity when its witness was taken. Reads of a document that has no bytes of its own go
     * to the destination and require this to hold, so the person never sees bytes other than the baseline's.
     */
    admission?: BigIntStats;
    /** `snapshot` for a copy such as an undo point: a lookup by the original file never finds it. */
    role: 'current' | 'snapshot';
    openingPageGeometry?: IPdfNativePageGeometry;
}

/** Every open document, by ref. The main process is the only owner of the store, so this is the registry. */
export const openDocuments = new Map<string, IOpenDocument>();
let nextRegistrationId = 1;
/** Creations whose directory may not have a manifest yet; collection leaves such directories alone meanwhile. */
let creationsInFlight = 0;
let storeRoot: string | null = null;
let store: IDocumentStore | null = null;
const revisionListeners = new Set<(event: IDocumentRevisionChangedEvent) => void>();

function getDocumentStoreRoot() {
    return storeRoot ?? join(getAppTempDirPath(), STORE_DIR);
}

/** Closes every document and points the store at another root, such as a test's temporary directory. */
export async function setDocumentStoreRootForTests(root: string | null) {
    await Promise.all([...openDocuments.values()].map(entry => entry.doc.close()));
    openDocuments.clear();
    storeRoot = root;
    store = null;
}

function absolute(storePath: string) {
    return join(getDocumentStoreRoot(), ...storePath.split('/'));
}

export function getDocumentStore(): IDocumentStore {
    store ??= {
        port: createNodeStorePort(getDocumentStoreRoot()),
        publication: createDesktopPublication(absolute),
        // Undo is the renderer's: a revision that is no longer current has no reader.
        historyBudget: 0,
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

function register(doc: DocumentDirectory, options: Omit<IOpenDocument, 'ref' | 'doc' | 'registrationId'>) {
    const entry: IOpenDocument = {
        ...options,
        ref: refFor(doc),
        doc,
        registrationId: nextRegistrationId++,
    };
    openDocuments.set(entry.ref, entry);
    return entry;
}

async function trackCreation<T>(create: () => Promise<T>) {
    creationsInFlight += 1;
    try {
        return await create();
    } finally {
        creationsInFlight -= 1;
    }
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
    return trackCreation(async () => {
        const before = await stat(destination, {bigint: true});
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
    });
}

/** A new document holding a copy of `source`, a file or bytes, with no destination: Save asks where. */
export async function createDocumentFromSource(source: string | Uint8Array, options: {
    ext: string;
    originalPath?: string;
    ownerWebContentsId?: number;
}) {
    return trackCreation(async () => register(
        await createDocument(getDocumentStore(), {
            ext: options.ext,
            source: typeof source === 'string' ? source : new Blob([new Uint8Array(source)]),
        }),
        {
            role: 'current',
            ...(options.originalPath === undefined ? {} : {originalPath: options.originalPath}),
            ...(options.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: options.ownerWebContentsId}),
        },
    ));
}

/** An independent copy of an open document: an undo snapshot, or a view moved to another window (T4). */
export async function forkOpenDocument(entry: IOpenDocument, ownerWebContentsId?: number) {
    return trackCreation(async () => register(
        await entry.doc.run(() => forkDocument(getDocumentStore(), entry.doc.id)),
        {
            role: 'snapshot',
            ...(entry.originalPath === undefined ? {} : {originalPath: entry.originalPath}),
            ...(entry.admission === undefined ? {} : {admission: entry.admission}),
            ...(ownerWebContentsId === undefined ? {} : {ownerWebContentsId}),
        },
    ));
}

/**
 * Reopens a document directory a checkpoint names, after a crash or a restart: an interrupted publish is settled
 * first, then the store's recovery steps run.
 */
export async function reopenStoredDocument(id: string, options: {ownerWebContentsId?: number; originalPath?: string}) {
    const existing = findByDirectory(id);
    if (existing) {
        if (options.ownerWebContentsId !== undefined) existing.ownerWebContentsId = options.ownerWebContentsId;
        return existing;
    }
    await settleInterruptedPublish(id);
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

async function settleInterruptedPublish(id: string) {
    const manifest = decodeManifest(await getDocumentStore().port.read(`${DOCUMENTS_DIR}/${id}/${MANIFEST_NAME}`));
    if (manifest.pendingPublish) {
        await recoverInterruptedPublish(manifest.pendingPublish.destination, manifest.baseline ?? null, manifest.pendingPublish.witness);
    }
}

// Revisions

export function documentRevisionToken(entry: IOpenDocument): TDocumentRevisionToken {
    // A document without bytes of its own and its first copy of the destination hold the same bytes: revision 1.
    return requireDocumentRevisionToken(String(entry.doc.state().current?.id ?? 1));
}

export function getDocumentRevisionInfo(entry: IOpenDocument): IDocumentRevisionInfo {
    const token = documentRevisionToken(entry);
    return {
        version: 1,
        token,
        documentRef: requireDocumentRef(entry.ref),
        authority: 'electron-working-copy',
        contentRevision: Number(token),
        mintedAt: createEpochMs(),
    };
}

/** The store's revision id for a renderer's token: `null` names a document without bytes of its own. */
function expectedRevisionId(entry: IOpenDocument, token: string | null) {
    const current = entry.doc.state().current;
    if (token === null) return current?.id ?? null;
    const id = /^\d+$/u.test(token) ? Number(token) : -1;
    return current === null && id === 1 ? null : id;
}

function staleRevisionError(entry: IOpenDocument, expected: TDocumentRevisionToken | null, current: IRevision | null) {
    return createStaleRevisionError({
        documentRef: requireDocumentRef(entry.ref),
        expectedRevision: expected,
        actualRevision: requireDocumentRevisionToken(String(current?.id ?? 1)),
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
    if (documentRevisionToken(entry) !== token) throw staleRevisionError(entry, token, entry.doc.state().current);
    return Promise.resolve();
}

/** A mutation must name the revision it was planned on. */
export function assertQueuedWorkingCopyMutationPreconditions(path: string, token?: TDocumentRevisionToken | null) {
    if (token === undefined || token === null) {
        return Promise.reject(createMissingRevisionError({documentRef: requireDocumentRef(requireOpenDocument(path).ref)}));
    }
    return assertWorkingCopyRevisionCurrent(path, token);
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

function throwFailedMutation(entry: IOpenDocument, token: TDocumentRevisionToken | null, result: Exclude<Awaited<ReturnType<DocumentDirectory['mutate']>>, {status: 'committed'}>): never {
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
    change: Omit<Extract<TMutation, {kind: 'rewrite'}>, 'drafts'>,
    reason: TDocumentRevisionChangeReason,
) {
    const previous = documentRevisionToken(entry);
    await clearNextRevision(entry);
    const result = await entry.doc.mutate(expectedRevisionId(entry, token), {...change, drafts: 'clear'});
    if (result.status !== 'committed') throwFailedMutation(entry, token, result);
    return notifyRevisionChanged(entry, previous, reason);
}

/**
 * Runs `rewrite`, which reads the document's bytes at `input` (its current revision, or its destination while it has
 * none of its own) and writes a new file at `output`, then commits that file as the next revision. Nothing is copied
 * first: the tool's output is the revision. Revision 1 names the destination's bytes, so the first revision of a
 * document without bytes of its own is revision 2. A failure leaves the document as it was.
 */
export async function rewriteDocument(
    entry: IOpenDocument,
    rewrite: (input: string, output: string) => Promise<void>,
    reason: TDocumentRevisionChangeReason,
) {
    const previous = documentRevisionToken(entry);
    const {current, destination} = entry.doc.state();
    const input = current ? revisionPath(entry, current) : destination;
    if (input === null) throw new WorkingCopyMissingError();
    const {next, ext} = entry.doc.snapshot();
    const name = `r${current ? next : next + 1}.${ext}`;
    const output = absolute(entry.doc.path(name));
    const removeOutput = () => entry.doc.run(() => rm(output, {force: true}));
    await removeOutput();
    try {
        if (!current) await assertAdmission(entry, input);
        await rewrite(input, output);
        if (!(await stat(output).catch(() => null))?.size) throw new Error('The rewrite wrote no revision');
        const result = await entry.doc.run(async (): Promise<TMutationResult> => {
            const stale = entry.doc.staleRevision(expectedRevisionId(entry, previous));
            if (stale) return stale;
            const manifest = entry.doc.snapshot();
            // A first copy of the destination made meanwhile is revision 1, and `name` is its next revision.
            if (manifest.current) {
                return entry.doc.applyMutation(manifest.current.id, {kind: 'rewrite', source: () => Promise.resolve(), drafts: 'clear'});
            }
            await assertAdmission(entry, input);
            const file = await getDocumentStore().port.open(entry.doc.path(name));
            const revision = {id: next + 1, file: name, length: await file.size()};
            await file.flush();
            await entry.doc.commit({...manifest, next: revision.id + 1, current: revision, drafts: undefined}, file);
            return {status: 'committed', revision};
        });
        if (result.status !== 'committed') throwFailedMutation(entry, previous, result);
    } catch (error) {
        await removeOutput();
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
        await copyFile(input, output, constants.COPYFILE_FICLONE);
        await rewrite(output);
    }, reason);
}

/** Stores the unsaved state that is not in the bytes yet, for revision `token`. */
export async function setOpenDocumentDrafts(entry: IOpenDocument, token: string | null, drafts: unknown) {
    const result = await entry.doc.setDrafts(expectedRevisionId(entry, token), drafts);
    return result.status;
}

/**
 * Save: commit `commit` into the working bytes, check the destination, publish, acknowledge. With `saveAs` the
 * document's destination becomes that file. The result tells a conflict and a stale revision apart; nothing retries.
 */
export async function saveOpenDocument(entry: IOpenDocument, token: TDocumentRevisionToken | null, options: {
    commit?: Omit<Extract<TMutation, {kind: 'rewrite'}>, 'drafts'>;
    saveAs?: string;
} = {}): Promise<TSaveResult> {
    const previous = documentRevisionToken(entry);
    const {destination, baseline} = entry.doc.state();
    // The renderer keeps the edits it asked to save as pending until a Save succeeds, so a Save the check will
    // refuse must not commit them. Under the replace the check runs again.
    if (options.commit && options.saveAs === undefined && destination !== null && baseline !== null
        && !sameWitness(await getDocumentStore().publication.witness(destination), baseline)) {
        return {status: 'conflict'};
    }
    await clearNextRevision(entry);
    const result = await saveDocument(entry.doc, {
        expected: expectedRevisionId(entry, token),
        ...(options.commit ? {commit: {...options.commit, drafts: 'clear'}} : {}),
        ...(options.saveAs === undefined ? {} : {saveAs: options.saveAs}),
    });
    if (result.status === 'saved') {
        if (options.saveAs !== undefined) {
            entry.originalPath = options.saveAs;
            entry.role = 'current';
        }
        notifyRevisionChanged(entry, previous, 'save-sync');
    }
    return result;
}

// Ownership and lifetime

async function removeDirectory(doc: DocumentDirectory) {
    await doc.close().catch(() => undefined);
    await getDocumentStore().port.remove(`${DOCUMENTS_DIR}/${doc.id}`);
}

/**
 * Ends a document: the person closed it, discarded it, or it was an undo snapshot no longer needed. A document a
 * native reader may still hold is quarantined: it closes, and its files stay for the next start to collect.
 */
export async function discardOpenDocument(entry: IOpenDocument) {
    if (openDocuments.get(entry.ref) !== entry) return false;
    openDocuments.delete(entry.ref);
    const current = entry.doc.state().current;
    if (isWorkingCopyQuarantined(entry.ref) || (current && isWorkingCopyQuarantined(revisionPath(entry, current)))) {
        await entry.doc.close();
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
    await Promise.allSettled([...openDocuments.values()].map(async (entry) => {
        if (options.skipPaths?.has(entry.ref)) {
            openDocuments.delete(entry.ref);
            await entry.doc.close();
        } else {
            await discardOpenDocument(entry);
        }
    }));
}

/** Waits for every queued store operation, so a quit never cuts a commit short. */
export async function settleOpenDocuments() {
    await Promise.allSettled([...openDocuments.values()].map(entry => entry.doc.run(() => Promise.resolve())));
}

/**
 * The startup collection: settles saves a crash interrupted, then removes every document directory that no window
 * holds and no workspace checkpoint names. Unsaved work survives through the checkpoint that names it; an
 * unreadable checkpoint or manifest keeps everything it might protect.
 */
export async function collectStaleDocuments() {
    const docStore = getDocumentStore();
    const isHeld = (id: string) => Promise.resolve(creationsInFlight > 0 || findByDirectory(id) !== null);
    for (const id of await docStore.port.list(DOCUMENTS_DIR)) {
        if (!STORE_ID_PATTERN.test(id) || await isHeld(id)) continue;
        try {
            await settleInterruptedPublish(id);
            const manifest = decodeManifest(await docStore.port.read(`${DOCUMENTS_DIR}/${id}/${MANIFEST_NAME}`));
            if (manifest.pendingPublish) await (await openDocument(docStore, id)).close();
        } catch (error) {
            log.debug(`Document ${id} kept an interrupted save for later: ${getErrorMessage(error)}`);
        }
    }
    const {removed, unsaved} = await collectDocuments(docStore, isHeld);
    const checkpoints = [...(await readWorkspaceCheckpoints(docStore.port)).values()];
    if (checkpoints.every(checkpoint => checkpoint !== null)) {
        const referenced = new Set(checkpoints.flatMap(checkpoint => Object.values(checkpoint!.tabs).map(tab => tab.directory)));
        for (const id of unsaved) {
            if (referenced.has(id) || await isHeld(id)) continue;
            // No checkpoint restores it, such as an undo snapshot or a document closed while unsaved.
            await docStore.port.remove(`${DOCUMENTS_DIR}/${id}`);
            removed.push(id);
        }
    }
    return removed.length;
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
 * The size and modification time the document's source had when it was opened, which a remembered reading view is
 * bound to; `null` for a document the app made or one recovered with bytes of its own.
 */
export function getWorkingCopyOriginalFileExpectation(ref: string, senderId?: number) {
    const admission = getWorkingCopyBackingEntry(ref, senderId)?.admission;
    return admission ? {size: Number(admission.size), mtimeMs: Number(admission.mtimeNs / 1_000n) / 1_000} : null;
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
