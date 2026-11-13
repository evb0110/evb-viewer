import {
    contentOf,
    contentWitness,
    sameWitness,
} from './contentWitness';
import type {
    IStoreFile,
    IStorePort,
    TExternalSource,
} from './storePort';

export const DOCUMENTS_DIR = 'documents';
export const MANIFEST_NAME = 'manifest.json';
/** Directory and window ids: also file names, so they never contain a separator. */
export const STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const EXT_PATTERN = /^[A-Za-z0-9]{1,16}$/u;
const REVISION_FILE_PATTERN = /^r\d+\.[A-Za-z0-9]{1,16}$/u;
const DRAFTS_FILE_PATTERN = /^drafts-[A-Za-z0-9-]{1,64}\.json$/u;
const COPY_BYTES = 4 * 1024 * 1024;

/** The bytes `[0, length)` of `file`. `witness` names them once something established it: a content witness, or the witness of the destination they were copied from. */
export interface IRevision {
    id: number;
    file: string;
    length: number;
    witness?: string | undefined;
}

/**
 * Revision 1 of a document opened from a destination, kept for undo while no file of the store holds it: the
 * destination's bytes, as long as the destination still has `witness`.
 */
export interface IDestinationRevision {
    id: 1;
    witness: string;
}

export type THistoryRevision = IRevision | IDestinationRevision;

const hasFile = (revision: THistoryRevision): revision is IRevision => 'file' in revision;

/** A publish whose outcome is unknown: `witness` is what `destination` holds if it finished. */
interface IPendingPublish {
    destination: string;
    witness: string;
    /** What the destination held before, for an `unsettled` record; the latest publish's is the manifest's `baseline`. */
    baseline?: string | undefined;
}

export interface IManifest {
    version: 1;
    ext: string;
    /** The id of the next revision, which also names its file. Revision 1 is the destination's bytes as opened. */
    next: number;
    current?: IRevision | undefined;
    /** Revisions kept for undo and redo; never contains `current`. */
    history: THistoryRevision[];
    destination?: string | undefined;
    /** The witness of the bytes last read from or published to `destination`. */
    baseline?: string | undefined;
    /** The latest publish while its outcome is unknown; recovery adopts it when the destination holds what it published. */
    pendingPublish?: IPendingPublish | undefined;
    /** Earlier publishes a later one followed before they could be settled, for example while their destination could not be read. */
    unsettled?: IPendingPublish[] | undefined;
    /** The immutable file holding the drafts that apply to `current`; absent when there are none. */
    drafts?: string | undefined;
}

export interface IDocumentState {
    id: string;
    current: IRevision | null;
    history: readonly THistoryRevision[];
    destination: string | null;
    baseline: string | null;
    /** Unsaved state not yet in the bytes, applying to `current`; `undefined` when there is none. */
    drafts: unknown;
    dirty: boolean;
    /** Its unsaved work is in a revision file this computer cannot read; see `DamagedDocumentError`. */
    damaged: boolean;
}

/** Bytes to publish: exactly `[0, length)` of `file`, which lives at the store-relative `path`; `witness`, what is known of them. */
export interface IPublishSource {
    path: string;
    length: number;
    file: IStoreFile;
    witness?: string | undefined;
}

/**
 * `witness`: the destination's witness after the write, the new baseline. `keptOriginal`: where bytes another program
 * wrote around the publication were kept; with `conflict`, that program also changed the destination after the write.
 */
export type TPublishResult = { status: 'published'; keptOriginal?: string; witness: string } | { status: 'conflict'; keptOriginal?: string };

