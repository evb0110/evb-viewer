import {
    appendFile,
    link,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {tmpdir} from 'node:os';
import {
    dirname, join,
} from 'node:path';
import {promisify} from 'node:util';
import type * as DocumentRevisionSidecarModule from '@electron/file-access/documentRevisionSidecar';
import type * as DocumentFileWriteAtomicModule from '@electron/file-access/documentFileWriteAtomic';
import type * as WorkingCopyContentTransitionJournalModule from '@electron/file-access/workingCopyContentTransitionJournal';
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

let tempRoot = '';
const execFileAsync = promisify(execFile);

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
        workingDirectory = '',
    ) {
        const originalPath = join(tempRoot, 'original.pdf');
        const workingCopyBase = workingDirectory
            ? (await import('@electron/utils/appTempDir')).getAppTempDir()
            : tempRoot;
        const workingCopyPath = join(workingCopyBase, workingDirectory, 'working.pdf');
        const stagedPath = join(tempRoot, 'staged.pdf');
        if (workingDirectory) {
            await mkdir(join(workingCopyBase, workingDirectory), {recursive: true});
        }
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

    it('does not publish a Save As target when durable prepublication intent fails', async () => {
        vi.doMock('@electron/file-access/documentFileWriteAtomic', async importOriginal => {
            const actual = await importOriginal<typeof DocumentFileWriteAtomicModule>();
            return {
                ...actual,
                writeFileAtomic: vi.fn(async (...args: Parameters<typeof actual.writeFileAtomic>) => {
                    if (String(args[0]).endsWith('.evb-two-target-transition.json')) {
                        throw new Error('prepublication intent write failed');
                    }
                    return actual.writeFileAtomic(...args);
                }),
            };
        });
        try {
            const {
                originalPath,
                stagedPath,
                workingCopyPath,
            } = await prepare('old-target', 'old-working', 'pdf-work-save-as');
            const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
            const {capturePathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

            await expect(transitionOriginalAndWorkingCopyRevision({
                workingCopyPath,
                originalPath,
                reason: 'save-sync',
                senderId: 7,
                allowMissingOriginalWitness: true,
                preservePublishedOriginalOnWorkingCopySyncFailure: true,
                useDestinationWitnessForPublication: false,
                captureOriginalWitness: () => capturePathSaveWitness(originalPath),
                publishOriginal: () => publishImmutableFileAtomic(stagedPath, originalPath),
            })).rejects.toThrow('prepublication intent write failed');

            await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-target');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
            await expect(readFile(`${workingCopyPath}.evb-two-target-transition.json`, 'utf8'))
                .rejects
                .toMatchObject({code: 'ENOENT'});
            expect((await readdir(tempRoot)).some(name => name.includes('.evb-transition-'))).toBe(false);
        } finally {
            vi.doUnmock('@electron/file-access/documentFileWriteAtomic');
        }
    });

    it('keeps a durable Save As fence when final fence persistence fails and survives reload', async () => {
        let transitionJournalWrites = 0;
        let resyncWorkingDirectory = '';
        vi.doMock('@electron/file-access/documentFileWriteAtomic', async importOriginal => {
            const actual = await importOriginal<typeof DocumentFileWriteAtomicModule>();
            return {
                ...actual,
                writeFileAtomic: vi.fn(async (...args: Parameters<typeof actual.writeFileAtomic>) => {
                    if (String(args[0]).endsWith('.evb-two-target-transition.json')) {
                        transitionJournalWrites += 1;
                        if (transitionJournalWrites === 3) {
                            throw new Error('final fence write failed');
                        }
                    }
                    return actual.writeFileAtomic(...args);
                }),
            };
        });
        try {
            const {
                originalPath,
                stagedPath,
                workingCopyPath,
            } = await prepare('old-target', 'old-working', 'pdf-work-save-as');
            resyncWorkingDirectory = dirname(workingCopyPath);
            const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
            const {capturePathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

            await expect(transitionOriginalAndWorkingCopyRevision({
                workingCopyPath,
                originalPath,
                reason: 'save-sync',
                senderId: 7,
                allowMissingOriginalWitness: true,
                preservePublishedOriginalOnWorkingCopySyncFailure: true,
                useDestinationWitnessForPublication: false,
                captureOriginalWitness: () => capturePathSaveWitness(originalPath),
                publishOriginal: () => publishImmutableFileAtomic(stagedPath, originalPath),
                syncWorkingCopy: async () => {
                    throw new Error('copy-back failed');
                },
                onWorkingCopySyncFailure: () => false,
            })).resolves.toMatchObject({
                targetWriteCommitted: true,
                workingCopyRefreshed: false,
            });

            await expect(readFile(originalPath, 'utf8')).resolves.toBe('new-committed-pdf');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
            await expect(readFile(`${workingCopyPath}.evb-two-target-transition.json`, 'utf8'))
                .resolves
                .toContain('original-committed');

            vi.resetModules();
            const {
                assertWorkingCopyMutationAllowed,
                getWorkingCopyRevision,
                hasWorkingCopySyncRequired,
            } = await import('@electron/file-access/documentRevisionStore');
            expect(hasWorkingCopySyncRequired(workingCopyPath)).toBe(true);
            expect(() => assertWorkingCopyMutationAllowed(workingCopyPath))
                .toThrow('Working copy recovery is unresolved');
            const {readWorkingCopyRevisionJournalEntries} = await import('@electron/file-access/documentRevisionSidecar');
            await expect(getWorkingCopyRevision(workingCopyPath, 7)).resolves.toMatchObject({contentRevision: 1});
            expect(() => assertWorkingCopyMutationAllowed(workingCopyPath)).toThrow('WORKING_COPY_SYNC_REQUIRED');
            expect(readWorkingCopyRevisionJournalEntries(workingCopyPath)).toEqual([expect.objectContaining({
                kind: 'working-copy-sync-required',
                originalPath,
                targetWriteCommitted: true,
            })]);
            await expect(readFile(`${workingCopyPath}.evb-two-target-transition.json`, 'utf8'))
                .resolves
                .toContain('original-committed');

            const {handleResyncWorkingCopy} = await import('@electron/features/documents/main/workingCopySave');
            const resyncResult = await handleResyncWorkingCopy({senderId: 7}, workingCopyPath);
            expect(resyncResult).toMatchObject({
                ok: true,
                workingCopyRefreshed: true,
            });
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('new-committed-pdf');
            await expect(readFile(`${workingCopyPath}.evb-two-target-transition.json`, 'utf8'))
                .rejects
                .toMatchObject({code: 'ENOENT'});
            expect(readWorkingCopyRevisionJournalEntries(workingCopyPath)).not.toEqual([expect.objectContaining({kind: 'working-copy-sync-required'})]);

            vi.resetModules();
            const {
                assertWorkingCopyMutationAllowed: assertAfterResync, getWorkingCopyRevision: getAfterResync,
            } =
                await import('@electron/file-access/documentRevisionStore');
            await expect(getAfterResync(workingCopyPath, 7)).resolves.toMatchObject({contentRevision: 2});
            expect(() => assertAfterResync(workingCopyPath)).not.toThrow();
        } finally {
            if (resyncWorkingDirectory) {
                await rm(resyncWorkingDirectory, {
                    force: true,
                    recursive: true,
                });
            }
            vi.doUnmock('@electron/file-access/documentFileWriteAtomic');
        }
    });

    it('links an immutable original into the working-copy path when reflinks are unavailable', async () => {
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

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            publishOriginal: () => publishImmutableFileAtomic(stagedPath, originalPath),
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
        expect(originalStat.ino).toBe(workingStat.ino);
        expect(originalStat.nlink).toBeGreaterThanOrEqual(2n);
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('new-committed-pdf');
        expect(phases).toContain('transition-sync-working-copy-link');
        expect(phases).not.toContain('transition-sync-working-copy-copy');
        expect(phases.indexOf('transition-sync-working-copy-fsync-file')).toBeGreaterThan(-1);
        expect(phases.indexOf('transition-sync-working-copy-fsync-directory')).toBeGreaterThan(-1);
        expect(phases.indexOf('transition-sync-working-copy-fsync-file'))
            .toBeLessThan(phases.indexOf('revision-write-sidecar'));
        expect(phases.indexOf('transition-sync-working-copy-fsync-directory'))
            .toBeLessThan(phases.indexOf('revision-write-sidecar'));
        await expect(originalPathSaveBaseMatches(workingCopyPath, originalPath, 7)).resolves.toBe(true);

        await appendFile(originalPath, '-external-change');
        await expect(originalPathSaveBaseMatches(workingCopyPath, originalPath, 7)).resolves.toBe(false);
    });

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
        await witness?.close();

        await appendFile(originalPath, '-external-change');
        await expect(captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7)).resolves.toBeNull();
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
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            publishOriginal: () => publishImmutableFileAtomic(stagedPath, originalPath),
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

    it('does not restore over an external replacement after publication', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare('old-original', 'old-working');
        const externalPath = join(tempRoot, 'external.pdf');
        await writeFile(externalPath, 'external-original');
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {
            captureOriginalPathSaveWitness,
            OriginalPathSaveConflictError,
        } = await import('@electron/file-access/originalPathSaveWitness');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishOriginal: assertDestinationCurrent => publishImmutableFileAtomic(
                stagedPath,
                originalPath,
                {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})},
            ),
            afterWorkingCopySync: async () => {
                await rename(externalPath, originalPath);
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
            publishOriginal: assertDestinationCurrent => publishImmutableFileAtomic(
                stagedPath,
                originalPath,
                {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})},
            ),
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
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            publishOriginal: async () => {
                await rename(stagedPath, originalPath);
                throw new Error('publication failed');
            },
        })).rejects.toThrow('publication failed');

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
    });

    it('restores every durable record when revision sidecar publication fails', async () => {
        vi.doMock('@electron/file-access/documentRevisionSidecar', async (importOriginal) => {
            const actual = await importOriginal<typeof DocumentRevisionSidecarModule>();
            return {
                ...actual,
                writeWorkingCopyRevisionSidecar: vi.fn(async (
                    workingCopyPath: string,
                    sidecar: DocumentRevisionSidecarModule.IWorkingCopyRevisionSidecar,
                    options?: {markMutationCommitStarted?: boolean},
                ) => {
                    if (sidecar.contentRevision === 2) {
                        throw new Error('sidecar publication failed');
                    }
                    return actual.writeWorkingCopyRevisionSidecar(workingCopyPath, sidecar, options);
                }),
            };
        });
        try {
            const {
                originalPath,
                stagedPath,
                workingCopyPath,
            } = await prepare('old-original', 'old-working');
            const sidecarPath = `${workingCopyPath}.evb-revision.json`;
            const oldSidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {token: string};
            const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
            const {originalPathSaveBaseMatches} = await import('@electron/file-access/originalPathSaveWitness');
            const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

            await expect(transitionOriginalAndWorkingCopyRevision({
                workingCopyPath,
                originalPath,
                reason: 'native-mutation',
                senderId: 7,
                publishOriginal: () => publishImmutableFileAtomic(stagedPath, originalPath),
                afterWorkingCopySync: async () => {
                    expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
                },
                afterOriginalRestore: async () => {
                    expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
                },
            })).rejects.toThrow('sidecar publication failed');

            await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
            await expect(originalPathSaveBaseMatches(workingCopyPath, originalPath, 7)).resolves.toBe(true);
            const restoredSidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as {token: string};
            expect(restoredSidecar.token).toBe(oldSidecar.token);
            await expect(readFile(`${workingCopyPath}.evb-revision-journal.json`, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
            await expect(readFile(`${workingCopyPath}.evb-content-transition.json`, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
            await expect(readFile(`${workingCopyPath}.evb-two-target-transition.json`, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            vi.doUnmock('@electron/file-access/documentRevisionSidecar');
        }
    });

    it('keeps a published revision when content-journal cleanup fails', async () => {
        vi.doMock('@electron/file-access/workingCopyContentTransitionJournal', async (importOriginal) => {
            const actual = await importOriginal<typeof WorkingCopyContentTransitionJournalModule>();
            return {
                ...actual,
                completeWorkingCopyContentTransition: vi.fn(async () => {
                    throw new Error('content journal cleanup failed');
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
                workingCopyPath,
                originalPath: prepared.originalPath,
                reason: 'native-mutation',
                senderId: 7,
                publishOriginal: () => publishImmutableFileAtomic(prepared.stagedPath, prepared.originalPath),
            })).resolves.toMatchObject({contentRevision: 2});

            await expect(readFile(prepared.originalPath, 'utf8')).resolves.toBe('new-committed-pdf');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('new-committed-pdf');
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyContentTransitionJournal');
        }

        vi.resetModules();
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        await expect(ensureWorkingCopyRevision(workingCopyPath, 7)).resolves.toMatchObject({contentRevision: 2});
        await expect(readFile(`${workingCopyPath}.evb-content-transition.json`, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('publishes a second witnessed save when the original and working copy share an inode', async () => {
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
            publishOriginal: assertDestinationCurrent => publishImmutableFileAtomic(
                stagedPath,
                originalPath,
                {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})},
            ),
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
        expect(firstOriginalStat.ino).toBe(firstWorkingStat.ino);

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishOriginal: assertDestinationCurrent => publishImmutableFileAtomic(
                secondStagedPath,
                originalPath,
                {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})},
            ),
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
            publishOriginal: assertDestinationCurrent => publishImmutableFileAtomic(
                stagedPath,
                originalPath,
                {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})},
            ),
            afterWorkingCopySync: async () => {
                expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
            },
        })).resolves.toMatchObject({contentRevision: 2});

        // A checkpoint can outlive the first app-owned atomic publication. A
        // hard reopen restores that checkpoint witness onto the now-linked
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
            publishOriginal: assertDestinationCurrent => publishImmutableFileAtomic(
                secondStagedPath,
                originalPath,
                {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})},
            ),
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
            publishOriginal: assertDestinationCurrent => publishImmutableFileAtomic(
                stagedPath,
                originalPath,
                {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})},
            ),
            afterWorkingCopySync: async () => {
                expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
            },
        })).resolves.toMatchObject({contentRevision: 2});

        await appendFile(originalPath, '-external-change');
        await expect(captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7)).resolves.toBeNull();
    });

    it('rejects a distinct-inode external replacement after restoring a stale checkpoint', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare();
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
            publishOriginal: assertDestinationCurrent => publishImmutableFileAtomic(
                stagedPath,
                originalPath,
                {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})},
            ),
            afterWorkingCopySync: async () => {
                expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
            },
        })).resolves.toMatchObject({contentRevision: 2});

        clearWorkingCopyOriginalPaths();
        await setWorkingCopyOriginalPath(workingCopyPath, originalPath, 7, {
            backingState: 'eager',
            originalFileExpectation: staleExpectation!,
        });
        await rename(replacementPath, originalPath);

        await expect(captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7)).resolves.toBeNull();
    });

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
        try {
            expect(recoveredWitness).toBeNull();
        } finally {
            await recoveredWitness?.close();
        }
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
            publishOriginal: async assertDestinationCurrent => {
                publicationPaused.resolve();
                await releasePublication.promise;
                await atomicReplace(stagedPath, originalPath, {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})});
            },
        });

        await publicationPaused.promise;
        await execFileAsync(process.execPath, [
            '-e',
            'const fs = require(\'node:fs/promises\'); const [target, bytes] = process.argv.slice(1); const replacement = `${target}.external`; fs.writeFile(replacement, bytes).then(() => fs.rename(replacement, target));',
            originalPath,
            externalBytes,
        ]);
        releasePublication.resolve();

        await expect(transition).resolves.toBeNull();
        await expect(readFile(originalPath, 'utf8')).resolves.toBe(externalBytes);
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
    });
});
