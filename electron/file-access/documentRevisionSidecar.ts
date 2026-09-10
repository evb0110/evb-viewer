import { randomUUID } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import {
    mkdir,
    readFile,
    rename,
    unlink,
    writeFile,
} from 'fs/promises';
import { dirname } from 'path';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionChangeReason,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import {
    isRecord,
    isErrnoException,
} from '@contracts/runtimeGuards';
import { quarantineCorruptFile } from '@electron/utils/quarantineCorruptFile';
import { atomicReplace } from '@electron/utils/atomicReplace';
import { createLogger } from '@electron/utils/createLogger';
import {
    parseEpochMs,
    type TEpochMs,
} from '@contracts/timestamps';
import {
    getPageIdentitySidecarPath,
    quarantinePageIdentitySidecar,
    rebasePageIdentitySidecarRevision,
} from '@electron/file-access/rebasePageIdentitySidecarRevision';

const log = createLogger('document-revision-sidecar');

export interface IWorkingCopyRevisionSidecar extends IDocumentRevisionInfo {
    sidecarVersion: 1;
    updatedAt: TEpochMs;
}

export interface IWorkingCopySyncRequiredJournalEntry {
    kind: 'working-copy-sync-required';
    id: string;
    reason: string;
    targetWriteCommitted: true;
    createdAt: number;
    updatedAt: number;
    originalPath?: string;
    ownerWebContentsId?: number;
}

interface IWorkingCopyRevisionCommitJournalEntry {
    kind: 'revision-sidecar-commit';
    id: string;
    reason: TDocumentRevisionChangeReason;
    sidecar: IWorkingCopyRevisionSidecar;
    createdAt: number;
    updatedAt: number;
}

type TWorkingCopyRevisionJournalEntry =
    | IWorkingCopySyncRequiredJournalEntry
    | IWorkingCopyRevisionCommitJournalEntry;

interface IWorkingCopyRevisionJournal {
    journalVersion: 1;
    updatedAt: number;
    entries: TWorkingCopyRevisionJournalEntry[];
}

const WORKING_COPY_REVISION_JOURNAL_MAX_ENTRIES = 8;
const WORKING_COPY_REVISION_JOURNAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WORKING_COPY_REVISION_JOURNAL_MAX_REASON_LENGTH = 2048;

export function getWorkingCopyRevisionSidecarPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-revision.json`;
}

function getWorkingCopyRevisionJournalPath(workingCopyPath: string) {
    return `${workingCopyPath}.evb-revision-journal.json`;
}

function requireDocumentRef(value: string): TDocumentRef {
    const parsed = parseDocumentRef(value);
    if (parsed === null) {
        throw new TypeError('Working copy path must be an absolute document ref');
    }
    return parsed;
}

function isPositiveTimestamp(value: unknown): value is TEpochMs {
    const parsed = parseEpochMs(value);
    return parsed !== null && parsed > 0;
}

function isContentRevision(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1;
}

function normalizeWorkingCopyRevisionSidecar(value: unknown): IWorkingCopyRevisionSidecar | null {
    if (!isRecord(value)) {
        return null;
    }
    const token = parseDocumentRevisionToken(value.token);
    const documentRef = parseDocumentRef(value.documentRef);
    const mintedAt = parseEpochMs(value.mintedAt);
    const updatedAt = parseEpochMs(value.updatedAt);
    if (
        value.sidecarVersion !== 1
        || value.version !== 1
        || value.authority !== 'electron-working-copy'
        || token === null
        || documentRef === null
        || !isContentRevision(value.contentRevision)
        || mintedAt === null
        || mintedAt <= 0
        || updatedAt === null
        || updatedAt <= 0
    ) {
        return null;
    }

    const {contentRevision} = value;

    return {
        sidecarVersion: 1,
        version: 1,
        documentRef,
        authority: 'electron-working-copy',
        token,
        contentRevision,
        mintedAt,
        updatedAt,
    };
}

function normalizeJournalReason(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    return trimmed.length > WORKING_COPY_REVISION_JOURNAL_MAX_REASON_LENGTH
        ? trimmed.slice(0, WORKING_COPY_REVISION_JOURNAL_MAX_REASON_LENGTH)
        : trimmed;
}

function normalizeOptionalPath(value: unknown) {
    return typeof value === 'string' && value.trim().length > 0
        ? value
        : undefined;
}

function normalizeOwnerWebContentsId(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function isJournalEntryFresh(updatedAt: number, now: number) {
    return now - updatedAt <= WORKING_COPY_REVISION_JOURNAL_TTL_MS;
}

function invalidRevisionJournalError(message = 'Invalid working-copy revision journal') {
    return new Error(message);
}

function normalizeRevisionJournalEntry(
    value: unknown,
): TWorkingCopyRevisionJournalEntry | null {
    if (!isRecord(value)) {
        throw invalidRevisionJournalError();
    }
    if (value.kind === 'working-copy-sync-required') {
        const reason = normalizeJournalReason(value.reason);
        if (
            typeof value.id !== 'string'
            || value.id.length === 0
            || reason === null
            || value.targetWriteCommitted !== true
            || !isPositiveTimestamp(value.createdAt)
            || !isPositiveTimestamp(value.updatedAt)
        ) {
            throw invalidRevisionJournalError('Invalid working-copy sync-required journal entry');
        }

        const originalPath = normalizeOptionalPath(value.originalPath);
        const ownerWebContentsId = normalizeOwnerWebContentsId(value.ownerWebContentsId);
        return {
            kind: 'working-copy-sync-required',
            id: value.id,
            reason,
            targetWriteCommitted: true,
            createdAt: value.createdAt,
            updatedAt: value.updatedAt,
            ...(originalPath === undefined ? {} : {originalPath}),
            ...(ownerWebContentsId === undefined ? {} : {ownerWebContentsId}),
        };
    }

    if (value.kind === 'revision-sidecar-commit') {
        const sidecar = normalizeWorkingCopyRevisionSidecar(value.sidecar);
        if (
            typeof value.id !== 'string'
            || value.id.length === 0
            || typeof value.reason !== 'string'
            || value.reason.trim().length === 0
            || sidecar === null
            || !isPositiveTimestamp(value.createdAt)
            || !isPositiveTimestamp(value.updatedAt)
        ) {
            throw invalidRevisionJournalError('Invalid working-copy revision journal entry');
        }

        return {
            kind: 'revision-sidecar-commit',
            id: value.id,
            reason: value.reason as TDocumentRevisionChangeReason,
            sidecar,
            createdAt: value.createdAt,
            updatedAt: value.updatedAt,
        };
    }

    throw invalidRevisionJournalError('Unknown working-copy revision journal entry');
}

function normalizeWorkingCopyRevisionJournal(value: unknown): IWorkingCopyRevisionJournal {
    const now = Date.now();
    if (!isRecord(value) || value.journalVersion !== 1 || !Array.isArray(value.entries)) {
        throw invalidRevisionJournalError('Unknown working-copy revision journal version');
    }

    const normalizedEntries = value.entries
        .map(entry => normalizeRevisionJournalEntry(entry))
        .filter((entry): entry is TWorkingCopyRevisionJournalEntry => entry !== null);
    const syncRequiredEntries = normalizedEntries
        .filter((entry): entry is IWorkingCopySyncRequiredJournalEntry => entry.kind === 'working-copy-sync-required')
        .sort((left, right) => right.updatedAt - left.updatedAt);
    const completedRevisionEntries = normalizedEntries
        .filter((entry): entry is IWorkingCopyRevisionCommitJournalEntry => entry.kind === 'revision-sidecar-commit')
        .filter(entry => isJournalEntryFresh(entry.updatedAt, now))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, Math.max(0, WORKING_COPY_REVISION_JOURNAL_MAX_ENTRIES - syncRequiredEntries.length));
    const entries = [
        ...syncRequiredEntries,
        ...completedRevisionEntries,
    ];
    return {
        journalVersion: 1,
        updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
            ? value.updatedAt
            : now,
        entries,
    };
}

function readWorkingCopyRevisionJournalFile(workingCopyPath: string): IWorkingCopyRevisionJournal {
    const journalPath = getWorkingCopyRevisionJournalPath(workingCopyPath);
    let text: string;
    try {
        text = readFileSync(journalPath, 'utf8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            const now = Date.now();
            return {
                journalVersion: 1,
                updatedAt: now,
                entries: [],
            };
        }
        throw new Error(`Working-copy revision journal could not be read: ${journalPath}`, {cause: error});
    }
    try {
        return normalizeWorkingCopyRevisionJournal(JSON.parse(text));
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('Working-copy revision journal')) {
            throw error;
        }
        throw new Error(`Working-copy revision journal is invalid: ${journalPath}`, {cause: error});
    }
}

function writeWorkingCopyRevisionJournalFile(
    workingCopyPath: string,
    entries: TWorkingCopyRevisionJournalEntry[],
) {
    const normalized = normalizeWorkingCopyRevisionJournal({
        journalVersion: 1,
        updatedAt: Date.now(),
        entries,
    });
    const journalPath = getWorkingCopyRevisionJournalPath(workingCopyPath);
    if (normalized.entries.length === 0) {
        if (existsSync(journalPath)) {
            unlinkSync(journalPath);
        }
        return;
    }

    const tempPath = `${journalPath}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(dirname(journalPath), { recursive: true });
    try {
        writeFileSync(tempPath, `${JSON.stringify(normalized)}\n`, 'utf8');
        renameSync(tempPath, journalPath);
    } catch (error) {
        if (existsSync(tempPath)) {
            unlinkSync(tempPath);
        }
        throw error;
    }
}

