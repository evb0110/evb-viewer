import type {AnnotationEntity, AnnotationId, ISavedSemanticEntry} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {semanticEntityFingerprint} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

type TKind = AnnotationEntity['kind'];

// A stored entity is deep-frozen once and never changes, so its fingerprint is computed at most once.
const storedFingerprints = new WeakMap<AnnotationEntity, string | null>();

// A frozen subtree was frozen here, whole, so the walk stops at it: storing an edit freezes only its new objects.
function freezeTree(value: unknown) {
    if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value) || Object.isFrozen(value)) {
        return;
    }
    Object.freeze(value);
    Object.values(value).forEach(freezeTree);
}

/**
 * Freezes an entity the store owns: one it built or copied, never a caller's.
 * Readers receive it without a copy; the store replaces it with a new object
 * on every change.
 */
export function freezeStoredEntity<T extends AnnotationEntity>(entity: T): T {
    if (!storedFingerprints.has(entity)) {
        freezeTree(entity);
        storedFingerprints.set(entity, null);
    }
    return entity;
}

export function isStoredEntity(entity: AnnotationEntity) {
    return storedFingerprints.has(entity);
}

/** `semanticEntityFingerprint`, cached for stored entities. */
export function fingerprintOf(entity: AnnotationEntity) {
    const cached = storedFingerprints.get(entity);
    if (cached) {
        return cached;
    }
    const fingerprint = semanticEntityFingerprint(entity);
    if (cached === null) {
        storedFingerprints.set(entity, fingerprint);
    }
    return fingerprint;
}

export function semanticEntryOf(entity: AnnotationEntity): ISavedSemanticEntry {
    return Object.freeze({
        kind: entity.kind,
        deleted: entity.deleted,
        fingerprint: fingerprintOf(entity),
    });
}

/**
 * The kinds for which `entity` and `saved` disagree about the saved document:
 * tombstones contribute nothing to it, so only a live annotation on either side
 * can differ. This is `semanticSnapshotsEqual` for one annotation.
 */
function differingKinds(entity: AnnotationEntity | undefined, saved: ISavedSemanticEntry | undefined): readonly TKind[] {
    const current = entity && !entity.deleted ? entity.kind : null;
    const held = saved && !saved.deleted ? saved.kind : null;
    if (current !== held) {
        return [current, held].filter((kind): kind is TKind => kind !== null);
    }
    return current !== null && fingerprintOf(entity!) !== saved!.fingerprint ? [current] : [];
}

/**
 * The store's entities, tombstones included, and what the saved file holds of
 * them. It indexes entities by page and keeps, per annotation, whether it
 * differs from the saved file, so readers and the dirty check never scan or
 * copy the whole document. Iteration follows insertion order, as a Map does:
 * replacing an entity keeps its place, removing and adding it again moves it
 * to the end.
 */
export class AnnotationEntityTable {
    readonly #entities = new Map<AnnotationId, AnnotationEntity>();
    readonly #insertion = new Map<AnnotationId, number>();
    readonly #pages = new Map<number, Set<AnnotationId>>();
    readonly #tombstones = new Set<AnnotationId>();
    readonly #saved = new Map<AnnotationId, ISavedSemanticEntry>();
    readonly #orphanedSaved = new Set<AnnotationId>();
    readonly #differing = new Map<AnnotationId, readonly TKind[]>();
    readonly #differingByKind = new Map<TKind, number>();
    #nextInsertion = 0;
    #snapshot: readonly AnnotationEntity[] | null = null;
    #liveSnapshot: readonly AnnotationEntity[] | null = null;

    get size() {
        return this.#entities.size;
    }
    get(id: AnnotationId) {
        return this.#entities.get(id);
    }
    has(id: AnnotationId) {
        return this.#entities.has(id);
    }
    keys() {
        return this.#entities.keys();
    }
    values() {
        return this.#entities.values();
    }
    forEach(callback: (entity: AnnotationEntity, id: AnnotationId) => void) {
        this.#entities.forEach(callback);
    }

    /** Stores `entity`, frozen, under `id`. */
    set(id: AnnotationId, entity: AnnotationEntity) {
        const stored = freezeStoredEntity(entity);
        const previous = this.#entities.get(id);
        if (previous === stored) {
            return;
        }
        if (!previous) {
            this.#insertion.set(id, this.#nextInsertion++);
        } else if (previous.pageIndex !== stored.pageIndex) {
            this.#leavePage(id, previous.pageIndex);
        }
        this.#entities.set(id, stored);
        const page = this.#pages.get(stored.pageIndex);
        if (page) {
            page.add(id);
        } else {
            this.#pages.set(stored.pageIndex, new Set([id]));
        }
        if (stored.deleted) {
            this.#tombstones.add(id);
        } else {
            this.#tombstones.delete(id);
        }
        this.#entitiesChanged();
        this.#compare(id);
    }

    delete(id: AnnotationId) {
        const previous = this.#entities.get(id);
        if (!previous) {
            return false;
        }
        this.#entities.delete(id);
        this.#insertion.delete(id);
        this.#leavePage(id, previous.pageIndex);
        this.#tombstones.delete(id);
        this.#entitiesChanged();
        this.#compare(id);
        return true;
    }

