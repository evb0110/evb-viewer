import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';
import type * as TViMockOriginalModule2 from '@electron/file-access/isAllowedOriginalSavePath';
import type * as TViMockOriginalModule3 from '@electron/file-access/documentFileWriteAtomic';

import { EventEmitter } from 'node:events';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'fs';
import {
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStaleRevisionError } from '@contracts/documentMutationErrors';
import { createPdfPersistenceErrorFrame } from '@contracts/documentPersistenceFrames';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {
    isTypedStagedArtifact,
    type ITypedStagedArtifact,
} from '@contracts/stagedArtifacts';
import type * as SerializedPdfPersistenceModule from '@electron/features/documents/main/serializedPdfPersistence';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {waitForCondition} from '@tests/unit/electron/waitForCondition';

type TSerializedPdfPersistenceModule = typeof SerializedPdfPersistenceModule;

interface IInvocationOrderMock { mock: { invocationCallOrder: number[] }; }

const SERIALIZED_TEST_REVISION_OPTIONS = { expectedDocumentRevisionToken: requireDocumentRevisionToken('drt1:test:base') };

const mocks = vi.hoisted(() => ({
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    validatePdfFile: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    getWorkingCopyOriginalFileExpectation: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn<(workingPath: string, senderWebContentsId?: number) => { originalPath: string } | null>(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    setWorkingCopyOriginalPath: vi.fn<(workingPath: string, originalPath: string, senderId?: number) => void>(),
    allowOpenPath: vi.fn(),
    addRecentFile: vi.fn(),
    updateRecentFilesMenu: vi.fn(),
    assertWorkingCopyRevisionCurrent: vi.fn(),
    assertWorkingCopyMutationAllowed: vi.fn(),
    assertWorkingCopyResyncAllowed: vi.fn(),
    getWorkingCopyRevision: vi.fn(),
    markWorkingCopySyncRequired: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    transitionWorkingCopyContentRevision: vi.fn(),
    optimizePdfForSaveAs: vi.fn(),
    optimizeLargePdfForOrdinarySave: vi.fn(),
    copyFileCopyOnWrite: vi.fn(),
    transitionOriginalAndWorkingCopyRevision: vi.fn(),
    createTypedStagedArtifact: vi.fn(),
    createTypedStagedArtifactForTrustedSiblingCopy: vi.fn(),
    releaseManagedTempFileHandle: vi.fn(),
    removeAllowedOpenPath: vi.fn(),
    ensureWorkingCopyMaterialized: vi.fn(),
}));

vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/file-access/documentFileWriteAtomic', async importOriginal => ({
    ...(await importOriginal<typeof TViMockOriginalModule3>()),
    copyFileAtomic: (sourcePath: string, targetPath: string) => mocks.copyFileCopyOnWrite(sourcePath, targetPath),
}));
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args)}));
vi.mock('@electron/features/documents/main/pdfSaveAsOptimization', () => ({
    optimizePdfForSaveAs: (...args: unknown[]) => mocks.optimizePdfForSaveAs(...args),
    optimizeLargePdfForOrdinarySave: (...args: unknown[]) => mocks.optimizeLargePdfForOrdinarySave(...args),
}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.getWorkingCopyOriginalFileExpectation(...args),
    getWorkingCopyOriginalPath: (...args: [string, number?]) => mocks.getWorkingCopyOriginalPath(...args),
    normalizePathForLookup: (path: string) => path.trim(),
    refreshWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.refreshWorkingCopyOriginalFileExpectation(...args),
    setWorkingCopyOriginalPath: (...args: [string, string, number?]) => mocks.setWorkingCopyOriginalPath(...args),
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyMutationAllowed: (...args: unknown[]) => mocks.assertWorkingCopyMutationAllowed(...args),
    assertWorkingCopyResyncAllowed: (...args: unknown[]) => mocks.assertWorkingCopyResyncAllowed(...args),
    assertWorkingCopyRevisionCurrent: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
    getWorkingCopyRevision: (...args: unknown[]) => mocks.getWorkingCopyRevision(...args),
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    transitionWorkingCopyContentRevision: (...args: unknown[]) => mocks.transitionWorkingCopyContentRevision(...args),
    markWorkingCopySyncRequired: (...args: unknown[]) => mocks.markWorkingCopySyncRequired(...args),
}));
vi.mock('@electron/file-access/isAllowedOriginalSavePath', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    isAllowedOriginalSavePath: vi.fn(() => true),
}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args)}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args),
    removeAllowedOpenPath: (...args: unknown[]) => mocks.removeAllowedOpenPath(...args),
}));
vi.mock('@electron/recentFiles', () => ({addRecentFile: (...args: unknown[]) => mocks.addRecentFile(...args)}));
vi.mock('@electron/menu', () => ({updateRecentFilesMenu: (...args: unknown[]) => mocks.updateRecentFilesMenu(...args)}));
vi.mock('@electron/features/documents/main/commitPdfTempFile', () => ({commitPdfTempFile: (...args: [string, string]) => mocks.atomicReplace(...args)}));
vi.mock('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision', () => ({transitionOriginalAndWorkingCopyRevision: (...args: unknown[]) => mocks.transitionOriginalAndWorkingCopyRevision(...args)}));
vi.mock('@electron/features/documents/main/managedTempFileHandles', () => ({
    createTypedStagedArtifact: (...args: unknown[]) => mocks.createTypedStagedArtifact(...args),
    createTypedStagedArtifactForTrustedSiblingCopy: (...args: unknown[]) =>
        mocks.createTypedStagedArtifactForTrustedSiblingCopy(...args),
    releaseManagedTempFileHandle: (...args: unknown[]) => mocks.releaseManagedTempFileHandle(...args),
}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({ensureWorkingCopyMaterialized: (...args: unknown[]) => mocks.ensureWorkingCopyMaterialized(...args)}));

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

async function importSerializedPdfPersistence(): Promise<TSerializedPdfPersistenceModule> {
    return import('@electron/features/documents/main/serializedPdfPersistence');
}

class FakeSender extends EventEmitter {
    constructor(readonly id = 42) {
        super();
    }
}

function createInvokeEvent(sender: FakeSender) {
    return {
        sender,
        senderId: sender.id,
    } as never;
}

function createPortEvent(sender: FakeSender, port: FakeMessagePort) {
    return {
        sender,
        ports: [port],
    } as never;
}

function firstInvocationOrder(mock: IInvocationOrderMock) {
    const order = mock.mock.invocationCallOrder[0];
    if (order === undefined) {
        throw new Error('Expected mock to have been invoked');
    }
    return order;
}

describe('serializedPdfPersistence', () => {
    let tempRoot = '';

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-serialized-pdf-persistence-test-'));
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
        mocks.optimizePdfForSaveAs.mockResolvedValue(null);
        mocks.optimizeLargePdfForOrdinarySave.mockResolvedValue(null);
        mocks.assertWorkingCopyMutationAllowed.mockResolvedValue(undefined);
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.refreshWorkingCopyOriginalFileExpectation.mockResolvedValue(true);
        mocks.getWorkingCopyRevision.mockImplementation(async (workingPath: string) => ({
            version: 1,
            documentRef: requireDocumentRef(workingPath),
            authority: 'electron-working-copy',
            token: requireDocumentRevisionToken('drt1:test:main-base'),
            contentRevision: 1,
            mintedAt: 1,
        }));
        mocks.markWorkingCopyContentChanged.mockResolvedValue(undefined);
        mocks.transitionWorkingCopyContentRevision.mockImplementation(async (
            _workingCopyPath: string,
            _reason: string,
            commit: (revision: {token: TDocumentRevisionToken}) => Promise<void>,
        ) => {
            await commit({token: requireDocumentRevisionToken('drt1:test:working-copy-committed')});
            return {token: requireDocumentRevisionToken('drt1:test:working-copy-committed')};
        });
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
            await unlink(sourcePath);
        });
        mocks.copyFileCopyOnWrite.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
        });
        mocks.transitionOriginalAndWorkingCopyRevision.mockImplementation(async (input: {
            workingCopyPath: string;
            originalPath: string;
            captureOriginalWitness?: () => Promise<{
                assertCurrent: () => Promise<void>;
                close: () => Promise<void>;
            } | null>;
            publishOriginal: (assertDestinationCurrent?: () => Promise<void>) => Promise<void>;
            afterOriginalPublish?: () => Promise<void>;
            syncWorkingCopy?: () => Promise<void>;
            afterWorkingCopySync?: () => Promise<void>;
            onWorkingCopySyncFailure?: (error: unknown) => Promise<boolean> | boolean;
            preservePublishedOriginalOnWorkingCopySyncFailure?: boolean;
        }) => {
            const witness = await input.captureOriginalWitness?.() ?? null;
            if (input.captureOriginalWitness && !witness && !input.preservePublishedOriginalOnWorkingCopySyncFailure) {
                return null;
            }
            const originalBefore = existsSync(input.originalPath)
                ? await readFile(input.originalPath)
                : null;
            const workingBefore = existsSync(input.workingCopyPath)
                ? await readFile(input.workingCopyPath)
                : null;
            let published = false;
            try {
                await input.publishOriginal(witness ? () => witness.assertCurrent() : undefined);
                published = true;
                await input.afterOriginalPublish?.();
                if (input.syncWorkingCopy) {
                    await input.syncWorkingCopy();
                } else {
                    await mocks.copyFileCopyOnWrite(input.originalPath, input.workingCopyPath);
                }
                await input.afterWorkingCopySync?.();
            } catch (error) {
                if (published && input.preservePublishedOriginalOnWorkingCopySyncFailure) {
                    await input.onWorkingCopySyncFailure?.(error);
                    return {
                        targetWriteCommitted: true,
                        workingCopyRefreshed: false,
                        workingCopySyncError: error instanceof Error ? error.message : String(error),
                    };
                }
                const restoreOriginal = originalBefore === null
                    ? unlink(input.originalPath).catch(() => undefined)
                    : writeFile(input.originalPath, originalBefore);
                await Promise.all([
                    restoreOriginal,
                    ...(workingBefore === null ? [] : [writeFile(input.workingCopyPath, workingBefore)]),
                ]);
                throw error;
            } finally {
                await witness?.close();
            }
            return {token: requireDocumentRevisionToken('drt1:test:committed')};
        });
        mocks.createTypedStagedArtifact.mockImplementation(async (
            _context: unknown,
            path: string,
            validations: {
                qpdfResult?: {
                    isValid: boolean;
                    tool: 'qpdf';
                    errors: string[];
                    warnings: string[];
                };
                qpdfCheck: boolean;
                tailCheck: boolean;
                semanticCheck: boolean;
                fsynced: boolean;
            },
            options: {trustedFingerprint?: {
                bytes: number;
                sha256: string;
            };},
        ) => ({
            receiptVersion: 1,
            artifactKind: 'pdf',
            path,
            size: options.trustedFingerprint?.bytes ?? statSync(path).size,
            sha256: options.trustedFingerprint?.sha256 ?? 'a'.repeat(64),
            fileIdentity: {
                platform: 'posix',
                deviceId: '1',
                inode: '2',
            },
            validations,
            leaseId: `lease:${path}`,
            revision: null,
        }));
        mocks.createTypedStagedArtifactForTrustedSiblingCopy.mockImplementation(async (
            _context: unknown,
            sourceArtifact: {
                size: number;
                sha256: string;
            },
            path: string,
            _originalPath: string,
            validations: Record<string, unknown>,
        ) => ({
            ...sourceArtifact,
            path,
            validations,
            leaseId: `lease:${path}`,
        }));
        mocks.releaseManagedTempFileHandle.mockReturnValue(true);
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('updates the Save As working copy after replacing the selected target', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp.pdf`;
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');

        const result = await runSaveAsSession({
            workingPath,
            targetPath,
            bytes: Buffer.from('new-pdf'),
            serializedSaveOptions: {
                ...SERIALIZED_TEST_REVISION_OPTIONS,
                changedObjectRefs: ['12 0 R'],
            },
        });

        expect(result).toMatchObject({
            type: 'result',
            path: targetPath,
            validation: { isValid: true },
        });
        expect(readFileSyncUtf8(workingPath)).toBe('new-pdf');
        expect(readFileSyncUtf8(targetPath)).toBe('new-pdf');
        expect(existsSync(tempPath)).toBe(false);
        expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledWith(workingPath, {
            ownerWebContentsId: 42,
            reason: 'serialized-persistence',
        });
        expect(mocks.createTypedStagedArtifact).toHaveBeenCalledWith(
            {senderId: 42},
            tempPath,
            expect.objectContaining({
                qpdfCheck: true,
                fsynced: true,
            }),
            expect.objectContaining({
                cleanupOnRelease: true,
                trustedFingerprint: {
                    bytes: 7,
                    sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
                },
            }),
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith(
            tempPath,
            targetPath,
            expect.objectContaining({
                receipt: {
                    artifact: expect.objectContaining({
                        path: tempPath,
                        leaseId: `lease:${tempPath}`,
                    }),
                    context: {senderId: 42},
                },
                changedObjectRefs: ['12 0 R'],
            }),
        );
        expect(
            firstInvocationOrder(mocks.ensureWorkingCopyMaterialized),
        ).toBeLessThan(firstInvocationOrder(mocks.makeSiblingTempPath));
        expect(
            firstInvocationOrder(mocks.ensureWorkingCopyMaterialized),
        ).toBeLessThan(firstInvocationOrder(mocks.atomicReplace));
        expect(mocks.setWorkingCopyOriginalPath).toHaveBeenCalledWith(workingPath, targetPath, 42);
        expect(mocks.allowOpenPath).toHaveBeenCalledWith(targetPath, expect.objectContaining({ id: 42 }));
        expect(mocks.addRecentFile).toHaveBeenCalledWith(targetPath);
        expect(mocks.updateRecentFilesMenu).toHaveBeenCalled();
    });

    it('deletes a staged Save As artifact without publishing when verification is canceled', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp.pdf`;
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
            cancelStagedSerializedPdf,
        } = await importSerializedPdfPersistence();
        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            7,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);
        const resultPromise = port.nextResult();

        port.emit('message', {data: {
            type: 'chunk',
            seq: 0,
            bytes: Buffer.from('new-pdf'),
        }});
        await port.nextMessage(message => isPortMessage(message, 'ack'));
        port.emit('message', {data: {type: 'complete'}});
        const stagedResult = await resultPromise;
        if (!isStagedPortMessage(stagedResult)) {
            throw new Error('Expected staged serialized PDF result');
        }

        expect(readFileSyncUtf8(targetPath)).toBe('old-target');
        expect(readFileSyncUtf8(tempPath)).toBe('new-pdf');
        await expect(cancelStagedSerializedPdf(
            {senderId: sender.id},
            stagedResult.sessionId,
            stagedResult.stagedOutput,
        )).resolves.toBe(true);
        expect(readFileSyncUtf8(targetPath)).toBe('old-target');
        expect(existsSync(tempPath)).toBe(false);
        expect(mocks.releaseManagedTempFileHandle)
            .toHaveBeenCalledWith({senderId: sender.id}, stagedResult.stagedOutput.leaseId);
        expect(mocks.removeAllowedOpenPath).toHaveBeenCalledWith(tempPath);
    });

    it('runs lossless optimization for streamed Save As before replacing the selected target', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp.pdf`;
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');
        mocks.optimizePdfForSaveAs.mockResolvedValueOnce({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: ['optimized'],
        });

        const result = await runSaveAsSession({
            workingPath,
            targetPath,
            bytes: Buffer.from('new-pdf'),
            options: { optimizeLossless: true },
        });

        expect(result).toMatchObject({
            type: 'result',
            path: targetPath,
            validation: { isValid: true },
        });
        expect(mocks.optimizePdfForSaveAs).toHaveBeenCalledWith(tempPath, { optimizeLossless: true });
        expect(mocks.createTypedStagedArtifact).toHaveBeenCalledWith(
            {senderId: 42},
            tempPath,
            expect.objectContaining({
                qpdfCheck: true,
                qpdfResult: expect.objectContaining({warnings: ['optimized']}),
            }),
            {cleanupOnRelease: true},
        );
        expect(
            firstInvocationOrder(mocks.optimizePdfForSaveAs),
        ).toBeLessThan(firstInvocationOrder(mocks.atomicReplace));
    });

    it('preserves the Save As working copy when target replacement fails', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');
        mocks.atomicReplace.mockRejectedValueOnce(new Error('replace failed'));

        const result = await runSaveAsSession({
            workingPath,
            targetPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'error',
            error: 'replace failed',
        });
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(readFileSyncUtf8(targetPath)).toBe('old-target');
        expect(mocks.setWorkingCopyOriginalPath).not.toHaveBeenCalled();
        expect(mocks.allowOpenPath).toHaveBeenCalledWith(
            `${targetPath}.tmp.pdf`,
            expect.objectContaining({id: 42}),
        );
        expect(mocks.addRecentFile).not.toHaveBeenCalled();
        expect(mocks.updateRecentFilesMenu).not.toHaveBeenCalled();
    });

    it('allows serialized PDF streams above the single IPC write budget', async () => {
        const workingPath = join(tempRoot, 'large-working.pdf');
        const targetPath = join(tempRoot, 'large-saved.pdf');
        const tempPath = `${targetPath}.tmp.pdf`;
        const sender = new FakeSender();
        const {
            beginSerializedPdfSaveAs,
            shutdownSerializedPdfPersistence,
        } = await importSerializedPdfPersistence();

        const result = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            (512 * 1024 * 1024) + 1,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );

        expect(result).toMatchObject({
            sessionId: expect.any(String),
            path: targetPath,
        });
        expect(existsSync(tempPath)).toBe(true);

        sender.emit('destroyed');
        await shutdownSerializedPdfPersistence();
        expect(existsSync(tempPath)).toBe(false);
    });

    it('allows serialized PDF streams above the former 16 GiB product cap', async () => {
        const workingPath = join(tempRoot, 'xlarge-working.pdf');
        const targetPath = join(tempRoot, 'xlarge-saved.pdf');
        const sender = new FakeSender();
        const {
            beginSerializedPdfSaveAs,
            shutdownSerializedPdfPersistence,
        } = await importSerializedPdfPersistence();

        const result = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            (16 * 1024 * 1024 * 1024) + 1,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );

        expect(result).toMatchObject({
            sessionId: expect.any(String),
            maxTotalBytes: Number.MAX_SAFE_INTEGER,
            path: targetPath,
        });
        sender.emit('destroyed');
        await shutdownSerializedPdfPersistence();
        expect(existsSync(`${targetPath}.tmp.pdf`)).toBe(false);
    });

    it('rejects byte counts outside the protocol safe-integer range', async () => {
        const workingPath = join(tempRoot, 'invalid-size-working.pdf');
        const targetPath = join(tempRoot, 'invalid-size-saved.pdf');
        const sender = new FakeSender();
        const {beginSerializedPdfSaveAs} = await importSerializedPdfPersistence();

        await expect(beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            Number.MAX_SAFE_INTEGER + 1,
            targetPath,
        )).rejects.toThrow('Invalid total byte count');

        expect(mocks.makeSiblingTempPath).not.toHaveBeenCalled();
        expect(existsSync(`${targetPath}.tmp.pdf`)).toBe(false);
    });

    it('rejects Save to original when the original file changed before final replacement', async () => {
        const workingPath = join(tempRoot, 'working-save.pdf');
        const originalPath = join(tempRoot, 'original-save.pdf');
        writeFileSync(workingPath, 'old-original');
        writeFileSync(originalPath, 'external-change');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: 1,
            size: 12,
        });

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'result',
            path: null,
            validation: {
                isValid: false,
                errors: [expect.stringContaining('Original file changed on disk')],
            },
        });
        expect(readFileSyncUtf8(workingPath)).toBe('old-original');
        expect(readFileSyncUtf8(originalPath)).toBe('external-change');
        expect(mocks.optimizeLargePdfForOrdinarySave).toHaveBeenCalledWith(`${originalPath}.tmp.pdf`);
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
    });

    it('rejects Save to original when the working-copy revision changed before final replacement', async () => {
        const workingPath = join(tempRoot, 'working-stale-revision.pdf');
        const originalPath = join(tempRoot, 'original-stale-revision.pdf');
        writeFileSync(workingPath, 'newer-working-copy');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: requireDocumentRef(workingPath),
            expectedRevision: requireDocumentRevisionToken('drt1:test:base'),
            actualRevision: requireDocumentRevisionToken('drt1:test:newer'),
        }));

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('stale-serialized-pdf'),
            serializedSaveOptions: { expectedDocumentRevisionToken: requireDocumentRevisionToken('drt1:test:base') },
        });

        expect(result).toMatchObject({
            type: 'error',
            code: 'STALE_REVISION',
            phase: 'commit',
            retryable: true,
            expected: true,
        });
        expect(mocks.assertWorkingCopyRevisionCurrent).toHaveBeenCalledWith(workingPath, 'drt1:test:base');
        expect(readFileSyncUtf8(workingPath)).toBe('newer-working-copy');
        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
    });

    it('rejects Save As when the working-copy revision changed before target replacement', async () => {
        const workingPath = join(tempRoot, 'working-save-as-stale-revision.pdf');
        const targetPath = join(tempRoot, 'target-save-as-stale-revision.pdf');
        writeFileSync(workingPath, 'newer-working-copy');
        writeFileSync(targetPath, 'old-target');
        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(createStaleRevisionError({
            documentRef: requireDocumentRef(workingPath),
            expectedRevision: requireDocumentRevisionToken('drt1:test:save-as-base'),
            actualRevision: requireDocumentRevisionToken('drt1:test:newer-save-as'),
        }));

        const result = await runSaveAsSession({
            workingPath,
            targetPath,
            bytes: Buffer.from('stale-serialized-pdf'),
            serializedSaveOptions: { expectedDocumentRevisionToken: requireDocumentRevisionToken('drt1:test:save-as-base') },
        });

        expect(result).toMatchObject({
            type: 'error',
            code: 'STALE_REVISION',
            phase: 'commit',
            retryable: true,
            expected: true,
        });
        expect(mocks.assertWorkingCopyRevisionCurrent).toHaveBeenCalledWith(workingPath, 'drt1:test:save-as-base');
        expect(readFileSyncUtf8(workingPath)).toBe('newer-working-copy');
        expect(readFileSyncUtf8(targetPath)).toBe('old-target');
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.setWorkingCopyOriginalPath).not.toHaveBeenCalled();
    });

    it('rolls back streamed Save to original when working-copy synchronization fails', async () => {
        const workingPath = join(tempRoot, 'copyback-working.pdf');
        const originalPath = join(tempRoot, 'copyback-original.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.copyFileCopyOnWrite.mockRejectedValueOnce(new Error('copy-back failed'));

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'error',
            phase: 'commit',
        });
        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(mocks.optimizeLargePdfForOrdinarySave).toHaveBeenCalledWith(`${originalPath}.tmp.pdf`);
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
    });

    it('waits for an in-flight streamed commit during shutdown before cleanup', async () => {
        const workingPath = join(tempRoot, 'shutdown-working.pdf');
        const targetPath = join(tempRoot, 'shutdown-target.pdf');
        const replaceGate = deferred<undefined>();
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');
        mocks.atomicReplace.mockImplementationOnce(async (sourcePath: string, replaceTargetPath: string) => {
            await replaceGate.promise;
            await writeFile(replaceTargetPath, await readFile(sourcePath));
            await unlink(sourcePath);
        });
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
            commitStagedSerializedPdf,
            shutdownSerializedPdfPersistence,
        } = await importSerializedPdfPersistence();
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            Buffer.byteLength('new-pdf'),
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        const resultPromise = port.nextResult();

        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);
        port.emit('message', {data: {
            type: 'chunk',
            seq: 0,
            bytes: Buffer.from('new-pdf'),
        }});
        port.emit('message', {data: {type: 'complete'}});

        const stagedResult = await resultPromise;
        if (!isStagedPortMessage(stagedResult)) {
            throw new Error('Expected staged serialized PDF result');
        }
        const commitPromise = commitStagedSerializedPdf(
            {senderId: sender.id},
            stagedResult.sessionId,
            stagedResult.stagedOutput,
        );
        await waitForCondition(() => {
            expect(mocks.atomicReplace).toHaveBeenCalledOnce();
        });

        let shutdownSettled = false;
        const shutdownPromise = shutdownSerializedPdfPersistence().then(() => {
            shutdownSettled = true;
        });
        await waitForSettledQueueTurn();

        expect(shutdownSettled).toBe(false);
        expect(existsSync(`${targetPath}.tmp.pdf`)).toBe(true);

        replaceGate.resolve(undefined);
        await expect(commitPromise).resolves.toMatchObject({path: targetPath});
        await shutdownPromise;

        expect(shutdownSettled).toBe(true);
        expect(readFileSyncUtf8(targetPath)).toBe('new-pdf');
        expect(existsSync(`${targetPath}.tmp.pdf`)).toBe(false);
    });

    it('refreshes the original save base after streamed Save to original syncs the working copy', async () => {
        const workingPath = join(tempRoot, 'refresh-working.pdf');
        const originalPath = join(tempRoot, 'refresh-original.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'result',
            path: originalPath,
            validation: { isValid: true },
        });
        expect(readFileSyncUtf8(originalPath)).toBe('new-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('new-pdf');
        expect(mocks.optimizeLargePdfForOrdinarySave).toHaveBeenCalledWith(`${originalPath}.tmp.pdf`);
        expect(
            firstInvocationOrder(mocks.optimizeLargePdfForOrdinarySave),
        ).toBeLessThan(firstInvocationOrder(mocks.atomicReplace));
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(workingPath, 42);
        expect(firstInvocationOrder(mocks.copyFileCopyOnWrite))
            .toBeLessThan(firstInvocationOrder(mocks.refreshWorkingCopyOriginalFileExpectation));
    });

    it('resolves and rehomes a streamed original save when its queued mapping changes', async () => {
        const workingPath = join(tempRoot, 'queued-stream-working.pdf');
        const firstDirectory = join(tempRoot, 'first-target');
        const secondDirectory = join(tempRoot, 'second-target');
        const firstOriginalPath = join(firstDirectory, 'original.pdf');
        const secondOriginalPath = join(secondDirectory, 'original.pdf');
        mkdirSync(firstDirectory);
        mkdirSync(secondDirectory);
        writeFileSync(workingPath, 'working-before');
        writeFileSync(firstOriginalPath, 'first-before');
        writeFileSync(secondOriginalPath, 'second-before');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath: firstOriginalPath});
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveToOriginal,
            commitStagedSerializedPdf,
        } = await importSerializedPdfPersistence();
        const sender = new FakeSender();
        const beginResult = await beginSerializedPdfSaveToOriginal(
            createInvokeEvent(sender),
            workingPath,
            Buffer.byteLength('streamed-new'),
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        const port = new FakeMessagePort();
        const stagedPromise = port.nextResult();
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);
        port.emit('message', {data: {
            type: 'chunk',
            seq: 0,
            bytes: Buffer.from('streamed-new'),
        }});
        port.emit('message', {data: {type: 'complete'}});
        const staged = await stagedPromise;
        if (!isStagedPortMessage(staged)) {
            throw new Error('Expected staged serialized PDF result');
        }
        const {enqueueWorkingCopyMutation} = await import('@electron/file-access/workingCopyMutationQueue');
        const blockedMutation = deferred<undefined>();
        const queuedMutation = enqueueWorkingCopyMutation(workingPath, () => blockedMutation.promise);

        const commitPromise = commitStagedSerializedPdf(
            {senderId: sender.id},
            staged.sessionId,
            staged.stagedOutput,
        );
        await waitForSettledQueueTurn();
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath: secondOriginalPath});
        blockedMutation.resolve(undefined);
        await queuedMutation;

        await expect(commitPromise).resolves.toMatchObject({path: secondOriginalPath});
        expect(readFileSyncUtf8(firstOriginalPath)).toBe('first-before');
        expect(readFileSyncUtf8(secondOriginalPath)).toBe('streamed-new');
        expect(readFileSyncUtf8(workingPath)).toBe('streamed-new');
        expect(mocks.createTypedStagedArtifactForTrustedSiblingCopy).toHaveBeenCalledWith(
            {senderId: 42},
            staged.stagedOutput,
            `${secondOriginalPath}.tmp.pdf`,
            secondOriginalPath,
            staged.stagedOutput.validations,
        );
    });

    it('streams a snapshot into the managed working copy without publishing the original', async () => {
        const workingPath = join(tempRoot, 'snapshot-working.pdf');
        const originalPath = join(tempRoot, 'snapshot-original.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('staged-snapshot'),
            serializedSaveOptions: {
                ...SERIALIZED_TEST_REVISION_OPTIONS,
                workingCopyOnly: true,
            },
        });

        expect(result).toMatchObject({
            type: 'result',
            path: workingPath,
            validation: {isValid: true},
        });
        expect(readFileSyncUtf8(workingPath)).toBe('staged-snapshot');
        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(mocks.optimizeLargePdfForOrdinarySave).not.toHaveBeenCalled();
        expect(mocks.transitionOriginalAndWorkingCopyRevision).not.toHaveBeenCalled();
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalledWith(
            workingPath,
            'replace-working-copy',
            expect.any(Function),
            42,
        );
        expect(mocks.markWorkingCopyContentChanged).not.toHaveBeenCalled();
        expect(mocks.addRecentFile).not.toHaveBeenCalled();
    });

    it('rolls back streamed Save to original when expectation refresh fails', async () => {
        const workingPath = join(tempRoot, 'refresh-fail-working.pdf');
        const originalPath = join(tempRoot, 'refresh-fail-original.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(originalPath, 'old-original');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.refreshWorkingCopyOriginalFileExpectation.mockResolvedValueOnce(false);

        const result = await runSaveToOriginalSession({
            workingPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'error',
            phase: 'commit',
        });
        expect(readFileSyncUtf8(originalPath)).toBe('old-original');
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(mocks.markWorkingCopySyncRequired).not.toHaveBeenCalled();
        expect(mocks.markWorkingCopyContentChanged).not.toHaveBeenCalled();
    });

    it('rejects Save As before opening a temp stream when the sender does not own the working copy', async () => {
        const workingPath = join(tempRoot, 'foreign-working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        mocks.ensureWorkingCopyMaterialized.mockRejectedValue(new Error('Working copy path is not managed'));

        const sender = new FakeSender();
        const {beginSerializedPdfSaveAs} = await importSerializedPdfPersistence();

        await expect(beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            128,
            targetPath,
        )).rejects.toThrow('Working copy path is not managed');

        expect(mocks.makeSiblingTempPath).not.toHaveBeenCalled();
        expect(existsSync(`${targetPath}.tmp.pdf`)).toBe(false);
    });

    it('returns a detached-document result when working-copy copy-back fails', async () => {
        const workingPath = join(tempRoot, 'save-as-copyback-working.pdf');
        const targetPath = join(tempRoot, 'save-as-copyback-target.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');
        mocks.copyFileCopyOnWrite.mockRejectedValueOnce(new Error('copy-back failed'));

        const result = await runSaveAsSession({
            workingPath,
            targetPath,
            bytes: Buffer.from('new-pdf'),
        });

        expect(result).toMatchObject({
            type: 'result',
            path: targetPath,
            validation: {
                isValid: true,
                errors: [],
                warnings: [],
            },
            warning: {
                reason: 'working-copy-sync-required',
                message: expect.stringContaining('The file was written, but this document is no longer connected to it: copy-back failed'),
            },
        });
        expect(readFileSyncUtf8(targetPath)).toBe('new-pdf');
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(mocks.setWorkingCopyOriginalPath).toHaveBeenCalledWith(workingPath, targetPath, 42);
        expect(mocks.markWorkingCopySyncRequired).toHaveBeenCalledWith(
            workingPath,
            expect.stringContaining('copy-back failed'),
            expect.objectContaining({
                originalPath: targetPath,
                ownerWebContentsId: 42,
            }),
        );
        expect(mocks.markWorkingCopyContentChanged).not.toHaveBeenCalled();
    });

    it('preserves the Save As target when materialization fails before streaming starts', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        writeFileSync(workingPath, 'old-working');
        writeFileSync(targetPath, 'old-target');
        mocks.ensureWorkingCopyMaterialized.mockRejectedValue(Object.assign(
            new Error('The original document is unavailable'),
            {
                code: 'SOURCE_BACKING_UNAVAILABLE',
                retryable: false,
            },
        ));

        const sender = new FakeSender();
        const { beginSerializedPdfSaveAs } = await importSerializedPdfPersistence();

        await expect(beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            128,
            targetPath,
        )).rejects.toMatchObject({
            code: 'SOURCE_BACKING_UNAVAILABLE',
            retryable: false,
        });
        expect(readFileSyncUtf8(workingPath)).toBe('old-working');
        expect(readFileSyncUtf8(targetPath)).toBe('old-target');
        expect(mocks.makeSiblingTempPath).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.setWorkingCopyOriginalPath).not.toHaveBeenCalled();
        expect(mocks.allowOpenPath).not.toHaveBeenCalled();
        expect(mocks.addRecentFile).not.toHaveBeenCalled();
        expect(mocks.updateRecentFilesMenu).not.toHaveBeenCalled();
    });

    it('acknowledges each streamed chunk after writing it to the temp file', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp.pdf`;
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            4,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        expect(beginResult).toMatchObject({
            sessionId: expect.any(String),
            protocolVersion: 1,
            maxChunkBytes: 8 * 1024 * 1024,
            maxInFlightChunks: 2,
            maxTotalBytes: expect.any(Number),
            ackTimeoutMs: expect.any(Number),
            progressTimeoutMs: expect.any(Number),
            resultTimeoutMs: expect.any(Number),
        });

        const portClosed = attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

        port.emit('message', {data: {
            type: 'chunk',
            seq: 0,
            bytes: Buffer.from('%PDF'),
        }});

        await expect(port.nextMessage(message => isPortMessage(message, 'ack'))).resolves.toMatchObject({
            type: 'ack',
            seq: 0,
            receivedBytes: 4,
        });
        expect(readFileSyncUtf8(tempPath)).toBe('%PDF');

        port.close();
        await portClosed;
        expect(existsSync(tempPath)).toBe(false);
    });

    it('keeps independent progress deadlines per serialized PDF session', async () => {
        vi.useFakeTimers({toFake: [
            'setTimeout',
            'clearTimeout',
        ]});
        try {
            const sender = new FakeSender(83);
            const firstTargetPath = join(tempRoot, 'progress-first.pdf');
            const secondTargetPath = join(tempRoot, 'progress-second.pdf');
            const firstTempPath = `${firstTargetPath}.tmp.pdf`;
            const secondTempPath = `${secondTargetPath}.tmp.pdf`;
            const port1 = new FakeMessagePort();
            const port2 = new FakeMessagePort();
            const {
                attachSerializedPdfPersistencePort,
                beginSerializedPdfSaveAs,
            } = await importSerializedPdfPersistence();

            const [
                firstBeginResult,
                secondBeginResult,
            ] = await Promise.all(
                [
                    beginSerializedPdfSaveAs(
                        createInvokeEvent(sender),
                        join(tempRoot, 'working-first.pdf'),
                        1,
                        firstTargetPath,
                        undefined,
                        SERIALIZED_TEST_REVISION_OPTIONS,
                    ),
                    beginSerializedPdfSaveAs(
                        createInvokeEvent(sender),
                        join(tempRoot, 'working-second.pdf'),
                        1,
                        secondTargetPath,
                        undefined,
                        SERIALIZED_TEST_REVISION_OPTIONS,
                    ),
                ],
            );
            const firstPortClosed = attachSerializedPdfPersistencePort(createPortEvent(sender, port1), firstBeginResult.sessionId);
            const secondPortClosed = attachSerializedPdfPersistencePort(createPortEvent(sender, port2), secondBeginResult.sessionId);

            const progressTimeoutMs = firstBeginResult.progressTimeoutMs!;
            vi.advanceTimersByTime(progressTimeoutMs - 2_000);
            port1.emit('message', {data: {
                type: 'chunk',
                seq: 0,
                bytes: Buffer.from('x'),
            }});
            await expect(port1.nextMessage(message => isPortMessage(message, 'ack'))).resolves.toMatchObject({
                type: 'ack',
                seq: 0,
            });

            vi.advanceTimersByTime(2_001);
            port2.close();
            await secondPortClosed;
            expect(existsSync(secondTempPath)).toBe(false);
            expect(existsSync(firstTempPath)).toBe(true);

            port1.close();
            await firstPortClosed;
            expect(existsSync(firstTempPath)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects a sender that floods more persistence frames than the negotiated window can bound', async () => {
        const targetPath = join(tempRoot, 'flooded-stream.pdf');
        const tempPath = `${targetPath}.tmp.pdf`;
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            6,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

        for (let seq = 0; seq < 5; seq += 1) {
            port.emit('message', {data: {
                type: 'chunk',
                seq,
                bytes: Buffer.from('x'),
            }});
        }

        await expect(port.nextMessage(message => isPortMessage(message, 'error'))).resolves.toMatchObject({
            type: 'error',
            phase: 'streaming',
            error: expect.stringContaining('queued message limit'),
        });
        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
    });

    it.each([
        {
            name: 'transferred-port metadata',
            wrap: (payload: unknown) => ({
                data: payload,
                ports: [],
            }),
        },
        {
            name: 'deeply nested payload wrappers',
            wrap: (payload: unknown) => wrapMessageEventPayload(payload, 8),
        },
    ])('accepts MessagePortMain events with $name', async ({wrap}) => {
        const workingPath = join(tempRoot, 'working.pdf');
        const targetPath = join(tempRoot, 'electron-message-event.pdf');
        const tempPath = `${targetPath}.tmp.pdf`;
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
            commitStagedSerializedPdf,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            workingPath,
            4,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);
        const resultPromise = port.nextResult();

        port.emit('message', wrap({
            type: 'chunk',
            seq: 0,
            bytes: Buffer.from('%PDF'),
        }));

        await expect(port.nextMessage(message => isPortMessage(message, 'ack'))).resolves.toMatchObject({
            type: 'ack',
            seq: 0,
            receivedBytes: 4,
        });
        expect(readFileSyncUtf8(tempPath)).toBe('%PDF');

        port.emit('message', wrap({type: 'complete'}));
        const stagedResult = await resultPromise;
        if (!isStagedPortMessage(stagedResult)) {
            throw new Error('Expected staged serialized PDF result');
        }
        await commitStagedSerializedPdf(
            {senderId: sender.id},
            stagedResult.sessionId,
            stagedResult.stagedOutput,
        );
        expect(readFileSyncUtf8(targetPath)).toBe('%PDF');
        expect(existsSync(tempPath)).toBe(false);
    });

    it('rejects cyclic MessagePortMain event wrappers without recursive listener failure', async () => {
        const targetPath = join(tempRoot, 'cyclic-message-event.pdf');
        const tempPath = `${targetPath}.tmp.pdf`;
        const sender = new FakeSender();
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            4,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);
        const messageEvent: {
            data: unknown;
            ports: unknown[];
        } = {
            data: null,
            ports: [],
        };
        messageEvent.data = messageEvent;

        port.emit('message', messageEvent);

        await expect(port.nextMessage(message => isPortMessage(message, 'error'))).resolves.toMatchObject({
            type: 'error',
            code: 'PROTOCOL_ERROR',
            phase: 'streaming',
            retryable: false,
            expected: false,
            error: expect.stringContaining('Unknown PDF persistence message (keys=data,ports)'),
        });
        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
    });

    it.each([
        {
            senderId: 73,
            event: 'destroyed',
            args: [],
        },
        {
            senderId: 74,
            event: 'render-process-gone',
            args: [],
        },
        {
            senderId: 75,
            event: 'did-start-navigation',
            args: [
                {},
                'https://example.invalid/',
                false,
                true,
            ],
        },
    ])('cleans an open Save As session on sender $event before streaming starts', async ({
        args,
        event,
        senderId,
    }) => {
        const targetPath = join(tempRoot, `${event}.pdf`);
        const tempPath = `${targetPath}.tmp.pdf`;
        const sender = new FakeSender(senderId);
        const removeListenerSpy = vi.spyOn(sender, 'removeListener');
        const {
            beginSerializedPdfSaveAs,
            shutdownSerializedPdfPersistence,
        } = await importSerializedPdfPersistence();

        await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            128,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );

        expect(existsSync(tempPath)).toBe(true);

        sender.emit(event, ...args);
        await shutdownSerializedPdfPersistence();
        expect(existsSync(tempPath)).toBe(false);
        expect(removeListenerSpy).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(removeListenerSpy).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
        if (event === 'did-start-navigation') {
            expect(removeListenerSpy).toHaveBeenCalledWith(event, expect.any(Function));
        }
    });

    it('rejects new streams above the per-sender active session limit', async () => {
        const sender = new FakeSender(80);
        const {
            beginSerializedPdfSaveAs,
            shutdownSerializedPdfPersistence,
        } = await importSerializedPdfPersistence();
        const targetPaths = Array.from({length: 4}, (_, index) => join(tempRoot, `limited-${index}.pdf`));

        for (const targetPath of targetPaths) {
            await expect(beginSerializedPdfSaveAs(
                createInvokeEvent(sender),
                join(tempRoot, 'working.pdf'),
                128,
                targetPath,
                undefined,
                SERIALIZED_TEST_REVISION_OPTIONS,
            )).resolves.toMatchObject({sessionId: expect.any(String)});
        }

        await expect(beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            128,
            join(tempRoot, 'limited-overflow.pdf'),
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        )).rejects.toThrow('Too many active PDF persistence streams');

        const tempPaths = mocks.makeSiblingTempPath.mock.results.flatMap(result =>
            result.type === 'return' ? [`${result.value}.pdf`] : [],
        );
        sender.emit('destroyed');
        await shutdownSerializedPdfPersistence();
        for (const tempPath of tempPaths) {
            expect(existsSync(tempPath)).toBe(false);
        }
    });

    it('rejects duplicate MessagePort attachment for a serialized PDF session', async () => {
        const targetPath = join(tempRoot, 'duplicate-port.pdf');
        const tempPath = `${targetPath}.tmp.pdf`;
        const sender = new FakeSender(81);
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            128,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        const portClosed = attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

        expect(() => attachSerializedPdfPersistencePort({
            sender,
            ports: [new FakeMessagePort()],
        } as never, beginResult.sessionId)).toThrow('PDF persistence MessagePort is already attached');

        port.close();
        await portClosed;
        expect(existsSync(tempPath)).toBe(false);
    });

    it('rejects serialized PDF chunks larger than the protocol chunk budget', async () => {
        const targetPath = join(tempRoot, 'oversized-chunk.pdf');
        const tempPath = `${targetPath}.tmp.pdf`;
        const sender = new FakeSender(82);
        const port = new FakeMessagePort();
        const {
            attachSerializedPdfPersistencePort,
            beginSerializedPdfSaveAs,
        } = await importSerializedPdfPersistence();

        const beginResult = await beginSerializedPdfSaveAs(
            createInvokeEvent(sender),
            join(tempRoot, 'working.pdf'),
            (8 * 1024 * 1024) + 1,
            targetPath,
            undefined,
            SERIALIZED_TEST_REVISION_OPTIONS,
        );
        attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

        port.emit('message', {data: {
            type: 'chunk',
            seq: 0,
            bytes: new Uint8Array((8 * 1024 * 1024) + 1),
        }});

        await expect(port.nextMessage(message => isPortMessage(message, 'error'))).resolves.toMatchObject({
            type: 'error',
            code: 'PROTOCOL_ERROR',
            phase: 'streaming',
            retryable: false,
            expected: false,
            seq: 0,
            error: expect.stringContaining('PDF persistence chunk exceeds maximum size'),
        });
        await waitForCondition(() => {
            expect(existsSync(tempPath)).toBe(false);
        });
    });
});

