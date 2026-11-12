import { contentWitness } from './contentWitness';
import type {
    IStoreFile,
    IStorePort,
    TExternalSource,
} from './storePort';

export const DOCUMENTS_DIR = 'documents';
export const MANIFEST_NAME = 'manifest.json';
export const DRAFTS_NAME = 'drafts.json';
/** Directory and window ids: also file names, so they never contain a separator. */
export const STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const EXT_PATTERN = /^[A-Za-z0-9]{1,16}$/u;
const REVISION_FILE_PATTERN = /^r\d+\.[A-Za-z0-9]{1,16}$/u;
const COPY_BYTES = 4 * 1024 * 1024;

/** The bytes `[0, length)` of `file`. `witness` is their content witness once something computed it. */
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
}

/** Bytes to publish: exactly `[0, length)` of `file`, which lives at the store-relative `path`. */
export interface IPublishSource {
    path: string;
    length: number;
    file: IStoreFile;
}

export type TPublishResult = { status: 'published'; keptOriginal?: string } | { status: 'conflict' };

/** Everything platform-specific about where a document is saved. */
export interface IPublicationPort {
    /** The content witness of the destination now; `null` when it has no readable content. */
    witness(destination: string): Promise<string | null>;
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
export type TMutation = { kind: 'append'; bytes: Uint8Array } | { kind: 'rewrite'; source: TExternalSource | TRevisionWriter };
export type TStaleRevision = { status: 'stale-revision'; current: IRevision | null };
export type TMutationResult = { status: 'committed'; revision: IRevision } | TStaleRevision | { status: 'conflict' };
export type TDraftResult = { status: 'stored'; revision: IRevision | null } | TStaleRevision | { status: 'conflict' };
export type TDocumentInit = { ext: string } & ({ destination: string } | { source: TExternalSource });

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
        && (value.pendingPublish === undefined || (isRecord(value.pendingPublish)
            && typeof value.pendingPublish.destination === 'string' && typeof value.pendingPublish.witness === 'string'));
}

export function decodeManifest(bytes: Uint8Array): IManifest {
    const value = decodeJson(bytes);
    if (!isManifest(value)) throw new Error('Unreadable document manifest');
    return value;
}

/** Dirty: drafts exist, a publish is unresolved, or the current bytes are not known to equal the baseline. */
export function isDirty(manifest: IManifest, hasDrafts: boolean) {
    const { current } = manifest;
    return hasDrafts || manifest.pendingPublish !== undefined
        || (current !== undefined && (current.witness === undefined || current.witness !== manifest.baseline));
}

