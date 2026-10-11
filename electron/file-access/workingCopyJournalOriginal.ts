import {
    link,
    stat,
} from 'node:fs/promises';
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import {
    assertPathMatchesSaveWitnessSnapshot,
    capturePathSaveWitness,
} from '@electron/file-access/originalPathSaveWitness';
import {
    hashContentFingerprintFilePath,
    OriginalPathSaveConflictError,
} from '@electron/file-access/originalPathSnapshot';
import {originalSaveSnapshotSchema} from '@electron/file-access/workingCopyManifest';
import * as v from 'valibot';

/** The original file a save publishes in the same transition. */
export const originalSchema = v.object({
    path: v.string(),
    backupPath: v.string(),
    state: v.picklist([
        'prepared',
        'published',
        'restored',
        'conflicted',
    ]),
    preparedSnapshot: v.optional(originalSaveSnapshotSchema),
    publishedSnapshot: v.optional(originalSaveSnapshotSchema),
    /** Fingerprint of the bytes the publication installs, recorded before it runs. */
    intendedFingerprint: v.optional(v.pipe(v.string(), v.regex(/^sha256-full-v1:[0-9a-f]{64}$/u))),
});

export type IWorkingCopyJournalOriginal = v.InferOutput<typeof originalSchema>;

export async function captureIntendedContentFingerprint(sourcePath: string, signal?: AbortSignal) {
    return hashContentFingerprintFilePath(sourcePath, (await stat(sourcePath, {bigint: true})).size, signal);
}

/**
 * A crash can publish the original and die before the journal records it. An
 * original holding exactly the intended bytes is EVB's own publication, so
 * recovery rolls it back like a recorded one instead of reporting a conflict.
 * The witness is taken before hashing and still current after it, so it can
 * guard the rollback: a replacement made while hashing is never overwritten.
 */
async function witnessIntendedContent(original: IWorkingCopyJournalOriginal) {
    try {
        const witness = original.intendedFingerprint !== undefined && await capturePathSaveWitness(original.path);
        if (!witness || await captureIntendedContentFingerprint(original.path) !== original.intendedFingerprint) {
            return null;
        }
        await witness.assertCurrent();
        return witness;
    } catch {
        return null;
    }
}

/**
 * Puts back the original of an interrupted transition. A crash can leave the
 * original as it was before publication, published, or (on the Windows
 * fallback) moved aside. Only an original that still matches the journaled
 * snapshot is overwritten, so a third-party replacement always wins.
 */
export async function restoreOriginal(original: IWorkingCopyJournalOriginal) {
    if (original.state === 'restored' || original.state === 'conflicted') {
        return;
    }
    if (original.preparedSnapshot !== undefined) {
        try {
            await assertPathMatchesSaveWitnessSnapshot(original.path, original.preparedSnapshot, {contentOnly: true});
            return;
        } catch {
            // The original still contains the published bytes.
        }
    }
    const intendedWitness = original.state === 'prepared' ? await witnessIntendedContent(original) : null;
    const expectedSnapshot = original.state === 'prepared' && !intendedWitness
        ? original.preparedSnapshot
        : original.publishedSnapshot;
    if (expectedSnapshot !== undefined) {
        try {
            await assertPathMatchesSaveWitnessSnapshot(original.path, expectedSnapshot);
        } catch (error) {
            if (await capturePathSaveWitness(original.path) !== null) {
                throw error;
            }
            // Restore the displaced bytes exclusively, including external edits.
            await link(original.backupPath, original.path);
            await assertPathMatchesSaveWitnessSnapshot(original.path, original.preparedSnapshot ?? expectedSnapshot, {contentOnly: true});
            return;
        }
    }
    const witness = intendedWitness ?? await capturePathSaveWitness(original.path);
    if (!witness) {
        throw new OriginalPathSaveConflictError();
    }
    await copyFileAtomic(original.backupPath, original.path, {assertDestinationCurrent: () => witness.assertCurrent()});
}
