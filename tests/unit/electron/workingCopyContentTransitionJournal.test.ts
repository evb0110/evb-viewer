import {
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

interface ITransitionSidecarFixture {
    targetPath: string;
    kind?: string;
    backupPath: string | null;
    originalState?: 'present' | 'absent';
}

interface ITransitionJournalFixture {sidecars: ITransitionSidecarFixture[];}

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

    it('rejects a transient page-identity stat failure before recording absence', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const pageIdentityPath = `${path}.evb-pages.json`;
        await writeFile(path, 'revision-n');
        await writeFile(pageIdentityPath, 'old-page-identities');
        const actualStat = await vi.importActual<typeof FsPromises>('node:fs/promises');
        fsMocks.stat.mockImplementation(async target => {
            if (target === pageIdentityPath) {
                throw Object.assign(new Error('transient stat failure'), {code: 'EIO'});
            }
            return actualStat.stat(target);
        });

        await expect(prepareWorkingCopyContentTransition(
            path,
            requireDocumentRevisionToken('revision-n-plus-one'),
        )).rejects.toMatchObject({code: 'EIO'});
        await expect(readFile(path, 'utf8')).resolves.toBe('revision-n');
        await expect(readFile(`${path}.evb-content-transition.json`)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(readFile(pageIdentityPath, 'utf8')).resolves.toBe('old-page-identities');
    });

    it('rejects an OCR root manifest lstat failure before recording an OCR backup mode', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const ocrPath = `${path}.ocr`;
        const manifestPath = join(ocrPath, 'manifest.json');
        await writeFile(path, 'revision-n');
        await mkdir(ocrPath);
        await writeFile(manifestPath, JSON.stringify({
            version: 4,
            catalogId: '00000000-0000-4000-8000-000000000001',
            source: {pdfPath: path},
            documentRevision: {token: requireDocumentRevisionToken('revision-n')},
            pageCount: 1,
            shardSize: 256,
            generation: 1,
            publishedAt: '2026-08-27T00:00:00.000Z',
        }));
        const actualLstat = await vi.importActual<typeof FsPromises>('node:fs/promises');
        fsMocks.lstat.mockImplementation(async target => {
            if (target === manifestPath) {
                throw Object.assign(new Error('transient manifest lstat failure'), {code: 'EACCES'});
            }
            return actualLstat.lstat(target);
        });

        await expect(prepareWorkingCopyContentTransition(
            path,
            requireDocumentRevisionToken('revision-n-plus-one'),
        )).rejects.toMatchObject({code: 'EACCES'});
        await expect(readFile(path, 'utf8')).resolves.toBe('revision-n');
        await expect(readFile(manifestPath, 'utf8')).resolves.toContain('"version":4');
        await expect(readFile(`${path}.evb-content-transition.json`)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('preserves evidence when an old journal cannot establish a missing sidecar', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const backupPath = `${path}.evb-content-old.bak`;
        const pageIdentityPath = `${path}.evb-pages.json`;
        const journalPath = `${path}.evb-content-transition.json`;
        await writeFile(path, 'prepared');
        await writeFile(backupPath, 'original');
        await writeFile(pageIdentityPath, 'new-page-identities');
        await writeFile(journalPath, JSON.stringify({
            version: 1,
            state: 'prepared',
            workingCopyPath: path,
            backupPath,
            nextRevisionToken: requireDocumentRevisionToken('revision-n-plus-one'),
            sidecars: [{
                targetPath: pageIdentityPath,
                backupPath: null,
                directory: false,
            }],
        }));

        await expect(recoverWorkingCopyContentTransition(path)).rejects.toThrow(
            'unknown original state',
        );
        await expect(readFile(path, 'utf8')).resolves.toBe('original');
        await expect(readFile(pageIdentityPath, 'utf8')).resolves.toBe('new-page-identities');
        await expect(readFile(journalPath)).resolves.toBeTruthy();
    });

    it('rejects a prepared journal with contradictory sidecar state', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const backupPath = `${path}.evb-content-old.bak`;
        const pageIdentityPath = `${path}.evb-pages.json`;
        const journalPath = `${path}.evb-content-transition.json`;
        await writeFile(path, 'prepared');
        await writeFile(backupPath, 'original');
        await writeFile(pageIdentityPath, 'new-page-identities');
        await writeFile(journalPath, JSON.stringify({
            version: 1,
            state: 'prepared',
            workingCopyPath: path,
            backupPath,
            nextRevisionToken: requireDocumentRevisionToken('revision-n-plus-one'),
            sidecars: [{
                targetPath: pageIdentityPath,
                backupPath,
                directory: false,
                originalState: 'absent',
            }],
        }));

        await expect(recoverWorkingCopyContentTransition(path)).rejects
            .toMatchObject({code: 'DOCUMENT_RECOVERY_JOURNAL_INVALID'});
        await expect(readFile(path, 'utf8')).resolves.toBe('prepared');
        await expect(readFile(pageIdentityPath, 'utf8')).resolves.toBe('new-page-identities');
        await expect(readFile(backupPath, 'utf8')).resolves.toBe('original');
        await expect(readFile(journalPath)).resolves.toBeTruthy();
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

    it('recovers sidecars with the same all-old crash decision as document bytes', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const ocrPath = `${path}.ocr`;
        const pageIdentityPath = `${path}.evb-pages.json`;
        const legacyIndexPath = `${path}.index.json`;
        const compactIndexPath = `${path}.index.evb-search-v2.bin`;
        await Promise.all([
            writeFile(path, 'revision-n'),
            mkdir(ocrPath),
            writeFile(pageIdentityPath, 'old-page-identities'),
            writeFile(legacyIndexPath, 'old-index'),
        ]);
        await writeFile(join(ocrPath, 'manifest.json'), 'old-ocr');
        await prepareWorkingCopyContentTransition(path, requireDocumentRevisionToken('revision-n-plus-one'));
        await Promise.all([
            writeFile(path, 'revision-n-plus-one'),
            rm(ocrPath, {recursive: true}),
            writeFile(pageIdentityPath, 'new-page-identities'),
            rm(legacyIndexPath),
            writeFile(compactIndexPath, 'new-compact-index'),
        ]);

        await expect(recoverWorkingCopyContentTransition(path)).resolves.toBe(true);
        await expect(readFile(path, 'utf8')).resolves.toBe('revision-n');
        await expect(readFile(join(ocrPath, 'manifest.json'), 'utf8')).resolves.toBe('old-ocr');
        await expect(readFile(pageIdentityPath, 'utf8')).resolves.toBe('old-page-identities');
        await expect(readFile(legacyIndexPath, 'utf8')).resolves.toBe('old-index');
        await expect(readFile(compactIndexPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('snapshots only the root pointer when a prepared v4 generation sits beside a legacy manifest', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-content-transition-'));
        const path = join(root, 'working.pdf');
        const ocrPath = `${path}.ocr`;
        await writeFile(path, 'revision-n');
        await mkdir(ocrPath);
        await Promise.all([
            writeFile(join(ocrPath, 'manifest.json'), 'legacy-v3-manifest'),
            mkdir(join(ocrPath, 'gen-00000001')),
        ]);

        await prepareWorkingCopyContentTransition(path, requireDocumentRevisionToken('revision-n-plus-one'));
        const journal = JSON.parse(await readFile(`${path}.evb-content-transition.json`, 'utf8')) as ITransitionJournalFixture;
        expect(journal.sidecars.find(sidecar => sidecar.targetPath === ocrPath)).toMatchObject({
            kind: 'ocr-v4-root',
            backupPath: expect.any(String),
        });

        await writeFile(path, 'revision-n-plus-one');
        await rm(join(ocrPath, 'manifest.json'));
        await writeFile(join(ocrPath, 'manifest.json'), 'prepared-v4-root');
        await expect(recoverWorkingCopyContentTransition(path)).resolves.toBe(true);
        await expect(readFile(join(ocrPath, 'manifest.json'), 'utf8')).resolves.toBe('legacy-v3-manifest');
        await expect(readdir(ocrPath)).resolves.toContain('gen-00000001');
    });
});