function updateWorkingCopyRevisionJournalEntries(
    workingCopyPath: string,
    update: (entries: TWorkingCopyRevisionJournalEntry[]) => TWorkingCopyRevisionJournalEntry[],
) {
    const journal = readWorkingCopyRevisionJournalFile(workingCopyPath);
    writeWorkingCopyRevisionJournalFile(workingCopyPath, update(journal.entries));
}

export function readWorkingCopyRevisionJournalEntries(workingCopyPath: string) {
    return readWorkingCopyRevisionJournalFile(workingCopyPath).entries;
}

export function writeWorkingCopySyncRequiredJournalEntry(
    workingCopyPath: string,
    options: {
        reason: string;
        originalPath?: string;
        ownerWebContentsId?: number;
    },
) {
    const now = Date.now();
    const existing = readWorkingCopyRevisionJournalFile(workingCopyPath)
        .entries
        .find(entry => entry.kind === 'working-copy-sync-required');
    const reason = normalizeJournalReason(options.reason) ?? 'Working copy must be resynced before further edits';
    const originalPath = normalizeOptionalPath(options.originalPath);
    const ownerWebContentsId = normalizeOwnerWebContentsId(options.ownerWebContentsId);
    const nextEntry: IWorkingCopySyncRequiredJournalEntry = {
        kind: 'working-copy-sync-required',
        id: existing?.id ?? `sync-required:${randomUUID()}`,
        reason,
        targetWriteCommitted: true,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(originalPath === undefined ? {} : {originalPath}),
        ...(ownerWebContentsId === undefined ? {} : {ownerWebContentsId}),
    };
    updateWorkingCopyRevisionJournalEntries(workingCopyPath, entries => [
        nextEntry,
        ...entries.filter(entry => entry.kind !== 'working-copy-sync-required'),
    ]);
}

export function readWorkingCopySyncRequiredJournalEntry(
    workingCopyPath: string,
): IWorkingCopySyncRequiredJournalEntry | null {
    return readWorkingCopyRevisionJournalFile(workingCopyPath)
        .entries
        .find((entry): entry is IWorkingCopySyncRequiredJournalEntry => entry.kind === 'working-copy-sync-required')
        ?? null;
}

export function clearWorkingCopySyncRequiredJournalEntry(workingCopyPath: string) {
    updateWorkingCopyRevisionJournalEntries(
        workingCopyPath,
        entries => entries.filter(entry => entry.kind !== 'working-copy-sync-required'),
    );
}

export function stageWorkingCopyRevisionSidecarCommit(
    workingCopyPath: string,
    sidecar: IWorkingCopyRevisionSidecar,
    reason: TDocumentRevisionChangeReason,
) {
    const now = Date.now();
    const nextEntry: IWorkingCopyRevisionCommitJournalEntry = {
        kind: 'revision-sidecar-commit',
        id: `revision:${sidecar.token}`,
        reason,
        sidecar,
        createdAt: now,
        updatedAt: now,
    };
    updateWorkingCopyRevisionJournalEntries(workingCopyPath, entries => [
        nextEntry,
        ...entries.filter(entry => entry.id !== nextEntry.id),
    ]);
}

export function clearWorkingCopyRevisionSidecarCommit(
    workingCopyPath: string,
    token: TDocumentRevisionToken,
) {
    updateWorkingCopyRevisionJournalEntries(
        workingCopyPath,
        entries => entries.filter(entry => (
            entry.kind !== 'revision-sidecar-commit'
            || entry.sidecar.token !== token
        )),
    );
}

function clearWorkingCopyRevisionSidecarCommitsThrough(
    workingCopyPath: string,
    contentRevision: number,
) {
    updateWorkingCopyRevisionJournalEntries(
        workingCopyPath,
        entries => entries.filter(entry => (
            entry.kind !== 'revision-sidecar-commit'
            || entry.sidecar.contentRevision > contentRevision
        )),
    );
}

function tryClearWorkingCopyRevisionSidecarCommitsThrough(
    workingCopyPath: string,
    contentRevision: number,
) {
    try {
        clearWorkingCopyRevisionSidecarCommitsThrough(workingCopyPath, contentRevision);
        return true;
    } catch {
        return false;
    }
}