    /** Every entity, tombstones included or not; one frozen array until the entities change. */
    snapshot(includeDeleted: boolean) {
        this.#snapshot ??= Object.freeze(Array.from(this.#entities.values()));
        if (includeDeleted) {
            return this.#snapshot;
        }
        this.#liveSnapshot ??= Object.freeze(this.#snapshot.filter((entity) => !entity.deleted));
        return this.#liveSnapshot;
    }

    /**
     * A new frozen snapshot, tombstones included, even when no entity changed: each publication is a distinct
     * array, so a subscriber that keeps the latest one sees every publication as a change.
     */
    publish() {
        this.#entitiesChanged();
        return this.snapshot(true);
    }

    /** The entities on one page, tombstones included, in store order. */
    onPage(pageIndex: number): AnnotationEntity[] {
        return this.#inOrder(this.#pages.get(pageIndex) ?? []).map((id) => this.#entities.get(id)!);
    }

    /** The ids on these pages, tombstones included, in store order; with `andTombstones`, every tombstone as well. */
    idsOnPages(pageIndices: Iterable<number>, andTombstones = false): AnnotationId[] {
        const ids = new Set<AnnotationId>(andTombstones ? this.#tombstones : []);
        new Set(pageIndices).forEach((pageIndex) => this.#pages.get(pageIndex)?.forEach((id) => ids.add(id)));
        return this.#inOrder(ids);
    }

    /** Every tombstone's id, in store order. */
    tombstoneIds(): AnnotationId[] {
        return this.#inOrder(this.#tombstones);
    }

    /** What the saved file holds of each annotation. */
    get saved(): ReadonlyMap<AnnotationId, ISavedSemanticEntry> {
        return this.#saved;
    }

    setSaved(id: AnnotationId, entry: ISavedSemanticEntry | undefined) {
        if (entry === undefined) {
            if (!this.#saved.has(id)) {
                return;
            }
            this.#saved.delete(id);
        } else {
            const stored = Object.isFrozen(entry) ? entry : Object.freeze({...entry});
            if (this.#saved.get(id) === stored) {
                return;
            }
            this.#saved.set(id, stored);
        }
        this.#compare(id);
    }

    /** Saved entries whose annotation the store no longer holds, such as a saved creation that was undone. */
    orphanedSavedIds(): AnnotationId[] {
        return [...this.#orphanedSaved];
    }

    /**
     * Makes the saved file hold what the store holds, which, while nothing
     * differs from it, changes only entries no live annotation reads: each
     * tombstone's, and those of annotations the store no longer holds.
     */
    adoptCurrentAsSaved() {
        if (this.differsFromSaved()) {
            throw new Error('Only a store that matches its saved file can adopt its annotations as saved');
        }
        this.tombstoneIds().forEach((id) => this.setSaved(id, semanticEntryOf(this.#entities.get(id)!)));
        this.orphanedSavedIds().forEach((id) => this.setSaved(id, undefined));
    }

    /** Replaces every entity, in the order given, and the saved file at once, as a page operation's Undo does. */
    replaceAll(entities: ReadonlyMap<AnnotationId, AnnotationEntity>, saved: ReadonlyMap<AnnotationId, ISavedSemanticEntry>) {
        this.#entities.clear();
        this.#insertion.clear();
        this.#pages.clear();
        this.#tombstones.clear();
        this.#saved.clear();
        this.#orphanedSaved.clear();
        this.#differing.clear();
        this.#differingByKind.clear();
        this.#entitiesChanged();
        entities.forEach((entity, id) => this.set(id, entity));
        saved.forEach((entry, id) => this.setSaved(id, entry));
    }

    /** Whether the live annotations, of one kind or all, differ from what the saved file holds. */
    differsFromSaved(kind?: TKind) {
        return kind === undefined ? this.#differing.size > 0 : (this.#differingByKind.get(kind) ?? 0) > 0;
    }

    #leavePage(id: AnnotationId, pageIndex: number) {
        const page = this.#pages.get(pageIndex);
        page?.delete(id);
        if (page?.size === 0) {
            this.#pages.delete(pageIndex);
        }
    }

    #inOrder(ids: Iterable<AnnotationId>) {
        return [...ids].sort((left, right) => this.#insertion.get(left)! - this.#insertion.get(right)!);
    }

    #entitiesChanged() {
        this.#snapshot = null;
        this.#liveSnapshot = null;
    }

    #compare(id: AnnotationId) {
        const entity = this.#entities.get(id);
        const saved = this.#saved.get(id);
        if (saved !== undefined && entity === undefined) {
            this.#orphanedSaved.add(id);
        } else {
            this.#orphanedSaved.delete(id);
        }
        this.#differing.get(id)?.forEach((kind) => this.#differingByKind.set(kind, this.#differingByKind.get(kind)! - 1));
        const kinds = differingKinds(entity, saved);
        kinds.forEach((kind) => this.#differingByKind.set(kind, (this.#differingByKind.get(kind) ?? 0) + 1));
        if (kinds.length > 0) {
            this.#differing.set(id, kinds);
        } else {
            this.#differing.delete(id);
        }
    }
}
