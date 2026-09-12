import {
    link,
    rm,
} from 'node:fs/promises';
import {isRecord} from '@contracts/runtimeGuards';
import {lstatSync} from 'fs';
import {normalizePathForLookup} from '@electron/file-access/workingCopyStore';
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {
    assertPathMatchesSaveWitnessSnapshot,
    capturePathSaveWitness,
    type IOriginalPathSaveJournalSnapshot,
    OriginalPathSaveConflictError,
} from '@electron/file-access/originalPathSaveWitness';
import {
    invalidDocumentRecoveryJournal,
    readDocumentRecoveryJournal,
} from '@electron/file-access/documentRecoveryJournal';

type TTwoTargetTransitionMode = 'save' | 'save-as';
type TTwoTargetTransitionState = 'prepared' | 'original-committed' | 'sync-required';

interface ITwoTargetTransitionJournal {
    version: 1;
    mode: TTwoTargetTransitionMode;
    state: TTwoTargetTransitionState;
    workingCopyPath: string;
    originalPath: string;
    originalBackupPath: string | null;
    originalExistedBefore: boolean;
    nextRevisionToken: string;
    ownerWebContentsId?: number;
    preparedOriginalSnapshot?: IOriginalPathSaveJournalSnapshot;
    publishedOriginalSnapshot?: IOriginalPathSaveJournalSnapshot;
    syncRequiredReason?: string;
}

export interface IPendingSaveAsWorkingCopySync {
    kind: 'save-as-working-copy-sync-required';
    workingCopyPath: string;
    originalPath: string;
    reason: string;
    ownerWebContentsId?: number;
}

export const TWO_TARGET_TRANSITION_JOURNAL_SUFFIX = '.evb-two-target-transition.json';

export function getTwoTargetTransitionJournalPath(workingCopyPath: string) {
    return `${workingCopyPath}${TWO_TARGET_TRANSITION_JOURNAL_SUFFIX}`;
}

const journalPath = getTwoTargetTransitionJournalPath;

function evidenceKey(workingCopyPath: string) {
    return normalizePathForLookup(workingCopyPath) || workingCopyPath;
}

// A two-target transition writes a journal beside the working copy and removes
// it once the pair is consistent again. While it is there the working copy may
// hold bytes that were never reconciled with the original, so mutations have to
// wait. The set is the owner of that answer: the transition maintains it, and
// disk is consulted only for a working copy this process has not seen yet,
// which is what makes the state survive a restart without paying a stat on
// every mutation.
const twoTargetTransitionEvidence = new Set<string>();
const twoTargetTransitionEvidenceProbed = new Set<string>();

export function noteTwoTargetTransitionJournalWritten(workingCopyPath: string) {
    const key = evidenceKey(workingCopyPath);
    twoTargetTransitionEvidence.add(key);
    twoTargetTransitionEvidenceProbed.add(key);
}

// Recovery may have resolved or re-written the journal behind our back, so the
// cached answer is dropped rather than guessed at.
export function invalidateTwoTargetTransitionEvidence(workingCopyPath: string) {
    const key = evidenceKey(workingCopyPath);
    twoTargetTransitionEvidence.delete(key);
    twoTargetTransitionEvidenceProbed.delete(key);
}

export function noteTwoTargetTransitionJournalCleared(workingCopyPath: string) {
    const key = evidenceKey(workingCopyPath);
    twoTargetTransitionEvidence.delete(key);
    twoTargetTransitionEvidenceProbed.add(key);
}

export function hasTwoTargetTransitionEvidence(workingCopyPath: string) {
    const key = evidenceKey(workingCopyPath);
    if (twoTargetTransitionEvidenceProbed.has(key)) {
        return twoTargetTransitionEvidence.has(key);
    }
    twoTargetTransitionEvidenceProbed.add(key);
    try {
        lstatSync(getTwoTargetTransitionJournalPath(workingCopyPath));
        twoTargetTransitionEvidence.add(key);
        return true;
    } catch {
        return false;
    }
}


