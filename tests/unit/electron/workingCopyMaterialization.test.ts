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
    readdirSync,
    rmSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import type * as FsPromises from 'node:fs/promises';

let tempRoot = '';
let resetModulesAfterTest = false;
const MULTI_CHUNK_FIXTURE_BYTES = 1024 * 1024 + 17;

vi.mock('electron', () => ({app: {getPath: vi.fn(() => tempRoot)}}));

describe('workingCopyMaterialization', () => {
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-materialization-test-'));
    });

    afterEach(async () => {
        vi.doUnmock('node:fs/promises');
        vi.doUnmock('fs/promises');
        if (resetModulesAfterTest) {
            vi.resetModules();
            resetModulesAfterTest = false;
        }
        const {resetMainOperationLifecycleForTests} = await import(
            '@electron/operation-lifecycle/mainOperationLifecycle'
        );
        resetMainOperationLifecycleForTests();
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('publishes verified bytes after cache invalidation without changing the document revision', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(MULTI_CHUNK_FIXTURE_BYTES, 41));
        const {
            getWorkingCopyRevision,
            initializeFreshWorkingCopyRevision,
        } = await import('@electron/file-access/documentRevisionStore');
        await initializeFreshWorkingCopyRevision(fixture.workingPath, 7);
        const revisionBefore = await getWorkingCopyRevision(fixture.workingPath, 7);
        const {
            ensureWorkingCopyMaterialized,
            onWorkingCopyBackingSwapCacheInvalidation,
            onWorkingCopyMaterializationProgress,
        } = await import('@electron/file-access/workingCopyMaterialization');
        const progress: Array<{
            bytesCopied: number;
            percent: number;
        }> = [];
        const removeProgressListener = onWorkingCopyMaterializationProgress((event) => {
            if (event.status === 'running' && event.phase === 'copying') {
                progress.push({
                    bytesCopied: event.bytesCopied,
                    percent: event.percent,
                });
            }
        });
        let cacheInvalidatedBeforePublication = false;
        const removeInvalidator = onWorkingCopyBackingSwapCacheInvalidation((
            logicalRef,
            previousPhysicalPath,
        ) => {
            expect(logicalRef).toBe(fixture.workingPath);
            expect(previousPhysicalPath).toBe(fixture.originalPath);
            expect(existsSync(fixture.workingPath)).toBe(false);
            cacheInvalidatedBeforePublication = true;
        });

        const result = await ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        });

        removeInvalidator();
        removeProgressListener();
        expect(cacheInvalidatedBeforePublication).toBe(true);
        expect(readFileSync(fixture.workingPath).equals(fixture.bytes)).toBe(true);
        expect(result).toMatchObject({
            logicalRef: fixture.workingPath,
            physicalWorkingCopyPath: fixture.workingPath,
            sourceFingerprint: expect.stringMatching(/^sha256-full-v1:/u),
        });
        const {getWorkingCopyBackingEntry} = await import('@electron/file-access/workingCopyStore');
        expect(getWorkingCopyBackingEntry(fixture.workingPath, 7)).toMatchObject({
            backingState: 'materialized',
            originalFileExpectation: {
                contentFingerprint: result.sourceFingerprint,
                size: fixture.bytes.byteLength,
            },
        });
        expect(progress.at(-1)).toEqual({
            bytesCopied: fixture.bytes.byteLength,
            percent: 100,
        });
        expect(progress.map(entry => entry.bytesCopied))
            .toEqual([...progress.map(entry => entry.bytesCopied)].sort((left, right) => left - right));
        const revisionAfter = await getWorkingCopyRevision(fixture.workingPath, 7);
        expect(revisionAfter).toEqual(revisionBefore);
    });

    it('shares one flight across concurrent demand waiters', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(MULTI_CHUNK_FIXTURE_BYTES, 19));
        const {
            ensureWorkingCopyMaterialized,
            onWorkingCopyBackingSwapCacheInvalidation,
            onWorkingCopyMaterializationProgress,
        } = await import('@electron/file-access/workingCopyMaterialization');
        const operationIds = new Set<string>();
        const removeProgressListener = onWorkingCopyMaterializationProgress(event => {
            operationIds.add(event.operationId);
        });
        let publications = 0;
        const removeInvalidator = onWorkingCopyBackingSwapCacheInvalidation(() => {
            publications += 1;
        });

        const results = await Promise.all([
            ensureWorkingCopyMaterialized(fixture.workingPath, {
                ownerWebContentsId: 7,
                reason: 'save',
            }),
            ensureWorkingCopyMaterialized(fixture.workingPath, {
                ownerWebContentsId: 7,
                reason: 'page-operation',
            }),
            ensureWorkingCopyMaterialized(fixture.workingPath, {
                ownerWebContentsId: 7,
                reason: 'ocr-persist',
            }),
        ]);

        removeInvalidator();
        removeProgressListener();
        expect(new Set(results.map(result => result.sourceFingerprint)).size).toBe(1);
        expect(operationIds.size).toBe(1);
        expect(publications).toBe(1);
    });

    it('cancels one waiter without aborting a flight retained by another waiter', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(MULTI_CHUNK_FIXTURE_BYTES, 23));
        const {
            ensureWorkingCopyMaterialized,
            onWorkingCopyMaterializationProgress,
        } = await import('@electron/file-access/workingCopyMaterialization');
        const firstWaiterController = new AbortController();
        const removeProgressListener = onWorkingCopyMaterializationProgress(event => {
            if (event.phase === 'copying' && event.bytesCopied > 0) {
                firstWaiterController.abort();
            }
        });

        const firstWaiter = ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
            signal: firstWaiterController.signal,
        });
        const secondWaiter = ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'page-operation',
        });
        const [
            firstResult,
            secondResult,
        ] = await Promise.allSettled([
            firstWaiter,
            secondWaiter,
        ]);

        removeProgressListener();
        expect(firstResult).toMatchObject({
            status: 'rejected',
            reason: {
                code: 'WORKING_COPY_MATERIALIZATION_CANCELLED',
                retryable: true,
            },
        });
        expect(secondResult.status).toBe('fulfilled');
        expect(readFileSync(fixture.workingPath).equals(fixture.bytes)).toBe(true);
    });

    it('lets a document consumer finish the copy a cancelled scan cleanup request started', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(2 * 1024 * 1024, 24));
        const {
            ensureWorkingCopyMaterialized,
            onWorkingCopyMaterializationProgress,
        } = await import('@electron/file-access/workingCopyMaterialization');
        const cleanupController = new AbortController();
        let documentWaiter: Promise<unknown> | null = null;
        const removeProgressListener = onWorkingCopyMaterializationProgress(event => {
            if (event.phase !== 'copying' || event.bytesCopied < 1 || documentWaiter) {
                return;
            }
            // The scan cleanup preview that started the flight is cancelled the
            // moment the document itself asks for the same copy. The document
            // joined an existing flight, so it must not inherit that abort.
            cleanupController.abort();
            documentWaiter = ensureWorkingCopyMaterialized(fixture.workingPath, {
                ownerWebContentsId: 7,
                reason: 'page-operation',
            });
        });

        const cleanupWaiter = ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'scan-cleanup',
            signal: cleanupController.signal,
        });
        await expect(cleanupWaiter).rejects.toMatchObject({code: 'WORKING_COPY_MATERIALIZATION_CANCELLED'});
        await expect(documentWaiter).resolves.toMatchObject({physicalWorkingCopyPath: fixture.workingPath});

        removeProgressListener();
        const {getWorkingCopyBackingEntry} = await import('@electron/file-access/workingCopyStore');
        expect(getWorkingCopyBackingEntry(fixture.workingPath, 7)).toMatchObject({backingState: 'materialized'});
        expect(readFileSync(fixture.workingPath).equals(fixture.bytes)).toBe(true);
        expect(materializingArtifacts(fixture.workingPath)).toEqual([]);
    });

    it('stops a joined flight once the last waiter is gone', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(2 * 1024 * 1024, 31));
        const {
            ensureWorkingCopyMaterialized,
            getWorkingCopyMaterializationFlightCountForTests,
            onWorkingCopyMaterializationProgress,
        } = await import('@electron/file-access/workingCopyMaterialization');
        const starterController = new AbortController();
        const joinerController = new AbortController();
        let joiner: Promise<unknown> | null = null;
        const removeProgressListener = onWorkingCopyMaterializationProgress(event => {
            if (event.phase !== 'copying' || event.bytesCopied < 1) {
                return;
            }
            if (!joiner) {
                // Somebody else joins the copy the first caller started, and the
                // first caller leaves: the copy is still owned.
                joiner = ensureWorkingCopyMaterialized(fixture.workingPath, {
                    ownerWebContentsId: 7,
                    reason: 'page-operation',
                    signal: joinerController.signal,
                });
                starterController.abort();
                return;
            }
            // Now the joiner leaves too. Copying gigabytes for nobody is work
            // the machine should not still be doing, and the caller that started
            // it is long gone, so the flight cannot wait for it to clean up.
            joinerController.abort();
        });

        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'scan-cleanup',
            signal: starterController.signal,
        })).rejects.toMatchObject({code: 'WORKING_COPY_MATERIALIZATION_CANCELLED'});
        await expect(joiner).rejects.toMatchObject({code: 'WORKING_COPY_MATERIALIZATION_CANCELLED'});
        removeProgressListener();

        await vi.waitFor(() => expect(getWorkingCopyMaterializationFlightCountForTests()).toBe(0));
        expect(materializingArtifacts(fixture.workingPath)).toEqual([]);
        const {getWorkingCopyBackingEntry} = await import('@electron/file-access/workingCopyStore');
        expect(getWorkingCopyBackingEntry(fixture.workingPath, 7)).toMatchObject({backingState: 'lazy-original'});
        // And the document can still be materialized afterwards.
        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'page-operation',
        })).resolves.toMatchObject({physicalWorkingCopyPath: fixture.workingPath});
        expect(readFileSync(fixture.workingPath).equals(fixture.bytes)).toBe(true);
    });

    it('cancels lazy materialization when its renderer owner disappears', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(2 * 1024 * 1024, 33));
        const {cancelMainOperationsForOwner} = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const {
            ensureWorkingCopyMaterialized,
            getWorkingCopyMaterializationFlightCountForTests,
            onWorkingCopyMaterializationProgress,
        } = await import('@electron/file-access/workingCopyMaterialization');
        let ownerCancellationRequested = false;
        const removeProgressListener = onWorkingCopyMaterializationProgress(event => {
            if (event.phase === 'copying' && event.bytesCopied > 0 && !ownerCancellationRequested) {
                ownerCancellationRequested = true;
                cancelMainOperationsForOwner(7, 'Renderer lifecycle ended');
            }
        });

        const materialization = ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        });
        try {
            await expect(materialization).rejects.toMatchObject({
                code: 'WORKING_COPY_MATERIALIZATION_CANCELLED',
                retryable: true,
            });
        } finally {
            removeProgressListener();
        }

        await vi.waitFor(() => expect(getWorkingCopyMaterializationFlightCountForTests()).toBe(0));
        expect(ownerCancellationRequested).toBe(true);
        expect(existsSync(fixture.workingPath)).toBe(false);
        expect(materializingArtifacts(fixture.workingPath)).toEqual([]);

        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        })).resolves.toMatchObject({physicalWorkingCopyPath: fixture.workingPath});
        expect(readFileSync(fixture.workingPath).equals(fixture.bytes)).toBe(true);
    });

    it('recovers a registration left materializing and a flight already tearing down', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(2 * 1024 * 1024, 25));
        const {
            ensureWorkingCopyMaterialized,
            getWorkingCopyMaterializationFlightCountForTests,
            onWorkingCopyMaterializationProgress,
        } = await import('@electron/file-access/workingCopyMaterialization');
        const abandonedController = new AbortController();
        const removeProgressListener = onWorkingCopyMaterializationProgress(event => {
            if (event.phase === 'copying' && event.bytesCopied > 0) abandonedController.abort();
        });

        // The only waiter leaves, so its own flight is torn down and the
        // registration is handed back.
        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'scan-cleanup',
            signal: abandonedController.signal,
        })).rejects.toMatchObject({code: 'WORKING_COPY_MATERIALIZATION_CANCELLED'});
        removeProgressListener();

        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'page-operation',
        })).resolves.toMatchObject({physicalWorkingCopyPath: fixture.workingPath});
        expect(readFileSync(fixture.workingPath).equals(fixture.bytes)).toBe(true);
        expect(getWorkingCopyMaterializationFlightCountForTests()).toBe(0);
        expect(materializingArtifacts(fixture.workingPath)).toEqual([]);
    });

    it('keeps a flight background-leased when the lease attaches after a demand waiter', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(MULTI_CHUNK_FIXTURE_BYTES, 27));
        const {
            ensureWorkingCopyMaterialized,
            startBackgroundWorkingCopyMaterialization,
        } = await import('@electron/file-access/workingCopyMaterialization');
        const demandController = new AbortController();

        const demandWaiter = ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
            signal: demandController.signal,
        });
        const backgroundHolder = startBackgroundWorkingCopyMaterialization(fixture.workingPath, 7);
        expect(backgroundHolder).not.toBeNull();
        demandController.abort();

        const [
            demandResult,
            backgroundResult,
        ] = await Promise.allSettled([
            demandWaiter,
            backgroundHolder!.promise,
        ]);

        expect(demandResult).toMatchObject({
            status: 'rejected',
            reason: {code: 'WORKING_COPY_MATERIALIZATION_CANCELLED'},
        });
        expect(backgroundResult.status).toBe('fulfilled');
        expect(readFileSync(fixture.workingPath).equals(fixture.bytes)).toBe(true);
    });

    it('explicitly cancels shared work, removes its partial, and permits retry', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(MULTI_CHUNK_FIXTURE_BYTES, 29));
        const {
            cancelWorkingCopyMaterialization,
            ensureWorkingCopyMaterialized,
            onWorkingCopyMaterializationProgress,
            startBackgroundWorkingCopyMaterialization,
        } = await import('@electron/file-access/workingCopyMaterialization');
        const background = startBackgroundWorkingCopyMaterialization(fixture.workingPath, 7);
        expect(background).not.toBeNull();
        const removeProgressListener = onWorkingCopyMaterializationProgress(event => {
            if (event.operationId === background?.operationId && event.bytesCopied > 0) {
                cancelWorkingCopyMaterialization(event.operationId, 'test cancellation');
            }
        });

        await expect(background?.promise).rejects.toMatchObject({
            code: 'WORKING_COPY_MATERIALIZATION_CANCELLED',
            retryable: true,
        });
        removeProgressListener();
        expect(existsSync(fixture.workingPath)).toBe(false);
        expect(materializingArtifacts(fixture.workingPath)).toEqual([]);

        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        })).resolves.toMatchObject({physicalWorkingCopyPath: fixture.workingPath});
        expect(readFileSync(fixture.workingPath).equals(fixture.bytes)).toBe(true);
    });

    it('keeps ENOSPC retryable and never publishes partial target content', async () => {
        const actualFs = await import('node:fs/promises');
        vi.doMock('node:fs/promises', async (importOriginal) => {
            const original = await importOriginal<typeof FsPromises>();
            return {
                ...original,
                open: async (...args: Parameters<typeof original.open>) => {
                    const handle = await actualFs.open(...args);
                    if (String(args[0]).includes('.materializing-') && args[1] === 'wx') {
                        const writableHandle = handle as typeof handle & {write: typeof handle.write};
                        writableHandle.write = vi.fn(async () => {
                            throw Object.assign(new Error('disk full'), {code: 'ENOSPC'});
                        }) as typeof handle.write;
                    }
                    return handle;
                },
            };
        });
        resetModulesAfterTest = true;
        vi.resetModules();
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(1024 * 1024, 31));
        const {ensureWorkingCopyMaterialized} = await import(
            '@electron/file-access/workingCopyMaterialization'
        );

        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        })).rejects.toMatchObject({
            code: 'WORKING_COPY_MATERIALIZATION_NO_SPACE',
            retryable: true,
        });
        expect(existsSync(fixture.workingPath)).toBe(false);
        expect(materializingArtifacts(fixture.workingPath)).toEqual([]);
        const {getWorkingCopyBackingEntry} = await import('@electron/file-access/workingCopyStore');
        expect(getWorkingCopyBackingEntry(fixture.workingPath, 7)).toMatchObject({
            backingState: 'lazy-original',
            sourceBackingErrorCode: 'WORKING_COPY_MATERIALIZATION_NO_SPACE',
        });
    });

    it('refuses before opening a materialization target when the destination lacks capacity', async () => {
        const openedPaths: string[] = [];
        vi.doMock('node:fs/promises', async (importOriginal) => {
            const original = await importOriginal<typeof FsPromises>();
            return {
                ...original,
                open: async (...args: Parameters<typeof original.open>) => {
                    openedPaths.push(String(args[0]));
                    return original.open(...args);
                },
                statfs: vi.fn(async () => ({
                    bavail: 1n,
                    bsize: 512n,
                })),
            };
        });
        resetModulesAfterTest = true;
        vi.resetModules();
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(1024 * 1024, 33));
        const {ensureWorkingCopyMaterialized} = await import(
            '@electron/file-access/workingCopyMaterialization'
        );

        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        })).rejects.toMatchObject({
            code: 'WORKING_COPY_MATERIALIZATION_NO_SPACE',
            retryable: true,
        });
        expect(existsSync(fixture.workingPath)).toBe(false);
        expect(openedPaths.some(path => path.includes('.materializing-'))).toBe(false);
        expect(materializingArtifacts(fixture.workingPath)).toEqual([]);
    });

    it('blocks materialization when the source changed before copying', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(1024, 37));
        const changedTime = new Date(Date.now() + 5_000);
        utimesSync(fixture.originalPath, changedTime, changedTime);
        const {ensureWorkingCopyMaterialized} = await import(
            '@electron/file-access/workingCopyMaterialization'
        );

        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        })).rejects.toMatchObject({
            code: 'SOURCE_BACKING_CHANGED',
            retryable: false,
        });
        expect(existsSync(fixture.workingPath)).toBe(false);
        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        })).rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});
    });

    it('discards copied bytes when the source changes during streaming', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(MULTI_CHUNK_FIXTURE_BYTES, 43));
        const {
            ensureWorkingCopyMaterialized,
            onWorkingCopyMaterializationProgress,
        } = await import('@electron/file-access/workingCopyMaterialization');
        let changed = false;
        const removeProgressListener = onWorkingCopyMaterializationProgress(event => {
            if (!changed && event.phase === 'copying' && event.bytesCopied > 0) {
                changed = true;
                const changedBytes = Buffer.from(fixture.bytes);
                changedBytes[0] = 99;
                writeFileSync(fixture.originalPath, changedBytes);
                const changedTime = new Date(Date.now() + 5_000);
                utimesSync(fixture.originalPath, changedTime, changedTime);
            }
        });

        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        })).rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});
        removeProgressListener();
        expect(existsSync(fixture.workingPath)).toBe(false);
        expect(materializingArtifacts(fixture.workingPath)).toEqual([]);
    });

    it('rechecks the source after cache invalidation and before the atomic swap', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(1024 * 1024, 67));
        const {
            ensureWorkingCopyMaterialized,
            onWorkingCopyBackingSwapCacheInvalidation,
        } = await import('@electron/file-access/workingCopyMaterialization');
        const removeInvalidator = onWorkingCopyBackingSwapCacheInvalidation(() => {
            const changedTime = new Date(Date.now() + 5_000);
            utimesSync(fixture.originalPath, changedTime, changedTime);
        });

        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        })).rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});
        removeInvalidator();
        expect(existsSync(fixture.workingPath)).toBe(false);
        expect(materializingArtifacts(fixture.workingPath)).toEqual([]);
    });

    it('blocks safely when the original disappears', async () => {
        const fixture = await registerLazyWorkingCopy(Buffer.alloc(1024, 47));
        unlinkSync(fixture.originalPath);
        const {ensureWorkingCopyMaterialized} = await import(
            '@electron/file-access/workingCopyMaterialization'
        );

        await expect(ensureWorkingCopyMaterialized(fixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        })).rejects.toMatchObject({code: 'SOURCE_BACKING_UNAVAILABLE'});
        expect(existsSync(fixture.workingPath)).toBe(false);
        expect(materializingArtifacts(fixture.workingPath)).toEqual([]);
    });

    it('registration-ID fences prevent an old flight publishing into a replacement registration', async () => {
        const firstFixture = await registerLazyWorkingCopy(Buffer.alloc(MULTI_CHUNK_FIXTURE_BYTES, 53));
        const secondOriginalPath = join(tempRoot, 'replacement-original.pdf');
        writeFileSync(secondOriginalPath, Buffer.alloc(256, 59));
        const {
            captureWorkingCopyAdmissionSnapshot,
            getWorkingCopyBackingEntry,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const replacementSnapshot = await captureWorkingCopyAdmissionSnapshot(secondOriginalPath);
        const {
            ensureWorkingCopyMaterialized,
            onWorkingCopyMaterializationProgress,
        } = await import('@electron/file-access/workingCopyMaterialization');
        let replacementRegistration: Promise<void> | null = null;
        const removeProgressListener = onWorkingCopyMaterializationProgress(event => {
            if (!replacementRegistration && event.phase === 'copying' && event.bytesCopied > 0) {
                replacementRegistration = setWorkingCopyOriginalPath(
                    firstFixture.workingPath,
                    secondOriginalPath,
                    7,
                    {
                        admissionSnapshot: replacementSnapshot,
                        backingState: 'lazy-original',
                        deferOriginalFileExpectation: true,
                    },
                );
            }
        });

        await expect(ensureWorkingCopyMaterialized(firstFixture.workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        })).rejects.toMatchObject({code: 'WORKING_COPY_REGISTRATION_CHANGED'});
        if (replacementRegistration !== null) {
            await Promise.resolve(replacementRegistration);
        }
        removeProgressListener();
        expect(existsSync(firstFixture.workingPath)).toBe(false);
        expect(getWorkingCopyBackingEntry(firstFixture.workingPath, 7)).toMatchObject({
            backingState: 'lazy-original',
            originalPath: secondOriginalPath,
        });
    });
});

async function registerLazyWorkingCopy(bytes: Buffer) {
    const originalPath = join(tempRoot, `original-${Math.random().toString(16).slice(2)}.pdf`);
    const workingPath = join(
        tempRoot,
        'evb-viewer',
        `pdf-work-${Math.random().toString(16).slice(2)}`,
        'working.pdf',
    );
    mkdirSync(dirname(workingPath), {recursive: true});
    writeFileSync(originalPath, bytes);
    const {
        captureWorkingCopyAdmissionSnapshot,
        setWorkingCopyOriginalPath,
    } = await import('@electron/file-access/workingCopyStore');
    const admissionSnapshot = await captureWorkingCopyAdmissionSnapshot(originalPath);
    await setWorkingCopyOriginalPath(workingPath, originalPath, 7, {
        admissionSnapshot,
        backingState: 'lazy-original',
        deferOriginalFileExpectation: true,
    });
    return {
        admissionSnapshot,
        bytes,
        originalPath,
        workingPath,
    };
}

function materializingArtifacts(workingPath: string) {
    const prefix = `${workingPath.split('/').at(-1)}.materializing-`;
    return readdirSync(dirname(workingPath)).filter(name => name.startsWith(prefix));
}
