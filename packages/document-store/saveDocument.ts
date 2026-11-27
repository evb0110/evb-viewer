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

export type TSaveResult = {
    status: 'saved';
    revision: IRevision | null;
    keptOriginal?: string;
    /** Confirmed true when the destination write succeeded, even if final manifest acknowledgement failed. */
    externalWriteCommitted?: true;
    /** Present when the destination write succeeded, but final manifest acknowledgement failed. */
    acknowledgmentError?: unknown;
    /** Surviving pending publish witness left on disk for recovery when acknowledgement failed. */
    pendingPublish?: IPendingPublish;
}
    | TStaleRevision
    /** The destination changed since it was last read or written: offer Save As. */
    | {
        status: 'conflict';
        keptOriginal?: string;
        /** Present when staging cleanup could not clear the manifest; pendingPublish survives for recovery. */
        acknowledgmentError?: unknown;
        pendingPublish?: IPendingPublish;
    }
    /** There is no destination a plain Save can check: a new document, or one only ever downloaded. */
    | { status: 'needs-save-as' };

/**
 * Publication failure carrying what the publication owner knows about the destination:
 * `false` when failure happened before staging completed, `null` when the write outcome is unverified
 * (with `pendingPublish` preserved for recovery), or `true` when post-publication bookkeeping failed.
 */
export class SavePublicationError extends Error {
    readonly externalWriteCommitted: boolean | null;
    readonly pendingPublish: IPendingPublish | undefined;
    readonly code: string | undefined;
    override readonly cause: unknown;

    constructor(
        cause: unknown,
        options: {
            externalWriteCommitted: boolean | null;
            pendingPublish?: IPendingPublish | undefined;
        },
    ) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.name = 'SavePublicationError';
        this.externalWriteCommitted = options.externalWriteCommitted;
        this.pendingPublish = options.pendingPublish;
        this.code = cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
        this.cause = cause;
    }
}

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
        // A pending publish for another destination comes from an unacknowledged Save As that reported
        // adoption failure to the workspace. Move it to `unsettled` so recovery settles any temp/displaced
        // leftovers on that path without silently switching this live document's destination or baseline.
        const prePending = doc.snapshot().pendingPublish;
        if (prePending && prePending.destination !== doc.snapshot().destination) {
            const manifest = doc.snapshot();
            const clearStagedWitness = manifest.current !== undefined
                && prePending.witness !== undefined
                && sameWitness(manifest.current.witness, prePending.witness)
                && !sameWitness(prePending.witness, manifest.baseline);
            await doc.commit({
                ...manifest,
                current: clearStagedWitness ? { ...manifest.current!, witness: undefined } : manifest.current,
                pendingPublish: undefined,
                unsettled: [...manifest.unsettled ?? [], { ...prePending, baseline: undefined }],
            });
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
        let attempted = undefined as IPendingPublish | undefined;
        let staged = false;
        const record = async (next: IPendingPublish, revision = current) => {
            const manifest = doc.snapshot();
            const earlier = manifest.pendingPublish === own ? undefined : manifest.pendingPublish;
            attempted = next;
            await doc.commit({
                ...manifest,
                current: revision,
                pendingPublish: next,
                unsettled: earlier ? [...manifest.unsettled ?? [], { ...earlier, baseline: manifest.baseline }] : manifest.unsettled,
            });
            own = next;
        };
        let published: TPublishResult;
        try {
            published = await doc.store.publication.publish(
                destination,
                { path: doc.path(current.file), length: current.length, file: doc.currentFile(), witness: current.witness },
                saveAs === undefined ? baseline ?? null : null,
                async (witness) => {
                    await record({ ...own, destination, witness }, { ...current, witness });
                    staged = true;
                },
                temp => record({ destination, temp }),
            );
        } catch (error) {
            if (!staged) {
                // A publish that failed before staging its bytes left the destination as it was.
                if (own && own.witness === undefined && doc.snapshot().pendingPublish === own) {
                    await doc.commit({ ...doc.snapshot(), pendingPublish: undefined }).catch(() => undefined);
                }
                const surviving = doc.snapshot().pendingPublish;
                const pendingPublish = surviving !== undefined && (surviving === own || surviving === attempted)
                    ? surviving
                    : undefined;
                throw new SavePublicationError(error, {
                    externalWriteCommitted: false,
                    ...(pendingPublish === undefined ? {} : { pendingPublish }),
                });
            }
            throw new SavePublicationError(error, {
                externalWriteCommitted: null,
                pendingPublish: doc.snapshot().pendingPublish ?? own,
            });
        }
        const kept = published.keptOriginal === undefined ? {} : { keptOriginal: published.keptOriginal };
        if (published.status === 'conflict') {
            // The staged witness named a file the destination did not end up holding: `current` gets its own back.
            if (staged) {
                try {
                    await doc.commit({ ...doc.snapshot(), current, pendingPublish: undefined });
                } catch (acknowledgmentError) {
                    const pendingPublish = doc.snapshot().pendingPublish;
                    return {
                        status: 'conflict',
                        ...kept,
                        acknowledgmentError,
                        ...(pendingPublish === undefined ? {} : { pendingPublish }),
                    };
                }
            }
            return { status: 'conflict', ...kept };
        }
        // The current bytes are now the destination's: both carry its witness.
        const revision = {
            ...current,
            witness: published.witness,
            ...(current.foreign === 'staged' ? { foreign: 'committed' as const } : {}),
        };
        try {
            await doc.commit({ ...doc.snapshot(), current: revision, destination, baseline: published.witness, pendingPublish: undefined });
        } catch (acknowledgmentError) {
            const pendingPublish = doc.snapshot().pendingPublish;
            // For Save As, returning `saved` while the manifest still names an earlier destination would let the UI
            // adopt the new path while a subsequent Save could fall back to the old destination. Report adoption as
            // incomplete while preserving `externalWriteCommitted: true` and the surviving pending witness.
            if (saveAs !== undefined && doc.snapshot().destination !== destination) {
                throw new SavePublicationError(acknowledgmentError, {
                    externalWriteCommitted: true,
                    ...(pendingPublish === undefined ? {} : { pendingPublish }),
                });
            }
            return {
                status: 'saved',
                revision,
                ...kept,
                externalWriteCommitted: true,
                acknowledgmentError,
                ...(pendingPublish === undefined ? {} : { pendingPublish }),
            };
        }
        return { status: 'saved', revision, ...kept };
    });
}
