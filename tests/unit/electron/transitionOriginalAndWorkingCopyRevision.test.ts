import {existsSync} from 'node:fs';
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
    basename, dirname, join,
} from 'node:path';
import type * as WorkingCopyManifestModule from '@electron/file-access/workingCopyManifest';
import type * as WorkingCopyJournalModule from '@electron/file-access/workingCopyJournal';
import type * as DocumentFileWriteAtomicModule from '@electron/file-access/documentFileWriteAtomic';
import type * as OriginalPathSnapshotModule from '@electron/file-access/originalPathSnapshot';
import type * as TransitionModule from '@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision';
import type * as WorkingCopyDirectoryModule from '@electron/file-access/workingCopyDirectory';
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
await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');
await import('@electron/features/documents/main/managedTempFileHandles');
await import('@electron/utils/appTempDir');

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

// Another program's in-place save, run as a separate process.
function writeExternally(path: string) {
    const writer = spawnSync(process.execPath, [
        '--input-type=module',
        '-e',
        'import fs from \'node:fs/promises\';const h=await fs.open(process.argv[1],\'r+\');await h.write(\'EXTERNAL\',262144);await h.close();',
        path,
    ], {
        encoding: 'utf8',
        windowsHide: true,
    });
    expect(writer.status, writer.stderr).toBe(0);
}