function namedFiles(manifest: IManifest) {
    return new Set([manifest.current, ...manifest.history].flatMap(revision => revision ? [revision.file] : []));
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
 * immutable up to the lengths the manifest names, and `drafts.json`. Calls run one at a time in call order.
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
    ) {}

    static async create(store: IDocumentStore, init: TDocumentInit) {
        if (!EXT_PATTERN.test(init.ext)) throw new Error(`Unsupported document extension: ${init.ext}`);
        const manifest: IManifest = { version: 1, ext: init.ext, next: 1, history: [] };
        const doc = new DocumentDirectory(crypto.randomUUID(), store, manifest, null, undefined);
        if ('destination' in init) {
            const baseline = await store.publication.witness(init.destination);
            if (baseline === null) throw new Error('The destination has no readable content');
            await doc.commit({ ...manifest, destination: init.destination, baseline });
        } else {
            const name = `r1.${init.ext}`;
            const { file, length } = await doc.createRevisionFile(name, init.source);
            await doc.commit({ ...manifest, next: 2, current: { id: 1, file: name, length } }, file);
        }
        return doc;
    }

    /** Opens a directory after a crash or a clean close alike: the four recovery steps of the model. */
    static async open(store: IDocumentStore, id: string) {
        if (!STORE_ID_PATTERN.test(id)) throw new Error(`Invalid document directory id: ${id}`);
        const { port } = store;
        const dir = `${DOCUMENTS_DIR}/${id}`;
        const names = await port.list(dir);
        const manifest = decodeManifest(await port.read(`${dir}/${MANIFEST_NAME}`));
        const file = manifest.current ? await port.open(`${dir}/${manifest.current.file}`, 'write') : null;
        try {
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
            if (size < current.length) {
                throw new Error(`Revision file ${current.file} of document ${id} is shorter than its manifest`);
            }
            if (size > named) {
                await file.truncate(named);
                await file.flush();
            }
        }
        // 2. Delete what the manifest does not name.
        const keep = new Set([MANIFEST_NAME, DRAFTS_NAME, ...namedFiles(manifest)]);
        for (const name of names) {
            if (!keep.has(name)) await port.remove(`${dir}/${name}`);
        }
        const doc = new DocumentDirectory(id, store, manifest, file, undefined);
        // 3. Settle a publish that was under way.
        await doc.resolvePending();
        // 4. Drafts apply only to the revision they were written for.
        if (names.includes(DRAFTS_NAME)) {
            const stored = await port.read(doc.path(DRAFTS_NAME)).then(decodeJson).catch(() => null);
            if (isRecord(stored) && 'drafts' in stored && stored.revision === (current?.id ?? null)) doc.drafts = stored.drafts;
            else await port.remove(doc.path(DRAFTS_NAME));
        }
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
            dirty: isDirty(manifest, this.drafts !== undefined),
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
            const file = target.file === current.file ? this.file : await this.store.port.open(this.path(target.file), 'write');
            await this.commit({ ...manifest, current: target, history: [...manifest.history.filter(revision => revision !== target), current] }, file);
            return { status: 'committed', revision: target };
        });
    }

    /** Stores unsaved state for revision `expected`; `undefined` deletes it. The first drafts copy the bytes in. */
    setDrafts(expected: number | null, drafts: unknown) {
        return this.run(async (): Promise<TDraftResult> => {
            const stale = this.staleRevision(expected);
            if (stale) return stale;
            if (drafts === undefined) {
                await this.store.port.remove(this.path(DRAFTS_NAME));
                this.drafts = undefined;
                return { status: 'stored', revision: this.manifest.current ?? null };
            }
            const current = await this.ensureCurrent();
            if (!current) return { status: 'conflict' };
            await this.store.port.writeAtomic(this.path(DRAFTS_NAME), encodeJson({ revision: current.id, drafts }));
            this.drafts = drafts;
            return { status: 'stored', revision: current };
        });
    }

    close() {
        return this.run(async () => {
            await this.file?.close();
            this.file = null;
        });
    }

    // The members below are the steps `saveDocument` composes; application code uses the methods above.

    /** Runs `task` after every earlier call on this directory has settled. */
    run<T>(task: () => Promise<T>): Promise<T> {
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
        await this.commit({ ...manifest, next: id + 1, current: revision, history }, file);
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
        const witness = await contentWitness(length, (offset, size) => file.readAt(offset, size)).catch(async (error: unknown) => {
            await file.close().catch(() => undefined);
            throw error;
        });
        if (witness !== manifest.baseline) {
            await file.close();
            await this.store.port.remove(this.path(name));
            return null;
        }
        const current = { id, file: name, length, witness };
        await this.commit({ ...manifest, next: id + 1, current }, file);
        return current;
    }

    /** Recovery step 3, also run before every Save: adopt or drop a publish whose outcome is unknown. */
    async resolvePending() {
        const { manifest } = this;
        const pending = manifest.pendingPublish;
        if (!pending) return;
        const witness = await this.store.publication.witness(pending.destination).catch(() => undefined);
        // Unreadable now, for example held by another program: the next open or Save decides.
        if (witness === undefined) return;
        const adopted = witness === pending.witness ? { destination: pending.destination, baseline: witness } : {};
        await this.commit({ ...manifest, ...adopted, pendingPublish: undefined });
    }

    /**
     * Replaces the manifest, the only commit point, then makes `file` the current file's handle and deletes
     * the files and drafts the new manifest no longer names. Failures after the replace are left to recovery,
     * which deletes the same things, so a committed change never reports failure. A new `file` is closed when
     * the replace fails.
     */
    async commit(next: IManifest, file: IStoreFile | null = this.file) {
        const { port } = this.store;
        const before = this.manifest;
        try {
            await port.writeAtomic(this.path(MANIFEST_NAME), encodeJson(next));
        } catch (error) {
            if (file !== this.file) await file?.close().catch(() => undefined);
            throw error;
        }
        this.manifest = next;
        if (file !== this.file) {
            await this.file?.close().catch(() => undefined);
            this.file = file;
        }
        const named = namedFiles(next);
        for (const name of namedFiles(before)) {
            if (!named.has(name)) await port.remove(this.path(name)).catch(() => undefined);
        }
        if (this.drafts !== undefined && before.current?.id !== next.current?.id) {
            this.drafts = undefined;
            await port.remove(this.path(DRAFTS_NAME)).catch(() => undefined);
        }
    }

    private async createRevisionFile(name: string, source: TExternalSource | TRevisionWriter) {
        const { port } = this.store;
        const path = this.path(name);
        try {
            if (typeof source !== 'function') await port.copyIn(source, path);
            const file = await port.open(path, 'write');
            try {
                if (typeof source === 'function') {
                    await source(file);
                    await file.flush();
                }
                return { file, length: await file.size() };
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
