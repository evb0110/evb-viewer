import {
    appendFile,
    link,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {
    dirname, join,
} from 'node:path';
import type * as WorkingCopyManifestModule from '@electron/file-access/workingCopyManifest';
import type * as WorkingCopyJournalModule from '@electron/file-access/workingCopyJournal';
import type * as DocumentFileWriteAtomicModule from '@electron/file-access/documentFileWriteAtomic';
import type * as OriginalPathSnapshotModule from '@electron/file-access/originalPathSnapshot';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePaneId} from '@contracts/editorPanes';
import {requireEpochMs} from '@contracts/timestamps';
import {requireTabId} from '@contracts/windowTabs';
import type {IWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

// The first import transforms the module graph, which takes seconds on a loaded
// machine. Collection pays that once, outside every test and hook budget; tests
// re-import these after resetModules from the transform cache.
await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
await import('@electron/file-access/originalPathSaveWitness');
await import('@electron/file-access/documentFileWriteAtomic');
await import('@electron/file-access/workingCopyStore');
await import('@electron/file-access/documentRevisionStore');
await import('@electron/file-access/workingCopyManifest');
await import('@electron/workspaceCheckpointStore');
await import('@electron/utils/atomicReplace');
await import('@electron/file-access/workingCopyJournal');

let tempRoot = '';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

function createCheckpoint(sourcePath: string, workingCopyPath: string): IWorkspaceCheckpoint {
    const paneId = requirePaneId('issue-398-pane');
    const tabId = requireTabId('issue-398-tab');
    return {
        version: 1,
        capturedAt: requireEpochMs(123),
        activePaneId: paneId,
        activeTabId: tabId,
        layout: {
            type: 'leaf',
            paneId,
        },
        panes: [{
            paneId,
            tabIds: [tabId],
            activeTabId: tabId,
        }],
        tabs: [{
            tabId,
            paneId,
            fileName: 'issue-398-source.pdf',
            sourceRef: requireDocumentRef(sourcePath),
            workingCopyRef: requireDocumentRef(workingCopyPath),
            isDirty: true,
            isDjvu: false,
            currentPage: 1,
            zoom: 1,
            zoomMode: 'fit-width',
        }],
    };
}

vi.mock('electron', () => ({app: {getPath: vi.fn(() => tempRoot)}}));

describe('transitionOriginalAndWorkingCopyRevision', () => {
    beforeEach(async () => {
        vi.resetModules();
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-two-target-transition-test-'));
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
    });

    afterEach(async () => {
        delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        await rm(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    async function prepare(
        initialOriginal = 'old-original',
        initialWorking = 'old-working',
        originalName = 'original.pdf',
        workingDirectory = tempRoot,
    ) {
        const originalPath = join(tempRoot, originalName);
        const workingCopyPath = join(workingDirectory, 'working.pdf');
        const stagedPath = join(tempRoot, 'staged.pdf');
        await mkdir(workingDirectory, {recursive: true});
        await Promise.all([
            writeFile(originalPath, initialOriginal),
            writeFile(workingCopyPath, initialWorking),
            writeFile(stagedPath, 'new-committed-pdf'),
        ]);

        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        await setWorkingCopyOriginalPath(workingCopyPath, originalPath, 7, {backingState: 'eager'});
        await ensureWorkingCopyRevision(workingCopyPath, 7);

        return {
            originalPath,
            stagedPath,
            workingCopyPath,
        };
    }

    it('keeps accepted work and an external save made during registration refresh', async () => {
        const {
            originalPath, stagedPath, workingCopyPath,
        } = await prepare();
        const publication = Buffer.alloc(2 * 1024 * 1024, 67);
        await writeFile(stagedPath, publication);
        const {atomicReplace} = await import('@electron/utils/atomicReplace');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
        const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
        const {OriginalPathSaveConflictError} = await import('@electron/file-access/originalPathSnapshot');
        const transition = transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            publishedSourcePath: stagedPath,
            senderId: 7,
            reason: 'save-sync',
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => atomicReplace(stagedPath, originalPath, {
                assertDestinationCurrent,
                destinationBackupPath,
            }),
            afterWorkingCopySync: async (admitted) => {
                const writer = spawnSync(process.execPath, [
                    '--input-type=module',
                    '-e',
                    'import fs from \'node:fs/promises\';const h=await fs.open(process.argv[1],\'r+\');await h.write(\'EXTERNAL\',262144);await h.close();',
                    originalPath,
                ],
                {
                    encoding: 'utf8',
                    windowsHide: true,
                });
                expect(writer.status, writer.stderr).toBe(0);
                await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7, admitted);
            },
        });
        const error: unknown = await transition.catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(OriginalPathSaveConflictError);
        if (!(error instanceof OriginalPathSaveConflictError)) throw new Error('Save did not report the external conflict');
        expect(error.keptFilePath).toBeTruthy();
        await expect(readFile(error.keptFilePath!, 'utf8')).resolves.toBe('old-working');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
        const external = Buffer.from(publication);
        external.write('EXTERNAL', 262144);
        expect((await readFile(originalPath)).equals(external)).toBe(true);
        await expect(captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7)).resolves.toBeNull();
    });

    it.each([
        'append',
        'overwrite',
        'atomic replacement',
    ] as const)(
        'isolates the accepted working bytes from external %s without reflinks',
        async (mutation) => {
            const {
                originalPath,
                stagedPath,
                workingCopyPath,
            } = await prepare();
            const phases: string[] = [];
            const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
            const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
            const {originalPathSaveBaseMatches} = await import('@electron/file-access/originalPathSaveWitness');
            const {getWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');

            await expect(transitionOriginalAndWorkingCopyRevision({
                captureOriginalWitness: async () => (await import('@electron/file-access/originalPathSaveWitness')).captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
                workingCopyPath,
                originalPath,
                reason: 'native-mutation',
                senderId: 7,
                publishedSourcePath: stagedPath,
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                }),
                afterWorkingCopySync: async () => {
                    expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
                },
                onPhase: phase => phases.push(phase),
            })).resolves.toMatchObject({
                contentRevision: 2,
                reason: 'native-mutation',
            });

            const [
                originalStat,
                workingStat,
            ] = await Promise.all([
                stat(originalPath, {bigint: true}),
                stat(workingCopyPath, {bigint: true}),
            ]);
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('new-committed-pdf');
            expect(phases.indexOf('transition-sync-working-copy-fsync-file')).toBeGreaterThan(-1);
            expect(phases.indexOf('transition-sync-working-copy-fsync-directory')).toBeGreaterThan(-1);
            expect(phases.indexOf('transition-sync-working-copy-fsync-file'))
                .toBeLessThan(phases.indexOf('revision-write-manifest'));
            expect(phases.indexOf('transition-sync-working-copy-fsync-directory'))
                .toBeLessThan(phases.indexOf('revision-write-manifest'));
            await expect(originalPathSaveBaseMatches(workingCopyPath, originalPath, 7)).resolves.toBe(true);

            const acceptedRevision = await getWorkingCopyRevision(workingCopyPath, 7);
            if (mutation === 'append') {
                await appendFile(originalPath, '-external-change');
            } else if (mutation === 'overwrite') {
                await writeFile(originalPath, 'external');
            } else {
                const externalPath = join(tempRoot, 'external.pdf');
                await writeFile(externalPath, 'external-replacement');
                await rename(externalPath, originalPath);
            }
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('new-committed-pdf');
            expect(originalStat.ino).not.toBe(workingStat.ino);
            expect(workingStat.nlink).toBe(1n);
            await expect(getWorkingCopyRevision(workingCopyPath, 7)).resolves.toEqual(acceptedRevision);
            await expect(originalPathSaveBaseMatches(workingCopyPath, originalPath, 7)).resolves.toBe(false);
        },
    );

    it('refreshes the original witness after a managed replacement detaches a linked working copy', async () => {
        const {
            originalPath,
            workingCopyPath,
        } = await prepare('original-before-transition', 'working-before-transition');
        const {
            getWorkingCopyOriginalFileExpectation,
            refreshWorkingCopyOriginalFileExpectation,
        } = await import('@electron/file-access/workingCopyStore');
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
        const {transitionWorkingCopyContentRevision} = await import('@electron/file-access/documentRevisionStore');

        await rm(workingCopyPath);
        await link(originalPath, workingCopyPath);
        expect((await stat(originalPath, {bigint: true})).nlink).toBe(2n);
        expect(getWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).not.toBeNull();
        expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);

        const replacementPath = `${workingCopyPath}.replacement`;
        await expect(transitionWorkingCopyContentRevision(
            workingCopyPath,
            'page-ops',
            async () => {
                await writeFile(replacementPath, 'working-after-transition');
                await rename(replacementPath, workingCopyPath);
            },
            7,
        )).resolves.toMatchObject({contentRevision: 2});

        const [
            originalStat,
            workingCopyStat,
        ] = await Promise.all([
            stat(originalPath, {bigint: true}),
            stat(workingCopyPath, {bigint: true}),
        ]);
        expect(originalStat.ino).not.toBe(workingCopyStat.ino);
        expect(originalStat.nlink).toBe(1n);
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('original-before-transition');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('working-after-transition');

        const witness = await captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7);
        expect(witness).not.toBeNull();

        await appendFile(originalPath, '-external-change');
        await expect(captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7)).resolves.toBeNull();
    });

    // No-link edits here precede displacement. Path recreation before install
    // remains the residual window documented in behavior-contract.md, T3.
    it.each([
        'in-place',
        'replacement',
        'long-name',
        'no-links-in-place',
        'no-links-replacement',
        'no-links-ebusy-replacement',
    ])('retains the bytes displaced by a last-instant %s edit', async mutation => {
        const fs = await import('node:fs/promises');
        let originalPath = '';
        let edited = false;
        let busy = false;
        const original = Buffer.alloc(2 * 1024 * 1024, 65);
        const external = Buffer.from(original);
        external.write('EXTERNAL-EDIT', 262144);
        const renameWithEdit: typeof fs.rename = async (source, destination) => {
            if (process.platform === 'win32' && mutation === 'no-links-ebusy-replacement' && !busy && String(destination) === originalPath
                && await fs.stat(originalPath).catch(() => null)) {
                busy = true;
                throw Object.assign(new Error('Injected EBUSY'), {code: 'EBUSY'});
            }
            if (!edited && (String(destination) === originalPath
                || String(source) === originalPath && (String(destination).includes('.evb-transition-') || String(destination).includes('.bak-')))) {
                edited = true;
                if (mutation.endsWith('in-place')) {
                    const handle = await fs.open(originalPath, 'r+');
                    await handle.write('EXTERNAL-EDIT', 262144);
                    await handle.close();
                } else {
                    const replacement = `${originalPath}.external`;
                    await fs.writeFile(replacement, external);
                    await fs.rename(replacement, originalPath);
                }
                await fs.utimes(originalPath, 1700000000, 1700000000);
            }
            await fs.rename(source, destination);
        };
        vi.doMock('fs/promises', () => ({
            ...fs,
            rename: renameWithEdit,
            link: async (...args: Parameters<typeof fs.link>) => {
                if (mutation.startsWith('no-links')) throw Object.assign(new Error('No hard links'), {code: 'ENOTSUP'});
                return fs.link(...args);
            },
        }));
        try {
            const fixture = await prepare('old-original', 'accepted-unsaved-work', mutation === 'long-name' ? `${'a'.repeat(220)}.pdf` : 'original.pdf');
            originalPath = fixture.originalPath;
            await writeFile(originalPath, original);
            await fs.utimes(originalPath, 1700000000, 1700000000);
            const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
            await refreshWorkingCopyOriginalFileExpectation(fixture.workingCopyPath, 7);
            const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
            const {atomicReplace} = await import('@electron/utils/atomicReplace');
            const result = await transitionOriginalAndWorkingCopyRevision({
                ...fixture,
                publishedSourcePath: fixture.stagedPath,
                senderId: 7,
                reason: 'save-sync',
                captureOriginalWitness: () => captureOriginalPathSaveWitness(fixture.workingCopyPath, originalPath, 7),
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => atomicReplace(fixture.stagedPath, originalPath, {
                    ...({
                        ...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent}),
                        ...(destinationBackupPath === undefined ? {} : {destinationBackupPath}),
                    }),
                    destinationBackupPath,
                }),
            }).catch((error: unknown) => error);
            expect(edited).toBe(true);
            expect(result).toMatchObject({keptFilePath: expect.any(String)});
            expect(await readFile(fixture.workingCopyPath, 'utf8')).toBe('accepted-unsaved-work');
            expect(await readFile(originalPath, 'utf8')).toBe('new-committed-pdf');
            const retained = (await readdir(tempRoot)).filter(name => name.includes('.evb-transition-') && name.endsWith('.bak'));
            expect(retained).toHaveLength(1);
            expect((await readFile(join(tempRoot, retained[0]!))).equals(external)).toBe(true);
            const {recoverWorkingCopyTransition} = await import('@electron/file-access/workingCopyJournal');
            await recoverWorkingCopyTransition(fixture.workingCopyPath);
            const {getWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
            await getWorkingCopyRevision(fixture.workingCopyPath, 7);
            expect(result).toMatchObject({keptFilePath: join(tempRoot, retained[0]!)});
            expect((await readFile(join(tempRoot, retained[0]!))).equals(external)).toBe(true);
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it.each([
        'in-place',
        'replacement',
    ])(
        'keeps accepted work when an external %s edit follows publication', async mutation => {
            const fixture = await prepare('old-original', 'accepted-unsaved-work');
            const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
            const {atomicReplace} = await import('@electron/utils/atomicReplace');
            const result = await transitionOriginalAndWorkingCopyRevision({
                ...fixture,
                publishedSourcePath: fixture.stagedPath,
                senderId: 7,
                reason: 'save-sync',
                captureOriginalWitness: () => captureOriginalPathSaveWitness(fixture.workingCopyPath, fixture.originalPath, 7),
                publishOriginal: async (assertDestinationCurrent, destinationBackupPath) => {
                    await atomicReplace(fixture.stagedPath, fixture.originalPath, {
                        ...({
                            ...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent}),
                            ...(destinationBackupPath === undefined ? {} : {destinationBackupPath}),
                        }),
                        destinationBackupPath,
                    });
                    const target = mutation === 'replacement' ? `${fixture.originalPath}.external` : fixture.originalPath;
                    await writeFile(target, 'external-after-publication');
                    if (mutation === 'replacement') await rename(target, fixture.originalPath);
                },
            }).catch((error: unknown) => error);
            expect(result).toMatchObject({keptFilePath: expect.any(String)});
            expect(await readFile(fixture.originalPath, 'utf8')).toBe('external-after-publication');
            expect(await readFile(fixture.workingCopyPath, 'utf8')).toBe('accepted-unsaved-work');
            const {getWorkingCopyJournalPath} = await import('@electron/file-access/workingCopyDirectory');
            const journal = JSON.parse(await readFile(getWorkingCopyJournalPath(fixture.workingCopyPath), 'utf8')) as WorkingCopyJournalModule.IWorkingCopyJournal;
            expect(result).toMatchObject({keptFilePath: journal.backupPath});
            expect(await readFile(journal.backupPath, 'utf8')).toBe('accepted-unsaved-work');
            const {recoverWorkingCopyTransition} = await import('@electron/file-access/workingCopyJournal');
            await recoverWorkingCopyTransition(fixture.workingCopyPath);
            expect(await readFile(journal.backupPath, 'utf8')).toBe('accepted-unsaved-work');
            expect(await readFile(fixture.originalPath, 'utf8')).toBe('external-after-publication');
        },
    );

    it('keeps the admitted baseline when the original changes before displacement', async () => {
        const fs = await import('node:fs/promises');
        let originalPath = '';
        let edited = false;
        const editBeforeBackup = async (source: string, destination: string) => {
            if (!edited && source === originalPath && destination.includes('.evb-transition-')) {
                edited = true;
                const handle = await fs.open(originalPath, 'r+');
                await handle.write('EXTERNAL-EDIT', 262144);
                await handle.close();
                await fs.utimes(originalPath, 1700000000, 1700000000);
            }
        };
        vi.doMock('fs/promises', () => ({
            ...fs,
            copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
                await editBeforeBackup(String(args[0]), String(args[1]));
                return fs.copyFile(...args);
            },
            link: async (...args: Parameters<typeof fs.link>) => {
                await editBeforeBackup(String(args[0]), String(args[1]));
                return fs.link(...args);
            },
        }));
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'success';
        try {
            const fixture = await prepare('old-original', 'accepted-unsaved-work');
            originalPath = fixture.originalPath;
            await writeFile(originalPath, Buffer.alloc(2 * 1024 * 1024, 65));
            await fs.utimes(originalPath, 1700000000, 1700000000);
            const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
            await refreshWorkingCopyOriginalFileExpectation(fixture.workingCopyPath, 7);
            const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
            const {atomicReplace} = await import('@electron/utils/atomicReplace');
            await expect(transitionOriginalAndWorkingCopyRevision({
                ...fixture,
                publishedSourcePath: fixture.stagedPath,
                senderId: 7,
                reason: 'save-sync',
                captureOriginalWitness: () => captureOriginalPathSaveWitness(fixture.workingCopyPath, originalPath, 7),
                publishOriginal: async (assertDestinationCurrent, destinationBackupPath) => {
                    await editBeforeBackup(originalPath, destinationBackupPath);
                    return atomicReplace(fixture.stagedPath, originalPath, {
                        ...({
                            ...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent}),
                            ...(destinationBackupPath === undefined ? {} : {destinationBackupPath}),
                        }),
                        destinationBackupPath,
                    });
                },
            })).resolves.toBeNull();
            expect(edited).toBe(true);
            expect((await readFile(originalPath)).subarray(262144, 262157).toString()).toBe('EXTERNAL-EDIT');
            expect(await readFile(fixture.workingCopyPath, 'utf8')).toBe('accepted-unsaved-work');
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it('keeps the original pathname on a volume without hard links', async () => {
        const fs = await import('node:fs/promises');
        vi.doMock('fs/promises', () => ({
            ...fs,
            link: async () => { throw Object.assign(new Error('No hard links'), {code: 'ENOTSUP'}); },
        }));
        try {
            const fixture = await prepare('old-original', 'accepted-unsaved-work');
            const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
            const {atomicReplace} = await import('@electron/utils/atomicReplace');
            await expect(transitionOriginalAndWorkingCopyRevision({
                ...fixture,
                publishedSourcePath: fixture.stagedPath,
                senderId: 7,
                reason: 'save-sync',
                captureOriginalWitness: () => captureOriginalPathSaveWitness(fixture.workingCopyPath, fixture.originalPath, 7),
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => atomicReplace(fixture.stagedPath, fixture.originalPath, {
                    ...({
                        ...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent}),
                        ...(destinationBackupPath === undefined ? {} : {destinationBackupPath}),
                    }),
                    destinationBackupPath,
                }),
            })).resolves.toMatchObject({contentRevision: 2});
            expect(await readFile(fixture.originalPath, 'utf8')).toBe('new-committed-pdf');
            expect(await readFile(fixture.workingCopyPath, 'utf8')).toBe('new-committed-pdf');
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it.each([
        [
            false,
            false,
        ],
        [
            true,
            false,
        ],
        [
            false,
            true,
        ],
        [
            true,
            true,
        ],
    ])('restores the actual displaced original after a crash, edited=%s, noLinks=%s', async (edited, noLinks) => {
        const fs = await import('node:fs/promises');
        if (noLinks) vi.doMock('fs/promises', () => ({
            ...fs,
            link: async () => { throw Object.assign(new Error('No hard links'), {code: 'ENOTSUP'}); },
        }));
        const fixture = await prepare('original-version', 'accepted-unsaved-work');
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
        const {restoreOriginal} = await import('@electron/file-access/workingCopyJournalOriginal');
        const witness = await captureOriginalPathSaveWitness(fixture.workingCopyPath, fixture.originalPath, 7);
        expect(witness).not.toBeNull();
        const preparedSnapshot = witness!.getSnapshotForJournal();
        if (edited) await writeFile(fixture.originalPath, 'external-version');
        const backupPath = join(tempRoot, 'displaced.bak');
        await rename(fixture.originalPath, backupPath);
        try {
            const recovery = restoreOriginal({
                path: fixture.originalPath,
                backupPath,
                state: 'prepared',
                preparedSnapshot,
            });
            if (edited) await expect(recovery).rejects.toThrow('Original file changed on disk');
            else await expect(recovery).resolves.toBeUndefined();
            expect(await readFile(fixture.originalPath, 'utf8')).toBe(edited ? 'external-version' : 'original-version');
            expect(await readFile(fixture.workingCopyPath, 'utf8')).toBe('accepted-unsaved-work');
        } finally { vi.doUnmock('fs/promises'); }
    });

    it('stops proof reads promptly when save is cancelled and retains both revisions', async () => {
        const fixture = await prepare('old-original', 'accepted-unsaved-work');
        const bytes = Buffer.alloc(4 * 1024 * 1024, 65);
        await writeFile(fixture.originalPath, bytes);
        await writeFile(fixture.stagedPath, Buffer.alloc(bytes.length, 67));
        const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
        await refreshWorkingCopyOriginalFileExpectation(fixture.workingCopyPath, 7);
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        const {atomicReplace} = await import('@electron/utils/atomicReplace');
        const chunks = await import('@electron/file-access/readFileChunk');
        const realRead = chunks.readFileChunk;
        const controller = new AbortController();
        let proof = false;
        let bytesAfterAbort = 0;
        const read = vi.spyOn(chunks, 'readFileChunk').mockImplementation(async (...args) => {
            const length = await realRead(...args);
            if (proof && args[0] === fixture.stagedPath && args[1].length === 1024 * 1024) {
                if (controller.signal.aborted) bytesAfterAbort += length;
                else controller.abort(new DOMException('Save cancelled', 'AbortError'));
            }
            return length;
        });
        try {
            await expect(transitionOriginalAndWorkingCopyRevision({
                ...fixture,
                publishedSourcePath: fixture.stagedPath,
                senderId: 7,
                signal: controller.signal,
                reason: 'save-sync',
                captureOriginalWitness: () => captureOriginalPathSaveWitness(fixture.workingCopyPath, fixture.originalPath, 7, controller.signal),
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => atomicReplace(fixture.stagedPath, fixture.originalPath, {
                    ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                    destinationBackupPath,
                }),
                onPhase: phase => { if (phase === 'transition-admit-original') proof = true; },
            })).rejects.toMatchObject({name: 'AbortError'});
            expect(controller.signal.aborted).toBe(true);
            expect(bytesAfterAbort).toBe(0);
            expect((await readFile(fixture.originalPath)).equals(bytes)).toBe(true);
            expect(await readFile(fixture.workingCopyPath, 'utf8')).toBe('accepted-unsaved-work');
            expect((await readdir(tempRoot)).some(name => name.includes('.evb-transition-'))).toBe(false);
            expect((await readdir(tempRoot)).includes('journal.json')).toBe(false);
        } finally {
            read.mockRestore();
        }
    });

    it('restores distinct original and working-copy inodes when post-sync work fails', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare('old-original', 'old-working');
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

        await expect(transitionOriginalAndWorkingCopyRevision({
            captureOriginalWitness: async () => (await import('@electron/file-access/originalPathSaveWitness')).captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            publishedSourcePath: stagedPath,
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                assertDestinationCurrent: assertDestinationCurrent,
                destinationBackupPath,
            }),
            afterWorkingCopySync: async () => {
                throw new Error('post-sync failure');
            },
        })).rejects.toThrow('post-sync failure');

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
        const [
            originalStat,
            workingStat,
        ] = await Promise.all([
            stat(originalPath, {bigint: true}),
            stat(workingCopyPath, {bigint: true}),
        ]);
        expect(originalStat.ino).not.toBe(workingStat.ino);
    });

    it.each([
        [
            '242-byte',
            `${'é'.repeat(80)}${'source'.repeat(13)}.pdf`,
        ],
        [
            '146-byte',
            `${'é'.repeat(50)}${'source'.repeat(7)}.pdf`,
        ],
    ])('saves in place when the %s original name is near the name limit', async (_length, originalName) => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare(
            'old-original',
            'old-working',
            originalName,
            // A real working copy lives in its own pdf-work-<uuid> directory, whose name is part of the backup name.
            join(tempRoot, 'pdf-work-00000000-0000-4000-8000-000000000001'),
        );
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        let namesDuringPublish: string[] = [];

        await expect(transitionOriginalAndWorkingCopyRevision({
            captureOriginalWitness: async () => (await import('@electron/file-access/originalPathSaveWitness')).captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            publishedSourcePath: stagedPath,
            publishOriginal: async (assertDestinationCurrent, destinationBackupPath) => {
                await publishImmutableFileAtomic(stagedPath, originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                });
                namesDuringPublish = await readdir(dirname(originalPath));
            },
        })).resolves.toMatchObject({contentRevision: 2});

        expect(namesDuringPublish.some(name => name.includes('.evb-transition-'))).toBe(true);
        expect(namesDuringPublish.every(name => Buffer.byteLength(name, 'utf8') <= 255)).toBe(true);
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('new-committed-pdf');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('new-committed-pdf');
    });

    it('retains combined recovery evidence when working-copy rollback fails', async () => {
        let failWorkingRollback = false;
        vi.doMock('@electron/file-access/documentFileWriteAtomic', async (importOriginal) => {
            const actual = await importOriginal<typeof DocumentFileWriteAtomicModule>();
            return {
                ...actual,
                copyFileAtomic: async (source: string, destination: string, options?: Parameters<typeof actual.copyFileAtomic>[2]) => {
                    if (failWorkingRollback && destination.endsWith('working.pdf')) {
                        throw new Error('working rollback publication failed');
                    }
                    return actual.copyFileAtomic(source, destination, options);
                },
            };
        });
        let workingCopyPath = '';
        try {
            const prepared = await prepare('old-original', 'old-working');
            workingCopyPath = prepared.workingCopyPath;
            const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
            await expect(transitionOriginalAndWorkingCopyRevision({
                captureOriginalWitness: async () => (await import('@electron/file-access/originalPathSaveWitness')).captureOriginalPathSaveWitness(workingCopyPath, prepared.originalPath, 7),
                workingCopyPath,
                originalPath: prepared.originalPath,
                reason: 'native-mutation',
                senderId: 7,
                publishedSourcePath: prepared.stagedPath,
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(prepared.stagedPath, prepared.originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                }),
                afterWorkingCopySync: async () => {
                    failWorkingRollback = true;
                    throw new Error('post-sync failure');
                },
            })).rejects.toThrow('working rollback publication failed');
            await expect(readFile(prepared.originalPath, 'utf8')).resolves.toBe('old-original');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('new-committed-pdf');
            const journalPath = join(dirname(workingCopyPath), 'journal.json');
            const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
                backupPath: string;
                original: {
                    backupPath: string;
                    state: string
                }
            };
            await expect(readFile(journal.backupPath, 'utf8')).resolves.toBe('old-working');
            await expect(readFile(journal.original.backupPath, 'utf8')).resolves.toBe('old-original');

            failWorkingRollback = false;
            vi.resetModules();
            const {recoverWorkingCopyTransition} = await import('@electron/file-access/workingCopyJournal');
            await expect(recoverWorkingCopyTransition(workingCopyPath)).resolves.toBe(true);
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
            await expect(readFile(prepared.originalPath, 'utf8')).resolves.toBe('old-original');
        } finally {
            vi.doUnmock('@electron/file-access/documentFileWriteAtomic');
        }
    });

    it('does not restore over an external replacement after publication', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare('old-original', 'old-working');
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
        const {OriginalPathSaveConflictError} = await import('@electron/file-access/originalPathSnapshot');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishedSourcePath: stagedPath,
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
            afterWorkingCopySync: async () => {
                await writeFile(originalPath, 'external-original');
                throw new Error('post-sync failure');
            },
        })).rejects.toBeInstanceOf(OriginalPathSaveConflictError);

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('external-original');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
    });

    it('restores a witnessed publication when post-sync work fails without an external edit', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare('old-original', 'old-working');
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishedSourcePath: stagedPath,
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
            afterWorkingCopySync: async () => {
                throw new Error('post-sync failure');
            },
        })).rejects.toThrow('post-sync failure');

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
    });

    it('restores the original when publication changes it and then fails', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare('old-original', 'old-working');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

        await expect(transitionOriginalAndWorkingCopyRevision({
            captureOriginalWitness: async () => (await import('@electron/file-access/originalPathSaveWitness')).captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            publishedSourcePath: stagedPath,
            publishOriginal: async (assertDestinationCurrent, destinationBackupPath) => {
                await (await import('@electron/utils/atomicReplace')).atomicReplace(stagedPath, originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                });
                throw new Error('publication failed');
            },
        })).rejects.toThrow('publication failed');

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
    });

    it('restores the original when a revision read runs while its backup is the only record', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare('old-original', 'old-working');
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        let revisionRead: Promise<unknown> = Promise.resolve();

        // The backup exists before the journal names it; a revision read in
        // that window (the renderer reads right after a rotation) must not
        // take the backup for an orphan.
        await expect(transitionOriginalAndWorkingCopyRevision({
            captureOriginalWitness: async () => (await import('@electron/file-access/originalPathSaveWitness')).captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            onPhase: phase => {
                if (phase === 'transition-journal-prepared') {
                    revisionRead = ensureWorkingCopyRevision(workingCopyPath, 7);
                }
            },
            publishedSourcePath: stagedPath,
            publishOriginal: async (assertDestinationCurrent, destinationBackupPath) => {
                await (await import('@electron/utils/atomicReplace')).atomicReplace(stagedPath, originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                });
                throw new Error('publication failed');
            },
        })).rejects.toThrow('publication failed');
        await revisionRead;

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
    });

    it('keeps a save when a revision read runs between publication and its journal record', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare('old-original', 'old-working');
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

        // A read here once took the live journal for a crash's and rolled the
        // published save back while the save still reported success.
        await expect(transitionOriginalAndWorkingCopyRevision({
            captureOriginalWitness: async () => (await import('@electron/file-access/originalPathSaveWitness')).captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            publishedSourcePath: stagedPath,
            publishOriginal: async (assertDestinationCurrent, destinationBackupPath) => {
                await publishImmutableFileAtomic(stagedPath, originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                });
                await ensureWorkingCopyRevision(workingCopyPath, 7);
            },
        })).resolves.toMatchObject({contentRevision: 2});

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('new-committed-pdf');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('new-committed-pdf');
    });

    it('recovers a publication a crash left unrecorded without treating it as an external edit', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare('old-original', 'old-working');
        const {capturePathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
        const {createOriginalFileContentFingerprintHash} = await import('@electron/file-access/createOriginalFileContentFingerprintHash');
        const {
            prepareWorkingCopyTransition,
            recordWorkingCopyJournalOriginal,
            recoverWorkingCopyTransition,
        } = await import('@electron/file-access/workingCopyJournal');
        const {requireDocumentRevisionToken} = await import('@contracts/documentRevision');

        // The journal names the original before publication. The save replaces
        // it, then the process dies before the journal records the publication.
        const journal = await prepareWorkingCopyTransition(workingCopyPath, requireDocumentRevisionToken('drt1:crash:2:next'));
        const backupPath = `${originalPath}.evb-transition-crash.bak`;
        await writeFile(backupPath, 'old-original');
        const preparedSnapshot = (await capturePathSaveWitness(originalPath))!.getSnapshotForJournal();
        const publishedContent = await readFile(stagedPath, 'utf8');
        await recordWorkingCopyJournalOriginal(journal, {
            path: originalPath,
            backupPath,
            state: 'prepared',
            preparedSnapshot,
            intendedFingerprint: `sha256-full-v1:${createOriginalFileContentFingerprintHash(Buffer.byteLength(publishedContent))
                .update(publishedContent)
                .digest('hex')}`,
        });
        await rename(stagedPath, originalPath);

        await expect(recoverWorkingCopyTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
    });

    it('keeps an external edit made while recovery checks the original against its intended bytes', async () => {
        let replaceAfterHash: (() => Promise<void>) | null = null;
        vi.doMock('@electron/file-access/originalPathSnapshot', async (importOriginal) => {
            const actual = await importOriginal<typeof OriginalPathSnapshotModule>();
            return {
                ...actual,
                hashContentFingerprintFilePath: async (
                    ...args: Parameters<typeof actual.hashContentFingerprintFilePath>
                ) => {
                    const fingerprint = await actual.hashContentFingerprintFilePath(...args);
                    const replace = replaceAfterHash;
                    replaceAfterHash = null;
                    await replace?.();
                    return fingerprint;
                },
            };
        });
        try {
            const {
                originalPath,
                stagedPath,
                workingCopyPath,
            } = await prepare('old-original', 'old-working');
            const {capturePathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const {captureIntendedContentFingerprint} = await import('@electron/file-access/workingCopyJournalOriginal');
            const {
                prepareWorkingCopyTransition,
                recordWorkingCopyJournalOriginal,
                recoverWorkingCopyTransition,
            } = await import('@electron/file-access/workingCopyJournal');
            const {getWorkingCopyJournalPath} = await import('@electron/file-access/workingCopyDirectory');
            const {requireDocumentRevisionToken} = await import('@contracts/documentRevision');

            const journal = await prepareWorkingCopyTransition(workingCopyPath, requireDocumentRevisionToken('drt1:crash:2:next'));
            const backupPath = `${originalPath}.evb-transition-crash.bak`;
            await writeFile(backupPath, 'old-original');
            await recordWorkingCopyJournalOriginal(journal, {
                path: originalPath,
                backupPath,
                state: 'prepared',
                preparedSnapshot: (await capturePathSaveWitness(originalPath))!.getSnapshotForJournal(),
                intendedFingerprint: await captureIntendedContentFingerprint(stagedPath),
            });
            await rename(stagedPath, originalPath);
            // Another program replaces the original while recovery hashes it.
            replaceAfterHash = async () => {
                const externalPath = join(tempRoot, 'external.pdf');
                await writeFile(externalPath, 'external-edit');
                await rename(externalPath, originalPath);
            };

            await expect(recoverWorkingCopyTransition(workingCopyPath)).rejects.toThrow();
            await expect(readFile(originalPath, 'utf8')).resolves.toBe('external-edit');
            await expect(stat(getWorkingCopyJournalPath(workingCopyPath))).resolves.toBeTruthy();
        } finally {
            vi.doUnmock('@electron/file-access/originalPathSnapshot');
        }
    });

    it('leaves no original backup when a save is cancelled while EVB fingerprints its output', async () => {
        const controller = new AbortController();
        let stagedHashPath = '';
        vi.doMock('@electron/file-access/originalPathSnapshot', async (importOriginal) => {
            const actual = await importOriginal<typeof OriginalPathSnapshotModule>();
            return {
                ...actual,
                hashContentFingerprintFilePath: (...args: Parameters<typeof actual.hashContentFingerprintFilePath>) => {
                    if (args[0] === stagedHashPath) {
                        controller.abort(new Error('save cancelled'));
                    }
                    return actual.hashContentFingerprintFilePath(...args);
                },
            };
        });
        try {
            const {
                originalPath,
                stagedPath,
                workingCopyPath,
            } = await prepare('old-original', 'old-working');
            stagedHashPath = stagedPath;
            const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

            await expect(transitionOriginalAndWorkingCopyRevision({
                workingCopyPath,
                originalPath,
                reason: 'native-mutation',
                senderId: 7,
                signal: controller.signal,
                captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
                publishedSourcePath: stagedPath,
                publishOriginal: async (assertDestinationCurrent, destinationBackupPath) => (await import('@electron/utils/atomicReplace')).atomicReplace(stagedPath, originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                }),
            })).rejects.toThrow('save cancelled');

            await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
            expect((await readdir(dirname(originalPath))).filter(name => name.endsWith('.bak'))).toEqual([]);
        } finally {
            vi.doUnmock('@electron/file-access/originalPathSnapshot');
        }
    });

    it('restores every durable record when manifest publication fails', async () => {
        vi.doMock('@electron/file-access/workingCopyManifest', async (importOriginal) => {
            const actual = await importOriginal<typeof WorkingCopyManifestModule>();
            return {
                ...actual,
                writeWorkingCopyManifestRevision: vi.fn(async (
                    ...args: Parameters<typeof actual.writeWorkingCopyManifestRevision>
                ) => {
                    if (args[1].contentRevision === 2) {
                        throw new Error('manifest publication failed');
                    }
                    return actual.writeWorkingCopyManifestRevision(...args);
                }),
            };
        });
        try {
            const {
                originalPath,
                stagedPath,
                workingCopyPath,
            } = await prepare('old-original', 'old-working');
            const manifestPath = join(tempRoot, 'manifest.json');
            const oldManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {revision: {token: string}};
            const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
            const {originalPathSaveBaseMatches} = await import('@electron/file-access/originalPathSaveWitness');
            const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

            await expect(transitionOriginalAndWorkingCopyRevision({
                captureOriginalWitness: async () => (await import('@electron/file-access/originalPathSaveWitness')).captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
                workingCopyPath,
                originalPath,
                reason: 'native-mutation',
                senderId: 7,
                publishedSourcePath: stagedPath,
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                }),
                afterWorkingCopySync: async () => {
                    expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
                },
                afterOriginalRestore: async () => {
                    expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
                },
            })).rejects.toThrow('manifest publication failed');

            await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
            await expect(originalPathSaveBaseMatches(workingCopyPath, originalPath, 7)).resolves.toBe(true);
            const restoredManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {revision: {token: string}};
            expect(restoredManifest.revision.token).toBe(oldManifest.revision.token);
            await expect(readFile(join(tempRoot, 'journal.json'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
            expect((await readdir(tempRoot)).filter(name => name.endsWith('.bak'))).toEqual([]);
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyManifest');
        }
    });

    it('keeps a published revision when journal cleanup fails', async () => {
        vi.doMock('@electron/file-access/workingCopyJournal', async (importOriginal) => {
            const actual = await importOriginal<typeof WorkingCopyJournalModule>();
            return {
                ...actual,
                completeWorkingCopyTransition: vi.fn(async () => {
                    throw new Error('journal cleanup failed');
                }),
            };
        });
        let workingCopyPath = '';
        try {
            const prepared = await prepare('old-original', 'old-working');
            workingCopyPath = prepared.workingCopyPath;
            const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

            await expect(transitionOriginalAndWorkingCopyRevision({
                captureOriginalWitness: async () => (await import('@electron/file-access/originalPathSaveWitness')).captureOriginalPathSaveWitness(workingCopyPath, prepared.originalPath, 7),
                workingCopyPath,
                originalPath: prepared.originalPath,
                reason: 'native-mutation',
                senderId: 7,
                publishedSourcePath: prepared.stagedPath,
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(prepared.stagedPath, prepared.originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                }),
            })).resolves.toMatchObject({contentRevision: 2});

            await expect(readFile(prepared.originalPath, 'utf8')).resolves.toBe('new-committed-pdf');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('new-committed-pdf');
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyJournal');
        }

        vi.resetModules();
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        await expect(ensureWorkingCopyRevision(workingCopyPath, 7)).resolves.toMatchObject({contentRevision: 2});
        await expect(readFile(join(tempRoot, 'journal.json'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
        expect((await readdir(tempRoot)).filter(name => name.endsWith('.bak'))).toEqual([]);
    });

    it('publishes a second witnessed save from a legacy shared inode', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare();
        const secondStagedPath = join(tempRoot, 'second-staged.pdf');
        await writeFile(secondStagedPath, 'second-committed-pdf');
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishedSourcePath: stagedPath,
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
            afterWorkingCopySync: async () => {
                expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
            },
        })).resolves.toMatchObject({contentRevision: 2});

        const [
            firstOriginalStat,
            firstWorkingStat,
        ] = await Promise.all([
            stat(originalPath, {bigint: true}),
            stat(workingCopyPath, {bigint: true}),
        ]);
        expect(firstOriginalStat.ino).not.toBe(firstWorkingStat.ino);
        // Existing linked working copies predate the durable publication baseline.
        const {updateWorkingCopyManifest} = await import('@electron/file-access/workingCopyManifest');
        await updateWorkingCopyManifest(workingCopyPath, current => ({
            version: 1,
            revision: current!.revision,
        }));
        await rm(workingCopyPath);
        await link(originalPath, workingCopyPath);
        expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishedSourcePath: secondStagedPath,
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(secondStagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
        })).resolves.toMatchObject({contentRevision: 3});

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('second-committed-pdf');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('second-committed-pdf');
    });

    it('restores the app-published original witness after a hard reopen before a second save', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare();
        const secondStagedPath = join(tempRoot, 'second-staged.pdf');
        await writeFile(secondStagedPath, 'second-committed-pdf');
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        const {
            clearWorkingCopyOriginalPaths,
            getWorkingCopyOriginalFileExpectation,
            refreshWorkingCopyOriginalFileExpectation,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
        const reopenedExpectation = getWorkingCopyOriginalFileExpectation(workingCopyPath, 7);
        expect(reopenedExpectation).not.toBeNull();

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishedSourcePath: stagedPath,
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
            afterWorkingCopySync: async () => {
                expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
            },
        })).resolves.toMatchObject({contentRevision: 2});

        await rm(stagedPath);

        // A checkpoint can outlive the first app-owned atomic publication. A
        // hard reopen restores that checkpoint witness onto the independent
        // original and working-copy paths before the next native save.
        clearWorkingCopyOriginalPaths();
        await setWorkingCopyOriginalPath(workingCopyPath, originalPath, 7, {
            backingState: 'eager',
            originalFileExpectation: reopenedExpectation!,
        });

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishedSourcePath: secondStagedPath,
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(secondStagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
        })).resolves.toMatchObject({contentRevision: 3});

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('second-committed-pdf');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('second-committed-pdf');
    });

    it('rejects a same-inode external edit after the app-published witness is current', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare();
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishedSourcePath: stagedPath,
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
            afterWorkingCopySync: async () => {
                expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
            },
        })).resolves.toMatchObject({contentRevision: 2});

        await appendFile(originalPath, '-external-change');
        await expect(captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7)).resolves.toBeNull();
    });

    it.each([
        'atomic replacement',
        'interior write',
    ] as const)(
        'rejects external %s after restoring a stale checkpoint',
        async (mutation) => {
            const {
                originalPath,
                stagedPath,
                workingCopyPath,
            } = await prepare();
            await writeFile(stagedPath, Buffer.alloc(320 * 1024, 65));
            const replacementPath = join(tempRoot, 'external-replacement.pdf');
            await writeFile(replacementPath, 'external-replacement');
            const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
            const {
                clearWorkingCopyOriginalPaths,
                getWorkingCopyOriginalFileExpectation,
                refreshWorkingCopyOriginalFileExpectation,
                setWorkingCopyOriginalPath,
            } = await import('@electron/file-access/workingCopyStore');
            const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const staleExpectation = getWorkingCopyOriginalFileExpectation(workingCopyPath, 7);
            expect(staleExpectation).not.toBeNull();

            await expect(transitionOriginalAndWorkingCopyRevision({
                workingCopyPath,
                originalPath,
                reason: 'native-mutation',
                senderId: 7,
                captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
                publishedSourcePath: stagedPath,
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                    ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                    destinationBackupPath,
                }),
                afterWorkingCopySync: async () => {
                    expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
                },
            })).resolves.toMatchObject({contentRevision: 2});

            clearWorkingCopyOriginalPaths();
            await setWorkingCopyOriginalPath(workingCopyPath, originalPath, 7, {
                backingState: 'eager',
                originalFileExpectation: staleExpectation!,
            });
            await rm(stagedPath);
            if (mutation === 'atomic replacement') {
                await rename(replacementPath, originalPath);
            } else {
                const handle = await open(originalPath, 'r+');
                try {
                    await handle.write(Buffer.from([66]), 0, 1, 80 * 1024);
                } finally {
                    await handle.close();
                }
                const {readWorkingCopyManifest} = await import('@electron/file-access/workingCopyManifest');
                const {assertPathMatchesSaveWitnessSnapshot} = await import('@electron/file-access/originalPathSaveWitness');
                const manifest = await readWorkingCopyManifest(workingCopyPath);
                await expect(assertPathMatchesSaveWitnessSnapshot(
                    originalPath, manifest!.originalSaveBase!.snapshot, {contentOnly: true},
                )).rejects.toThrow('Original file changed on disk');
            }

            await expect(captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7)).resolves.toBeNull();
        },
    );

    it('rejects Save after recovering a dirty materialized checkpoint over an external replacement', async () => {
        const originalBytes = Buffer.from('%PDF-1.7\n% issue-398 source A\n%%EOF\n');
        const unsavedWorkingBytes = Buffer.from('%PDF-1.7\n% issue-398 unsaved C\n%%EOF\n');
        const externalBytes = Buffer.from('%PDF-1.7\n% issue-398 external B\n%%EOF\n');
        const originalPath = join(tempRoot, 'issue-398-source.pdf');
        const workingCopyPath = join(tempRoot, 'issue-398-working.pdf');
        const replacementPath = join(tempRoot, 'issue-398-replacement.pdf');
        await Promise.all([
            writeFile(originalPath, originalBytes),
            writeFile(workingCopyPath, unsavedWorkingBytes),
            writeFile(replacementPath, externalBytes),
        ]);

        const {
            clearWorkingCopyOriginalPaths,
            getWorkingCopyOriginalFileExpectation,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const {
            claimWorkspaceCheckpoint,
            flushPendingWorkspaceCheckpointSave,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');

        await setWorkingCopyOriginalPath(workingCopyPath, originalPath, 7, {backingState: 'materialized'});
        expect(getWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).not.toBeNull();
        await saveWorkspaceCheckpoint(createCheckpoint(originalPath, workingCopyPath), 7);
        await flushPendingWorkspaceCheckpointSave();

        clearWorkingCopyOriginalPaths();
        await rename(replacementPath, originalPath);
        await expect(claimWorkspaceCheckpoint(22)).resolves.toMatchObject({tabs: [{
            sourceRef: originalPath,
            workingCopyRef: workingCopyPath,
            isDirty: true,
        }]});

        const recoveredWitness = await captureOriginalPathSaveWitness(workingCopyPath, originalPath, 22);
        expect(recoveredWitness).toBeNull();
        await expect(readFile(originalPath)).resolves.toEqual(externalBytes);
        await expect(readFile(workingCopyPath)).resolves.toEqual(unsavedWorkingBytes);
    });

    it('preserves a same-size external replacement made after save admission', async () => {
        const initialBytes = 'original-version';
        const externalBytes = 'external-version';
        expect(Buffer.byteLength(externalBytes)).toBe(Buffer.byteLength(initialBytes));
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare(initialBytes, 'old-working');
        const publicationPaused = deferred();
        const releasePublication = deferred();
        const {atomicReplace} = await import('@electron/utils/atomicReplace');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');

        const transition = transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'save-sync',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishedSourcePath: stagedPath,
            publishOriginal: async (assertDestinationCurrent, destinationBackupPath) => {
                publicationPaused.resolve();
                await releasePublication.promise;
                await atomicReplace(stagedPath, originalPath, {
                    ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                    destinationBackupPath,
                });
            },
        });

        await publicationPaused.promise;
        await writeFile(originalPath, externalBytes);
        releasePublication.resolve();

        await expect(transition).resolves.toBeNull();
        await expect(readFile(originalPath, 'utf8')).resolves.toBe(externalBytes);
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
    });
});