function parseJournalSnapshot(value: unknown, journalPath: string) {
    if (value === undefined) {
        return undefined;
    }
    if (
        !value
        || typeof value !== 'object'
        || [
            'ctimeNs',
            'deviceId',
            'inode',
            'linkCount',
            'mtimeNs',
            'sampleSha256',
            'size',
        ].some(name => typeof (value as Record<string, unknown>)[name] !== 'string')
    ) {
        throw invalidDocumentRecoveryJournal(
            journalPath,
            undefined,
            'Invalid two-target document transition journal',
        );
    }
    return value as IOriginalPathSaveJournalSnapshot;
}

async function readTransitionJournal(workingCopyPath: string) {
    const path = journalPath(workingCopyPath);
    const value = await readDocumentRecoveryJournal(path);
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw invalidDocumentRecoveryJournal(path);
    }
    const mode = value.mode === undefined ? 'save' : value.mode;
    const state = value.state;
    const originalBackupPath = value.originalBackupPath === null
        ? null
        : typeof value.originalBackupPath === 'string'
            ? value.originalBackupPath
            : undefined;
    const originalExistedBefore = value.originalExistedBefore === undefined
        ? mode !== 'save-as'
        : value.originalExistedBefore;
    if (
        value.version !== 1
        || (mode !== 'save' && mode !== 'save-as')
        || (state !== 'prepared' && state !== 'original-committed' && state !== 'sync-required')
        || value.workingCopyPath !== workingCopyPath
        || typeof value.originalPath !== 'string'
        || originalBackupPath === undefined
        || typeof originalExistedBefore !== 'boolean'
        || typeof value.nextRevisionToken !== 'string'
        || (value.ownerWebContentsId !== undefined
            && (typeof value.ownerWebContentsId !== 'number' || !Number.isSafeInteger(value.ownerWebContentsId) || value.ownerWebContentsId < 0))
        || (mode === 'save' && originalBackupPath === null)
        || (mode === 'save' && state === 'sync-required')
        || (mode === 'save-as' && value.originalExistedBefore === undefined)
        || (mode === 'save-as'
            && state === 'sync-required'
            && (typeof value.syncRequiredReason !== 'string' || value.syncRequiredReason.trim().length === 0))
    ) {
        throw invalidDocumentRecoveryJournal(
            path,
            undefined,
            'Invalid two-target document transition journal',
        );
    }
    const preparedOriginalSnapshot = parseJournalSnapshot(value.preparedOriginalSnapshot, path);
    const publishedOriginalSnapshot = parseJournalSnapshot(value.publishedOriginalSnapshot, path);
    return {
        path,
        journal: {
            version: 1,
            mode,
            state,
            workingCopyPath,
            originalPath: value.originalPath,
            originalBackupPath,
            originalExistedBefore,
            nextRevisionToken: value.nextRevisionToken,
            ...(value.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: value.ownerWebContentsId}),
            ...(preparedOriginalSnapshot === undefined ? {} : {preparedOriginalSnapshot}),
            ...(publishedOriginalSnapshot === undefined ? {} : {publishedOriginalSnapshot}),
            ...(typeof value.syncRequiredReason === 'string' ? {syncRequiredReason: value.syncRequiredReason} : {}),
        } satisfies ITwoTargetTransitionJournal,
    };
}

async function completeTransitionJournal(
    path: string,
    journal: ITwoTargetTransitionJournal,
) {
    await Promise.all([
        ...(journal.originalBackupPath === null ? [] : [rm(journal.originalBackupPath, {force: true})]),
        rm(path, {force: true}),
    ]);
}

