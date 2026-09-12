import {
    mkdir,
    mkdtemp,
    link,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireEpochMs} from '@contracts/timestamps';
import {writeWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {recoverTwoTargetDocumentTransition} from '@electron/file-access/recoverTwoTargetDocumentTransition';

describe('two-target document transition recovery', () => {
    let root = '';

    afterEach(async () => {
        await rm(root, {
            recursive: true,
            force: true,
        });
    });

    async function prepare(publicRevision: string) {
        root = await mkdtemp(join(tmpdir(), 'evb-two-target-'));
        const workingCopyPath = join(root, 'working.pdf');
        const originalPath = join(root, 'original.pdf');
        const originalBackupPath = join(root, 'original.backup.pdf');
        const nextRevisionToken = requireDocumentRevisionToken('drt1:test:next');
        await Promise.all([
            writeFile(workingCopyPath, 'new-working-copy'),
            writeFile(originalPath, 'new-original'),
            writeFile(originalBackupPath, 'old-original'),
            writeWorkingCopyRevisionSidecar(workingCopyPath, {
                sidecarVersion: 1,
                version: 1,
                documentRef: requireDocumentRef(workingCopyPath),
                authority: 'electron-working-copy',
                token: requireDocumentRevisionToken(publicRevision),
                contentRevision: 2,
                mintedAt: requireEpochMs(2),
                updatedAt: requireEpochMs(2),
            }),
            writeFile(`${workingCopyPath}.evb-two-target-transition.json`, JSON.stringify({
                version: 1,
                state: 'original-committed',
                workingCopyPath,
                originalPath,
                originalBackupPath,
                nextRevisionToken,
            })),
        ]);
        return {
            workingCopyPath,
            originalPath,
        };
    }

    it('restores the original when the new working-copy revision was not published', async () => {
        const {
            workingCopyPath,
            originalPath,
        } = await prepare('drt1:test:old');
        await expect(recoverTwoTargetDocumentTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
    });

    it('keeps the new original when the exact new revision is already public', async () => {
        const {
            workingCopyPath,
            originalPath,
        } = await prepare('drt1:test:next');
        await expect(recoverTwoTargetDocumentTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('new-original');
    });

    it('restores a missing original only from the matching journaled backup', async () => {
        const {
            workingCopyPath,
            originalPath,
        } = await prepare('drt1:test:old');
        const originalBackupPath = join(root, 'original.backup.pdf');
        const {capturePathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
        await writeFile(originalPath, 'old-original');
        await rm(originalBackupPath);
        await link(originalPath, originalBackupPath);
        const preparedWitness = await capturePathSaveWitness(originalPath);
        expect(preparedWitness).not.toBeNull();
        const preparedOriginalSnapshot = preparedWitness!.getSnapshotForJournal();
        await preparedWitness!.close();
        const newOriginalPath = join(root, 'new-original.pdf');
        await writeFile(newOriginalPath, 'new-original');
        await rename(newOriginalPath, originalPath);
        const publishedWitness = await capturePathSaveWitness(originalPath);
        expect(publishedWitness).not.toBeNull();
        const publishedOriginalSnapshot = publishedWitness!.getSnapshotForJournal();
        await publishedWitness!.close();
        await rm(originalPath);
        await writeFile(`${workingCopyPath}.evb-two-target-transition.json`, JSON.stringify({
            version: 1,
            state: 'original-committed',
            workingCopyPath,
            originalPath,
            originalBackupPath,
            nextRevisionToken: requireDocumentRevisionToken('drt1:test:next'),
            preparedOriginalSnapshot,
            publishedOriginalSnapshot,
        }));

        await expect(recoverTwoTargetDocumentTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(originalBackupPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('fails closed when the two-target journal cannot be read', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-two-target-'));
        const workingCopyPath = join(root, 'working.pdf');
        const journalPath = `${workingCopyPath}.evb-two-target-transition.json`;
        await mkdir(journalPath);

        await expect(recoverTwoTargetDocumentTransition(workingCopyPath)).rejects.toMatchObject({
            name: 'DocumentRecoveryJournalError',
            code: 'DOCUMENT_RECOVERY_JOURNAL_UNREADABLE',
            journalPath,
        });
    });

    it('fails closed on a truncated two-target journal', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-two-target-'));
        const workingCopyPath = join(root, 'working.pdf');
        const journalPath = `${workingCopyPath}.evb-two-target-transition.json`;
        await writeFile(journalPath, '{"version":1');

        await expect(recoverTwoTargetDocumentTransition(workingCopyPath)).rejects.toMatchObject({
            name: 'DocumentRecoveryJournalError',
            code: 'DOCUMENT_RECOVERY_JOURNAL_INVALID',
            journalPath,
        });
        await expect(readFile(journalPath, 'utf8')).resolves.toBe('{"version":1');
    });

    it.each([
        {
            name: 'an unknown version',
            journal: {
                version: 99,
                entries: [],
            },
        },
        {
            name: 'a malformed sync-required entry',
            journal: {
                version: 1,
                mode: 'save-as',
                state: 'sync-required',
                originalBackupPath: null,
                originalExistedBefore: true,
                nextRevisionToken: requireDocumentRevisionToken('drt1:test:next'),
                syncRequiredReason: '',
            },
        },
        {
            name: 'a save-as entry without its original existence witness',
            journal: {
                version: 1,
                mode: 'save-as',
                state: 'prepared',
                originalBackupPath: null,
                nextRevisionToken: requireDocumentRevisionToken('drt1:test:next'),
            },
        },
        {
            name: 'a save transition marked sync-required',
            journal: {
                version: 1,
                mode: 'save',
                state: 'sync-required',
                originalBackupPath: 'original.backup.pdf',
                nextRevisionToken: requireDocumentRevisionToken('drt1:test:next'),
            },
        },
    ])('preserves evidence and fails closed for $name', async ({journal}) => {
        root = await mkdtemp(join(tmpdir(), 'evb-two-target-'));
        const workingCopyPath = join(root, 'working.pdf');
        const journalPath = `${workingCopyPath}.evb-two-target-transition.json`;
        const journalWithPaths = {
            ...journal,
            workingCopyPath,
            originalPath: join(root, 'original.pdf'),
        };
        const journalText = JSON.stringify(journalWithPaths);
        await writeFile(journalPath, journalText);

        await expect(recoverTwoTargetDocumentTransition(workingCopyPath)).rejects.toMatchObject({
            name: 'DocumentRecoveryJournalError',
            code: 'DOCUMENT_RECOVERY_JOURNAL_INVALID',
            journalPath,
        });
        await expect(readFile(journalPath, 'utf8')).resolves.toBe(journalText);
    });

    it.skipIf(process.platform === 'win32')('leaves a real external replacement in place after a crash', async () => {
        const {
            workingCopyPath,
            originalPath,
        } = await prepare('drt1:test:old');
        const originalBackupPath = join(root, 'original.backup.pdf');
        const {
            capturePathSaveWitness,
            OriginalPathSaveConflictError,
        } = await import('@electron/file-access/originalPathSaveWitness');
        const witness = await capturePathSaveWitness(originalPath);
        expect(witness).not.toBeNull();
        const publishedOriginalSnapshot = witness!.getSnapshotForJournal();
        await witness!.close();
        await writeFile(`${workingCopyPath}.evb-two-target-transition.json`, JSON.stringify({
            version: 1,
            state: 'original-committed',
            workingCopyPath,
            originalPath,
            originalBackupPath,
            nextRevisionToken: requireDocumentRevisionToken('drt1:test:next'),
            publishedOriginalSnapshot,
        }));
        const externalPath = join(root, 'external-replacement.pdf');
        await writeFile(externalPath, 'external-after-crash');
        await rename(externalPath, originalPath);

        await expect(recoverTwoTargetDocumentTransition(workingCopyPath))
            .rejects
            .toBeInstanceOf(OriginalPathSaveConflictError);
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('external-after-crash');
        await expect(readFile(originalBackupPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(`${workingCopyPath}.evb-two-target-transition.json`, 'utf8'))
            .resolves
            .toContain('original-committed');
    });
});