describe('transitionOriginalAndWorkingCopyRevision', () => {
    beforeEach(async () => {
        vi.resetModules();
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-two-target-transition-test-'));
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
    });

    afterEach(async () => {
        delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        vi.unstubAllEnvs();
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

    // Another program's temporary file and backups beside the PDF, including one another working copy's save names.
    async function writeUnrelatedNeighbours(originalPath: string) {
        const neighbours = [
            '.unrelated.tmp',
            'notes.bak',
            `${basename(originalPath)}.evb-transition-pdf-work-other-00000000-0000-4000-8000-000000000000.bak`,
        ].map(name => join(dirname(originalPath), name));
        await Promise.all(neighbours.map(path => writeFile(path, 'another program')));
        return async () => Promise.all(neighbours.map(path => readFile(path, 'utf8')));
    }

    // An annotation save as the renderer makes it: an opaque native stage committed through the real handler.
    async function prepareAnnotationSaves(directoryName: string) {
        vi.stubEnv('TMPDIR', tempRoot);
        vi.stubEnv('TEMP', tempRoot);
        vi.stubEnv('TMP', tempRoot);
        const {getAppTempDir} = await import('@electron/utils/appTempDir');
        const fixture = await prepare('old-original', 'old-working', 'original.pdf', join(getAppTempDir(), directoryName));
        const {makeSiblingTempPath} = await import('@electron/utils/atomicReplace');
        const {createOpaqueNativePdfStagedArtifact} = await import('@electron/features/documents/main/managedTempFileHandles');
        const {handleCommitStagedPdfNativeMutations} = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');
        const {getWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        const saveAnnotations = async (bytes: Buffer) => {
            const stagedPath = `${makeSiblingTempPath(fixture.workingCopyPath)}.pdf`;
            await writeFile(stagedPath, bytes);
            const staged = await createOpaqueNativePdfStagedArtifact({senderId: 7}, stagedPath, {
                qpdfCheck: false,
                tailCheck: true,
                semanticCheck: true,
                semanticScopeSha256: 'b'.repeat(64),
                fsynced: true,
            }, {cleanupOnRelease: true});
            const {token} = await getWorkingCopyRevision(fixture.workingCopyPath, 7);
            return handleCommitStagedPdfNativeMutations({senderId: 7}, fixture.workingCopyPath, staged, {expectedDocumentRevisionToken: token});
        };
        return {
            ...fixture,
            saveAnnotations,
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
            stagePublication: () => Promise.resolve({path: stagedPath}),
            senderId: 7,
            reason: 'save-sync',
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => atomicReplace(stagedPath, originalPath, {
                assertDestinationCurrent,
                destinationBackupPath,
            }),
            refreshOriginalExpectation: async (admitted) => {
                writeExternally(originalPath);
                await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7, admitted);
            },
        });
        const error: unknown = await transition.catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(OriginalPathSaveConflictError);
        if (!(error instanceof OriginalPathSaveConflictError)) throw new Error('Save did not report the external conflict');
        expect(dirname(error.keptFilePath!)).toBe(dirname(originalPath));
        await expect(readFile(error.keptFilePath!, 'utf8')).resolves.toBe('old-original');
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
                stagePublication: () => Promise.resolve({path: stagedPath}),
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                }),
                refreshOriginalExpectation: async () => {
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
            const earlierKeptPath = originalPath.replace(/\.pdf$/u, ' (original).pdf');
            if (mutation === 'in-place') await writeFile(earlierKeptPath, 'earlier-kept');
            const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
            await refreshWorkingCopyOriginalFileExpectation(fixture.workingCopyPath, 7);
            const {captureOriginalPathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
            const {atomicReplace} = await import('@electron/utils/atomicReplace');
            const result = await transitionOriginalAndWorkingCopyRevision({
                ...fixture,
                stagePublication: () => Promise.resolve({path: fixture.stagedPath}),
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
            const keptName = basename(originalPath).replace(/\.pdf$/u, mutation === 'in-place' ? ' (original 2).pdf' : ' (original).pdf');
            const retained = (await readdir(tempRoot)).filter(name => name === keptName);
            expect(retained).toHaveLength(1);
            expect((await readdir(tempRoot)).some(name => name.includes('.evb-transition-'))).toBe(false);
            if (mutation === 'in-place') expect(await readFile(earlierKeptPath, 'utf8')).toBe('earlier-kept');
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
                stagePublication: () => Promise.resolve({path: fixture.stagedPath}),
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
            const keptFilePath = join(tempRoot, 'original (original).pdf');
            expect(result).toMatchObject({keptFilePath});
            expect(await readFile(keptFilePath, 'utf8')).toBe('old-original');
            // The save finished its journal, so later reads neither copy the working copy back nor touch the kept file.
            const {getWorkingCopyJournalPath} = await import('@electron/file-access/workingCopyDirectory');
            await expect(stat(getWorkingCopyJournalPath(fixture.workingCopyPath))).rejects.toMatchObject({code: 'ENOENT'});
            const {recoverWorkingCopyTransition} = await import('@electron/file-access/workingCopyJournal');
            await expect(recoverWorkingCopyTransition(fixture.workingCopyPath)).resolves.toBe(false);
            expect(await readFile(keptFilePath, 'utf8')).toBe('old-original');
            expect(await readFile(fixture.workingCopyPath, 'utf8')).toBe('accepted-unsaved-work');
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
                stagePublication: () => Promise.resolve({path: fixture.stagedPath}),
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
                stagePublication: () => Promise.resolve({path: fixture.stagedPath}),
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
                stagePublication: () => Promise.resolve({path: fixture.stagedPath}),
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
            stagePublication: () => Promise.resolve({path: stagedPath}),
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                assertDestinationCurrent: assertDestinationCurrent,
                destinationBackupPath,
            }),
            refreshOriginalExpectation: async () => {
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
            stagePublication: () => Promise.resolve({path: stagedPath}),
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
                stagePublication: () => Promise.resolve({path: prepared.stagedPath}),
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(prepared.stagedPath, prepared.originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                }),
                refreshOriginalExpectation: async () => {
                    if (failWorkingRollback) return;
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
            // The restore moved the displaced original back, so its bytes are in the original, not beside it.
            await expect(readFile(journal.original.backupPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});

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
            stagePublication: () => Promise.resolve({path: stagedPath}),
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
            refreshOriginalExpectation: async () => {
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
            stagePublication: () => Promise.resolve({path: stagedPath}),
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
            refreshOriginalExpectation: async () => {
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
            stagePublication: () => Promise.resolve({path: stagedPath}),
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
                if (phase === 'transition-stage-publication') {
                    revisionRead = ensureWorkingCopyRevision(workingCopyPath, 7);
                }
            },
            stagePublication: () => Promise.resolve({path: stagedPath}),
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
            stagePublication: () => Promise.resolve({path: stagedPath}),
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

    it('keeps one revision per content and refuses Save as in use while a locked PDF waits to be restored after a crash', async () => {
        const fs = await import('node:fs/promises');
        let lockedPath = '';
        vi.doMock('fs/promises', () => ({
            ...fs,
            // Another program holds the PDF open without delete sharing, so nothing can replace it.
            rename: async (...args: Parameters<typeof fs.rename>) => {
                if (lockedPath && String(args[1]) === lockedPath) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), {code: 'EBUSY'});
                return fs.rename(...args);
            },
        }));
        try {
            const {
                originalPath, stagedPath, workingCopyPath, saveAnnotations,
            } = await prepareAnnotationSaves('pdf-work-locked-recovery');
            const {capturePathSaveWitness} = await import('@electron/file-access/originalPathSaveWitness');
            const {createOriginalFileContentFingerprintHash} = await import('@electron/file-access/createOriginalFileContentFingerprintHash');
            const {
                prepareWorkingCopyTransition, recordWorkingCopyJournalOriginal,
            } = await import('@electron/file-access/workingCopyJournal');
            const {getWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
            const {requireDocumentRevisionToken} = await import('@contracts/documentRevision');
            const {token} = await getWorkingCopyRevision(workingCopyPath, 7);
            const before = await readdir(tempRoot);

            // A save published the PDF and synced the working copy, then EVB died before the commit.
            const journal = await prepareWorkingCopyTransition(workingCopyPath, requireDocumentRevisionToken('drt1:crash:9:next'));
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
            await fs.rename(stagedPath, originalPath);
            await writeFile(workingCopyPath, publishedContent);
            lockedPath = originalPath;

            await expect(getWorkingCopyRevision(workingCopyPath, 7)).resolves.toMatchObject({token});
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
            await expect(saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 68))).rejects.toMatchObject({code: 'EBUSY'});
            await expect(readFile(originalPath, 'utf8')).resolves.toBe(publishedContent);

            lockedPath = '';
            await expect(getWorkingCopyRevision(workingCopyPath, 7)).resolves.toMatchObject({token});
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
            await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
            expect((await readdir(tempRoot)).filter(name => !before.includes(name))).toEqual([]);
            await expect(saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 69))).resolves.toMatchObject({applied: true});
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it('finishes keeping the file as it was before a save when a crash cut its move short', async () => {
        const {
            originalPath, workingCopyPath,
        } = await prepare('saved-by-evb', 'old-working');
        const {
            prepareWorkingCopyTransition, recoverWorkingCopyTransition,
        } = await import('@electron/file-access/workingCopyJournal');
        const {getWorkingCopyJournalPath} = await import('@electron/file-access/workingCopyDirectory');
        const {requireDocumentRevisionToken} = await import('@contracts/documentRevision');
        const journal = await prepareWorkingCopyTransition(workingCopyPath, requireDocumentRevisionToken('drt1:crash:2:next'));
        const before = await readdir(tempRoot);
        const backupPath = `${originalPath}.evb-transition-crash.bak`;
        await writeFile(backupPath, 'other-program');
        // The save recorded the conflict and linked the kept name, then stopped before it removed the hidden one.
        await writeFile(getWorkingCopyJournalPath(workingCopyPath), JSON.stringify({
            ...journal,
            original: {
                path: originalPath,
                backupPath,
                state: 'conflicted',
            },
        }));
        const keptPath = join(tempRoot, 'original (original).pdf');
        await link(backupPath, keptPath);

        await expect(recoverWorkingCopyTransition(workingCopyPath)).resolves.toBe(true);
        expect((await readdir(tempRoot)).filter(name => !before.includes(name))).toEqual(['original (original).pdf']);
        await expect(readFile(keptPath, 'utf8')).resolves.toBe('other-program');
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('saved-by-evb');
    });

    it('keeps an external edit made while recovery checks the original, and the file before the save beside it', async () => {
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

            await expect(recoverWorkingCopyTransition(workingCopyPath)).resolves.toBe(true);
            await expect(readFile(originalPath, 'utf8')).resolves.toBe('external-edit');
            await expect(readFile(join(tempRoot, 'original (original).pdf'), 'utf8')).resolves.toBe('old-original');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
            await expect(stat(getWorkingCopyJournalPath(workingCopyPath))).rejects.toMatchObject({code: 'ENOENT'});
            expect((await readdir(tempRoot)).filter(name => name.includes('.evb-transition-'))).toEqual([]);
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
                stagePublication: () => Promise.resolve({path: stagedPath}),
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
                stagePublication: () => Promise.resolve({path: stagedPath}),
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                    assertDestinationCurrent: assertDestinationCurrent,
                    destinationBackupPath,
                }),
                refreshOriginalExpectation: async expected => {
                    expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7, expected)).toBe(true);
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
                stagePublication: () => Promise.resolve({path: prepared.stagedPath}),
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
            stagePublication: () => Promise.resolve({path: stagedPath}),
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
            refreshOriginalExpectation: async () => {
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
            stagePublication: () => Promise.resolve({path: secondStagedPath}),
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
            stagePublication: () => Promise.resolve({path: stagedPath}),
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
            refreshOriginalExpectation: async () => {
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
            stagePublication: () => Promise.resolve({path: secondStagedPath}),
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
            stagePublication: () => Promise.resolve({path: stagedPath}),
            publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                destinationBackupPath,
            }),
            refreshOriginalExpectation: async () => {
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
                stagePublication: () => Promise.resolve({path: stagedPath}),
                publishOriginal: (assertDestinationCurrent, destinationBackupPath) => publishImmutableFileAtomic(stagedPath, originalPath, {
                    ...({...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                    destinationBackupPath,
                }),
                refreshOriginalExpectation: async () => {
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
            stagePublication: () => Promise.resolve({path: stagedPath}),
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

    it('refuses the next annotation save after another program saves the PDF right after one', async () => {
        let afterTransition = (): void => undefined;
        vi.doMock('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision', async importOriginal => {
            const actual = await importOriginal<typeof TransitionModule>();
            return {
                ...actual,
                transitionOriginalAndWorkingCopyRevision: async (...args: Parameters<typeof actual.transitionOriginalAndWorkingCopyRevision>) => {
                    const event = await actual.transitionOriginalAndWorkingCopyRevision(...args);
                    afterTransition();
                    return event;
                },
            };
        });
        try {
            const {
                originalPath, workingCopyPath, saveAnnotations,
            } = await prepareAnnotationSaves('pdf-work-native-race');
            const firstSave = Buffer.alloc(2 * 1024 * 1024, 67);
            const external = Buffer.from(firstSave);
            external.write('EXTERNAL', 262144);
            afterTransition = () => {
                afterTransition = () => undefined;
                writeExternally(originalPath);
            };

            await expect(saveAnnotations(firstSave)).resolves.toMatchObject({applied: true});
            expect((await readFile(originalPath)).equals(external)).toBe(true);
            await expect(saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 68))).resolves.toMatchObject({
                applied: false,
                reason: 'original-changed',
            });
            expect((await readFile(originalPath)).equals(external)).toBe(true);
            expect((await readFile(workingCopyPath)).equals(firstSave)).toBe(true);
        } finally {
            vi.doUnmock('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        }
    });

    it('refuses the next annotation save after another program saves right after a failed save is restored', async () => {
        const fs = await import('node:fs/promises');
        const paths = {
            original: '',
            working: '',
        };
        let fault: 'armed' | 'thrown' | 'idle' = 'idle';
        let external: Buffer | null = null;
        vi.doMock('fs/promises', () => ({
            ...fs,
            rename: async (...args: Parameters<typeof fs.rename>) => {
                if (fault === 'armed' && String(args[1]) === paths.working) {
                    fault = 'thrown';
                    throw Object.assign(new Error('Injected EIO while syncing the working copy'), {code: 'EIO'});
                }
                await fs.rename(...args);
                if (fault === 'thrown' && external === null && String(args[1]) === paths.original) {
                    writeExternally(paths.original);
                    external = await fs.readFile(paths.original);
                }
            },
        }));
        try {
            const {
                originalPath, workingCopyPath, saveAnnotations,
            } = await prepareAnnotationSaves('pdf-work-rollback-race');
            paths.original = originalPath;
            paths.working = workingCopyPath;
            fault = 'armed';

            await expect(saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 67))).resolves.toMatchObject({
                applied: false,
                reason: 'original-changed',
            });
            expect(external).not.toBeNull();
            await expect(saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 68))).resolves.toMatchObject({
                applied: false,
                reason: 'original-changed',
            });
            expect((await readFile(originalPath)).equals(external!)).toBe(true);
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it('names the file as it was before a failed save when another program edits the PDF before the rollback restores it', async () => {
        const fs = await import('node:fs/promises');
        const paths = {
            original: '',
            working: '',
        };
        let armed = false;
        vi.doMock('fs/promises', () => ({
            ...fs,
            rename: async (...args: Parameters<typeof fs.rename>) => {
                if (armed && String(args[1]) === paths.working) {
                    armed = false;
                    // Another program edits the saved PDF, then the working-copy sync fails and the save rolls back.
                    writeExternally(paths.original);
                    throw Object.assign(new Error('Injected EIO while syncing the working copy'), {code: 'EIO'});
                }
                await fs.rename(...args);
            },
        }));
        try {
            const {
                originalPath, workingCopyPath, saveAnnotations,
            } = await prepareAnnotationSaves('pdf-work-restore-race');
            paths.original = originalPath;
            paths.working = workingCopyPath;
            const before = await readdir(tempRoot);
            armed = true;

            const keptFilePath = join(tempRoot, 'original (original).pdf');
            await expect(saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 67))).resolves.toMatchObject({
                applied: false,
                reason: 'original-changed',
                keptFilePath,
            });
            // The refusal names the file as it is on disk when it is shown, not after a later read.
            await expect(readFile(keptFilePath, 'utf8')).resolves.toBe('old-original');
            expect((await readFile(originalPath)).subarray(262144, 262152).toString()).toBe('EXTERNAL');
            expect((await readdir(tempRoot)).filter(name => !before.includes(name))).toEqual(['original (original).pdf']);
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it.each([
        'publication',
        'working-copy sync',
    ] as const)('names the file as it was before an annotation save another program edits right after %s', async moment => {
        let workingPath = '';
        let edit = (): void => undefined;
        vi.doMock('@electron/file-access/documentFileWriteAtomic', async importOriginal => {
            const actual = await importOriginal<typeof DocumentFileWriteAtomicModule>();
            return {
                ...actual,
                publishImmutableFileAtomic: async (...args: Parameters<typeof actual.publishImmutableFileAtomic>) => {
                    await actual.publishImmutableFileAtomic(...args);
                    if (moment === 'publication') edit();
                },
                copyFileAtomic: async (...args: Parameters<typeof actual.copyFileAtomic>) => {
                    await actual.copyFileAtomic(...args);
                    if (moment === 'working-copy sync' && args[1] === workingPath) edit();
                },
            };
        });
        try {
            const {
                originalPath, workingCopyPath, saveAnnotations,
            } = await prepareAnnotationSaves('pdf-work-edit-after-publication');
            workingPath = workingCopyPath;
            const external = Buffer.alloc(2 * 1024 * 1024, 67);
            external.write('EXTERNAL', 262144);
            edit = () => {
                edit = () => undefined;
                writeExternally(originalPath);
            };

            const result = await saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 67));
            expect(result).toMatchObject({
                applied: false,
                reason: 'original-changed',
            });
            if (!result.keptFilePath) throw new Error('The conflict named no kept file');
            expect(dirname(result.keptFilePath)).toBe(dirname(originalPath));
            await expect(readFile(result.keptFilePath, 'utf8')).resolves.toBe('old-original');
            expect((await readFile(originalPath)).equals(external)).toBe(true);
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
        } finally {
            vi.doUnmock('@electron/file-access/documentFileWriteAtomic');
        }
    });

    it('removes the publication link a crash left beside the PDF on the next start and keeps an unrelated temporary file', async () => {
        const fs = await import('node:fs/promises');
        let originalDirectory = '';
        let crashed = (): void => undefined;
        vi.doMock('fs/promises', () => ({
            ...fs,
            // The process dies right before it removes the publication's temporary name.
            unlink: async (...args: Parameters<typeof fs.unlink>) => {
                if (originalDirectory !== '' && dirname(String(args[0])) === originalDirectory && String(args[0]).endsWith('.tmp')) {
                    crashed();
                    return new Promise<void>(() => undefined);
                }
                return fs.unlink(...args);
            },
        }));
        try {
            const {
                originalPath, workingCopyPath, saveAnnotations,
            } = await prepareAnnotationSaves('pdf-work-crash-before-unlink');
            const unrelated = join(dirname(originalPath), '.unrelated.tmp');
            await writeFile(unrelated, 'another program');
            const crash = new Promise<void>(resolve => {
                crashed = resolve;
            });
            originalDirectory = dirname(originalPath);
            void saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 67));
            await crash;
            originalDirectory = '';
            expect((await readdir(dirname(originalPath))).filter(name => name.endsWith('.tmp'))).toHaveLength(2);

            vi.resetModules();
            const {recoverWorkingCopyTransition} = await import('@electron/file-access/workingCopyJournal');
            await expect(recoverWorkingCopyTransition(workingCopyPath)).resolves.toBe(true);
            expect((await readdir(dirname(originalPath))).filter(name => name.endsWith('.tmp'))).toEqual(['.unrelated.tmp']);
            await expect(readFile(unrelated, 'utf8')).resolves.toBe('another program');
            await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it('removes a copy-path stage a crash left during staging on the next start and keeps unrelated files', async () => {
        let crashed = (): void => undefined;
        vi.doMock('@electron/file-access/workingCopyDirectory', async importOriginal => {
            const actual = await importOriginal<typeof WorkingCopyDirectoryModule>();
            return {
                ...actual,
                // The process dies once the working copy has been copied to the stage.
                copyFileCopyOnWrite: async (...args: Parameters<typeof actual.copyFileCopyOnWrite>) => {
                    await actual.copyFileCopyOnWrite(...args);
                    crashed();
                    return new Promise<never>(() => undefined);
                },
            };
        });
        try {
            const {
                originalPath, workingCopyPath,
            } = await prepareAnnotationSaves('pdf-work-crash-while-staging');
            const readNeighbours = await writeUnrelatedNeighbours(originalPath);
            const before = await readdir(dirname(originalPath));
            const {handleFileSaveStructured} = await import('@electron/features/documents/main/workingCopySave');
            const {getWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
            const {token} = await getWorkingCopyRevision(workingCopyPath, 7);
            const crash = new Promise<void>(resolve => {
                crashed = resolve;
            });
            void handleFileSaveStructured({senderId: 7}, workingCopyPath, {expectedDocumentRevisionToken: token});
            await crash;
            const staged = (await readdir(dirname(originalPath))).filter(name => !before.includes(name));
            expect(staged).toHaveLength(1);
            await expect(readFile(join(dirname(originalPath), staged[0]!), 'utf8')).resolves.toBe('old-working');

            vi.resetModules();
            const {recoverWorkingCopyTransition} = await import('@electron/file-access/workingCopyJournal');
            await recoverWorkingCopyTransition(workingCopyPath);
            expect((await readdir(dirname(originalPath))).sort()).toEqual([...before].sort());
            await expect(readNeighbours()).resolves.toEqual([
                'another program',
                'another program',
                'another program',
            ]);
            await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyDirectory');
        }
    });

    it('leaves nothing of a completed save beside the PDF when a crash follows the journal removal', async () => {
        const fs = await import('node:fs/promises');
        let journalPath = '';
        let crashed = (): void => undefined;
        vi.doMock('node:fs/promises', () => ({
            ...fs,
            // The process dies right after the completed save removes its journal.
            rm: async (...args: Parameters<typeof fs.rm>) => {
                await fs.rm(...args);
                if (journalPath !== '' && String(args[0]) === journalPath) {
                    crashed();
                    return new Promise<never>(() => undefined);
                }
            },
        }));
        try {
            const {
                originalPath, workingCopyPath, saveAnnotations,
            } = await prepareAnnotationSaves('pdf-work-crash-after-journal');
            const readNeighbours = await writeUnrelatedNeighbours(originalPath);
            const before = await readdir(dirname(originalPath));
            const {getWorkingCopyJournalPath} = await import('@electron/file-access/workingCopyDirectory');
            const saved = Buffer.alloc(2 * 1024 * 1024, 67);
            const crash = new Promise<void>(resolve => {
                crashed = resolve;
            });
            journalPath = getWorkingCopyJournalPath(workingCopyPath);
            void saveAnnotations(saved);
            await crash;
            journalPath = '';

            vi.resetModules();
            const {recoverWorkingCopyTransition} = await import('@electron/file-access/workingCopyJournal');
            await expect(recoverWorkingCopyTransition(workingCopyPath)).resolves.toBe(false);
            expect((await readdir(dirname(originalPath))).sort()).toEqual([...before].sort());
            await expect(readNeighbours()).resolves.toEqual([
                'another program',
                'another program',
                'another program',
            ]);
            expect((await readFile(originalPath)).equals(saved)).toBe(true);
        } finally {
            vi.doUnmock('node:fs/promises');
        }
    });

    it('reopens and refuses Save after a crash during copy-path staging and an edit elsewhere, leaving nothing beside the PDF', async () => {
        let crashed = (): void => undefined;
        vi.doMock('@electron/file-access/workingCopyDirectory', async importOriginal => {
            const actual = await importOriginal<typeof WorkingCopyDirectoryModule>();
            return {
                ...actual,
                copyFileCopyOnWrite: async (...args: Parameters<typeof actual.copyFileCopyOnWrite>) => {
                    await actual.copyFileCopyOnWrite(...args);
                    crashed();
                    return new Promise<never>(() => undefined);
                },
            };
        });
        let originalPath = '';
        let workingCopyPath = '';
        let before: string[] = [];
        let checkpointExpectation: unknown;
        try {
            ({
                originalPath, workingCopyPath,
            } = await prepareAnnotationSaves('pdf-work-crash-then-edit'));
            await writeUnrelatedNeighbours(originalPath);
            before = await readdir(dirname(originalPath));
            const {getWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
            const {createOriginalFileContentFingerprintHash} = await import('@electron/file-access/createOriginalFileContentFingerprintHash');
            const bytes = await readFile(originalPath);
            checkpointExpectation = {
                ...getWorkingCopyOriginalFileExpectation(workingCopyPath, 7),
                contentFingerprint: `sha256-full-v1:${createOriginalFileContentFingerprintHash(bytes.byteLength).update(bytes).digest('hex')}`,
            };
            const {handleFileSaveStructured} = await import('@electron/features/documents/main/workingCopySave');
            const {getWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
            const {token} = await getWorkingCopyRevision(workingCopyPath, 7);
            const crash = new Promise<void>(resolve => {
                crashed = resolve;
            });
            void handleFileSaveStructured({senderId: 7}, workingCopyPath, {expectedDocumentRevisionToken: token});
            await crash;
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyDirectory');
        }
        // While EVB is stopped, another program saves the PDF.
        await writeFile(originalPath, 'edited-elsewhere');

        // EVB restarts and restores the tab from its checkpoint.
        vi.resetModules();
        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        await setWorkingCopyOriginalPath(workingCopyPath, originalPath, 7, {
            backingState: 'materialized',
            deferOriginalFileExpectation: true,
            originalFileExpectation: checkpointExpectation as never,
        });
        const {getWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        const {handleFileSaveStructured} = await import('@electron/features/documents/main/workingCopySave');
        const revision = await getWorkingCopyRevision(workingCopyPath, 7);
        await expect(handleFileSaveStructured({senderId: 7}, workingCopyPath, {expectedDocumentRevisionToken: revision.token}))
            .resolves.toMatchObject({
                ok: false,
                reason: 'original-changed',
            });
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('edited-elsewhere');
        expect((await readdir(dirname(originalPath))).sort()).toEqual([...before].sort());
    });

    it('leaves nothing beside the PDF when a crash interrupts the rollback of a failed save', async () => {
        const fs = await import('node:fs/promises');
        const paths = {
            original: '',
            working: '',
        };
        let fault: 'armed' | 'thrown' | 'idle' = 'idle';
        let crashed = (): void => undefined;
        vi.doMock('fs/promises', () => ({
            ...fs,
            rename: async (...args: Parameters<typeof fs.rename>) => {
                if (fault === 'armed' && String(args[1]) === paths.working) {
                    fault = 'thrown';
                    throw Object.assign(new Error('Injected EIO while syncing the working copy'), {code: 'EIO'});
                }
                // The process dies as the rollback moves bytes back over the original.
                if (fault === 'thrown' && String(args[1]) === paths.original) {
                    crashed();
                    return new Promise<never>(() => undefined);
                }
                return fs.rename(...args);
            },
        }));
        try {
            const {
                originalPath, workingCopyPath, saveAnnotations,
            } = await prepareAnnotationSaves('pdf-work-crash-during-rollback');
            const readNeighbours = await writeUnrelatedNeighbours(originalPath);
            const before = await readdir(dirname(originalPath));
            paths.original = originalPath;
            paths.working = workingCopyPath;
            const crash = new Promise<void>(resolve => {
                crashed = resolve;
            });
            fault = 'armed';
            void saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 67));
            await crash;
            fault = 'idle';

            vi.resetModules();
            const {recoverWorkingCopyTransition} = await import('@electron/file-access/workingCopyJournal');
            await expect(recoverWorkingCopyTransition(workingCopyPath)).resolves.toBe(true);
            expect((await readdir(dirname(originalPath))).sort()).toEqual([...before].sort());
            await expect(readNeighbours()).resolves.toEqual([
                'another program',
                'another program',
                'another program',
            ]);
            await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it('keeps reads and edits working while another program holds a saved backup, refuses saves until it is released, and removes it', async () => {
        const fs = await import('node:fs/promises');
        let holding = false;
        let originalDirectory = '';
        vi.doMock('node:fs/promises', () => ({
            ...fs,
            // Windows refuses to delete a file another program holds without delete sharing.
            rm: async (...args: Parameters<typeof fs.rm>) => {
                const path = String(args[0]);
                if (holding && dirname(path) === originalDirectory && path.includes('.evb-transition-') && existsSync(path)) {
                    throw Object.assign(new Error('EBUSY: resource busy or locked'), {code: 'EBUSY'});
                }
                return fs.rm(...args);
            },
        }));
        try {
            const {
                originalPath, workingCopyPath, saveAnnotations,
            } = await prepareAnnotationSaves('pdf-work-held-backup');
            const readNeighbours = await writeUnrelatedNeighbours(originalPath);
            const before = await readdir(dirname(originalPath));
            originalDirectory = dirname(originalPath);
            holding = true;
            await expect(saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 67))).resolves.toMatchObject({applied: true});
            const {
                getWorkingCopyRevision, transitionWorkingCopyContentRevision,
            } = await import('@electron/file-access/documentRevisionStore');
            await expect(getWorkingCopyRevision(workingCopyPath, 7)).resolves.toMatchObject({contentRevision: 2});
            const held = (await readdir(originalDirectory)).filter(name => !before.includes(name));
            expect(held).toHaveLength(1);

            // An edit such as a page rotation does not need the held file.
            await expect(transitionWorkingCopyContentRevision(workingCopyPath, 'page-ops', async () => {
                await writeFile(workingCopyPath, 'edited while held');
            }, 7)).resolves.toBeTruthy();
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('edited while held');
            await expect(getWorkingCopyRevision(workingCopyPath, 7)).resolves.toMatchObject({contentRevision: 3});
            // A save would forget the held file, so it is refused with the file-in-use error until the hold ends.
            await expect(saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 68))).rejects.toMatchObject({code: 'EBUSY'});
            expect((await readdir(originalDirectory)).filter(name => !before.includes(name))).toEqual(held);

            holding = false;
            await expect(saveAnnotations(Buffer.alloc(2 * 1024 * 1024, 69))).resolves.toMatchObject({applied: true});
            expect((await readdir(originalDirectory)).sort()).toEqual([...before].sort());
            const {cleanupWorkingCopy} = await import('@electron/file-access/workingCopyCleanup');
            await cleanupWorkingCopy(workingCopyPath, 7);
            expect((await readdir(originalDirectory)).sort()).toEqual([...before].sort());
            await expect(readNeighbours()).resolves.toEqual([
                'another program',
                'another program',
                'another program',
            ]);
        } finally {
            vi.doUnmock('node:fs/promises');
        }
    });
    it('keeps the journal of a document closed while another program holds its save leftover, and the next start removes it', async () => {
        const fs = await import('node:fs/promises');
        let holding = false;
        let originalDirectory = '';
        vi.doMock('node:fs/promises', () => ({
            ...fs,
            // Windows refuses to delete a file another program holds without delete sharing.
            rm: async (...args: Parameters<typeof fs.rm>) => {
                const path = String(args[0]);
                if (holding && dirname(path) === originalDirectory && path.includes('.evb-transition-') && existsSync(path)) {
                    throw Object.assign(new Error('EBUSY: resource busy or locked'), {code: 'EBUSY'});
                }
                return fs.rm(...args);
            },
        }));
        try {
            const {
                originalPath, workingCopyPath, saveAnnotations,
            } = await prepareAnnotationSaves('pdf-work-held-at-close');
            const readNeighbours = await writeUnrelatedNeighbours(originalPath);
            const before = await readdir(dirname(originalPath));
            originalDirectory = dirname(originalPath);
            const saved = Buffer.alloc(2 * 1024 * 1024, 67);
            holding = true;
            await expect(saveAnnotations(saved)).resolves.toMatchObject({applied: true});
            const {cleanupWorkingCopy} = await import('@electron/file-access/workingCopyCleanup');
            await cleanupWorkingCopy(workingCopyPath, 7);
            const {getWorkingCopyJournalPath} = await import('@electron/file-access/workingCopyDirectory');
            // The journal still owns the held file after close; only the document is gone.
            expect(existsSync(getWorkingCopyJournalPath(workingCopyPath))).toBe(true);
            expect(existsSync(workingCopyPath)).toBe(false);
            expect((await readdir(originalDirectory)).filter(name => !before.includes(name))).toHaveLength(1);

            // The other program lets go, and EVB starts again.
            holding = false;
            vi.resetModules();
            const {cleanupStaleWorkingCopyDirectories} = await import('@electron/file-access/workingCopyCleanup');
            await cleanupStaleWorkingCopyDirectories();
            expect((await readdir(originalDirectory)).sort()).toEqual([...before].sort());
            expect(existsSync(dirname(workingCopyPath))).toBe(false);
            expect((await readFile(originalPath)).equals(saved)).toBe(true);
            await expect(readNeighbours()).resolves.toEqual([
                'another program',
                'another program',
                'another program',
            ]);
        } finally {
            vi.doUnmock('node:fs/promises');
        }
    });
});