export async function readPendingSaveAsWorkingCopySync(
    workingCopyPath: string,
): Promise<IPendingSaveAsWorkingCopySync | undefined> {
    const transition = await readTransitionJournal(workingCopyPath);
    if (
        !transition
        || transition.journal.mode !== 'save-as'
        || (transition.journal.state !== 'original-committed' && transition.journal.state !== 'sync-required')
    ) {
        return undefined;
    }
    return {
        kind: 'save-as-working-copy-sync-required',
        workingCopyPath,
        originalPath: transition.journal.originalPath,
        reason: transition.journal.syncRequiredReason ?? 'Save As left the working copy out of sync',
        ...(transition.journal.ownerWebContentsId === undefined ? {} : {ownerWebContentsId: transition.journal.ownerWebContentsId}),
    };
}

export async function completeTwoTargetDocumentTransition(workingCopyPath: string) {
    const transition = await readTransitionJournal(workingCopyPath);
    if (!transition) {
        return false;
    }
    if (
        transition.journal.mode !== 'save-as'
        || (transition.journal.state !== 'original-committed' && transition.journal.state !== 'sync-required')
    ) {
        throw invalidDocumentRecoveryJournal(
            transition.path,
            undefined,
            'Cannot complete an uncommitted two-target document transition',
        );
    }
    await completeTransitionJournal(transition.path, transition.journal);
    return true;
}

export async function recoverTwoTargetDocumentTransition(workingCopyPath: string) {
    const transition = await readTransitionJournal(workingCopyPath);
    if (!transition) {
        return false;
    }
    const {
        path, journal,
    } = transition;
    if (journal.mode === 'save-as') {
        if (journal.state !== 'prepared') {
            return readPendingSaveAsWorkingCopySync(workingCopyPath);
        }
        if (journal.originalExistedBefore) {
            if (!journal.preparedOriginalSnapshot) {
                throw invalidDocumentRecoveryJournal(path);
            }
            await assertPathMatchesSaveWitnessSnapshot(journal.originalPath, journal.preparedOriginalSnapshot);
        } else if (await capturePathSaveWitness(journal.originalPath)) {
            throw new OriginalPathSaveConflictError();
        }
        await completeTransitionJournal(path, journal);
        return true;
    }

    const revision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (revision?.token !== journal.nextRevisionToken) {
        const expectedOriginalSnapshot = journal.state === 'prepared'
            ? journal.preparedOriginalSnapshot
            : journal.publishedOriginalSnapshot;
        if (expectedOriginalSnapshot !== undefined) {
            try {
                await assertPathMatchesSaveWitnessSnapshot(journal.originalPath, expectedOriginalSnapshot);
            } catch (error) {
                // A Windows fallback can be interrupted after it moves the
                // original aside. In that state there is no live destination
                // witness. Restore only when the journaled backup itself is
                // the exact pre-publication file, and create the destination
                // exclusively so a third-party replacement wins the race.
                const missingDestination = await capturePathSaveWitness(journal.originalPath) === null;
                if (!missingDestination) {
                    throw error;
                }
                const backupSnapshot = journal.preparedOriginalSnapshot ?? expectedOriginalSnapshot;
                if (!journal.originalBackupPath) {
                    throw error;
                }
                await assertPathMatchesSaveWitnessSnapshot(journal.originalBackupPath, backupSnapshot, {contentOnly: true});
                await link(journal.originalBackupPath, journal.originalPath);
                await Promise.all([
                    rm(journal.originalBackupPath, {force: true}),
                    rm(path, {force: true}),
                ]);
                return true;
            }
        }
        const witness = await capturePathSaveWitness(journal.originalPath);
        if (!witness) {
            throw new OriginalPathSaveConflictError();
        }
        try {
            if (!journal.originalBackupPath) {
                throw new Error('Cannot restore a missing original target');
            }
            await copyFileAtomic(journal.originalBackupPath, journal.originalPath, {assertDestinationCurrent: () => witness.assertCurrent()});
        } finally {
            await witness.close();
        }
    }
    await Promise.all([
        rm(journal.originalBackupPath!, {force: true}),
        rm(path, {force: true}),
    ]);
    return true;
}