/** Everything platform-specific about where a document is saved. */
export interface IPublicationPort {
    /**
     * The witness of the destination now; `null` when it has no readable content. A platform may answer with
     * file metadata alone unless `content` asks for the content witness too, which reads every byte.
     */
    witness(destination: string, content?: boolean): Promise<string | null>;
    /**
     * Ends what an interrupted publish of `published` left at `destination`, which held `baseline` before (on desktop,
     * the file it moved aside), then answers as `witness` does. Throws while the destination cannot be read. Without
     * it, recovery asks `witness`, for the content when `published` names it.
     */
    settle?(destination: string, published: string, baseline: string | null): Promise<string | null>;
    /** The destination's bytes, to copy in as the first revision. */
    source(destination: string): Promise<TExternalSource>;
    /**
     * Writes `source` to `destination`. Before the destination changes, `stage` receives the witness the
     * destination will have, and is awaited: the core records it as the pending publish. With `expected`, refuses
     * with `conflict` unless the destination's witness still equals it, checked as close to the write as the
     * platform allows. Refusals of another kind (locked, read-only, folder not writable) throw the adapter's own error.
     */
    publish(destination: string, source: IPublishSource, expected: string | null, stage: (witness: string) => Promise<void>): Promise<TPublishResult>;
}

export interface IDocumentStore {
    port: IStorePort;
    publication: IPublicationPort;
}

export type TRevisionWriter = (file: IStoreFile) => Promise<void>;
/** Where a new revision file's bytes come from: copied in, written, or a file the store takes over. */
type TRevisionSource = TExternalSource | TRevisionWriter | { move: string };
/** The drafts a mutation leaves: the current ones, new ones (`undefined` clears), or none. */
export type TDraftsAfter = 'keep' | 'clear' | { replace: unknown };
/** New bytes for a document: written from `source`, or `move`: a file the caller wrote on the store's file system and gives up. */
export type TReplacement = { kind: 'rewrite'; source: TExternalSource | TRevisionWriter } | { kind: 'move'; file: string };
export type TMutation = ({ kind: 'append'; bytes: Uint8Array } | TReplacement) & { drafts: TDraftsAfter };
export type TStaleRevision = { status: 'stale-revision'; current: IRevision | null };
export type TMutationResult = { status: 'committed'; revision: IRevision } | TStaleRevision | { status: 'conflict' };
export type TDraftResult = { status: 'stored'; revision: IRevision | null } | TStaleRevision | { status: 'conflict' };
/** `revision` is `null` after a restore to the destination's bytes: the document reads its destination again. */
export type TRestoreResult = { status: 'committed'; revision: IRevision | null } | TStaleRevision | { status: 'conflict' };
/**
 * `imported`: bytes the person supplied without a destination; they are the baseline, so the document starts clean.
 * `id`: the directory's id when the caller must know it first, for example to lock it before it exists.
 */
export type TDocumentInit = { ext: string; id?: string } & ({ destination: string } | { source: TExternalSource; imported?: boolean });

/**
 * The manifest names a current revision whose file is missing or short, as when a profile comes back without it. The
 * directory stays as it is for an open that finds the file; meanwhile it reads as its destination, stays unsaved, and
 * refuses every change and Save with this.
 */