interface ISerializedPersistenceTestRevisionOptions {
    expectedDocumentRevisionToken: TDocumentRevisionToken;
    workingCopyOnly?: true;
    changedObjectRefs?: string[];
}

async function runSaveAsSession(options: {
    workingPath: string;
    targetPath: string;
    bytes: Uint8Array;
    options?: { optimizeLossless?: boolean };
    serializedSaveOptions?: ISerializedPersistenceTestRevisionOptions;
}) {
    const {
        attachSerializedPdfPersistencePort,
        beginSerializedPdfSaveAs,
        commitStagedSerializedPdf,
    } = await importSerializedPdfPersistence();
    const sender = new FakeSender();
    const beginResult = await beginSerializedPdfSaveAs(
        createInvokeEvent(sender),
        options.workingPath,
        options.bytes.byteLength,
        options.targetPath,
        options.options,
        options.serializedSaveOptions ?? SERIALIZED_TEST_REVISION_OPTIONS,
    );
    const port = new FakeMessagePort();
    const resultPromise = port.nextResult();

    attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

    port.emit('message', {data: {
        type: 'chunk',
        seq: 0,
        bytes: options.bytes,
    }});
    port.emit('message', {data: {type: 'complete'}});

    const result = await resultPromise;
    if (!isStagedPortMessage(result)) {
        return result;
    }
    try {
        const committed = await commitStagedSerializedPdf(
            {senderId: sender.id},
            result.sessionId,
            result.stagedOutput,
        );
        return {
            type: 'result',
            ...committed,
        };
    } catch (error) {
        return createPdfPersistenceErrorFrame(error, {phase: 'commit'});
    }
}

