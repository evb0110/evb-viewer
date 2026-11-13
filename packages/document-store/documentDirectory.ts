import {
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

interface IPendingPublish {
    destination: string;
    witness: string;
}

export interface IManifest {
    version: 1;
    ext: string;
    /** The id of the next revision, which also names its file when it needs one. */
    next: number;
    current?: IRevision | undefined;
    /** Revisions kept for undo and redo, oldest first; never contains `current`. */
    history: IRevision[];
    destination?: string | undefined;
    /** The witness of the bytes last read from or published to `destination`. */
    baseline?: string | undefined;
    pendingPublish?: IPendingPublish | undefined;
    /** The immutable file holding the drafts that apply to `current`; absent when there are none. */
    drafts?: string | undefined;
}

export interface IDocumentState {
    id: string;
    current: IRevision | null;
    history: readonly IRevision[];
    destination: string | null;
    baseline: string | null;
    /** Unsaved state not yet in the bytes, applying to `current`; `undefined` when there is none. */
    drafts: unknown;
    dirty: boolean;
    /** Its unsaved work is in a revision file this computer cannot read; see `DamagedDocumentError`. */
    damaged: boolean;
}

/** Bytes to publish: exactly `[0, length)` of `file`, which lives at the store-relative `path`. */
export interface IPublishSource {
    path: string;
    length: number;
    file: IStoreFile;
}

/** `witness`: facts the platform read from the destination after the write, joined to the bytes' witness as the new baseline. */
export type TPublishResult = { status: 'published'; keptOriginal?: string; witness?: string } | { status: 'conflict' };

/** Everything platform-specific about where a document is saved. */
export interface IPublicationPort {
    /**
     * The witness of the destination now; `null` when it has no readable content. A platform may answer with
     * file metadata alone unless `content` asks for the content witness too, which reads every byte.
     */
    witness(destination: string, content?: boolean): Promise<string | null>;
    /** The destination's bytes, to copy in as the first revision. */
    source(destination: string): Promise<TExternalSource>;
    /**
     * Writes `source` to `destination`. With `expected`, refuses with `conflict` unless the destination's
     * witness still equals it, checked as close to the write as the platform allows. Refusals of another
     * kind (locked, read-only, folder not writable) throw the adapter's own error.
     */
    publish(destination: string, source: IPublishSource, expected: string | null): Promise<TPublishResult>;
}

export interface IDocumentStore {
    port: IStorePort;
    publication: IPublicationPort;
    /** Bytes that revision files kept only for undo may occupy; the oldest revisions go first. */
    historyBudget: number;
}

export type TRevisionWriter = (file: IStoreFile) => Promise<void>;
/** The drafts a mutation leaves: the current ones, new ones (`undefined` clears), or none. */
export type TDraftsAfter = 'keep' | 'clear' | { replace: unknown };
export type TMutation = ({ kind: 'append'; bytes: Uint8Array } | { kind: 'rewrite'; source: TExternalSource | TRevisionWriter })
    & { drafts: TDraftsAfter };
export type TStaleRevision = { status: 'stale-revision'; current: IRevision | null };
export type TMutationResult = { status: 'committed'; revision: IRevision } | TStaleRevision | { status: 'conflict' };
export type TDraftResult = { status: 'stored'; revision: IRevision | null } | TStaleRevision | { status: 'conflict' };
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

function isManifest(value: unknown): value is IManifest {
    return isRecord(value) && value.version === 1 && typeof value.ext === 'string' && EXT_PATTERN.test(value.ext)
        && isCount(value.next) && Array.isArray(value.history) && value.history.every(isRevision)
        && (value.current === undefined || isRevision(value.current))
        && isOptionalString(value.destination) && isOptionalString(value.baseline)
        && (value.drafts === undefined || (typeof value.drafts === 'string' && DRAFTS_FILE_PATTERN.test(value.drafts)))
        && (value.pendingPublish === undefined || (isRecord(value.pendingPublish)
            && typeof value.pendingPublish.destination === 'string' && typeof value.pendingPublish.witness === 'string'));
}

export function decodeManifest(bytes: Uint8Array): IManifest {
    const value = decodeJson(bytes);
    if (!isManifest(value)) throw new Error('Unreadable document manifest');
    return value;
}

/** Dirty: drafts exist, a publish is unresolved, or the current bytes are not known to equal the baseline. */
export function isDirty(manifest: IManifest) {
    const { current } = manifest;
    return manifest.drafts !== undefined || manifest.pendingPublish !== undefined
        || (current !== undefined && !sameWitness(current.witness, manifest.baseline));
}

function namedFiles(manifest: IManifest) {
    const files = [manifest.current, ...manifest.history].flatMap(revision => revision ? [revision.file] : []);
    return new Set(manifest.drafts === undefined ? files : [...files, manifest.drafts]);
}

/** Drops the oldest revisions until the files only history keeps fit the budget. */
function trimHistory(history: IRevision[], current: IRevision, budget: number) {
    const kept = [...history];
    const historyBytes = () => {
        const lengths = new Map<string, number>();
        for (const revision of kept) {
            if (revision.file !== current.file) lengths.set(revision.file, Math.max(lengths.get(revision.file) ?? 0, revision.length));
        }
        return [...lengths.values()].reduce((sum, length) => sum + length, 0);
    };
    while (kept.length > 0 && historyBytes() > budget) kept.shift();
    return kept;
}

/**
 * One document directory: `manifest.json` (the only commit point), revision files `r<id>.<ext>` that are
 * immutable up to the lengths the manifest names, and the immutable drafts file it names. Calls run one at a
 * time in call order.
 */
export class DocumentDirectory {
    private tail: Promise<unknown> = Promise.resolve();

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
        const manifest: IManifest = { version: 1, ext: init.ext, next: 1, history: [] };
        const doc = new DocumentDirectory(id, store, manifest, null, undefined);
        if ('destination' in init) {
            const baseline = await store.publication.witness(init.destination);
            if (baseline === null) throw new Error('The destination has no readable content');
            await doc.commit({ ...manifest, destination: init.destination, baseline });
        } else {
            const name = `r1.${init.ext}`;
            const { file, length, witness } = await doc.createRevisionFile(name, init.source, init.imported === true);
            await doc.commit({ ...manifest, next: 2, current: { id: 1, file: name, length, witness }, baseline: witness }, file);
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
            const named = Math.max(...[current, ...manifest.history].filter(revision => revision.file === current.file).map(revision => revision.length));
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

    /** Makes a retained revision current again: undo, or redo after an undo. */
    restore(revisionId: number) {
        return this.run(async (): Promise<TMutationResult> => {
            const { manifest } = this;
            const { current } = manifest;
            if (current?.id === revisionId) return { status: 'committed', revision: current };
            const target = manifest.history.find(revision => revision.id === revisionId);
            if (!current || !target) return { status: 'stale-revision', current: current ?? null };
            const file = target.file === current.file ? this.file : await this.store.port.open(this.path(target.file));
            await this.commit({
                ...manifest,
                current: target,
                history: [...manifest.history.filter(revision => revision !== target), current],
                drafts: undefined,
            }, file);
            return { status: 'committed', revision: target };
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
        return this.damaged ? Promise.resolve() : this.run(async () => {
            await this.file?.close();
            this.file = null;
        });
    }

    // The members below are the steps `saveDocument` composes; application code uses the methods above.

    /** Runs `task` after every earlier call on this directory has settled; a damaged directory runs nothing. */
    run<T>(task: () => Promise<T>): Promise<T> {
        if (this.damaged) return Promise.reject(new DamagedDocumentError(`The unsaved changes of document ${this.id} are in a revision file that is missing or cut short`));
        const result = this.tail.then(task);
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

    async applyMutation(expected: number | null, mutation: TMutation): Promise<TMutationResult> {
        const stale = this.staleRevision(expected);
        if (stale) return stale;
        const base = await this.ensureCurrent();
        if (!base) return { status: 'conflict' };
        const drafts = await this.writeDrafts(mutation.drafts);
        const manifest = this.manifest;
        const id = manifest.next;
        let revision: IRevision;
        let file = this.file;
        const redoSharesFile = manifest.history.some(other => other.file === base.file && other.length > base.length);
        if (mutation.kind === 'append' && !redoSharesFile) {
            await this.currentFile().writeAt(base.length, mutation.bytes);
            await this.currentFile().flush();
            revision = { id, file: base.file, length: base.length + mutation.bytes.byteLength };
        } else {
            const name = `r${id}.${manifest.ext}`;
            const created = await this.createRevisionFile(name, mutation.kind === 'rewrite' ? mutation.source : this.copyThenAppend(base, mutation.bytes));
            file = created.file;
            revision = { id, file: name, length: created.length };
        }
        const history = trimHistory([...manifest.history, base], revision, this.store.historyBudget);
        await this.commit({ ...manifest, next: id + 1, current: revision, history, drafts: drafts.name }, file, drafts.value);
        return { status: 'committed', revision };
    }

    /**
     * The current revision, copying the destination in as the first one when there is none. `null` when the
     * destination no longer holds the baseline: edits must not land on bytes the person has not seen.
     */
    async ensureCurrent(): Promise<IRevision | null> {
        const { manifest } = this;
        if (manifest.current) return manifest.current;
        if (manifest.destination === undefined) throw new Error(`Document ${this.id} has neither bytes nor a destination`);
        const id = manifest.next;
        const name = `r${id}.${manifest.ext}`;
        const { file, length } = await this.createRevisionFile(name, await this.store.publication.source(manifest.destination));
        // The destination still holds the baseline after the copy, so the copy holds the baseline's bytes.
        if (!sameWitness(await this.store.publication.witness(manifest.destination), manifest.baseline)) {
            await file.close();
            await this.store.port.remove(this.path(name));
            return null;
        }
        const current = { id, file: name, length, witness: manifest.baseline };
        await this.commit({ ...manifest, next: id + 1, current }, file);
        return current;
    }

    /** Recovery step 3, also run before every Save: adopt or drop a publish whose outcome is unknown. */
    async resolvePending() {
        const { manifest } = this;
        const pending = manifest.pendingPublish;
        if (!pending) return;
        const witness = await this.store.publication.witness(pending.destination, true).catch(() => undefined);
        // Unreadable now, for example held by another program: the next open or Save decides.
        if (witness === undefined) return;
        const adopted = witness && sameWitness(witness, pending.witness) ? { destination: pending.destination, baseline: witness } : {};
        await this.commit({ ...manifest, ...adopted, pendingPublish: undefined });
    }

    /**
     * Replaces the manifest, the only commit point, then makes `file` the current file's handle and `drafts`
     * the value of the drafts file it names, and deletes the files the new manifest no longer names. Failures
     * after the replace are left to recovery, which deletes the same things, so a committed change never
     * reports failure. A new `file` is closed when the replace fails.
     */
    async commit(next: IManifest, file: IStoreFile | null = this.file, drafts: unknown = this.drafts) {
        const { port } = this.store;
        const before = this.manifest;
        try {
            await port.writeAtomic(this.path(MANIFEST_NAME), encodeJson(next));
        } catch (error) {
            if (file !== this.file) await file?.close().catch(() => undefined);
            throw error;
        }
        this.manifest = next;
        this.drafts = next.drafts === undefined ? undefined : drafts;
        if (file !== this.file) {
            await this.file?.close().catch(() => undefined);
            this.file = file;
        }
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
    private async createRevisionFile(name: string, source: TExternalSource | TRevisionWriter, withWitness = false) {
        const { port } = this.store;
        const path = this.path(name);
        try {
            if (typeof source !== 'function') await port.copyIn(source, path);
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