async function readWorkingCopyRevisionSidecarFile(workingCopyPath: string) {
    const sidecarPath = getWorkingCopyRevisionSidecarPath(workingCopyPath);
    let text: string;
    try {
        text = await readFile(sidecarPath, 'utf8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        log.warn(`Failed to read revision sidecar ${sidecarPath}`);
        throw error;
    }
    try {
        const sidecar = normalizeWorkingCopyRevisionSidecar(JSON.parse(text));
        if (sidecar) {
            return sidecar;
        }
    } catch {
        // Invalid JSON follows the same quarantine path as an invalid schema.
    }
    const quarantinePath = await quarantineCorruptFile(sidecarPath).catch(() => null);
    log.warn(`Quarantined corrupt revision sidecar at ${quarantinePath ?? sidecarPath}`);
    return null;
}

async function rebasePageIdentityBeforeRevisionJournalReplay(
    workingCopyPath: string,
    previousRevision: IWorkingCopyRevisionSidecar | null,
    nextRevision: IWorkingCopyRevisionSidecar,
) {
    const pageIdentityPath = getPageIdentitySidecarPath(workingCopyPath);
    // A staged revision is created only after the first revision exists. If a
    // recovery journal is found without a current sidecar, an existing page
    // ledger has no safe identity fence to rebase against.
    if (!previousRevision) {
        const quarantinePath = await quarantinePageIdentitySidecar(workingCopyPath);
        if (quarantinePath !== null) {
            log.warn(`Quarantined unfenced page identity sidecar at ${quarantinePath}`);
        }
        return;
    }
    if (!existsSync(pageIdentityPath)) {
        return;
    }
    await rebasePageIdentitySidecarRevision(workingCopyPath, previousRevision, nextRevision);
}

export async function reconcileWorkingCopyRevisionSidecarJournal(workingCopyPath: string) {
    const pendingRevisions = readWorkingCopyRevisionJournalFile(workingCopyPath)
        .entries
        .filter((entry): entry is IWorkingCopyRevisionCommitJournalEntry => entry.kind === 'revision-sidecar-commit')
        .sort((left, right) => right.sidecar.contentRevision - left.sidecar.contentRevision || right.updatedAt - left.updatedAt);
    const current = await readWorkingCopyRevisionSidecarFile(workingCopyPath);
    if (current) {
        tryClearWorkingCopyRevisionSidecarCommitsThrough(workingCopyPath, current.contentRevision);
    }
    const pendingRevision = pendingRevisions
        .find(entry => !current || entry.sidecar.contentRevision > current.contentRevision);
    if (!pendingRevision) {
        return null;
    }

    await rebasePageIdentityBeforeRevisionJournalReplay(
        workingCopyPath,
        current,
        pendingRevision.sidecar,
    );
    await writeWorkingCopyRevisionSidecar(workingCopyPath, pendingRevision.sidecar);
    tryClearWorkingCopyRevisionSidecarCommitsThrough(workingCopyPath, pendingRevision.sidecar.contentRevision);
    return pendingRevision.sidecar;
}

export async function readWorkingCopyRevisionSidecar(workingCopyPath: string) {
    await reconcileWorkingCopyRevisionSidecarJournal(workingCopyPath);
    return readWorkingCopyRevisionSidecarFile(workingCopyPath);
}

export async function assertWorkingCopyRevisionSidecarCurrent(
    workingCopyPath: string,
    token: TDocumentRevisionToken,
): Promise<void> {
    const sidecar = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (sidecar?.token !== token) {
        throw createStaleRevisionError({
            documentRef: requireDocumentRef(workingCopyPath),
            expectedRevision: token,
            actualRevision: sidecar?.token ?? null,
        });
    }
}

export async function writeWorkingCopyRevisionSidecar(
    workingCopyPath: string,
    sidecar: IWorkingCopyRevisionSidecar,
    options: {markMutationCommitStarted?: boolean} = {},
) {
    const sidecarPath = getWorkingCopyRevisionSidecarPath(workingCopyPath);
    const tempPath = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(sidecarPath), { recursive: true });
    try {
        await writeFile(tempPath, `${JSON.stringify(sidecar)}\n`, 'utf8');
        await atomicReplace(tempPath, sidecarPath, options);
    } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
    }
}

/**
 * Publishes the initial revision for a newly-created, disposable working copy.
 *
 * The rename makes the sidecar immediately readable by the renderer and other
 * read-only consumers, but deliberately does not fsync it. There is no user
 * mutation to recover at this point: a crash may discard the new working copy
 * and recreate it from its original. The revision store must promote this
 * provisional sidecar through `writeWorkingCopyRevisionSidecar` before the
 * first mutation is allowed to commit.
 */
export async function writeProvisionalWorkingCopyRevisionSidecar(
    workingCopyPath: string,
    sidecar: IWorkingCopyRevisionSidecar,
) {
    const sidecarPath = getWorkingCopyRevisionSidecarPath(workingCopyPath);
    const tempPath = `${sidecarPath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(sidecarPath), { recursive: true });
    try {
        await writeFile(tempPath, `${JSON.stringify(sidecar)}\n`, 'utf8');
        await rename(tempPath, sidecarPath);
    } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
    }
}