export class DamagedDocumentError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encodeJson(value: unknown) {
    return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeJson(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(bytes));
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';

function isRevision(value: unknown): value is IRevision {
    return isRecord(value) && isCount(value.id) && typeof value.file === 'string' && REVISION_FILE_PATTERN.test(value.file)
        && isCount(value.length) && isOptionalString(value.witness);
}

const isDestinationRevision = (value: unknown) => isRecord(value) && value.id === 1 && typeof value.witness === 'string' && !('file' in value);
const isPendingPublish = (value: unknown) => isRecord(value) && typeof value.destination === 'string' && typeof value.witness === 'string'
    && isOptionalString(value.baseline);

function isManifest(value: unknown): value is IManifest {
    return isRecord(value) && value.version === 1 && typeof value.ext === 'string' && EXT_PATTERN.test(value.ext)
        && isCount(value.next) && Array.isArray(value.history)
        && value.history.every(revision => isRevision(revision) || isDestinationRevision(revision))
        && (value.current === undefined || isRevision(value.current))
        && isOptionalString(value.destination) && isOptionalString(value.baseline)
        && (value.drafts === undefined || (typeof value.drafts === 'string' && DRAFTS_FILE_PATTERN.test(value.drafts)))
        && (value.pendingPublish === undefined || isPendingPublish(value.pendingPublish))
        && (value.unsettled === undefined || (Array.isArray(value.unsettled) && value.unsettled.every(isPendingPublish)));
}

export function decodeManifest(bytes: Uint8Array): IManifest {
    const value = decodeJson(bytes);
    if (!isManifest(value)) throw new Error('Unreadable document manifest');
    return value;
}

/** Dirty: drafts exist, a publish is unresolved, or the current bytes are not known to equal the baseline. */
export function isDirty(manifest: IManifest) {
    const { current } = manifest;
    return manifest.drafts !== undefined || manifest.pendingPublish !== undefined || manifest.unsettled !== undefined
        || (current !== undefined && !sameWitness(current.witness, manifest.baseline));
}

function namedFiles(manifest: IManifest) {
    const files = [manifest.current, ...manifest.history].flatMap(revision => revision && hasFile(revision) ? [revision.file] : []);
    return new Set(manifest.drafts === undefined ? files : [...files, manifest.drafts]);
}

/**
 * One document directory: `manifest.json` (the only commit point), revision files `r<id>.<ext>` that are
 * immutable up to the lengths the manifest names, and the immutable drafts file it names. Calls run one at a
 * time in call order.
 *
 * Undo is a restore to a revision `history` keeps. History keeps the revisions the caller last asked to
 * retain, and the one the latest change replaced; a file nothing names is deleted.
 */
export class DocumentDirectory {
    private tail: Promise<unknown> = Promise.resolve();
    private retained: ReadonlySet<number> = new Set();
    /** Why every call is refused until the directory is opened again; see `commit`. */
    private refusal: Error | null = null;

    private constructor(
        readonly id: string,
        readonly store: IDocumentStore,
        private manifest: IManifest,
        /** The open handle on the current revision's file. */
        private file: IStoreFile | null,
        private drafts: unknown,
        readonly damaged = false,
    ) {}

    static async create(store: IDocumentStore, init: TDocumentInit) {
        if (!EXT_PATTERN.test(init.ext)) throw new Error(`Unsupported document extension: ${init.ext}`);
        const id = init.id ?? crypto.randomUUID();
        if (!STORE_ID_PATTERN.test(id)) throw new Error(`Invalid document directory id: ${id}`);
        const manifest: IManifest = { version: 1, ext: init.ext, next: 2, history: [] };
        const doc = new DocumentDirectory(id, store, manifest, null, undefined);
        if ('destination' in init) {
            const baseline = await store.publication.witness(init.destination);
            if (baseline === null) throw new Error('The destination has no readable content');
            await doc.commit({ ...manifest, destination: init.destination, baseline });
        } else {
            const name = `r1.${init.ext}`;
            const { file, length, witness } = await doc.createRevisionFile(name, init.source, init.imported === true);
            await doc.commit({ ...manifest, current: { id: 1, file: name, length, witness }, baseline: witness }, file);
        }
        return doc;
    }

    /**
     * A new, independent directory holding a clone of the source's current bytes with the same revision ids,
     * destination, baseline and drafts, and no history. The caller holds the source's lock.
     */
    static async fork(store: IDocumentStore, sourceId: string, id: string = crypto.randomUUID()) {
        if (![sourceId, id].every(value => STORE_ID_PATTERN.test(value))) throw new Error(`Invalid document directory id: ${sourceId} or ${id}`);
        const { port } = store;
        const from = (name: string) => `${DOCUMENTS_DIR}/${sourceId}/${name}`;
        const manifest = decodeManifest(await port.read(from(MANIFEST_NAME)));
        const { current, drafts } = manifest;
        const doc = new DocumentDirectory(id, store, { ...manifest, current: undefined, history: [], drafts: undefined }, null, undefined);
        let value: unknown;
        if (drafts !== undefined) {
            const bytes = await port.read(from(drafts));
            await port.writeAtomic(doc.path(drafts), bytes);
            value = decodeJson(bytes);
        }
        // Bytes past `current.length` (a redo tail) are never read, and the next open cuts them.
        if (current) await port.copy(from(current.file), doc.path(current.file));
        await doc.commit({ ...manifest, history: [] }, current ? await port.open(doc.path(current.file)) : null, value);
        return doc;
    }

