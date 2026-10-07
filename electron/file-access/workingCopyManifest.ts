import {
    existsSync,
    readFileSync,
} from 'fs';
import {
    readFile,
    rm,
} from 'fs/promises';
import {isErrnoException} from '@contracts/runtimeGuards';
import * as v from 'valibot';
import {writeJsonAtomic} from '@electron/utils/atomicReplace';
import {createKeyedSerialQueue} from '@electron/utils/createKeyedSerialQueue';
import {getWorkingCopyManifestPath} from '@electron/file-access/workingCopyDirectory';

import {
    type originalSaveBaseSchema,
    parseManifest,
    parseRevision,
    readPersistedWorkingCopyManifest,
    syncRequiredSchema,
    type IWorkingCopyManifest,
    type IWorkingCopySyncRequired,
    type TWorkingCopyRevision,
} from '@electron/file-access/readWorkingCopyManifest';

const runManifestUpdate = createKeyedSerialQueue();
export {
    originalSaveSnapshotSchema,
    type IWorkingCopyManifest,
    type IWorkingCopySyncRequired,
    type TWorkingCopyRevision,
} from '@electron/file-access/readWorkingCopyManifest';

/**
 * Imports the revision of a working copy written by an older version, whose
 * revision sat beside the document instead of in the manifest. Crash recovery
 * replays unsaved annotations only onto the exact revision they were captured
 * from, so a restored working copy must keep its token. A pending transition
 * from the old layout means the bytes may not match that revision; the working
 * copy then gets a fresh revision and its recovered annotations are refused.
 */
async function importLegacyRevision(workingCopyPath: string) {
    const legacyPath = `${workingCopyPath}.evb-revision.json`;
    if (!existsSync(legacyPath)) {
        return null;
    }
    const interrupted = [
        `${workingCopyPath}.evb-content-transition.json`,
        `${workingCopyPath}.evb-two-target-transition.json`,
    ].some(path => existsSync(path));
    let revision: TWorkingCopyRevision | null = null;
    if (!interrupted) {
        try {
            revision = parseRevision(JSON.parse(await readFile(legacyPath, 'utf8')));
        } catch {
            // An unreadable legacy revision is replaced by a fresh one.
        }
    }
    let syncRequired: IWorkingCopySyncRequired | undefined;
    const legacyJournalPath = `${workingCopyPath}.evb-revision-journal.json`;
    try {
        const legacyJournal = JSON.parse(await readFile(legacyJournalPath, 'utf8')) as {entries?: unknown};
        if (Array.isArray(legacyJournal.entries)) {
            for (const entry of legacyJournal.entries) {
                const record = typeof entry === 'object' && entry !== null
                    ? entry as Record<string, unknown>
                    : null;
                if (record?.kind !== 'working-copy-sync-required') {
                    continue;
                }
                const result = v.safeParse(syncRequiredSchema, record, {abortEarly: true});
                syncRequired = result.success
                    ? result.output
                    : {reason: 'The working copy must be reconciled with its saved file before it can be changed.'};
                break;
            }
        }
    } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) {
            syncRequired = {reason: 'The working copy save state could not be read and must be reconciled before it can be changed.'};
        }
    }
    const manifest = revision === null ? null : {
        version: 1 as const,
        revision,
        ...(syncRequired === undefined ? {} : {syncRequired}),
    };
    if (syncRequired !== undefined && manifest === null) {
        return null;
    }
    if (manifest) {
        await writeJsonAtomic(getWorkingCopyManifestPath(workingCopyPath), manifest, {markMutationCommitStarted: false});
    }
    await Promise.all([
        legacyPath,
        legacyJournalPath,
    ].map(path => rm(path, {force: true})));
    return manifest;
}

export async function readWorkingCopyManifest(workingCopyPath: string): Promise<IWorkingCopyManifest | null> {
    try {
        return await readPersistedWorkingCopyManifest(workingCopyPath);
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return importLegacyRevision(workingCopyPath);
        }
        throw error;
    }
}

export async function readWorkingCopyRevision(workingCopyPath: string) {
    return (await readWorkingCopyManifest(workingCopyPath))?.revision ?? null;
}

/**
 * Reads the sync-required state for synchronous mutation guards. Throws when
 * the manifest exists but cannot be read or parsed.
 */
export function readWorkingCopySyncRequired(workingCopyPath: string): IWorkingCopySyncRequired | null {
    const manifestPath = getWorkingCopyManifestPath(workingCopyPath);
    let text: string;
    try {
        text = readFileSync(manifestPath, 'utf8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    const manifest = parseManifest(JSON.parse(text));
    if (!manifest) {
        throw new Error(`Working copy manifest is invalid: ${manifestPath}`);
    }
    return manifest.syncRequired ?? null;
}

/**
 * Serializes read-modify-write updates of one manifest. A durable write is the
 * commit point of a revision; an initial revision of a fresh working copy may
 * skip the flush because a crash just recreates it from its original.
 */
export function updateWorkingCopyManifest(
    workingCopyPath: string,
    update: (current: IWorkingCopyManifest | null) => IWorkingCopyManifest,
    options: Parameters<typeof writeJsonAtomic>[2] = {},
) {
    return runManifestUpdate(workingCopyPath, async () => {
        const next = update(await readWorkingCopyManifest(workingCopyPath));
        await writeJsonAtomic(getWorkingCopyManifestPath(workingCopyPath), next, options);
        return next;
    });
}

export function writeWorkingCopyManifestRevision(
    workingCopyPath: string,
    revision: TWorkingCopyRevision,
    options: Parameters<typeof writeJsonAtomic>[2] = {},
    originalSaveBase?: v.InferOutput<typeof originalSaveBaseSchema>,
) {
    return updateWorkingCopyManifest(workingCopyPath, current => ({
        ...current,
        version: 1,
        revision,
        ...(originalSaveBase ? {originalSaveBase} : {}),
    }), options);
}
