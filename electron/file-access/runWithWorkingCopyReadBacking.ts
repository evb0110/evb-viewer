import {existsSync} from 'node:fs';
import {
    captureWorkingCopyAdmissionSnapshot,
    getWorkingCopyBackingEntry,
    runWithWorkingCopyRegistrationFence,
    transitionWorkingCopyBackingState,
    workingCopyAdmissionSnapshotsMatch,
    type IWorkingCopyOriginalEntry,
} from '@electron/file-access/workingCopyStore';
import {WorkingCopyMaterializationError} from '@electron/file-access/workingCopyMaterialization';

export interface IWorkingCopyReadBackingOptions {ownerWebContentsId?: number;}

function throwBackingError(
    entry: IWorkingCopyOriginalEntry,
    logicalRef: string,
    code: 'SOURCE_BACKING_CHANGED' | 'SOURCE_BACKING_UNAVAILABLE',
    cause?: unknown,
): never {
    transitionWorkingCopyBackingState(
        logicalRef,
        entry.registrationId,
        'lazy-original',
        {
            expectedBackingState: [
                'lazy-original',
                'materializing',
            ],
            sourceBackingErrorCode: code,
        },
    );
    throw new WorkingCopyMaterializationError(
        code,
        code === 'SOURCE_BACKING_CHANGED'
            ? 'The original document changed while it was being read'
            : 'The original document is unavailable',
        cause === undefined ? {} : {cause},
    );
}

async function assertOriginalBackingCurrent(
    entry: IWorkingCopyOriginalEntry,
    logicalRef: string,
) {
    if (!entry.admissionSnapshot) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_MATERIALIZATION_FAILED',
            'Lazy working copy has no admission snapshot',
        );
    }
    let currentSnapshot;
    try {
        currentSnapshot = await captureWorkingCopyAdmissionSnapshot(entry.originalPath);
    } catch (error) {
        throwBackingError(entry, logicalRef, 'SOURCE_BACKING_UNAVAILABLE', error);
    }
    if (!workingCopyAdmissionSnapshotsMatch(currentSnapshot, entry.admissionSnapshot)) {
        throwBackingError(entry, logicalRef, 'SOURCE_BACKING_CHANGED');
    }
}

/**
 * Runs a read against the physical bytes behind one logical working-copy ref.
 * Lazy copies keep reading the immutable witnessed original while background
 * materialization proceeds. The registration fence prevents a close or reopen
 * from changing ownership during the read.
 */
export async function runWithWorkingCopyReadBacking<TResult>(
    logicalRef: string,
    operation: (physicalReadPath: string, assertOriginalUnchanged: () => Promise<void>) => Promise<TResult>,
    options: IWorkingCopyReadBackingOptions = {},
) {
    const entry = getWorkingCopyBackingEntry(logicalRef, options.ownerWebContentsId);
    if (!entry) {
        throw new Error('Working copy path is not managed');
    }
    const fenced = await runWithWorkingCopyRegistrationFence(
        logicalRef,
        entry.registrationId,
        async currentEntry => {
            const originalBacked = currentEntry.backingState === 'lazy-original'
                || currentEntry.backingState === 'materializing';
            if (!originalBacked) {
                if (!existsSync(logicalRef)) {
                    throw new Error(`Working copy not found: ${logicalRef}`);
                }
                // The working copy is the read source here, so there is no
                // separate original whose mtime could drift underneath us.
                return operation(logicalRef, () => Promise.resolve());
            }
            if (
                currentEntry.sourceBackingErrorCode === 'SOURCE_BACKING_CHANGED'
                || currentEntry.sourceBackingErrorCode === 'SOURCE_BACKING_UNAVAILABLE'
            ) {
                throw new WorkingCopyMaterializationError(
                    currentEntry.sourceBackingErrorCode,
                    currentEntry.sourceBackingErrorCode === 'SOURCE_BACKING_CHANGED'
                        ? 'The original document changed after it was opened'
                        : 'The original document is unavailable',
                );
            }
            await assertOriginalBackingCurrent(currentEntry, logicalRef);
            const result = await operation(
                currentEntry.originalPath,
                () => assertOriginalBackingCurrent(currentEntry, logicalRef),
            );
            // Callers that publish something durable check freshness themselves
            // at the moment of publication; this trailing check is for the ones
            // whose result is only meaningful if the file held still throughout.
            await assertOriginalBackingCurrent(currentEntry, logicalRef);
            return result;
        },
    );
    if (!fenced.matched) {
        throw new WorkingCopyMaterializationError(
            'WORKING_COPY_REGISTRATION_CHANGED',
            'Working-copy registration changed during the read',
        );
    }
    return fenced.value;
}