    /** Opens a directory after a crash or a clean close alike: the three recovery steps of the model. */
    static async open(store: IDocumentStore, id: string) {
        if (!STORE_ID_PATTERN.test(id)) throw new Error(`Invalid document directory id: ${id}`);
        const { port } = store;
        const dir = `${DOCUMENTS_DIR}/${id}`;
        const names = await port.list(dir);
        const manifest = decodeManifest(await port.read(`${dir}/${MANIFEST_NAME}`));
        const { current } = manifest;
        const file = current && names.includes(current.file) ? await port.open(`${dir}/${current.file}`) : null;
        try {
            if (current && (!file || await file.size() < current.length)) {
                await file?.close();
                return new DocumentDirectory(id, store, { ...manifest, current: undefined, history: [], drafts: undefined }, null, undefined, true);
            }
            return await DocumentDirectory.recover(store, id, names, manifest, file);
        } catch (error) {
            await file?.close().catch(() => undefined);
            throw error;
        }
    }

    private static async recover(store: IDocumentStore, id: string, names: string[], manifest: IManifest, file: IStoreFile | null) {
        const { port } = store;
        const dir = `${DOCUMENTS_DIR}/${id}`;
        const { current } = manifest;
        if (current && file) {
            // 1. Cut an unfinished append. A redo revision can name the same file further than `current`.
            const size = await file.size();
            const named = Math.max(...[current, ...manifest.history.filter(hasFile)].filter(revision => revision.file === current.file).map(revision => revision.length));
            if (size > named) {
                await file.truncate(named);
                await file.flush();
            }
        }
        // 2. Delete what the manifest does not name, including drafts and temporary files of unfinished commits.
        const keep = new Set([MANIFEST_NAME, ...namedFiles(manifest)]);
        for (const name of names) {
            if (!keep.has(name)) await port.remove(`${dir}/${name}`);
        }
        const drafts = manifest.drafts === undefined ? undefined : decodeJson(await port.read(`${dir}/${manifest.drafts}`));
        const doc = new DocumentDirectory(id, store, manifest, file, drafts);
        // 3. Settle a publish that was under way.
        await doc.resolvePending();
        return doc;
    }

    state(): IDocumentState {
        const { manifest } = this;
        return {
            id: this.id,
            current: manifest.current ?? null,
            history: manifest.history,
            destination: manifest.destination ?? null,
            baseline: manifest.baseline ?? null,
            drafts: this.drafts,
            dirty: this.damaged || isDirty(manifest),
            damaged: this.damaged,
        };
    }

    /** Reads the current revision. It does not wait for queued calls: the bytes a revision names never change. */
    read(offset: number, length: number) {
        const current = this.manifest.current;
        if (!current) throw new Error('The document has no bytes of its own yet: read its destination');
        return this.currentFile().readAt(offset, Math.max(0, Math.min(length, current.length - offset)));
    }

    mutate(expected: number | null, mutation: TMutation) {
        return this.run(() => this.applyMutation(expected, mutation));
    }

    /**
     * Makes revision `revisionId` that history keeps current again, on top of revision `expected`: undo, or redo
     * after an undo. One manifest replace; nothing is copied. Drafts described the replaced bytes, so they go.
     */
    restore(expected: number | null, revisionId: number) {
        return this.run(async (): Promise<TRestoreResult> => {
            const stale = this.staleRevision(expected);
            if (stale) return stale;
            const { manifest } = this;
            const { current } = manifest;
            if ((current?.id ?? 1) === revisionId) return { status: 'committed', revision: current ?? null };
            const target = manifest.history.find(revision => revision.id === revisionId);
            if (!target) return { status: 'stale-revision', current: current ?? null };
            if (!hasFile(target) && !(sameWitness(target.witness, manifest.baseline) && manifest.destination !== undefined
                && sameWitness(await this.store.publication.witness(manifest.destination), target.witness))) return { status: 'conflict' };
            const file = !hasFile(target) ? null : target.file === current?.file ? this.file : await this.store.port.open(this.path(target.file));
            await this.commit({
                ...manifest,
                current: hasFile(target) ? target : undefined,
                history: this.historyAfter(manifest.history.filter(revision => revision !== target)),
                drafts: undefined,
            }, file);
            return { status: 'committed', revision: hasFile(target) ? target : null };
        });
    }

