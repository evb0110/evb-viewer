import { sameWitness } from './contentWitness';
import type {
    DocumentDirectory,
    IRevision,
    TMutation,
    TStaleRevision,
} from './documentDirectory';

export interface ISaveOptions {
    /** The revision the caller's edits are based on; `null` when the document has no bytes of its own. */
    expected: number | null;
    /** Pending edits to write into the bytes first. */
    commit?: TMutation;
    /** A new destination: Save As. Its result becomes the document's destination. */
    saveAs?: string;
}

export type TSaveResult = { status: 'saved'; revision: IRevision | null; keptOriginal?: string }
    | TStaleRevision
    /** The destination changed since it was last read or written: offer Save As. */
    | { status: 'conflict'; keptOriginal?: string }
    /** There is no destination a plain Save can check: a new document, or one only ever downloaded. */
    | { status: 'needs-save-as' };

/**
 * Save: commit the pending edits as a mutation, so the work is durable whatever happens next; publish, with
 * the destination check done by the publication port, which names the witness the destination is about to
 * have so it is recorded as `pendingPublish` first; acknowledge by making the destination's witness after the
 * write the baseline. Conflicts and stale revisions are returned once; nothing retries.
 */
export function saveDocument(doc: DocumentDirectory, options: ISaveOptions) {
    return doc.run(async (): Promise<TSaveResult> => {
        if (options.commit) {
            const committed = await doc.applyMutation(options.expected, options.commit);
            if (committed.status !== 'committed') return committed;
        } else {
            const stale = doc.staleRevision(options.expected);
            if (stale) return stale;
        }
        await doc.resolvePending();
        const { saveAs } = options;
        const { destination: saved, baseline } = doc.snapshot();
        const destination = saveAs ?? saved;
        if (destination === undefined || (saveAs === undefined && baseline === undefined)) return { status: 'needs-save-as' };
        // Without bytes of its own the document still is its destination: a plain Save has nothing to write.
        if (saveAs === undefined && !doc.snapshot().current) return { status: 'saved', revision: null };
        const current = await doc.ensureCurrent();
        if (!current) return { status: 'conflict' };
        if (saveAs === undefined && sameWitness(current.witness, baseline)) return { status: 'saved', revision: current };

        let staged = false;
        const published = await doc.store.publication.publish(
            destination,
            { path: doc.path(current.file), length: current.length, file: doc.currentFile(), witness: current.witness },
            saveAs === undefined ? baseline ?? null : null,
            // The current bytes carry the witness too, so recovery that adopts it leaves the document clean.
            async (witness) => {
                await doc.commit({ ...doc.snapshot(), current: { ...current, witness }, pendingPublish: { destination, witness } });
                staged = true;
            },
        );
        const kept = published.keptOriginal === undefined ? {} : { keptOriginal: published.keptOriginal };
        if (published.status === 'conflict') {
            // The staged witness named a file the destination did not end up holding: `current` gets its own back.
            if (staged) await doc.commit({ ...doc.snapshot(), current, pendingPublish: undefined });
            return { status: 'conflict', ...kept };
        }
        // The current bytes are now the destination's: both carry its witness.
        const revision = { ...current, witness: published.witness };
        await doc.commit({ ...doc.snapshot(), current: revision, destination, baseline: published.witness, pendingPublish: undefined });
        return { status: 'saved', revision, ...kept };
    });
}