async function runSaveToOriginalSession(options: {
    workingPath: string;
    bytes: Uint8Array;
    serializedSaveOptions?: ISerializedPersistenceTestRevisionOptions;
}) {
    const {
        attachSerializedPdfPersistencePort,
        beginSerializedPdfSaveToOriginal,
        commitStagedSerializedPdf,
    } = await importSerializedPdfPersistence();
    const sender = new FakeSender();
    const beginResult = await beginSerializedPdfSaveToOriginal(
        createInvokeEvent(sender),
        options.workingPath,
        options.bytes.byteLength,
        options.serializedSaveOptions ?? SERIALIZED_TEST_REVISION_OPTIONS,
    );
    const port = new FakeMessagePort();
    const resultPromise = port.nextResult();

    attachSerializedPdfPersistencePort(createPortEvent(sender, port), beginResult.sessionId);

    port.emit('message', {data: {
        type: 'chunk',
        seq: 0,
        bytes: options.bytes,
    }});
    port.emit('message', {data: {type: 'complete'}});

    const result = await resultPromise;
    if (!isStagedPortMessage(result)) {
        return result;
    }
    try {
        const committed = await commitStagedSerializedPdf(
            {senderId: sender.id},
            result.sessionId,
            result.stagedOutput,
        );
        return {
            type: 'result',
            ...committed,
        };
    } catch (error) {
        return createPdfPersistenceErrorFrame(error, {phase: 'commit'});
    }
}