    /** Keeps exactly the revisions `revisionIds` names in history, from now on and after every change. */
    retain(revisionIds: readonly number[]) {
        return this.run(async () => {
            this.retained = new Set(revisionIds);
            const history = this.manifest.history.filter(revision => this.retained.has(revision.id));
            if (history.length < this.manifest.history.length) await this.commit({ ...this.manifest, history });
        });
    }

    /** Stores unsaved state for revision `expected`; `undefined` deletes it. The first drafts copy the bytes in. */
    setDrafts(expected: number | null, drafts: unknown) {
        return this.run(async (): Promise<TDraftResult> => {
            const stale = this.staleRevision(expected);
            if (stale) return stale;
            if (drafts !== undefined && !await this.ensureCurrent()) return { status: 'conflict' };
            const after = await this.writeDrafts({ replace: drafts });
            await this.commit({ ...this.manifest, drafts: after.name }, this.file, after.value);
            return { status: 'stored', revision: this.manifest.current ?? null };
        });
    }

    /**
     * Gives the document bytes of its own, copying the destination in when it has none, for readers that need a
     * file. The revision id stays what a caller expecting `null` meets as revision 1. `null` on a conflict.
     */
    materialize() {
        return this.run(() => this.ensureCurrent());
    }

    /**
     * The store path the next revision's file will have. A caller may prepare that file itself, such as a native
     * tool's output, and commit it with a rewrite whose writer leaves it as it is; while no manifest names it,
     * recovery removes it. Valid until the next change to this directory commits.
     */
    nextRevisionPath() {
        return this.path(`r${this.manifest.next}.${this.manifest.ext}`);
    }

    close() {
        const closed = this.tail.then(async () => {
            await this.file?.close();
            this.file = null;
        });
        this.tail = closed.catch(() => undefined);
        return closed;
    }

    // The members below are the steps `saveDocument` composes; application code uses the methods above.

    /** Runs `task` after every earlier call on this directory has settled; a damaged or refusing directory runs nothing. */
    run<T>(task: () => Promise<T>): Promise<T> {
        if (this.damaged) return Promise.reject(new DamagedDocumentError(`The unsaved changes of document ${this.id} are in a revision file that is missing or cut short`));
        const result = this.tail.then(() => {
            if (this.refusal) throw this.refusal;
            return task();
        });
        this.tail = result.catch(() => undefined);
        return result;
    }

    snapshot(): IManifest {
        return this.manifest;
    }

    path(name: string) {
        return `${DOCUMENTS_DIR}/${this.id}/${name}`;
    }

    currentFile() {
        if (!this.file) throw new Error(`Document ${this.id} has no open revision file`);
        return this.file;
    }

    staleRevision(expected: number | null): TStaleRevision | null {
        const current = this.manifest.current ?? null;
        return (current?.id ?? null) === expected ? null : { status: 'stale-revision', current };
    }

