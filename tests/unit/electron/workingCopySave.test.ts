import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';
import type * as TViMockOriginalModule2 from '@electron/file-access/isAllowedOriginalSavePath';
import type * as TViMockOriginalModule3 from '@electron/pdf/nativeToolPaths';
import type * as TViMockOriginalModule4 from '@electron/file-access/documentFileWriteAtomic';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import {execFile} from 'node:child_process';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'fs';
import {
    readFile,
    rename,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {promisify} from 'node:util';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const execFileAsync = promisify(execFile);

const mocks = vi.hoisted(() => ({
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    atomicReplace: vi.fn(async (
        sourcePath: string,
        targetPath: string,
        options?: {assertDestinationCurrent?: () => Promise<void>},
    ) => {
        await options?.assertDestinationCurrent?.();
        await rename(sourcePath, targetPath);
    }),
    validatePdfFile: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    getWorkingCopyOriginalFileExpectation: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    isAllowedOriginalSavePath: vi.fn(),
    getPdfNativeToolPaths: vi.fn(),
    runNativeToolCommand: vi.fn(),
    optimizeLargePdfForOrdinarySave: vi.fn(),
    optimizePdfForSave: vi.fn(),
    copyFileCopyOnWrite: vi.fn(),
    copyFileAtomic: vi.fn(),
    assertWorkingCopyMutationAllowed: vi.fn(),
    assertWorkingCopyResyncAllowed: vi.fn(),
    assertWorkingCopyRevisionCurrent: vi.fn(),
    awaitWorkingCopyRevisionDurability: vi.fn(),
    markWorkingCopySyncRequired: vi.fn(),
    clearWorkingCopySyncRequired: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    transitionWorkingCopyContentRevision: vi.fn(),
    ensureWorkingCopyMaterialized: vi.fn(),
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: Parameters<typeof mocks.atomicReplace>) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args)}));
vi.mock('@electron/features/documents/main/pdfSaveAsOptimization', () => ({
    optimizeLargePdfForOrdinarySave: (...args: unknown[]) => mocks.optimizeLargePdfForOrdinarySave(...args),
    optimizePdfForSave: (...args: unknown[]) => mocks.optimizePdfForSave(...args),
}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.getWorkingCopyOriginalFileExpectation(...args),
    getWorkingCopyOriginalPath: (...args: unknown[]) => mocks.getWorkingCopyOriginalPath(...args),
    normalizePathForLookup: (path: string) => path.trim(),
    refreshWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.refreshWorkingCopyOriginalFileExpectation(...args),
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyMutationAllowed: (...args: unknown[]) => mocks.assertWorkingCopyMutationAllowed(...args),
    assertWorkingCopyResyncAllowed: (...args: unknown[]) => mocks.assertWorkingCopyResyncAllowed(...args),
    assertWorkingCopyRevisionCurrent: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
    awaitWorkingCopyRevisionDurability: (...args: unknown[]) => mocks.awaitWorkingCopyRevisionDurability(...args),
    clearWorkingCopySyncRequired: (...args: unknown[]) => mocks.clearWorkingCopySyncRequired(...args),
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    markWorkingCopySyncRequired: (...args: unknown[]) => mocks.markWorkingCopySyncRequired(...args),
    transitionWorkingCopyContentRevision: (...args: unknown[]) => mocks.transitionWorkingCopyContentRevision(...args),
}));
vi.mock('@electron/file-access/isAllowedOriginalSavePath', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    isAllowedOriginalSavePath: (...args: unknown[]) => mocks.isAllowedOriginalSavePath(...args),
}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({
    attemptWorkingCopyClone: async (...args: [string, string]) => {
        await mocks.copyFileCopyOnWrite(...args);
        return 'cloned';
    },
    copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args),
}));
vi.mock('@electron/file-access/documentFileWriteAtomic', async importOriginal => ({
    ...(await importOriginal<typeof TViMockOriginalModule4>()),
    copyFileAtomic: (...args: [string, string]) => mocks.copyFileAtomic(...args),
}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal_2) => ({
    ...(await importOriginal_2<typeof TViMockOriginalModule3>()),
    getPdfNativeToolPaths: (...args: unknown[]) => mocks.getPdfNativeToolPaths(...args),
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => {
    class WorkingCopyMaterializationError extends Error {
        readonly code: string;
        readonly retryable: boolean;

        constructor(code: string, message: string, options: {retryable?: boolean} = {}) {
            super(message);
            this.name = 'WorkingCopyMaterializationError';
            this.code = code;
            this.retryable = options.retryable ?? false;
        }
    }
    return {
        ensureWorkingCopyMaterialized: (...args: unknown[]) => mocks.ensureWorkingCopyMaterialized(...args),
        WorkingCopyMaterializationError,
    };
});

function createOriginalFileExpectationForTest(originalPath: string) {
    const originalStat = statSync(originalPath, {bigint: true});
    return {
        ctimeNs: originalStat.ctimeNs.toString(),
        deviceId: originalStat.dev.toString(),
        inode: originalStat.ino.toString(),
        mtimeMs: Number(originalStat.mtimeNs) / 1_000_000,
        mtimeNs: originalStat.mtimeNs.toString(),
        size: Number(originalStat.size),
    };
}

describe('workingCopySave', () => {
    let tempRoot = '';
    const context = {senderId: 42};
    const revisionOptions = {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-save')};

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-working-copy-save-test-'));
        mocks.validatePdfFile.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.ensureWorkingCopyMaterialized.mockImplementation(async (path: string) => ({
            logicalRef: path,
            physicalWorkingCopyPath: path,
            sourceFingerprint: '',
        }));
        mocks.getWorkingCopyOriginalFileExpectation.mockImplementation((workingPath: string, senderWebContentsId?: number) => {
            const original = mocks.getWorkingCopyOriginalPath(workingPath, senderWebContentsId);
            return original?.originalPath
                ? createOriginalFileExpectationForTest(original.originalPath)
                : null;
        });
        mocks.isAllowedOriginalSavePath.mockReturnValue(true);
        mocks.getPdfNativeToolPaths.mockReturnValue({qpdf: '/mock/qpdf'});
        mocks.runNativeToolCommand.mockResolvedValue({
            code: 0,
            signal: null,
            stdout: '',
            stderr: '',
        });
        mocks.optimizeLargePdfForOrdinarySave.mockResolvedValue(null);
        mocks.optimizePdfForSave.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.assertWorkingCopyMutationAllowed.mockResolvedValue(undefined);
        mocks.assertWorkingCopyResyncAllowed.mockReturnValue(undefined);
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.awaitWorkingCopyRevisionDurability.mockResolvedValue(undefined);
        mocks.refreshWorkingCopyOriginalFileExpectation.mockResolvedValue(true);
        mocks.clearWorkingCopySyncRequired.mockReturnValue(true);
        mocks.markWorkingCopyContentChanged.mockResolvedValue({});
        mocks.transitionWorkingCopyContentRevision.mockImplementation(async (
            workingCopyPath: string,
            reason: string,
            commit: (revision: unknown) => Promise<void>,
        ) => {
            const previousBytes = await readFile(workingCopyPath);
            const revision = {
                token: requireDocumentRevisionToken('revision-after-save'),
                version: 1,
                documentRef: workingCopyPath,
                authority: 'electron-working-copy',
                contentRevision: 2,
                mintedAt: Date.now(),
                reason,
            };
            try {
                await commit(revision);
            } catch (error) {
                await writeFile(workingCopyPath, previousBytes);
                throw error;
            }
            return revision;
        });
        mocks.copyFileCopyOnWrite.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
        });
        mocks.copyFileAtomic.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
        });
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('routes working-copy save through the shared mutation queue before reading the working file', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        writeFileSync(workingPath, 'new-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const queuedMutation = deferred<undefined>();
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockingMutation = enqueueWorkingCopyMutation(workingPath, () => queuedMutation.promise);
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');

        const savePromise = handleFileSaveStructured(context, workingPath, revisionOptions);
        await waitForSettledQueueTurn();

        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();

        queuedMutation.resolve(undefined);
        await blockingMutation;
        await expect(savePromise).resolves.toMatchObject({
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: true,
        });
        expect(readFileSyncUtf8(originalPath)).toBe('new-working');
        expect(mocks.optimizeLargePdfForOrdinarySave).toHaveBeenCalledWith(`${originalPath}.tmp`);
        expect(mocks.atomicReplace).toHaveBeenCalledWith(
            `${originalPath}.tmp`,
            originalPath,
            expect.objectContaining({assertDestinationCurrent: expect.any(Function)}),
        );
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.atomicReplace.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.refreshWorkingCopyOriginalFileExpectation.mock.invocationCallOrder[0]!);
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('resolves the original mapping when a queued save starts executing', async () => {
        const workingPath = join(tempRoot, 'remapped-working.pdf');
        const firstOriginalPath = join(tempRoot, 'remapped-first-original.pdf');
        const secondOriginalPath = join(tempRoot, 'remapped-second-original.pdf');
        writeFileSync(workingPath, 'queued-working');
        writeFileSync(firstOriginalPath, 'first-original');
        writeFileSync(secondOriginalPath, 'second-original');
        let currentOriginalPath = firstOriginalPath;
        mocks.getWorkingCopyOriginalPath.mockImplementation(() => ({originalPath: currentOriginalPath}));
        const queuedMutation = deferred<undefined>();
        const {enqueueWorkingCopyMutation} = await import('@electron/file-access/workingCopyMutationQueue');
        const blockingMutation = enqueueWorkingCopyMutation(workingPath, () => queuedMutation.promise);
        const {handleFileSaveStructured} = await import('@electron/features/documents/main/workingCopySave');

        const savePromise = handleFileSaveStructured(context, workingPath, revisionOptions);
        await waitForSettledQueueTurn();
        currentOriginalPath = secondOriginalPath;
        queuedMutation.resolve(undefined);
        await blockingMutation;

        await expect(savePromise).resolves.toMatchObject({
            ok: true,
            externalWriteCommitted: true,
        });
        expect(readFileSyncUtf8(firstOriginalPath)).toBe('first-original');
        expect(readFileSyncUtf8(secondOriginalPath)).toBe('queued-working');
    });

    it('returns a structured success result for working-copy saves', async () => {
        const workingPath = join(tempRoot, 'structured-working.pdf');
        const originalPath = join(tempRoot, 'structured-original.pdf');
        writeFileSync(workingPath, 'new-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleFileSaveStructured(context, workingPath, revisionOptions))
            .resolves
            .toMatchObject({
                ok: true,
                externalWriteCommitted: true,
                workingCopyRefreshed: true,
                validation: {isValid: true},
            });
        expect(readFileSyncUtf8(originalPath)).toBe('new-working');
    });

    it('returns a typed stale conflict without overwriting a same-size external replacement', async () => {
        const initialBytes = 'original-version';
        const externalBytes = 'external-version';
        expect(Buffer.byteLength(externalBytes)).toBe(Buffer.byteLength(initialBytes));
        const workingPath = join(tempRoot, 'external-conflict-working.pdf');
        const originalPath = join(tempRoot, 'external-conflict-original.pdf');
        writeFileSync(workingPath, 'renderer-version');
        writeFileSync(originalPath, initialBytes);
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const publicationPaused = deferred<undefined>();
        const releasePublication = deferred<undefined>();
        mocks.atomicReplace.mockImplementationOnce(async (
            _sourcePath: string,
            _targetPath: string,
            options?: {assertDestinationCurrent?: () => Promise<void>},
        ) => {
            publicationPaused.resolve(undefined);
            await releasePublication.promise;
            await options?.assertDestinationCurrent?.();
        });
        const {handleFileSaveStructured} = await import('@electron/features/documents/main/workingCopySave');

        const save = handleFileSaveStructured(context, workingPath, revisionOptions);
        await publicationPaused.promise;
        await execFileAsync(process.execPath, [
            '-e',
            'const fs = require(\'node:fs/promises\'); const [target, bytes] = process.argv.slice(1); const replacement = `${target}.external`; fs.writeFile(replacement, bytes).then(() => fs.rename(replacement, target));',
            originalPath,
            externalBytes,
        ]);
        releasePublication.resolve(undefined);

        await expect(save).resolves.toMatchObject({
            ok: false,
            reason: 'stale',
            externalWriteCommitted: false,
            validation: {errors: [expect.stringContaining('Original file changed on disk')]},
        });
        expect(readFileSyncUtf8(originalPath)).toBe(externalBytes);
        expect(readFileSyncUtf8(workingPath)).toBe('renderer-version');
    });

    it('copies optimized structured save bytes back to the working copy after the original write commits', async () => {
        const workingPath = join(tempRoot, 'structured-optimized-working.pdf');
        const originalPath = join(tempRoot, 'structured-optimized-original.pdf');
        writeFileSync(workingPath, 'unoptimized-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.optimizeLargePdfForOrdinarySave.mockImplementationOnce(async (tempPath: string) => {
            writeFileSync(tempPath, 'optimized-pdf');
            return {
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            };
        });
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleFileSaveStructured(context, workingPath, revisionOptions))
            .resolves
            .toMatchObject({
                ok: true,
                externalWriteCommitted: true,
                workingCopyRefreshed: true,
            });

        expect(readFileSyncUtf8(originalPath)).toBe('optimized-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('optimized-pdf');
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('returns structured failure when original refresh fails after save', async () => {
        const workingPath = join(tempRoot, 'refresh-fail-working.pdf');
        const originalPath = join(tempRoot, 'refresh-fail-original.pdf');
        writeFileSync(workingPath, 'new-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.refreshWorkingCopyOriginalFileExpectation.mockImplementationOnce(() => {
            throw new Error('refresh failed');
        });
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleFileSaveStructured(context, workingPath, revisionOptions))
            .resolves
            .toMatchObject({
                ok: false,
                reason: 'write-failed',
                message: 'refresh failed',
                externalWriteCommitted: false,
                validation: null,
            });
        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
    });

    it('propagates a typed materialization failure without staging or publishing save bytes', async () => {
        const workingPath = join(tempRoot, 'lazy-working.pdf');
        const originalPath = join(tempRoot, 'lazy-original.pdf');
        writeFileSync(originalPath, 'original-before-failed-materialization');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const {WorkingCopyMaterializationError} = await import(
            '@electron/file-access/workingCopyMaterialization'
        );
        const failure = new WorkingCopyMaterializationError(
            'SOURCE_BACKING_UNAVAILABLE',
            'The original document is unavailable',
        );
        mocks.ensureWorkingCopyMaterialized.mockRejectedValue(failure);
        const {handleFileSaveStructured} = await import(
            '@electron/features/documents/main/workingCopySave'
        );

        await expect(handleFileSaveStructured(context, workingPath, revisionOptions))
            .rejects.toBe(failure);

        expect(mocks.makeSiblingTempPath).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(readFileSyncUtf8(originalPath)).toBe('original-before-failed-materialization');
    });

    it('resyncs from the latest original mapping even when normal mutations are sync-blocked', async () => {
        const workingPath = join(tempRoot, 'resync-working.pdf');
        const firstOriginalPath = join(tempRoot, 'resync-first-original.pdf');
        const secondOriginalPath = join(tempRoot, 'resync-second-original.pdf');
        writeFileSync(workingPath, 'stale-working');
        writeFileSync(firstOriginalPath, 'first-original');
        writeFileSync(secondOriginalPath, 'second-original');
        let currentOriginalPath = firstOriginalPath;
        mocks.getWorkingCopyOriginalPath.mockImplementation(() => ({originalPath: currentOriginalPath}));
        mocks.assertWorkingCopyMutationAllowed.mockImplementation(() => {
            throw new Error('working copy sync required');
        });
        const queuedMutation = deferred<undefined>();
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockingMutation = enqueueWorkingCopyMutation(workingPath, () => queuedMutation.promise);
        const { handleResyncWorkingCopy } = await import('@electron/features/documents/main/workingCopySave');

        const resyncPromise = handleResyncWorkingCopy(context, workingPath);
        await waitForSettledQueueTurn();
        currentOriginalPath = secondOriginalPath;
        queuedMutation.resolve(undefined);
        await blockingMutation;

        await expect(resyncPromise).resolves.toMatchObject({
            ok: true,
            externalWriteCommitted: false,
            workingCopyRefreshed: true,
        });
        expect(readFileSyncUtf8(workingPath)).toBe('second-original');
        expect(mocks.assertWorkingCopyMutationAllowed).not.toHaveBeenCalled();
        expect(mocks.assertWorkingCopyResyncAllowed).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.clearWorkingCopySyncRequired).toHaveBeenCalledWith(workingPath);
        expect(mocks.markWorkingCopyContentChanged).not.toHaveBeenCalled();
    });

    it('keeps resync blocked when the target is replaced during copy-back', async () => {
        const workingPath = join(tempRoot, 'resync-race-working.pdf');
        const originalPath = join(tempRoot, 'resync-race-original.pdf');
        const externalPath = join(tempRoot, 'resync-race-external.pdf');
        writeFileSync(workingPath, 'stale-working');
        writeFileSync(originalPath, 'original-before-race');
        writeFileSync(externalPath, 'external-replacement');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.copyFileAtomic.mockImplementationOnce(async (sourcePath: string, targetPath: string) => {
            await rename(externalPath, originalPath);
            await writeFile(targetPath, await readFile(sourcePath));
        });

        const {handleResyncWorkingCopy} = await import('@electron/features/documents/main/workingCopySave');
        await expect(handleResyncWorkingCopy(context, workingPath)).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            externalWriteCommitted: false,
        });
        expect(readFileSyncUtf8(originalPath)).toBe('external-replacement');
        expect(readFileSyncUtf8(workingPath)).toBe('stale-working');
        expect(mocks.clearWorkingCopySyncRequired).not.toHaveBeenCalled();
    });

    it('repairs through qpdf before atomically replacing the original and working copy', async () => {
        const workingPath = join(tempRoot, 'repair-working.pdf');
        const originalPath = join(tempRoot, 'repair-original.pdf');
        writeFileSync(workingPath, 'damaged-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.runNativeToolCommand.mockImplementationOnce(async (_qpdf: string, args: string[]) => {
            await writeFile(args[1] ?? '', 'repaired-pdf');
            return {
                code: 0,
                signal: null,
                stdout: '',
                stderr: '',
            };
        });
        const { handleRepairPdfSave } = await import('@electron/features/documents/main/workingCopySave');

        await expect(handleRepairPdfSave(context, workingPath, revisionOptions)).resolves.toMatchObject({isValid: true});

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith('/mock/qpdf', [
            workingPath,
            `${originalPath}.tmp`,
        ], expect.objectContaining({
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(repair-save)',
        }));
        expect(readFileSyncUtf8(originalPath)).toBe('repaired-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('repaired-pdf');
        expect(mocks.optimizeLargePdfForOrdinarySave).toHaveBeenCalledWith(`${originalPath}.tmp`);
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('optimizes the current PDF for interaction through qpdf before replacing the original', async () => {
        const workingPath = join(tempRoot, 'optimize-working.pdf');
        const originalPath = join(tempRoot, 'optimize-original.pdf');
        writeFileSync(workingPath, 'working-pdf');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const { handleOptimizePdfForInteraction } =
            await import('@electron/features/documents/main/workingCopySave');

        await expect(handleOptimizePdfForInteraction(context, workingPath, revisionOptions)).resolves.toMatchObject({isValid: true});

        expect(mocks.optimizePdfForSave).toHaveBeenCalledWith(`${originalPath}.tmp`, {
            force: true,
            label: 'qpdf(optimize-current-pdf)',
        });
        expect(readFileSyncUtf8(originalPath)).toBe('working-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('working-pdf');
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

});

function readFileSyncUtf8(path: string) {
    return readFileSync(path, 'utf8');
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

async function waitForSettledQueueTurn() {
    await delay(20);
}
