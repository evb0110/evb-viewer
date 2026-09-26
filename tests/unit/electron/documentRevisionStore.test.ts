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
    rmSync,
    writeFileSync,
} from 'fs';
import {
    dirname,
    join,
} from 'path';
import { tmpdir } from 'os';
import {
    appendFile,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import type * as NodeCrypto from 'node:crypto';
import type * as FsPromises from 'fs/promises';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireEpochMs} from '@contracts/timestamps';
import {
    prepareWorkingCopyTransition,
    recordWorkingCopyJournalOriginal,
    recoverWorkingCopyTransition,
} from '@electron/file-access/workingCopyJournal';
import {writeWorkingCopyManifestRevision} from '@electron/file-access/workingCopyManifest';

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
            markWorkingCopyContentChanged,
        } = await import('@electron/file-access/documentRevisionStore');
        const {readWorkingCopyRevision} = await import('@electron/file-access/workingCopyManifest');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        const revision = await ensureWorkingCopyRevision(workingPath, 7);
        const persisted = await readWorkingCopyRevision(workingPath);

        expect(revision).toMatchObject({
            version: 1,
            documentRef: requireDocumentRef(workingPath),
            authority: 'electron-working-copy',
            contentRevision: 1,
        });
        expect(revision.token).toMatch(/^drt1:1:1:/u);
        expect(persisted?.token).toBe(revision.token);

        const changed = await markWorkingCopyContentChanged(workingPath, 'write', 7);

        expect(changed.previousToken).toBe(revision.token);
        expect(changed.contentRevision).toBe(2);
        expect(changed.token).toMatch(/^drt1:1:2:/u);
        await expect(isWorkingCopyRevisionCurrent(workingPath, revision.token)).resolves.toBe(false);
        await expect(assertWorkingCopyRevisionCurrent(workingPath, revision.token))
            .rejects
            .toMatchObject({code: 'STALE_REVISION'});

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

    it('mints a fresh revision when the manifest is corrupt', async () => {
        const originalPath = join(tempRoot, 'no-journal-corrupt-revision-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-no-journal-corrupt-revision', 'no-journal-corrupt-revision.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        const initial = await ensureWorkingCopyRevision(workingPath, 7);
        writeFileSync(join(dirname(workingPath), 'manifest.json'), '{corrupt revision');

        const recovered = await ensureWorkingCopyRevision(workingPath, 7);
        expect(recovered.contentRevision).toBe(1);
        expect(recovered.token).not.toBe(initial.token);
    });

    it('fails closed when the manifest cannot be read', async () => {
        vi.doMock('fs/promises', async importOriginal => {
            const actual = await importOriginal<typeof FsPromises>();
            return {
                ...actual,
                readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
                    const [path] = args;
                    if (String(path).endsWith('manifest.json')) {
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
            writeFileSync(join(dirname(workingPath), 'manifest.json'), JSON.stringify({
                version: 1,
                revision: {
                    version: 1,
                    documentRef: requireDocumentRef(workingPath),
                    authority: 'electron-working-copy',
                    token: requireDocumentRevisionToken('drt1:inaccessible:1:revision'),
                    contentRevision: 1,
                    mintedAt: requireEpochMs(Date.now()),
                },
            }));

            await expect(ensureWorkingCopyRevision(workingPath, 7))
                .rejects
                .toMatchObject({code: 'EACCES'});
            expect(existsSync(join(dirname(workingPath), 'manifest.json'))).toBe(true);
        } finally {
            vi.doUnmock('fs/promises');
        }
    });


    it('keeps the revision of a working copy written in the old layout', async () => {
        const originalPath = join(tempRoot, 'legacy-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-legacy', 'document.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));
        const token = requireDocumentRevisionToken('drt1:legacy:3:revision');
        writeFileSync(`${workingPath}.evb-revision.json`, JSON.stringify({
            sidecarVersion: 1,
            version: 1,
            documentRef: requireDocumentRef(workingPath),
            authority: 'electron-working-copy',
            token,
            contentRevision: 3,
            mintedAt: requireEpochMs(Date.now()),
            updatedAt: requireEpochMs(Date.now()),
        }));

        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        await expect(ensureWorkingCopyRevision(workingPath, 7)).resolves.toMatchObject({
            token,
            contentRevision: 3,
        });
        expect(existsSync(`${workingPath}.evb-revision.json`)).toBe(false);
        expect(existsSync(join(dirname(workingPath), 'manifest.json'))).toBe(true);
    });
});

const NEXT = requireDocumentRevisionToken('drt1:test:2:next');

describe('workingCopyJournal crash recovery', () => {
    let root = '';

    afterEach(async () => {
        await rm(root, {
            recursive: true,
            force: true,
        });
    });

    async function setup(publishedToken: string) {
        root = await mkdtemp(join(tmpdir(), 'evb-working-copy-journal-'));
        const workingCopyPath = join(root, 'document.pdf');
        await writeFile(workingCopyPath, 'revision-1');
        await writeWorkingCopyManifestRevision(workingCopyPath, {
            version: 1,
            documentRef: requireDocumentRef(workingCopyPath),
            authority: 'electron-working-copy',
            token: requireDocumentRevisionToken(publishedToken),
            contentRevision: 1,
            mintedAt: requireEpochMs(1),
        });
        return workingCopyPath;
    }

    it('puts back the previous bytes when the next revision was never published', async () => {
        const workingCopyPath = await setup('drt1:test:1:current');
        await prepareWorkingCopyTransition(workingCopyPath, NEXT);
        await writeFile(workingCopyPath, 'revision-2');

        await expect(recoverWorkingCopyTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('revision-1');
        await expect(readdir(root)).resolves.toEqual([
            'document.pdf',
            'manifest.json',
        ]);
    });

    it('keeps the new bytes once the manifest names the next revision', async () => {
        const workingCopyPath = await setup(NEXT);
        await prepareWorkingCopyTransition(workingCopyPath, NEXT);
        await writeFile(workingCopyPath, 'revision-2');

        await expect(recoverWorkingCopyTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('revision-2');
        await expect(readdir(root)).resolves.toEqual([
            'document.pdf',
            'manifest.json',
        ]);
    });

    it('cuts an in-place append back to its previous length', async () => {
        const workingCopyPath = await setup('drt1:test:1:current');
        await prepareWorkingCopyTransition(workingCopyPath, NEXT, undefined, 'append');
        await appendFile(workingCopyPath, '-appended');

        await recoverWorkingCopyTransition(workingCopyPath);
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('revision-1');
    });

    it('restores a published original together with the working copy', async () => {
        const workingCopyPath = await setup('drt1:test:1:current');
        const originalPath = join(root, 'original.pdf');
        const originalBackupPath = join(root, 'original.pdf.evb-transition-test.bak');
        await writeFile(originalPath, 'saved-2');
        await writeFile(originalBackupPath, 'saved-1');
        const journal = await prepareWorkingCopyTransition(workingCopyPath, NEXT);
        await recordWorkingCopyJournalOriginal(journal, {
            path: originalPath,
            backupPath: originalBackupPath,
            state: 'published',
        });
        await writeFile(workingCopyPath, 'revision-2');

        await recoverWorkingCopyTransition(workingCopyPath);
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('saved-1');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('revision-1');
        await expect(readdir(root)).resolves.toEqual([
            'document.pdf',
            'manifest.json',
            'original.pdf',
        ]);
    });

    it('leaves a truncated journal and the document untouched', async () => {
        const workingCopyPath = await setup('drt1:test:1:current');
        await writeFile(join(root, 'journal.json'), '{"version":1');

        await expect(recoverWorkingCopyTransition(workingCopyPath)).rejects.toThrow('Working-copy journal is invalid');
        await expect(readFile(join(root, 'journal.json'), 'utf8')).resolves.toBe('{"version":1');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('revision-1');
    });
});