    /**
     * A rewrite or move on a document without bytes of its own copies nothing in: its source is the new revision,
     * and the destination's bytes stay revision 1 for undo. An append needs them in front, so it copies them in.
     */
    async applyMutation(expected: number | null, mutation: TMutation): Promise<TMutationResult> {
        const stale = this.staleRevision(expected);
        if (stale) return stale;
        const base = mutation.kind === 'append' ? await this.ensureCurrent() : this.manifest.current;
        if (base === null) return { status: 'conflict' };
        const drafts = await this.writeDrafts(mutation.drafts);
        const manifest = this.manifest;
        const id = manifest.next;
        let revision: IRevision;
        let file = this.file;
        const redoSharesFile = manifest.history.some(other => hasFile(other) && other.file === base?.file && other.length > base.length);
        if (mutation.kind === 'append' && base && !redoSharesFile) {
            await this.currentFile().writeAt(base.length, mutation.bytes);
            await this.currentFile().flush();
            revision = { id, file: base.file, length: base.length + mutation.bytes.byteLength };
        } else {
            const name = `r${id}.${manifest.ext}`;
            const source = mutation.kind === 'rewrite' ? mutation.source
                : mutation.kind === 'move' ? { move: mutation.file } : this.copyThenAppend(base!, mutation.bytes);
            const created = base ? await this.createRevisionFile(name, source) : await this.createFromDestination(name, source);
            if (!created) return { status: 'conflict' };
            file = created.file;
            revision = { id, file: name, length: created.length };
        }
        await this.commit({ ...manifest, next: id + 1, current: revision, history: this.historyAfter(manifest.history), drafts: drafts.name }, file, drafts.value);
        return { status: 'committed', revision };
    }

    /** The history a change leaves: what the caller retains, and the revision the change replaces. */
    private historyAfter(history: readonly THistoryRevision[]): THistoryRevision[] {
        const { current, baseline } = this.manifest;
        const replaced: THistoryRevision | undefined = current ?? (baseline === undefined ? undefined : { id: 1, witness: baseline });
        return [...history.filter(revision => this.retained.has(revision.id) && revision.id !== replaced?.id), ...replaced ? [replaced] : []];
    }

    /** The current revision, copying the destination in as revision 1 when there is none; `null` on a conflict. */
    async ensureCurrent(): Promise<IRevision | null> {
        const { manifest } = this;
        if (manifest.current) return manifest.current;
        if (manifest.destination === undefined) throw new Error(`Document ${this.id} has neither bytes nor a destination`);
        const name = `r1.${manifest.ext}`;
        const created = await this.createFromDestination(name, await this.store.publication.source(manifest.destination));
        if (!created) return null;
        const current = { id: 1, file: name, length: created.length, witness: manifest.baseline };
        await this.commit({ ...manifest, current }, created.file);
        return current;
    }

    /**
     * A revision file made from bytes read from the destination. `null`, and no file, when the destination no
     * longer holds the baseline afterwards: edits must not land on bytes the person has not seen.
     */
    private async createFromDestination(name: string, source: TRevisionSource) {
        const created = await this.createRevisionFile(name, source);
        if (sameWitness(await this.store.publication.witness(this.manifest.destination!), this.manifest.baseline)) return created;
        await created.file.close();
        await this.store.port.remove(this.path(name));
        return null;
    }

    /**
     * Recovery step 3, also run before every Save: settles each publish whose outcome is unknown and drops its record,
     * adopting the latest when its destination holds what it published. A record whose destination cannot be read
     * now, for example held by another program, stays for the next open or Save.
     */
    async resolvePending() {
        const { manifest } = this;
        const { pendingPublish: pending, unsettled = [] } = manifest;
        if (!pending && unsettled.length === 0) return;
        const { publication } = this.store;
        // A witness without content names the published file by its metadata, which is enough to compare.
        const settle = (record: IPendingPublish, baseline: string | undefined) => (publication.settle
            ? publication.settle(record.destination, record.witness, baseline ?? null)
            : publication.witness(record.destination, contentOf(record.witness) !== undefined)).catch(() => undefined);
        const left: IPendingPublish[] = [];
        for (const record of unsettled) {
            if (await settle(record, record.baseline) === undefined) left.push(record);
        }
        const witness = pending && await settle(pending, manifest.baseline);
        const adopted = pending && witness && sameWitness(witness, pending.witness) ? { destination: pending.destination, baseline: witness } : {};
        const next = { ...manifest, ...adopted, pendingPublish: witness === undefined ? pending : undefined, unsettled: left.length > 0 ? left : undefined };
        if (JSON.stringify(next) !== JSON.stringify(manifest)) await this.commit(next);
    }

