import { sameWitness } from './contentWitness';
import type {
    DocumentDirectory,
    IPendingPublish,
    IRevision,
    TPublishResult,
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
        // Save As publishes a destination another program changed as it is now; a plain Save refuses it below.
        const current = await doc.ensureCurrent(saveAs !== undefined);
        if (!current) return { status: 'conflict' };
        if (saveAs === undefined && sameWitness(current.witness, baseline)) return { status: 'saved', revision: current };
        await doc.keepDestinationRevision();

        // This publish's record: first the file it stages beside the destination, then the witness it stages. The
        // current bytes carry the witness too, so recovery that adopts it leaves the document clean. An earlier publish
        // still unresolved is kept to be settled, with the baseline its destination had.
        let own = undefined as IPendingPublish | undefined;
        const record = async (next: IPendingPublish, staged = current) => {
            const manifest = doc.snapshot();
            const earlier = manifest.pendingPublish === own ? undefined : manifest.pendingPublish;
            own = next;
            await doc.commit({
                ...manifest,
                current: staged,
                pendingPublish: own,
                unsettled: earlier ? [...manifest.unsettled ?? [], { ...earlier, baseline: manifest.baseline }] : manifest.unsettled,
            });
        };
        let published: TPublishResult;
        try {
            published = await doc.store.publication.publish(
                destination,
                { path: doc.path(current.file), length: current.length, file: doc.currentFile(), witness: current.witness },
                saveAs === undefined ? baseline ?? null : null,
                witness => record({ ...own, destination, witness }, { ...current, witness }),
                temp => record({ destination, temp }),
            );
        } catch (error) {
            // A publish that failed before staging its bytes left the destination as it was.
            if (own && own.witness === undefined) await doc.commit({ ...doc.snapshot(), pendingPublish: undefined });
            throw error;
        }
        const staged = own?.witness !== undefined;
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
