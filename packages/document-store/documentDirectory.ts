import {contentOf, sameWitness} from './contentWitness';
import {
    currentTextIdentity,
    decodeJson,
    decodeManifest,
    DOCUMENTS_DIR,
    encodeJson,
    EXT_PATTERN,
    hasFile,
    hasNoUserEdits,
    type IDestinationRevision,
    type IManifest,
    type IPendingPublish,
    type IRevision,
    isDirty,
    isRecord,
    MANIFEST_NAME,
    mintTextIdentity,
    namedFiles,
    parseTextIdentity,
    revisionTextIdentity,
    STORE_ID_PATTERN,
    TEXT_IDENTITY_VERSION,
    type TForeignRevisionState,
    type THistoryRevision,
} from './manifest';
import type {IStoreFile, IStorePort, TExternalSource} from './storePort';

export {
    currentTextIdentity,
    decodeJson,
    decodeManifest,
    DOCUMENTS_DIR,
    encodeJson,
    isDirty,
    isRecord,
    MANIFEST_NAME,
    mintTextIdentity,
    parseTextIdentity,
    revisionTextIdentity,
    STORE_ID_PATTERN,
    TEXT_IDENTITY_VERSION,
};
export type {IDestinationRevision, IManifest, IPendingPublish, IRevision, TForeignRevisionState, THistoryRevision};

const COPY_BYTES = 4 * 1024 * 1024;

export interface IDocumentState {
    readonly id: string;
    readonly byteRevision: number;
    readonly current: IRevision | null;
    readonly history: readonly THistoryRevision[];
    readonly destination: string | null;
    readonly baseline: string | null;
    /** Versioned text-identity token for the current revision, or `null` when absent/legacy/damaged. */
    readonly textIdentity: string | null;
    /** Unsaved state not yet in the bytes, applying to `current`; `undefined` when there is none. */
    readonly drafts: unknown;
    readonly dirty: boolean;
    /** Its unsaved work is in a revision file this computer cannot read; see `DamagedDocumentError`. */
    readonly damaged: boolean;
}