class FakeMessagePort extends EventEmitter {
    private readonly postedMessages: unknown[] = [];

    start() {
        return undefined;
    }

    postMessage(message: unknown) {
        this.postedMessages.push(message);
        this.emit('posted-message', message);
    }

    close() {
        this.emit('close');
    }

    nextResult() {
        return this.nextMessage(isTerminalPortMessage);
    }

    nextMessage(predicate: (message: unknown) => boolean) {
        return new Promise<unknown>((resolve) => {
            const existingResult = this.postedMessages.find(predicate);
            if (existingResult) {
                resolve(existingResult);
                return;
            }

            this.on('posted-message', (message) => {
                if (predicate(message)) {
                    resolve(message);
                }
            });
        });
    }
}

function isPortMessage(message: unknown, type: string) {
    return Boolean(
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === type,
    );
}

function isTerminalPortMessage(message: unknown) {
    return Boolean(
        message
        && typeof message === 'object'
        && 'type' in message
        && (message.type === 'result' || message.type === 'staged' || message.type === 'error'),
    );
}

function isStagedPortMessage(message: unknown): message is {
    type: 'staged';
    sessionId: string;
    stagedOutput: ITypedStagedArtifact;
} {
    return isPortMessage(message, 'staged')
        && typeof message === 'object'
        && message !== null
        && 'sessionId' in message
        && 'stagedOutput' in message
        && isTypedStagedArtifact(message.stagedOutput);
}

function wrapMessageEventPayload(payload: unknown, depth: number) {
    let current = payload;
    for (let index = 0; index < depth; index += 1) {
        current = {
            data: current,
            ports: [],
        };
    }
    return current;
}

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
