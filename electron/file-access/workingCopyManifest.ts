import {
    existsSync,
    readFileSync,
} from 'fs';
import {
    readFile,
    rm,
} from 'fs/promises';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    isRecord,
    isErrnoException,
} from '@contracts/runtimeGuards';
import {parseEpochMs} from '@contracts/timestamps';
import {quarantineCorruptFile} from '@electron/utils/quarantineCorruptFile';
import {writeJsonAtomic} from '@electron/utils/atomicReplace';
import {createKeyedSerialQueue} from '@electron/utils/createKeyedSerialQueue';
import {createLogger} from '@electron/utils/createLogger';
import {getWorkingCopyManifestPath} from '@electron/file-access/workingCopyDirectory';

const log = createLogger('working-copy-manifest');
const runManifestUpdate = createKeyedSerialQueue();

/** A save wrote its target but could not refresh the working copy from it. */
export interface IWorkingCopySyncRequired {
    reason: string;
    originalPath?: string;
    ownerWebContentsId?: number;
}

export interface IWorkingCopyManifest {
    version: 1;
    revision: IDocumentRevisionInfo;
    syncRequired?: IWorkingCopySyncRequired;
}

function parseRevision(value: unknown): IDocumentRevisionInfo | null {
    if (!isRecord(value)) {
        return null;
    }
    const token = parseDocumentRevisionToken(value.token);
    const documentRef = parseDocumentRef(value.documentRef);
    const mintedAt = parseEpochMs(value.mintedAt);
    const {contentRevision} = value;
    if (
        value.version !== 1
        || value.authority !== 'electron-working-copy'
        || token === null
        || documentRef === null
        || typeof contentRevision !== 'number'
        || !Number.isSafeInteger(contentRevision)
        || contentRevision < 1
        || mintedAt === null
        || mintedAt <= 0
    ) {
        return null;
    }
    return {
        version: 1,
        documentRef,
        authority: 'electron-working-copy',
        token,
        contentRevision,
        mintedAt,
    };
}

function parseSyncRequired(value: unknown): IWorkingCopySyncRequired | null {
    if (!isRecord(value) || typeof value.reason !== 'string' || value.reason.trim() === '') {
        return null;
    }
    const {
        originalPath, ownerWebContentsId,
    } = value;
    return {
        reason: value.reason,
        ...(typeof originalPath === 'string' && originalPath.trim() !== '' ? {originalPath} : {}),
        ...(typeof ownerWebContentsId === 'number' && Number.isSafeInteger(ownerWebContentsId) && ownerWebContentsId >= 0
            ? {ownerWebContentsId}
            : {}),
    };
}

function parseManifest(value: unknown): IWorkingCopyManifest | null {
    if (!isRecord(value) || value.version !== 1) {
        return null;
    }
    const revision = parseRevision(value.revision);
    if (revision === null) {
        return null;
    }
    const syncRequired = value.syncRequired === undefined ? undefined : parseSyncRequired(value.syncRequired);
    if (syncRequired === null) {
        return null;
    }
    return {
        version: 1,
        revision,
        ...(syncRequired === undefined ? {} : {syncRequired}),
    };
}

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
    let revision: IDocumentRevisionInfo | null = null;
    if (!interrupted) {
        try {
            revision = parseRevision(JSON.parse(await readFile(legacyPath, 'utf8')));
        } catch {
            // An unreadable legacy revision is replaced by a fresh one.
        }
    }
    const manifest = revision === null ? null : {
        version: 1 as const,
        revision,
    };
    if (manifest) {
        await writeJsonAtomic(getWorkingCopyManifestPath(workingCopyPath), manifest, {markMutationCommitStarted: false});
    }
    await Promise.all([
        legacyPath,
        `${workingCopyPath}.evb-revision-journal.json`,
    ].map(path => rm(path, {force: true})));
    return manifest;
}

export async function readWorkingCopyManifest(workingCopyPath: string): Promise<IWorkingCopyManifest | null> {
    const manifestPath = getWorkingCopyManifestPath(workingCopyPath);
    let text: string;
    try {
        text = await readFile(manifestPath, 'utf8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return importLegacyRevision(workingCopyPath);
        }
        log.warn(`Failed to read working-copy manifest ${manifestPath}`);
        throw error;
    }
    try {
        const manifest = parseManifest(JSON.parse(text));
        if (manifest) {
            return manifest;
        }
    } catch {
        // Invalid JSON follows the same quarantine path as an invalid schema.
    }
    const quarantinePath = await quarantineCorruptFile(manifestPath).catch(() => null);
    log.warn(`Quarantined corrupt working-copy manifest at ${quarantinePath ?? manifestPath}`);
    return null;
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
    revision: IDocumentRevisionInfo,
    options: Parameters<typeof writeJsonAtomic>[2] = {},
) {
    return updateWorkingCopyManifest(workingCopyPath, current => ({
        ...current,
        version: 1,
        revision,
    }), options);
}