export interface IDraftRevisionGuard {
    byteRevision?: number;
    baseline?: string | null;
    foreignStaged?: boolean;
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
export type TPublishResult = {status: 'published'; keptOriginal?: string; witness: string} | {status: 'conflict'; keptOriginal?: string};

/** Everything platform-specific about where a document is saved. */
export interface IPublicationPort {
    /**
     * The witness of the destination now; `null` when it has no readable content. A platform may answer with
     * file metadata alone unless `content` asks for the content witness too, which reads every byte.
     */
    witness(destination: string, content?: boolean): Promise<string | null>;
    /**
     * Ends what the interrupted publish `record` left at its destination, which held `baseline` before (on desktop, its
     * staged copy and the file it moved aside), then answers as `witness` does. Throws while the destination cannot be
     * read. Without it, recovery asks `witness`, for the content when the record's witness names it.
     */
    settle?(record: IPendingPublish, baseline: string | null): Promise<string | null>;
    /** The destination's bytes, to copy in as the first revision. */
    source(destination: string): Promise<TExternalSource>;
    /**
     * Writes `source` to `destination`. Before the destination changes, `stage` receives the witness the
     * destination will have, and is awaited: the core records it as the pending publish. A platform that stages a
     * file beside the destination passes its path to `reserve` before creating it, so recovery removes it. With
     * `expected`, refuses with `conflict` unless the destination's witness still equals it, checked as close to the
     * write as the platform allows. Refusals of another kind (locked, read-only, folder not writable) throw the
     * adapter's own error.
     */
    publish(
        destination: string,
        source: IPublishSource,
        expected: string | null,
        stage: (witness: string) => Promise<void>,
        reserve?: (temp: string) => Promise<void>,
    ): Promise<TPublishResult>;
}

export interface IDocumentStore {
    port: IStorePort;
    publication: IPublicationPort;
}

export type TRevisionWriter = (file: IStoreFile) => Promise<void>;
/** Where a new revision file's bytes come from: copied in, written, or a file the store takes over. */
type TRevisionSource = TExternalSource | TRevisionWriter | {move: string};
/** The drafts a mutation leaves: the current ones, new ones (`undefined` clears), or none. */
export type TDraftsAfter = 'keep' | 'clear' | {replace: unknown};
/**
 * New bytes for a document: written from `source`, with `imported` its baseline and no history, as `TDocumentInit`'s,
 * or `openOnly` when the bytes are solely an open-time normalization/decryption/repair rather than a user edit;
 * `move`: a file the caller wrote on the store's file system and gives up; `extend`: what the caller appended to the
 * current file, up to its end, after `ownCurrentFile`.
 */
export type TReplacement =
    | {kind: 'rewrite'; source: TExternalSource | TRevisionWriter; imported?: boolean; openOnly?: boolean}
    | {kind: 'move'; file: string}
    | {kind: 'extend'};
export type TTextIdentityChange = 'inherit' | 'refresh';
export type TMutation = ({kind: 'append'; bytes: Uint8Array} | TReplacement) & {
    drafts: TDraftsAfter;
    /**
     * `'inherit'` reuses the parent revision's versioned text identity only when the writer is proven to preserve
     * extracted page text and geometry (and the parent carries a valid current-version identity). Defaults to `'refresh'`.
     */
    textIdentity?: TTextIdentityChange;
};
export type TStaleRevision = {status: 'stale-revision'; current: IRevision | null};
export type TMutationResult = {status: 'committed'; revision: IRevision} | TStaleRevision | {status: 'conflict'};
export type TDraftResult = {status: 'stored'; revision: IRevision | null} | TStaleRevision | {status: 'conflict'};
/** `revision` is `null` after a restore to the destination's bytes: the document reads its destination again. */
export type TRestoreResult = {status: 'committed'; revision: IRevision | null} | TStaleRevision | {status: 'conflict'};
/**
 * `imported`: bytes the person supplied without a destination; they are the baseline, so the document starts clean.
 * `openOnly`: bytes produced solely during an open without a destination, eligible for cleanup if interrupted before any edit.
 * `id`: the directory's id when the caller must know it first, for example to lock it before it exists. A writer
 * `source` writes the first revision itself, such as bytes arriving as a stream. `name`: the file name the document
 * is created under; the manifest keeps it, and its extension, or `bin`, names the revision files, as `ext` does.
 */
export type TDocumentInit = ({ext: string} | {name: string}) & {id?: string} & (
        {destination: string} | {source: TExternalSource | TRevisionWriter; imported?: boolean; openOnly?: boolean}
    );

const extensionOf = (name: string) => /\.([A-Za-z0-9]{1,16})$/u.exec(name)?.[1]?.toLowerCase() ?? 'bin';

/**
 * The manifest names a current revision whose file is missing or short, as when a profile comes back without it. The
 * directory stays as it is for an open that finds the file; meanwhile it reads as its destination, stays unsaved, and
 * refuses every change and Save with this.
 */
export class DamagedDocumentError extends Error {}

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
    /** Monotonic epoch bumped only when the current bytes or baseline identity actually changes. */
    private byteRevision = 0;

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
        const ext = 'name' in init ? extensionOf(init.name) : init.ext;
        if (!EXT_PATTERN.test(ext)) {
            throw new Error(`Unsupported document extension: ${ext}`);
        }
        const id = init.id ?? crypto.randomUUID();
        if (!STORE_ID_PATTERN.test(id)) {
            throw new Error(`Invalid document directory id: ${id}`);
        }
        const manifest: IManifest = {version: 1, ext, ...('name' in init ? {name: init.name} : {}), next: 2, history: []};
        const doc = new DocumentDirectory(id, store, manifest, null, undefined);
        if ('destination' in init) {
            const baseline = await store.publication.witness(init.destination);
            if (baseline === null) {
                throw new Error('The destination has no readable content');
            }
            await doc.commitFirst(
                {...manifest, destination: init.destination, baseline, destinationTextIdentity: mintTextIdentity()},
                null,
                undefined,
            );
        } else {
            const name = `r1.${ext}`;
            const {file, length, witness} = await doc.createRevisionFile(name, init.source, init.imported === true);
            const current: IRevision = {
                id: 1,
                file: name,
                length,
                witness,
                textIdentity: mintTextIdentity(),
                ...(init.openOnly === true && init.imported !== true ? {openOnly: true as const} : {}),
            };
            await doc.commitFirst({...manifest, current, baseline: witness}, file, undefined);
        }
        return doc;
    }

    /**
     * A new, independent directory holding a clone of the source's current bytes with the same revision ids,
     * destination, baseline and drafts, and no history. The caller holds the source's lock.
     */
    static async fork(store: IDocumentStore, sourceId: string, id: string = crypto.randomUUID()) {
        if (![sourceId, id].every((value) => STORE_ID_PATTERN.test(value))) {
            throw new Error(`Invalid document directory id: ${sourceId} or ${id}`);
        }
        const {port} = store;
        const from = (name: string) => `${DOCUMENTS_DIR}/${sourceId}/${name}`;
        const manifest = decodeManifest(await port.read(from(MANIFEST_NAME)));
        const {current, drafts} = manifest;
        const doc = new DocumentDirectory(id, store, {...manifest, current: undefined, history: [], drafts: undefined}, null, undefined);
        let value: unknown;
        if (drafts !== undefined) {
            const bytes = await port.read(from(drafts));
            await port.writeAtomic(doc.path(drafts), bytes);
            value = decodeJson(bytes);
        }
        let file: IStoreFile | null = null;
        try {
            if (current) {
                await port.copy(from(current.file), doc.path(current.file));
            }
            file = current ? await port.open(doc.path(current.file)) : null;
            // Native tools read the copy to its end: what lies past `current.length` (a redo, an uncommitted append) goes.
            if (current && file && (await file.size()) > current.length) {
                await file.truncate(current.length);
            }
        } catch (error) {
            await file?.close().catch(() => undefined);
            if (current) {
                await port.remove(doc.path(current.file)).catch(() => undefined);
            }
            throw error;
        }
        await doc.commitFirst({...manifest, history: []}, file, value);
        return doc;
    }

    /** Opens a directory after a crash or a clean close alike: the three recovery steps of the model. */
    static async open(store: IDocumentStore, id: string) {
        if (!STORE_ID_PATTERN.test(id)) {
            throw new Error(`Invalid document directory id: ${id}`);
        }
        const {port} = store;
        const dir = `${DOCUMENTS_DIR}/${id}`;
        const names = await port.list(dir);
        const manifest = decodeManifest(await port.read(`${dir}/${MANIFEST_NAME}`));
        const {current} = manifest;
        const file = current && names.includes(current.file) ? await port.open(`${dir}/${current.file}`) : null;
        try {
            if (current && (!file || (await file.size()) < current.length)) {
                await file?.close();
                return new DocumentDirectory(
                    id,
                    store,
                    {...manifest, current: undefined, history: [], drafts: undefined},
                    null,
                    undefined,
                    true,
                );
            }
            return await DocumentDirectory.recover(store, id, names, manifest, file);
        } catch (error) {
            await file?.close().catch(() => undefined);
            throw error;
        }
    }

    private static async recover(store: IDocumentStore, id: string, names: string[], manifest: IManifest, file: IStoreFile | null) {
        const {port} = store;
        const dir = `${DOCUMENTS_DIR}/${id}`;
        const {current} = manifest;
        if (current && file) {
            // 1. Cut an unfinished append. A redo revision can name the same file further than `current`.
            const size = await file.size();
            const named = Math.max(
                ...[current, ...manifest.history.filter(hasFile)]
                    .filter((revision) => revision.file === current.file)
                    .map((revision) => revision.length),
            );
            if (size > named) {
                await file.truncate(named);
                await file.flush();
            }
        }
        // 2. Delete what the manifest does not name, including drafts and temporary files of unfinished commits.
        const keep = new Set([MANIFEST_NAME, ...namedFiles(manifest)]);
        for (const name of names) {
            if (!keep.has(name)) {
                await port.remove(`${dir}/${name}`);
            }
        }
        const drafts = manifest.drafts === undefined ? undefined : decodeJson(await port.read(`${dir}/${manifest.drafts}`));
        const doc = new DocumentDirectory(id, store, manifest, file, drafts);
        // 3. Settle a publish that was under way.
        await doc.resolvePending();
        return doc;
    }

    state(): IDocumentState {
        const {manifest} = this;
        return {
            id: this.id,
            byteRevision: this.byteRevision,
            current: manifest.current ?? null,
            history: manifest.history,
            destination: manifest.destination ?? null,
            baseline: manifest.baseline ?? null,
            textIdentity: this.damaged ? null : currentTextIdentity(manifest),
            drafts: this.drafts,
            dirty: this.damaged || isDirty(manifest),
            damaged: this.damaged,
        };
    }

    /** Reads the current revision. It does not wait for queued calls: the bytes a revision names never change. */
    read(offset: number, length: number) {
        const current = this.manifest.current;
        if (!current) {
            throw new Error('The document has no bytes of its own yet: read its destination');
        }
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
        return this.run(() => this.applyRestore(expected, revisionId));
    }

    async applyRestore(expected: number | null, revisionId: number): Promise<TRestoreResult> {
        const stale = this.staleRevision(expected);
        if (stale) {
            return stale;
        }
        const {manifest} = this;
        const {current} = manifest;
        if ((current?.id ?? 1) === revisionId) {
            return {status: 'committed', revision: current ?? null};
        }
        const target = manifest.history.find((revision) => revision.id === revisionId);
        if (!target) {
            return {status: 'stale-revision', current: current ?? null};
        }
        if (
            !hasFile(target) &&
            !(
                sameWitness(target.witness, manifest.baseline) &&
                manifest.destination !== undefined &&
                sameWitness(await this.store.publication.witness(manifest.destination), target.witness)
            )
        ) {
            return {status: 'conflict'};
        }
        let file = hasFile(target) ? this.file : null;
        if (hasFile(target)) {
            // `open` creates a missing file: the revision must be there, whole, before the manifest names it.
            const {port} = this.store;
            if (target.file !== current?.file) {
                file = (await port.list(`${DOCUMENTS_DIR}/${this.id}`)).includes(target.file)
                    ? await port.open(this.path(target.file))
                    : null;
            }
            try {
                if (!file || (await file.size()) < target.length) {
                    throw new DamagedDocumentError(`Revision ${target.id} of document ${this.id} is missing or cut short`);
                }
            } catch (error) {
                if (file !== this.file) {
                    await file?.close().catch(() => undefined);
                }
                throw error;
            }
        }
        await this.commit(
            {
                ...manifest,
                current: hasFile(target) ? target : undefined,
                ...(!hasFile(target) ? {destinationTextIdentity: target.textIdentity} : {}),
                history: this.historyAfter(manifest.history.filter((revision) => revision !== target)),
                drafts: undefined,
            },
            file,
        );
        return {status: 'committed', revision: hasFile(target) ? target : null};
    }

    /** Keeps exactly the revisions `revisionIds` names in history, from now on and after every change. */
    retain(revisionIds: readonly number[]) {
        return this.run(async () => {
            this.retained = new Set(revisionIds);
            const history = this.manifest.history.filter((revision) => this.retained.has(revision.id));
            if (history.length < this.manifest.history.length) {
                await this.commit({...this.manifest, history});
            }
        });
    }

    /**
     * Stores unsaved state for revision `expected`; `undefined` deletes it. Nothing is copied: without bytes of its own
     * the drafts apply to the destination the baseline names, and a Save meets a destination changed since as a conflict.
     * Captures `byteRevision`, `baseline` and `foreignStaged` synchronously (or from `guard` captured before an async
     * pre-step) so an unchanged `null -> 1` materialization and backing-file moves are accepted while any byte change,
     * rewrite+undo, foreign-bytes staging, or baseline replacement (`saveAs`) is rejected as `stale-revision`.
     */
    setDrafts(expected: number | null, drafts: unknown, guard?: IDraftRevisionGuard) {
        const capturedByteRevision = guard?.byteRevision ?? this.byteRevision;
        const capturedBaseline = guard?.baseline !== undefined ? guard.baseline : (this.manifest.baseline ?? null);
        const capturedForeignStaged = guard?.foreignStaged ?? this.manifest.current?.foreign === 'staged';
        return this.run(async (): Promise<TDraftResult> => {
            const stale = this.staleDraftRevision(expected, capturedByteRevision, capturedBaseline, capturedForeignStaged);
            if (stale) {
                return stale;
            }
            const after = await this.writeDrafts({replace: drafts});
            await this.commit({...this.manifest, drafts: after.name}, this.file, after.value);
            return {status: 'stored', revision: this.manifest.current ?? null};
        });
    }

    /**
     * Gives the document bytes of its own, copying the destination in when it has none, for readers that need a
     * file. The revision id stays what a caller expecting `null` meets as revision 1. `null` on a conflict; `asItIs`
     * as for `ensureCurrent`.
     */
    materialize(asItIs = false) {
        return this.run(() => this.ensureCurrent(asItIs));
    }

    /**
     * Makes the current revision's file hold exactly its bytes, for readers that read a file to its end and for a
     * caller that appends to it in place and commits with `extend`. Revisions that name more of the file, such as a
     * redo after an undo, move to a copy of it; bytes past the revision, which belong to nobody (what a failed append
     * left, say), are cut. Returns the current revision; `null`, changing nothing, when the document has no bytes of
     * its own.
     */
    ownCurrentFile() {
        return this.run(() => this.applyOwnCurrentFile());
    }

    async applyOwnCurrentFile() {
        const {current} = this.manifest;
        if (!current) {
            return null;
        }
        const longer = this.longerThanCurrent();
        if (longer.length > 0) {
            await this.moveToCopy(longer);
        }
        if ((await this.currentFile().size()) > current.length) {
            await this.currentFile().truncate(current.length);
        }
        return current;
    }

    /**
     * Stops using the current file: every revision in it moves to a copy holding exactly what they name, so a writer
     * that may still be appending to the old file writes where nobody reads. The old file goes once nothing holds it.
     */
    abandonCurrentFile() {
        return this.run(async () => {
            const {current, history} = this.manifest;
            if (current) {
                await this.moveToCopy([current, ...history.filter(hasFile).filter((other) => other.file === current.file)]);
            }
        });
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
            this.refusal ??= new Error(`Document ${this.id} is closed`);
            await this.file?.close();
            this.file = null;
        });
        this.tail = closed.catch(() => undefined);
        return closed;
    }

    // The members below are the steps `saveDocument` composes; application code uses the methods above.

    /** Runs `task` after every earlier call on this directory has settled; a damaged or refusing directory runs nothing. */
    run<T>(task: () => Promise<T>): Promise<T> {
        if (this.damaged) {
            return Promise.reject(
                new DamagedDocumentError(`The unsaved changes of document ${this.id} are in a revision file that is missing or cut short`),
            );
        }
        const result = this.tail.then(() => {
            if (this.refusal) {
                throw this.refusal;
            }
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
        if (!this.file) {
            throw new Error(`Document ${this.id} has no open revision file`);
        }
        return this.file;
    }

    staleRevision(expected: number | null): TStaleRevision | null {
        const current = this.manifest.current ?? null;
        return (current?.id ?? null) === expected ? null : {status: 'stale-revision', current};
    }

    private staleDraftRevision(
        expected: number | null,
        capturedByteRevision: number,
        capturedBaseline: string | null,
        capturedForeignStaged: boolean,
    ): TStaleRevision | null {
        const {current, baseline, destination} = this.manifest;
        const stale: TStaleRevision = {status: 'stale-revision', current: current ?? null};
        if (capturedForeignStaged || current?.foreign === 'staged' || this.byteRevision !== capturedByteRevision) {
            return stale;
        }
        if ((current?.id ?? null) === expected) {
            if (expected === null && !sameWitness(baseline, capturedBaseline)) {
                return stale;
            }
            return null;
        }
        if (
            expected === null &&
            destination !== undefined &&
            current?.id === 1 &&
            sameWitness(current.witness, capturedBaseline) &&
            sameWitness(baseline, capturedBaseline)
        ) {
            return null;
        }
        return stale;
    }

    /**
     * A rewrite or move supplies all the new bytes: on a document without bytes of its own nothing is copied in, the
     * destination's bytes stay revision 1 for undo, and the baseline still guards the publication. An append needs
     * them in front, so it copies them in. An append or extend grows the current file in place unless another
     * revision names more of it.
     */
    async applyMutation(expected: number | null, mutation: TMutation): Promise<TMutationResult> {
        const stale = this.staleRevision(expected);
        if (stale) {
            return stale;
        }
        const base = mutation.kind === 'append' ? await this.ensureCurrent() : this.manifest.current;
        if (base === null) {
            return {status: 'conflict'};
        }
        // Drafts first: a failure leaves no open revision file, only a drafts file recovery deletes.
        const drafts = await this.writeDrafts(mutation.drafts);
        const manifest = this.manifest;
        const id = manifest.next;
        const isImported = mutation.kind === 'rewrite' && mutation.imported === true;
        const parentTextIdentity = currentTextIdentity(manifest);
        const textIdentity =
            !isImported && mutation.textIdentity === 'inherit' && parentTextIdentity !== null ? parentTextIdentity : mintTextIdentity();
        let revision: IRevision;
        let file = this.file;
        const extended = base && this.longerThanCurrent().length === 0 ? base : null;
        if ((mutation.kind === 'append' || mutation.kind === 'extend') && extended) {
            if (mutation.kind === 'append') {
                await this.currentFile().writeAt(extended.length, mutation.bytes);
            }
            await this.currentFile().flush();
            const length = mutation.kind === 'append' ? extended.length + mutation.bytes.byteLength : await this.currentFile().size();
            revision = {id, file: extended.file, length, textIdentity};
        } else if (mutation.kind === 'extend') {
            throw new Error(`Document ${this.id} cannot extend a file another revision extends`);
        } else {
            const name = `r${id}.${manifest.ext}`;
            const source =
                mutation.kind === 'rewrite'
                    ? mutation.source
                    : mutation.kind === 'move'
                      ? {move: mutation.file}
                      : this.copyThenAppend(base!, mutation.bytes);
            const created = await this.createRevisionFile(name, source, isImported);
            file = created.file;
            const canMarkOpenOnly =
                mutation.kind === 'rewrite' &&
                mutation.openOnly === true &&
                !isImported &&
                drafts.name === undefined &&
                hasNoUserEdits(manifest);
            revision = {
                id,
                file: name,
                length: created.length,
                witness: created.witness,
                textIdentity,
                ...(canMarkOpenOnly ? {openOnly: true as const} : {}),
            };
        }
        const history = revision.witness === undefined ? this.historyAfter(manifest.history) : [];
        await this.commit(
            {...manifest, next: id + 1, current: revision, history, baseline: revision.witness ?? manifest.baseline, drafts: drafts.name},
            file,
            drafts.value,
        );
        return {status: 'committed', revision};
    }

    /** Moves `moved`, revisions in one file, to a copy of it cut to the most they name: one manifest replace. */
    private async moveToCopy(moved: readonly IRevision[]) {
        const {manifest} = this;
        const {port} = this.store;
        const name = `r${manifest.next}.${manifest.ext}`;
        const length = Math.max(...moved.map((revision) => revision.length));
        let file: IStoreFile | undefined;
        try {
            await port.copy(this.path(moved[0]!.file), this.path(name));
            file = await port.open(this.path(name));
            if ((await file.size()) > length) {
                await file.truncate(length);
            }
        } catch (error) {
            await file?.close().catch(() => undefined);
            await port.remove(this.path(name)).catch(() => undefined);
            throw error;
        }
        const rename = <T extends THistoryRevision>(revision: T): T =>
            moved.includes(revision as IRevision) ? ({...revision, file: name} as T) : revision;
        const current = manifest.current && rename(manifest.current);
        if (current === manifest.current) {
            await file.close();
        }
        await this.commit(
            {...manifest, next: manifest.next + 1, current, history: manifest.history.map(rename)},
            current === manifest.current ? this.file : file,
        );
    }

    /** The revisions that name more of the current file than the current revision: it may grow in place without them. */
    private longerThanCurrent() {
        const {current, history} = this.manifest;
        return history
            .filter(hasFile)
            .filter((other) => current !== undefined && other.file === current.file && other.length > current.length);
    }

    /** The history a change leaves: what the caller retains, and the revision the change replaces. */
    private historyAfter(history: readonly THistoryRevision[]): THistoryRevision[] {
        const {current, baseline} = this.manifest;
        const archived: IRevision | undefined = current?.foreign === 'staged' ? {...current, foreign: 'committed'} : current;
        const replaced: THistoryRevision | undefined =
            archived ??
            (baseline === undefined
                ? undefined
                : {
                      id: 1,
                      witness: baseline,
                      ...(this.manifest.destinationTextIdentity === undefined ? {} : {textIdentity: this.manifest.destinationTextIdentity}),
                  });
        return [
            ...history.filter((revision) => this.retained.has(revision.id) && revision.id !== replaced?.id),
            ...(replaced ? [replaced] : []),
        ];
    }

    /**
     * Gives revision 1, which history keeps without a file while the destination holds it, a file of its own: a publish
     * is about to replace the destination's bytes or make another file the destination. Nothing when history keeps no
     * such revision, or when the destination no longer holds it or cannot be read: the publish goes ahead, and undo to
     * that revision is refused as before.
     */
    async keepDestinationRevision() {
        const {manifest} = this;
        const {destination} = manifest;
        const kept = manifest.history.find((revision) => !hasFile(revision));
        if (!kept || destination === undefined || !sameWitness(kept.witness, manifest.baseline)) {
            return;
        }
        const name = `r1.${manifest.ext}`;
        const created = await this.createFromDestination(name).catch(() => null);
        if (!created) {
            return;
        }
        await created.file.close();
        const revision: IRevision = {
            id: 1,
            file: name,
            length: created.length,
            witness: kept.witness,
            ...(kept.textIdentity === undefined ? {} : {textIdentity: kept.textIdentity}),
        };
        await this.commit({...manifest, history: manifest.history.map((other) => (other === kept ? revision : other))});
    }

    /**
     * The current revision, copying the destination in as revision 1 when there is none; `null` on a conflict (see
     * `createFromDestination`). With `asItIs`, a destination another program changed is taken as it is now, for a
     * Save that builds on it: those bytes are not the baseline, so Save refuses them and Save As publishes them.
     */
    async ensureCurrent(asItIs = false): Promise<IRevision | null> {
        const {manifest} = this;
        if (manifest.current) {
            return manifest.current;
        }
        if (manifest.destination === undefined) {
            throw new Error(`Document ${this.id} has neither bytes nor a destination`);
        }
        const name = `r1.${manifest.ext}`;
        const created = await this.createFromDestination(name, asItIs);
        if (!created) {
            return null;
        }
        const inheritedTextIdentity =
            created.witness === undefined ? mintTextIdentity() : (parseTextIdentity(manifest.destinationTextIdentity) ?? undefined);
        const current: IRevision = {
            id: 1,
            file: name,
            length: created.length,
            witness: created.witness,
            ...(inheritedTextIdentity === undefined ? {} : {textIdentity: inheritedTextIdentity}),
            ...(created.witness === undefined ? {foreign: 'staged' as const} : {}),
        };
        await this.commit({...manifest, current}, created.file);
        return current;
    }

    /**
     * A revision file copied from the destination, with the baseline as its witness while the destination holds it.
     * `null`, and no file, when the destination changed during the copy, or no longer holds the baseline unless
     * `asItIs`: edits land on bytes the person has not seen only when a Save asks for that.
     */
    private async createFromDestination(name: string, asItIs = false) {
        const {publication} = this.store;
        const {destination, baseline} = this.manifest;
        const before = await publication.witness(destination!);
        if (!asItIs && !sameWitness(before, baseline)) {
            return null;
        }
        const created = await this.createRevisionFile(name, await publication.source(destination!));
        const discard = async () => {
            await created.file.close().catch(() => undefined);
            await this.store.port.remove(this.path(name));
        };
        const after = await publication.witness(destination!).catch(async (error: unknown) => {
            await discard();
            throw error;
        });
        const unchanged = sameWitness(after, baseline);
        if (sameWitness(before, after) && (unchanged || asItIs)) {
            return {...created, witness: unchanged ? baseline : undefined};
        }
        await discard();
        return null;
    }

    /**
     * Recovery step 3, also run before every Save: settles each publish whose outcome is unknown and drops its record,
     * adopting the latest when its destination holds what it published. A record whose destination cannot be read
     * now, for example held by another program, stays for the next open or Save.
     */
    async resolvePending() {
        const {manifest} = this;
        const {pendingPublish: pending, unsettled = []} = manifest;
        if (!pending && unsettled.length === 0) {
            return;
        }
        const {publication} = this.store;
        // A witness without content names the published file by its metadata, which is enough to compare.
        const settle = (record: IPendingPublish, baseline: string | undefined) =>
            (publication.settle
                ? publication.settle(record, baseline ?? null)
                : publication.witness(record.destination, contentOf(record.witness) !== undefined)
            ).catch(() => undefined);
        const left: IPendingPublish[] = [];
        for (const record of unsettled) {
            if ((await settle(record, record.baseline)) === undefined) {
                left.push(record);
            }
        }
        const witness = pending && (await settle(pending, manifest.baseline));
        const adopted =
            pending && witness && sameWitness(witness, pending.witness)
                ? {
                      destination: pending.destination,
                      baseline: witness,
                      ...(manifest.current === undefined && !sameWitness(witness, manifest.baseline)
                          ? {destinationTextIdentity: mintTextIdentity()}
                          : {}),
                      ...(manifest.current?.foreign === 'staged' && sameWitness(manifest.current.witness, pending.witness)
                          ? {current: {...manifest.current, foreign: 'committed' as const}}
                          : {}),
                  }
                : {};
        const next = {
            ...manifest,
            ...adopted,
            pendingPublish: witness === undefined ? pending : undefined,
            unsettled: left.length > 0 ? left : undefined,
        };
        if (JSON.stringify(next) !== JSON.stringify(manifest)) {
            await this.commit(next);
        }
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
    async commit(next: IManifest, file: IStoreFile | null = this.file, drafts: unknown = this.drafts, initial = false) {
        const {port} = this.store;
        const before = this.manifest;
        const text = JSON.stringify(next);
        let failure: unknown;
        try {
            await port.writeAtomic(this.path(MANIFEST_NAME), new TextEncoder().encode(text));
        } catch (error) {
            failure = error;
            const onDisk = await port.read(this.path(MANIFEST_NAME)).then(
                (bytes) => new TextDecoder().decode(bytes),
                () => null,
            );
            if (onDisk !== text) {
                if (file !== this.file) {
                    await file?.close().catch(() => undefined);
                }
                if (onDisk !== JSON.stringify(before)) {
                    this.refusal = new Error(`Document ${this.id} lost track of its manifest; open it again`, {cause: error});
                }
                throw error;
            }
        }
        this.manifest = next;
        this.drafts = next.drafts === undefined ? undefined : drafts;
        if (!initial) {
            this.recordRevisionChange(before, next);
        }
        if (file !== this.file) {
            await this.file?.close().catch(() => undefined);
            this.file = file;
        }
        if (failure !== undefined) {
            throw failure;
        }
        const named = namedFiles(next);
        for (const name of namedFiles(before)) {
            if (!named.has(name)) {
                await port.remove(this.path(name)).catch(() => undefined);
            }
        }
    }

    /**
     * The first manifest of a directory nobody holds yet. One that fails, even after it replaced the manifest, leaves
     * no file of the directory open: the caller removes the directory, which an open file blocks on some platforms
     * (the origin private file system, Windows).
     */
    private async commitFirst(next: IManifest, file: IStoreFile | null, drafts: unknown) {
        try {
            await this.commit(next, file, drafts, true);
        } catch (error) {
            await this.file?.close().catch(() => undefined);
            this.file = null;
            throw error;
        }
    }

    /**
     * Updates the single-owner byte-revision epoch when `manifest` moves from `before` to `next`.
     * Unchanged materialization, backing-file moves (`moveToCopy`), history retention, drafts writes and `pendingPublish`
     * bookkeeping leave `byteRevision` unchanged; any real change to current bytes, foreign state or unmaterialized
     * baseline identity advances it.
     */
    private recordRevisionChange(before: IManifest, next: IManifest) {
        const unchangedMaterialization =
            before.current === undefined &&
            next.current?.id === 1 &&
            next.current.foreign === undefined &&
            next.current.witness !== undefined &&
            sameWitness(next.current.witness, before.baseline) &&
            sameWitness(next.baseline, before.baseline);
        if (unchangedMaterialization) {
            return;
        }
        const currentChanged = before.current?.id !== next.current?.id || before.current?.foreign !== next.current?.foreign;
        const unmaterializedBaselineChanged =
            before.current === undefined &&
            next.current === undefined &&
            before.baseline !== next.baseline &&
            !sameWitness(before.baseline, next.baseline);
        if (currentChanged || unmaterializedBaselineChanged) {
            this.byteRevision += 1;
        }
    }

    /** Writes the drafts a change leaves as a new file, for the change's manifest to name. */
    private async writeDrafts(after: TDraftsAfter): Promise<{name: string | undefined; value: unknown}> {
        if (after === 'keep') {
            return {name: this.manifest.drafts, value: this.drafts};
        }
        if (after === 'clear' || after.replace === undefined) {
            return {name: undefined, value: undefined};
        }
        const name = `drafts-${crypto.randomUUID()}.json`;
        await this.store.port.writeAtomic(this.path(name), encodeJson(after.replace));
        return {name, value: after.replace};
    }

    /** Creates a revision file from `source`; with `withWitness`, also returns the content witness of its bytes. */
    private async createRevisionFile(name: string, source: TRevisionSource, withWitness = false) {
        const {port} = this.store;
        const path = this.path(name);
        try {
            if (typeof source === 'object' && 'move' in source) {
                if (!port.move) {
                    throw new Error('This store cannot take files in');
                }
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
                const witness = withWitness ? await file.witness(length) : undefined;
                return {file, length, witness};
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
        return async (target) => {
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
