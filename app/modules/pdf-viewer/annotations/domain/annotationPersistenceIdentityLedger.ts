import type {
    AnnotationEntity,
    AnnotationId,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

/**
 * What the last acknowledged save wrote for an entity: the revision the file
 * holds and the object ref it holds it under. Authored content is never part
 * of it, so replaying a history snapshot must not replay these fields.
 */
interface IPersistenceIdentity {
    readonly persistedRevision: number;
    readonly pdfRef: string | undefined;
}

/**
 * Puts the ref of record on a replayed identity. A ref the record no longer
 * holds was retired with the revision that numbered it, so it is dropped
 * rather than restored: the external identity index binds by presence, and a
 * resurrected number can collide with whichever annotation inherited it. The
 * key is omitted rather than set to `undefined` because the index, the saved
 * semantic fingerprint and `exactOptionalPropertyTypes` all read absence, not
 * an own undefined property, as unbound.
 */
export function rebaseAnnotationPersistenceIdentity(
    identity: AnnotationEntity['identity'],
    pdfRef: string | undefined,
) {
    if (pdfRef !== undefined) {
        return pdfRef === identity.pdfRef ? identity : {
            ...identity,
            pdfRef,
        };
    }
    if (!('pdfRef' in identity)) {
        return identity;
    }
    const {
        pdfRef: _retired,
        ...retained
    } = identity;
    return retained;
}

/** The before/after pair one history command replays for one annotation. */
export interface IAnnotationSnapshotEntry {
    readonly id: AnnotationId;
    readonly before: AnnotationEntity | null;
    readonly after: AnnotationEntity | null;
}

/**
 * The persistence identity of record for canonical annotations, and the only
 * thing that survives an annotation being replayed out of the store.
 *
 * `acknowledgeSave` writes `persistedRevision` and binds `pdfRef` on the live
 * entities, but history commands hold absolute before/after clones taken
 * before that: an undo or a redo replayed wholesale would otherwise restore
 * the persistence state of the moment it was recorded. A redo of a pre-save
 * create is the visible case. It brings back `persistedRevision: -1` with no
 * `pdfRef`, so a saved annotation reports dirty again and delete serialization,
 * which keys off `pdfRef`, has nothing to key on.
 *
 * The rebase happens where a snapshot is replayed rather than by rewriting the
 * retained commands at acknowledgement time, because the authority holding
 * those commands is the workspace ledger; store-side handles on them would pin
 * payloads that the ledger's depth and byte caps exist to release. Reading the
 * live entity first also keeps a later identity change (a failed save's
 * rollback, a re-imported shape ref) ahead of an older acknowledgement instead
 * of resurrecting a retired ref.
 */
export class AnnotationPersistenceIdentityLedger {
    readonly #removed = new Map<AnnotationId, IPersistenceIdentity>();

    /**
     * Rebases one replayed batch onto the persistence identity of record and
     * remembers what the replay removes, in the order the entries apply.
     */
    rebaseReplay(
        entries: readonly IAnnotationSnapshotEntry[],
        live: (id: AnnotationId) => AnnotationEntity | undefined,
    ) {
        return entries.map((entry) => {
            const current = live(entry.id);
            const after = this.#rebase(entry.after, current);
            this.#track(entry.id, after, current);
            return {
                id: entry.id,
                before: entry.before,
                after,
            };
        });
    }

    /** Returns the snapshot with the persistence identity of record applied. */
    #rebase(snapshot: AnnotationEntity | null, live: AnnotationEntity | undefined) {
        if (!snapshot) {
            if (
                live
                && !live.deleted
                && (live.persistedRevision >= 0 || live.identity.pdfRef !== undefined)
            ) {
                // History recorded a creation as null -> entity. Once a save
                // materializes that entity, undo must describe a persisted
                // deletion so the next save can remove the object from the
                // document. Removing it from the store would lose both the
                // delete intent and the PDF object ref that keys the mutation.
                return {
                    ...live,
                    deleted: true,
                    revision: live.revision + 1,
                };
            }
            return snapshot;
        }
        const persisted = this.#identityOf(snapshot.identity.id, live);
        if (!persisted) {
            return snapshot;
        }
        const identity = rebaseAnnotationPersistenceIdentity(snapshot.identity, persisted.pdfRef);
        // A saved delete retires the PDF object. Undoing that delete restores a
        // live transient, even though the tombstone itself carries the save's
        // revision while it waits to be serialized. Never let the retired
        // revision make the restored entity look clean.
        const restoredAfterSavedDelete = Boolean(
            live?.deleted
            && !snapshot.deleted
            && live.persistedRevision >= 0
            && live.identity.pdfRef === undefined,
        );
        const persistedRevision = restoredAfterSavedDelete
            ? -1
            : persisted.persistedRevision;
        if (identity === snapshot.identity && persistedRevision === snapshot.persistedRevision) {
            return snapshot;
        }
        return {
            ...snapshot,
            identity,
            persistedRevision,
        };
    }

    /**
     * Remembers the persistence identity of an entity a replay removes, so a
     * redo of a saved create restores the saved annotation rather than a fresh
     * transient. Nothing is remembered for an entity the file never held, and
     * the record is dropped as soon as the entity is back, so this only ever
     * holds ids an undo took out of the store.
     */
    #track(id: AnnotationId, replayed: AnnotationEntity | null, live: AnnotationEntity | undefined) {
        if (replayed) {
            this.#removed.delete(id);
            return;
        }
        const persisted = this.#identityOf(id, live);
        if (persisted && (persisted.persistedRevision >= 0 || persisted.pdfRef !== undefined)) {
            this.#removed.set(id, persisted);
        }
    }

    /** Hard removal: the id can no longer come back through history. */
    forget(id: AnnotationId) {
        this.#removed.delete(id);
    }

    /**
     * Drops every remembered identity, which a save acknowledgement must do:
     * an annotation an undo took out of the store was not part of the save, so
     * the acknowledged bytes say nothing about it and may have been written
     * without it. A later redo then restores it as the transient it provably
     * is instead of binding it to a ref this revision may no longer hold.
     */
    clear() {
        this.#removed.clear();
    }

    /** The live entity is the record; a replay-removed one keeps its last one. */
    #identityOf(id: AnnotationId, live: AnnotationEntity | undefined) {
        if (live) {
            return {
                persistedRevision: live.persistedRevision,
                pdfRef: live.identity.pdfRef,
            };
        }
        return this.#removed.get(id) ?? null;
    }
}
