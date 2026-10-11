import {link} from 'node:fs/promises';
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import {
    assertPathMatchesSaveWitnessSnapshot,
    capturePathSaveWitness,
    OriginalPathSaveConflictError,
} from '@electron/file-access/originalPathSaveWitness';
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
    ]),
    preparedSnapshot: v.optional(originalSaveSnapshotSchema),
    publishedSnapshot: v.optional(originalSaveSnapshotSchema),
});

export type IWorkingCopyJournalOriginal = v.InferOutput<typeof originalSchema>;

/**
 * Puts back the original of an interrupted transition. A crash can leave the
 * original as it was before publication, published, or (on the Windows
 * fallback) moved aside. Only an original that still matches the journaled
 * snapshot is overwritten, so a third-party replacement always wins.
 */
export async function restoreOriginal(original: IWorkingCopyJournalOriginal) {
    if (original.state === 'restored') {
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
    const expectedSnapshot = original.state === 'prepared'
        ? original.preparedSnapshot
        : original.publishedSnapshot;
    if (expectedSnapshot !== undefined) {
        try {
            await assertPathMatchesSaveWitnessSnapshot(original.path, expectedSnapshot);
        } catch (error) {
            if (await capturePathSaveWitness(original.path) !== null) {
                throw error;
            }
            await assertPathMatchesSaveWitnessSnapshot(
                original.backupPath,
                original.preparedSnapshot ?? expectedSnapshot,
                {contentOnly: true},
            );
            // The link creates the destination only while it is still absent.
            await link(original.backupPath, original.path);
            return;
        }
    }
    const witness = await capturePathSaveWitness(original.path);
    if (!witness) {
        throw new OriginalPathSaveConflictError();
    }
    await copyFileAtomic(original.backupPath, original.path, {assertDestinationCurrent: () => witness.assertCurrent()});
}
