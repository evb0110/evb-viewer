import { contentWitness } from './contentWitness';
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
    | { status: 'conflict' }
    /** There is no destination a plain Save can check: a new document, or one only ever downloaded. */
    | { status: 'needs-save-as' };

/**
 * Save: commit the pending edits as a mutation, so the work is durable whatever happens next; record the
 * witness about to be published as `pendingPublish`; publish, with the destination check done by the
 * publication port; acknowledge by making that witness the baseline. Conflicts and stale revisions are
 * returned once; nothing retries.
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
        if (saveAs === undefined && current.witness === baseline) return { status: 'saved', revision: current };

        const file = doc.currentFile();
        const witness = current.witness ?? await contentWitness(current.length, (offset, length) => file.readAt(offset, length));
        const revision = { ...current, witness };
        await doc.commit({ ...doc.snapshot(), current: revision, pendingPublish: { destination, witness } });
        const published = await doc.store.publication.publish(
            destination,
            { path: doc.path(revision.file), length: revision.length, file },
            saveAs === undefined ? baseline ?? null : null,
        );
        if (published.status === 'conflict') {
            await doc.commit({ ...doc.snapshot(), pendingPublish: undefined });
            return { status: 'conflict' };
        }
        await doc.commit({ ...doc.snapshot(), destination, baseline: witness, pendingPublish: undefined });
        return published.keptOriginal === undefined
            ? { status: 'saved', revision }
            : { status: 'saved', revision, keptOriginal: published.keptOriginal };
    });
}