    /**
     * Replaces the manifest, the only commit point, then makes `file` the current file's handle and `drafts`
     * the value of the drafts file it names, and deletes the files the new manifest no longer names. Failures
     * after the replace are left to recovery, which deletes the same things, so a committed change never
     * reports failure. A replace that fails may still have landed (its directory flush failed, say), so this
     * continues from the manifest the disk holds: the new one, kept without deleting what the old one named,
     * since it may not be durable; or the old one, closing a new `file`. A disk that shows neither leaves the
     * directory refusing everything until it is opened again.
     */
    async commit(next: IManifest, file: IStoreFile | null = this.file, drafts: unknown = this.drafts) {
        const { port } = this.store;
        const before = this.manifest;
        const text = JSON.stringify(next);
        let failure: unknown;
        try {
            await port.writeAtomic(this.path(MANIFEST_NAME), new TextEncoder().encode(text));
        } catch (error) {
            failure = error;
            const onDisk = await port.read(this.path(MANIFEST_NAME)).then(bytes => new TextDecoder().decode(bytes), () => null);
            if (onDisk !== text) {
                if (file !== this.file) await file?.close().catch(() => undefined);
                if (onDisk !== JSON.stringify(before)) this.refusal = new Error(`Document ${this.id} lost track of its manifest; open it again`, { cause: error });
                throw error;
            }
        }
        this.manifest = next;
        this.drafts = next.drafts === undefined ? undefined : drafts;
        if (file !== this.file) {
            await this.file?.close().catch(() => undefined);
            this.file = file;
        }
        if (failure !== undefined) throw failure;
        const named = namedFiles(next);
        for (const name of namedFiles(before)) {
            if (!named.has(name)) await port.remove(this.path(name)).catch(() => undefined);
        }
    }

    /** Writes the drafts a change leaves as a new file, for the change's manifest to name. */
    private async writeDrafts(after: TDraftsAfter): Promise<{ name: string | undefined; value: unknown }> {
        if (after === 'keep') return { name: this.manifest.drafts, value: this.drafts };
        if (after === 'clear' || after.replace === undefined) return { name: undefined, value: undefined };
        const name = `drafts-${crypto.randomUUID()}.json`;
        await this.store.port.writeAtomic(this.path(name), encodeJson(after.replace));
        return { name, value: after.replace };
    }

    /** Creates a revision file from `source`; with `withWitness`, also returns the content witness of its bytes. */
    private async createRevisionFile(name: string, source: TRevisionSource, withWitness = false) {
        const { port } = this.store;
        const path = this.path(name);
        try {
            if (typeof source === 'object' && 'move' in source) {
                if (!port.move) throw new Error('This store cannot take files in');
                await port.move(source.move, path);
            } else if (typeof source !== 'function') {
                await port.copyIn(source, path);
            }
            const file = await port.open(path);
            try {
                if (typeof source === 'function') {
                    await source(file);
                    await file.flush();
                }
                const length = await file.size();
                const witness = withWitness ? await contentWitness(length, (offset, size) => file.readAt(offset, size)) : undefined;
                return { file, length, witness };
            } catch (error) {
                await file.close().catch(() => undefined);
                throw error;
            }
        } catch (error) {
            await port.remove(path).catch(() => undefined);
            throw error;
        }
    }

    /** An append whose file a redo revision extends differently goes to a new file. */
    private copyThenAppend(base: IRevision, bytes: Uint8Array): TRevisionWriter {
        const source = this.currentFile();
        return async target => {
            for (let offset = 0; offset < base.length; offset += COPY_BYTES) {
                await target.writeAt(offset, await source.readAt(offset, Math.min(COPY_BYTES, base.length - offset)));
            }
            await target.writeAt(base.length, bytes);
        };
    }
}

export const createDocument = (store: IDocumentStore, init: TDocumentInit) => DocumentDirectory.create(store, init);
export const openDocument = (store: IDocumentStore, id: string) => DocumentDirectory.open(store, id);
export const forkDocument = (store: IDocumentStore, id: string, newId?: string) => DocumentDirectory.fork(store, id, newId);
