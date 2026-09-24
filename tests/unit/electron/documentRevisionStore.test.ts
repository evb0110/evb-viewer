import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import {
    dirname,
    join,
} from 'path';
import { tmpdir } from 'os';
import type * as NodeCrypto from 'node:crypto';
import type * as FsPromises from 'fs/promises';
import type * as DocumentRevisionSidecarModule from '@electron/file-access/documentRevisionSidecar';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireEpochMs} from '@contracts/timestamps';

let tempRoot = '';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => tempRoot) } }));

vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof NodeCrypto>();
    let index = 0;
    return {
        ...actual,
        randomUUID: () => `00000000-0000-4000-8000-${(index += 1).toString().padStart(12, '0')}`,
    };
});

describe('documentRevisionStore', () => {
    beforeEach(() => {
        vi.resetModules();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-document-revision-test-'));
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('mints, persists, reloads, and rejects stale working-copy revision tokens', async () => {
        const originalPath = join(tempRoot, 'original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-revision', 'original.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            assertWorkingCopyRevisionCurrent,
            ensureWorkingCopyRevision,
            isWorkingCopyRevisionCurrent,
            markWorkingCopyRevisionChanged,
        } = await import('@electron/file-access/documentRevisionStore');
        const {
            readWorkingCopyRevisionSidecar,
            writeWorkingCopyRevisionSidecar,
        } = await import('@electron/file-access/documentRevisionSidecar');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        const revision = await ensureWorkingCopyRevision(workingPath, 7);
        const persisted = await readWorkingCopyRevisionSidecar(workingPath);

        expect(revision).toMatchObject({
            version: 1,
            documentRef: requireDocumentRef(workingPath),
            authority: 'electron-working-copy',
            contentRevision: 1,
        });
        expect(revision.token).toMatch(/^drt1:1:1:/u);
        expect(persisted?.token).toBe(revision.token);

        const changed = await markWorkingCopyRevisionChanged(workingPath, 'write', 7);

        expect(changed.previousToken).toBe(revision.token);
        expect(changed.contentRevision).toBe(2);
        expect(changed.token).toMatch(/^drt1:1:2:/u);
        await expect(isWorkingCopyRevisionCurrent(workingPath, revision.token)).resolves.toBe(false);
        await expect(assertWorkingCopyRevisionCurrent(workingPath, revision.token))
            .rejects
            .toMatchObject({code: 'STALE_REVISION'});

        await writeWorkingCopyRevisionSidecar(workingPath, {
            sidecarVersion: 1,
            ...changed,
            updatedAt: changed.mintedAt,
        });
        vi.resetModules();
        const { getWorkingCopyRevision } = await import('@electron/file-access/documentRevisionStore');

        await expect(getWorkingCopyRevision(workingPath, 7))
            .resolves
            .toMatchObject({
                token: changed.token,
                contentRevision: 2,
            });
    });

    it('removes orphaned transition backups when opening a mapped working copy', async () => {
        const originalPath = join(tempRoot, 'orphaned-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-orphaned', 'orphaned-original.pdf');
        const orphanedBackupPath = `${originalPath}.evb-transition-stale.bak`;
        const unrelatedPath = `${originalPath}.evb-transition-stale.txt`;
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));
        writeFileSync(orphanedBackupPath, new Uint8Array([1]));
        writeFileSync(unrelatedPath, new Uint8Array([3]));

        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        await ensureWorkingCopyRevision(workingPath, 7);

        expect(existsSync(orphanedBackupPath)).toBe(false);
        expect(existsSync(unrelatedPath)).toBe(true);
    });

    it('keeps fresh revision fsync off the open path and fences the first mutation on durability', async () => {
        let provisionalSidecar: DocumentRevisionSidecarModule.IWorkingCopyRevisionSidecar | null = null;
        let releaseDurableWrite: (() => void) | undefined;
        const durableWriteGate = new Promise<void>((resolve) => {
            releaseDurableWrite = resolve;
        });
        const provisionalWrite = vi.fn(async (
            _path: string,
            sidecar: DocumentRevisionSidecarModule.IWorkingCopyRevisionSidecar,
        ) => {
            provisionalSidecar = sidecar;
        });
        const durableWrite = vi.fn(async () => durableWriteGate);
        const stageCommit = vi.fn();
        vi.doMock('@electron/file-access/documentRevisionSidecar', async (importOriginal) => {
            const actual = await importOriginal<typeof DocumentRevisionSidecarModule>();
            return {
                ...actual,
                clearWorkingCopyRevisionSidecarCommit: vi.fn(),
                readWorkingCopyRevisionSidecar: vi.fn(async () => provisionalSidecar),
                stageWorkingCopyRevisionSidecarCommit: stageCommit,
                writeProvisionalWorkingCopyRevisionSidecar: provisionalWrite,
                writeWorkingCopyRevisionSidecar: durableWrite,
            };
        });
        try {
            const originalPath = join(tempRoot, 'fresh-original.pdf');
            const workingPath = join(tempRoot, 'pdf-work-fresh', 'fresh.pdf');
            mkdirSync(dirname(workingPath), {recursive: true});
            writeFileSync(originalPath, new Uint8Array([1]));
            writeFileSync(workingPath, new Uint8Array([2]));
            const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
            const {
                initializeFreshWorkingCopyRevision,
                markWorkingCopyRevisionChanged,
            } = await import('@electron/file-access/documentRevisionStore');
            await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

            const initial = await initializeFreshWorkingCopyRevision(workingPath, 7);
            expect(provisionalWrite).toHaveBeenCalledOnce();
            expect(durableWrite).not.toHaveBeenCalled();

            const mutation = markWorkingCopyRevisionChanged(workingPath, 'write', 7);
            await vi.waitFor(() => expect(durableWrite).toHaveBeenCalledOnce());
            expect(durableWrite).toHaveBeenCalledWith(
                workingPath,
                provisionalSidecar,
                {markMutationCommitStarted: false},
            );
            expect(stageCommit).not.toHaveBeenCalled();
            releaseDurableWrite?.();
            const changed = await mutation;

            expect(stageCommit).toHaveBeenCalledOnce();
            expect(changed.previousToken).toBe(initial.token);
            expect(changed.contentRevision).toBe(2);
        } finally {
            vi.doUnmock('@electron/file-access/documentRevisionSidecar');
        }
    });

    it('publishes a transition revision only after its commit succeeds', async () => {
        const originalPath = join(tempRoot, 'transition-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-transition', 'transition.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));
        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const {
            ensureWorkingCopyRevision,
            getWorkingCopyRevision,
            transitionWorkingCopyContentRevision,
        } = await import('@electron/file-access/documentRevisionStore');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);
        const initial = await ensureWorkingCopyRevision(workingPath, 7);

        await expect(transitionWorkingCopyContentRevision(
            workingPath,
            'ocr-apply',
            async () => { throw new Error('catalog commit failed'); },
            7,
            () => { throw new Error('phase reporter failed'); },
        )).rejects.toThrow('catalog commit failed');
        await expect(getWorkingCopyRevision(workingPath, 7)).resolves.toMatchObject({token: initial.token});

        const committed = await transitionWorkingCopyContentRevision(
            workingPath,
            'ocr-apply',
            async nextRevision => {
                expect(nextRevision.contentRevision).toBe(2);
            },
            7,
            () => { throw new Error('phase reporter failed'); },
        );
        expect(committed.previousToken).toBe(initial.token);
        expect(committed.contentRevision).toBe(2);
    });

    it('serializes overlapping content transitions before admitting the next revision', async () => {
        const originalPath = join(tempRoot, 'overlapping-transition-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-overlapping-transition', 'overlapping-transition.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'before-transition');

        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const {
            ensureWorkingCopyRevision,
            getWorkingCopyRevision,
            transitionWorkingCopyContentRevision,
        } = await import('@electron/file-access/documentRevisionStore');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);
        const initial = await ensureWorkingCopyRevision(workingPath, 7);
        let releaseFirst!: () => void;
        const firstCommitStarted = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        let firstCommitEntered!: () => void;
        const firstCommitReady = new Promise<void>(resolve => {
            firstCommitEntered = resolve;
        });
        const first = transitionWorkingCopyContentRevision(
            workingPath,
            'save-sync',
            async nextRevision => {
                expect(nextRevision.contentRevision).toBe(2);
                firstCommitEntered();
                await firstCommitStarted;
            },
            7,
        );
        await firstCommitReady;

        let secondCommitEntered = false;
        const second = transitionWorkingCopyContentRevision(
            workingPath,
            'page-ops',
            async nextRevision => {
                secondCommitEntered = true;
                expect(nextRevision.contentRevision).toBe(3);
            },
            7,
        );
        await Promise.resolve();
        expect(secondCommitEntered).toBe(false);

        releaseFirst();
        await expect(first).resolves.toMatchObject({contentRevision: 2});
        await expect(second).resolves.toMatchObject({contentRevision: 3});
        await expect(getWorkingCopyRevision(workingPath, 7)).resolves.toMatchObject({contentRevision: 3});
        expect(initial.contentRevision).toBe(1);
    });

    it('marks content changes with a new revision', async () => {
        const originalPath = join(tempRoot, 'artifact-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-artifacts', 'artifact-original.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            ensureWorkingCopyRevision,
            isWorkingCopyRevisionCurrent,
            markWorkingCopyContentChanged,
        } = await import('@electron/file-access/documentRevisionStore');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        const revision = await ensureWorkingCopyRevision(workingPath, 7);
        const changed = await markWorkingCopyContentChanged(workingPath, 'page-ops', 7);

        expect(changed.previousToken).toBe(revision.token);
        expect(changed.reason).toBe('page-ops');
        await expect(isWorkingCopyRevisionCurrent(workingPath, revision.token)).resolves.toBe(false);
    });

    it('reconciles a pending revision sidecar journal after module reload', async () => {
        const originalPath = join(tempRoot, 'journal-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-journal', 'journal-original.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const { ensureWorkingCopyRevision } = await import('@electron/file-access/documentRevisionStore');
        const {
            readWorkingCopyRevisionJournalEntries,
            readWorkingCopyRevisionSidecar,
            stageWorkingCopyRevisionSidecarCommit,
        } = await import('@electron/file-access/documentRevisionSidecar');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        const revision = await ensureWorkingCopyRevision(workingPath, 7);
        const nextSidecar = {
            sidecarVersion: 1 as const,
            version: 1 as const,
            documentRef: requireDocumentRef(workingPath),
            authority: 'electron-working-copy' as const,
            token: requireDocumentRevisionToken('drt1:journal:2:pending'),
            contentRevision: revision.contentRevision + 1,
            mintedAt: requireEpochMs(Date.now()),
            updatedAt: requireEpochMs(Date.now()),
        };
        stageWorkingCopyRevisionSidecarCommit(workingPath, nextSidecar, 'save-sync');

        expect(readWorkingCopyRevisionJournalEntries(workingPath))
            .toEqual([expect.objectContaining({
                kind: 'revision-sidecar-commit',
                sidecar: expect.objectContaining({token: nextSidecar.token}),
            })]);

        vi.resetModules();
        const { getWorkingCopyRevision } = await import('@electron/file-access/documentRevisionStore');
        const {
            readWorkingCopyRevisionJournalEntries: readReloadedJournalEntries,
            readWorkingCopyRevisionSidecar: readReloadedRevisionSidecar,
        } = await import('@electron/file-access/documentRevisionSidecar');

        await expect(getWorkingCopyRevision(workingPath, 7))
            .resolves
            .toMatchObject({
                token: nextSidecar.token,
                contentRevision: nextSidecar.contentRevision,
            });
        await expect(readReloadedRevisionSidecar(workingPath))
            .resolves
            .toMatchObject({
                token: nextSidecar.token,
                contentRevision: nextSidecar.contentRevision,
            });
        expect(readReloadedJournalEntries(workingPath)
            .some(entry => entry.kind === 'revision-sidecar-commit')).toBe(false);
        await expect(readWorkingCopyRevisionSidecar(workingPath))
            .resolves
            .toMatchObject({token: nextSidecar.token});
    });

    it('recovers a corrupt revision sidecar from its pending journal', async () => {
        const originalPath = join(tempRoot, 'journal-corrupt-revision-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-journal-corrupt-revision', 'journal-corrupt-revision.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        const {
            readWorkingCopyRevisionJournalEntries,
            stageWorkingCopyRevisionSidecarCommit,
        } = await import('@electron/file-access/documentRevisionSidecar');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        await ensureWorkingCopyRevision(workingPath, 7);
        const recoveredSidecar = {
            sidecarVersion: 1 as const,
            version: 1 as const,
            documentRef: requireDocumentRef(workingPath),
            authority: 'electron-working-copy' as const,
            token: requireDocumentRevisionToken('drt1:journal:2:recovered'),
            contentRevision: 2,
            mintedAt: requireEpochMs(Date.now()),
            updatedAt: requireEpochMs(Date.now()),
        };
        stageWorkingCopyRevisionSidecarCommit(workingPath, recoveredSidecar, 'save-sync');
        writeFileSync(`${workingPath}.evb-revision.json`, '{corrupt revision');

        vi.resetModules();
        const {ensureWorkingCopyRevision: ensureReloadedWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        const recovered = await ensureReloadedWorkingCopyRevision(workingPath, 7);

        expect(recovered.token).toBe(recoveredSidecar.token);
        expect(recovered.contentRevision).toBe(2);
        expect(readWorkingCopyRevisionJournalEntries(workingPath))
            .not.toEqual(expect.arrayContaining([expect.objectContaining({kind: 'revision-sidecar-commit'})]));
    });

    it('mints a fresh revision when a corrupt sidecar has no pending journal', async () => {
        const originalPath = join(tempRoot, 'no-journal-corrupt-revision-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-no-journal-corrupt-revision', 'no-journal-corrupt-revision.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        const initial = await ensureWorkingCopyRevision(workingPath, 7);
        writeFileSync(`${workingPath}.evb-revision.json`, '{corrupt revision');

        const recovered = await ensureWorkingCopyRevision(workingPath, 7);
        expect(recovered.contentRevision).toBe(1);
        expect(recovered.token).not.toBe(initial.token);
    });

    it('fails closed when the revision sidecar cannot be read', async () => {
        vi.doMock('fs/promises', async importOriginal => {
            const actual = await importOriginal<typeof FsPromises>();
            return {
                ...actual,
                readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
                    const [path] = args;
                    if (String(path).endsWith('.evb-revision.json')) {
                        throw Object.assign(new Error('access denied'), {code: 'EACCES'});
                    }
                    return actual.readFile(...args);
                }),
            };
        });
        try {
            const originalPath = join(tempRoot, 'inaccessible-revision-original.pdf');
            const workingPath = join(tempRoot, 'pdf-work-inaccessible-revision', 'inaccessible-revision.pdf');
            mkdirSync(dirname(workingPath), {recursive: true});
            writeFileSync(originalPath, new Uint8Array([1]));
            writeFileSync(workingPath, new Uint8Array([2]));

            const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
            const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
            await setWorkingCopyOriginalPath(workingPath, originalPath, 7);
            writeFileSync(`${workingPath}.evb-revision.json`, JSON.stringify({
                sidecarVersion: 1,
                version: 1,
                documentRef: requireDocumentRef(workingPath),
                authority: 'electron-working-copy',
                token: requireDocumentRevisionToken('drt1:inaccessible:1:revision'),
                contentRevision: 1,
                mintedAt: requireEpochMs(Date.now()),
                updatedAt: requireEpochMs(Date.now()),
            }));

            await expect(ensureWorkingCopyRevision(workingPath, 7))
                .rejects
                .toMatchObject({code: 'EACCES'});
            expect(existsSync(`${workingPath}.evb-revision.json`)).toBe(true);
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it('does not replay stale revision journal entries over a newer sidecar', async () => {
        const originalPath = join(tempRoot, 'journal-stale-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-journal-stale', 'journal-stale-original.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            readWorkingCopyRevisionJournalEntries,
            readWorkingCopyRevisionSidecar,
            stageWorkingCopyRevisionSidecarCommit,
            writeWorkingCopyRevisionSidecar,
        } = await import('@electron/file-access/documentRevisionSidecar');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);
        const newerSidecar = {
            sidecarVersion: 1 as const,
            version: 1 as const,
            documentRef: requireDocumentRef(workingPath),
            authority: 'electron-working-copy' as const,
            token: requireDocumentRevisionToken('drt1:journal:3:current'),
            contentRevision: 3,
            mintedAt: requireEpochMs(Date.now()),
            updatedAt: requireEpochMs(Date.now()),
        };
        const staleSidecar = {
            ...newerSidecar,
            token: requireDocumentRevisionToken('drt1:journal:2:stale'),
            contentRevision: 2,
        };
        await writeWorkingCopyRevisionSidecar(workingPath, newerSidecar);
        stageWorkingCopyRevisionSidecarCommit(workingPath, staleSidecar, 'save-sync');

        await expect(readWorkingCopyRevisionSidecar(workingPath))
            .resolves
            .toMatchObject({
                token: newerSidecar.token,
                contentRevision: newerSidecar.contentRevision,
            });
        expect(readWorkingCopyRevisionJournalEntries(workingPath)
            .some(entry => entry.kind === 'revision-sidecar-commit')).toBe(false);
    });

    it('fails closed for unreadable journal data and retries after the evidence is repaired', async () => {
        const workingPath = join(tempRoot, 'pdf-work-journal-invalid', 'journal-invalid.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(workingPath, new Uint8Array([2]));
        const journalPath = `${workingPath}.evb-revision-journal.json`;
        const invalidJournal = '{"journalVersion":1,"entries":[{' ;
        writeFileSync(journalPath, invalidJournal);

        const {
            assertWorkingCopyMutationAllowed,
            hasWorkingCopySyncRequired,
            isWorkingCopyRevisionCurrent,
        } = await import('@electron/file-access/documentRevisionStore');
        const {
            readWorkingCopyRevisionJournalEntries,
            readWorkingCopyRevisionSidecar,
        } = await import('@electron/file-access/documentRevisionSidecar');

        expect(() => readWorkingCopyRevisionJournalEntries(workingPath)).toThrow(/invalid/u);
        expect(readFileSync(journalPath, 'utf8')).toBe(invalidJournal);
        await expect(readWorkingCopyRevisionSidecar(workingPath)).rejects.toThrow(/invalid/u);
        await expect(isWorkingCopyRevisionCurrent(workingPath, requireDocumentRevisionToken('drt1:journal:1:current')))
            .resolves
            .toBe(false);
        expect(() => assertWorkingCopyMutationAllowed(workingPath)).toThrow(/recovery journal/u);
        expect(hasWorkingCopySyncRequired(workingPath)).toBe(true);

        const now = Date.now();
        writeFileSync(journalPath, JSON.stringify({
            journalVersion: 1,
            updatedAt: now,
            entries: [{
                kind: 'working-copy-sync-required',
                id: 'sync-required:repaired',
                reason: 'copy-back failed',
                targetWriteCommitted: true,
                createdAt: now,
                updatedAt: now,
            }],
        }));
        expect(() => assertWorkingCopyMutationAllowed(workingPath)).toThrow('copy-back failed');
    });

    it('rejects unknown journal versions and retains sync-required entries past seven days', async () => {
        const workingPath = join(tempRoot, 'pdf-work-journal-retention', 'journal-retention.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(workingPath, new Uint8Array([2]));
        const journalPath = `${workingPath}.evb-revision-journal.json`;
        const unknownJournal = JSON.stringify({
            journalVersion: 99,
            entries: [],
        });
        writeFileSync(journalPath, unknownJournal);

        const {readWorkingCopyRevisionJournalEntries} = await import('@electron/file-access/documentRevisionSidecar');
        expect(() => readWorkingCopyRevisionJournalEntries(workingPath)).toThrow(/invalid/u);
        expect(readFileSync(journalPath, 'utf8')).toBe(unknownJournal);

        const {assertWorkingCopyMutationAllowed} = await import('@electron/file-access/documentRevisionStore');
        const updatedAt = Date.now() - (8 * 24 * 60 * 60 * 1000);
        writeFileSync(journalPath, JSON.stringify({
            journalVersion: 1,
            updatedAt,
            entries: [{
                kind: 'working-copy-sync-required',
                id: 'sync-required:old',
                reason: 'old copy-back failure',
                targetWriteCommitted: true,
                createdAt: updatedAt,
                updatedAt,
            }],
        }));
        expect(() => assertWorkingCopyMutationAllowed(workingPath)).toThrow('old copy-back failure');
    });
});
