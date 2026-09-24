import {
    appendFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {
    prepareWorkingCopyContentTransition,
    recoverWorkingCopyContentTransition,
    rollbackWorkingCopyContentTransition,
} from '@electron/file-access/workingCopyContentTransitionJournal';

const fsMocks = vi.hoisted(() => ({
    lstat: vi.fn(),
    stat: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    fsMocks.lstat.mockImplementation(actual.lstat);
    fsMocks.stat.mockImplementation(actual.stat);
    return {
        ...actual,
        lstat: fsMocks.lstat,
        stat: fsMocks.stat,
    };
});

describe('workingCopyContentTransitionJournal', () => {
    let root = '';

    afterEach(async () => {
        vi.restoreAllMocks();
        fsMocks.lstat.mockReset();
        fsMocks.stat.mockReset();
        const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
        fsMocks.lstat.mockImplementation(actual.lstat);
        fsMocks.stat.mockImplementation(actual.stat);
        await rm(root, {
            recursive: true,
            force: true,
        });
    });

    it('recovers pre-transition bytes after a crash before revision publication', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, 'revision-n');
        await prepareWorkingCopyContentTransition(path, requireDocumentRevisionToken('revision-n-plus-one'));
        await writeFile(path, 'revision-n-plus-one');

        await expect(recoverWorkingCopyContentTransition(path)).resolves.toBe(true);
        await expect(readFile(path, 'utf8')).resolves.toBe('revision-n');
        await expect(recoverWorkingCopyContentTransition(path)).resolves.toBe(false);
    });

    it('truncates an append-only hard-link backup during crash recovery', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, 'revision-n');

        await prepareWorkingCopyContentTransition(
            path,
            requireDocumentRevisionToken('revision-n-plus-one'),
            undefined,
            'append',
        );
        const journal = JSON.parse(await readFile(`${path}.evb-content-transition.json`, 'utf8')) as {
            backupMode?: string;
            previousLength?: number;
        };
        expect(journal.backupMode).toBe('append-hard-link');
        expect(journal.previousLength).toBe(Buffer.byteLength('revision-n'));

        await appendFile(path, '-plus-one');
        await expect(readFile(path, 'utf8')).resolves.toBe('revision-n-plus-one');
        await expect(recoverWorkingCopyContentTransition(path)).resolves.toBe(true);
        await expect(readFile(path, 'utf8')).resolves.toBe('revision-n');
    });

    it('restores pre-append bytes when the appended working copy was replaced', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, 'revision-n');

        await prepareWorkingCopyContentTransition(
            path,
            requireDocumentRevisionToken('revision-n-plus-one'),
            undefined,
            'append',
        );
        await appendFile(path, '-plus-one');
        await rm(path);
        await writeFile(path, 'replacement');

        await expect(recoverWorkingCopyContentTransition(path)).resolves.toBe(true);
        await expect(readFile(path, 'utf8')).resolves.toBe('revision-n');
    });

    it('fails closed when the transition journal cannot be read', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const journalPath = `${path}.evb-content-transition.json`;
        await mkdir(journalPath);

        await expect(recoverWorkingCopyContentTransition(path)).rejects.toMatchObject({
            name: 'DocumentRecoveryJournalError',
            code: 'DOCUMENT_RECOVERY_JOURNAL_UNREADABLE',
            journalPath,
        });
        await expect(readdir(root)).resolves.toContain('working.pdf.evb-content-transition.json');
    });

    it('fails closed on a truncated transition journal', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const journalPath = `${path}.evb-content-transition.json`;
        await writeFile(journalPath, '{"version":1');

        await expect(recoverWorkingCopyContentTransition(path)).rejects.toMatchObject({
            name: 'DocumentRecoveryJournalError',
            code: 'DOCUMENT_RECOVERY_JOURNAL_INVALID',
            journalPath,
        });
        await expect(readFile(journalPath, 'utf8')).resolves.toBe('{"version":1');
    });

    it('rolls back immediately when verify or commit fails', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        await writeFile(path, 'verified');
        const journal = await prepareWorkingCopyContentTransition(
            path,
            requireDocumentRevisionToken('next-revision'),
        );
        await writeFile(path, 'unverified');
        await rollbackWorkingCopyContentTransition(journal);
        await expect(readFile(path, 'utf8')).resolves.toBe('verified');
    });

});
