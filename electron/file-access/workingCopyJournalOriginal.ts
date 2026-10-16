import {existsSync} from 'node:fs';
import {
    rename, stat,
} from 'node:fs/promises';
import {
    atomicReplace, moveFileToMissingPath, recoverWindowsAtomicReplace,
} from '@electron/utils/atomicReplace';
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
    const witness = original.intendedFingerprint === undefined ? null : await capturePathSaveWitness(original.path);
    const fingerprint = witness && await captureIntendedContentFingerprint(original.path).catch(() => null);
    return witness && fingerprint === original.intendedFingerprint ? witness.assertCurrent().then(() => witness, () => null) : null;
}

/**
 * Restores an interrupted publication by moving the displaced backup back; without one, the original was never
 * displaced or is already restored and is not EVB's to restore, and an original that already holds its pre-save bytes
 * keeps them. A present destination must match a full fingerprint first: sampled bytes alone prove nothing, so a
 * journal without one keeps the displaced file beside the PDF, as for any other change.
 */
export async function restoreOriginal(original: IWorkingCopyJournalOriginal) {
    if (original.state === 'restored' || original.state === 'conflicted' || !await stat(original.backupPath).then(() => true, () => false)) return;
    // Each decision below reads the whole PDF afresh. A PDF or displaced backup another program holds refuses the restore,
    // and renaming each onto itself, which changes nothing, says so first, so neither is read in full at every read.
    const assertMovable = (path: string) => rename(path, path).catch((error: unknown) => existsSync(path) ? Promise.reject(error) : undefined);
    await assertMovable(original.path).then(() => assertMovable(original.backupPath));
    if (original.preparedSnapshot !== undefined && await assertPathMatchesSaveWitnessSnapshot(original.path, original.preparedSnapshot, {contentOnly: true}).then(() => true, () => false)) return;
    // A replace journal left by EVB's Windows fallback is applied only for an original EVB is about to restore.
    if (process.platform === 'win32') await recoverWindowsAtomicReplace(original.path);
    // EVB's own bytes, recorded as published or not yet, are rolled back even when only their metadata changed.
    const intendedWitness = await witnessIntendedContent(original);
    const expectedSnapshot = intendedWitness ? undefined : original[original.state === 'prepared' ? 'preparedSnapshot' : 'publishedSnapshot'];
    if (expectedSnapshot !== undefined) {
        try {
            await assertPathMatchesSaveWitnessSnapshot(original.path, expectedSnapshot);
        } catch (error) {
            if (await capturePathSaveWitness(original.path) !== null) {
                throw error;
            }
            // Restore the displaced bytes exclusively, including external edits.
            await moveFileToMissingPath(original.backupPath, original.path);
            await assertPathMatchesSaveWitnessSnapshot(original.path, original.preparedSnapshot ?? expectedSnapshot, {contentOnly: true});
            return;
        }
    }
    const witness = intendedWitness ?? (expectedSnapshot?.contentFingerprint === undefined ? null : await capturePathSaveWitness(original.path));
    if (!witness) throw new OriginalPathSaveConflictError();
    await atomicReplace(original.backupPath, original.path, {assertDestinationCurrent: () => witness.assertCurrent()});
}
