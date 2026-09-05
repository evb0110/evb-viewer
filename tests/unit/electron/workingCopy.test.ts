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
    renameSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    truncateSync,
    utimesSync,
    writeFileSync,
} from 'fs';
import {
    basename,
    dirname,
    join,
    win32,
} from 'path';
import { tmpdir } from 'os';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import {requireDocumentRevisionToken} from '@contracts';
import {PDF_DECRYPT_PASSWORD_MAX_BYTES} from '@contracts/pdfDecryptSchemas';
import type * as NodeChildProcess from 'node:child_process';
import type * as NodeFs from 'fs';
import type * as WorkingCopyStore from '@electron/file-access/workingCopyStore';
import type * as FsPromises from 'fs/promises';

let tempRoot = '';
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: platform,
    });
}

vi.mock('electron', () => ({ app: { getPath: vi.fn((_name: string) => tempRoot) } }));

vi.mock('@electron/pdf/pdfPageCount', () => ({getPdfPageCount: vi.fn(async () => 1)}));

describe('workingCopy', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-working-copy-test-'));
    });

    afterEach(() => {
        setPlatform(originalPlatform);
        delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        delete process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE;
        vi.useRealTimers();
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('uses the native writer for an unprovided password on protected PDFs', async () => {
        const previousCloneResult = process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        const writer = vi.fn(async () => ({
            outcome: 'needs-password' as const,
            wasEncrypted: true as const,
            revision: null,
        }));
        vi.doMock('@electron/file-access/workingCopyDecryption', () => ({
            decryptWorkingCopyWithWriter: writer,
            PdfDecryptAttemptError: class PdfDecryptAttemptError extends Error {
                readonly outcome: 'needs-password' | 'unsupported-encryption';

                constructor(outcome: 'needs-password' | 'unsupported-encryption') {
                    super(outcome);
                    this.name = 'PdfDecryptAttemptError';
                    this.outcome = outcome;
                }
            },
        }));
        vi.resetModules();

        try {
            process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'success';
            const {createWorkingCopyWithOutcome} = await import('@electron/file-access/workingCopyCreation');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const originalPath = join(tempRoot, 'protected.pdf');
            writeFileSync(originalPath, Buffer.from('%PDF-1.7\n/Encrypt 1 0 R\n'));
            const trustedOriginalPath = allowOpenPath(originalPath);
            expect(trustedOriginalPath).not.toBeNull();

            await expect(createWorkingCopyWithOutcome(trustedOriginalPath!, 7))
                .rejects.toMatchObject({outcome: 'needs-password'});
            expect(writer).toHaveBeenCalledWith(expect.any(String), undefined, undefined);
        } finally {
            if (previousCloneResult === undefined) {
                delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
            } else {
                process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = previousCloneResult;
            }
            vi.doUnmock('@electron/file-access/workingCopyDecryption');
            vi.resetModules();
        }
    });

    it('rejects invalid passwords at the main-process working-copy boundary', async () => {
        const {
            handleCreateWorkingCopyFromData,
            handleCreateWorkingCopyFromPath,
        } = await import('@electron/features/documents/main/documentWorkingCopyHandlers');
        const context = {senderId: 7} as Parameters<typeof handleCreateWorkingCopyFromData>[0];
        const oversizedPassword = 'x'.repeat(PDF_DECRYPT_PASSWORD_MAX_BYTES + 1);
        const protectedPath = join(tempRoot, 'protected.pdf');
        writeFileSync(protectedPath, Buffer.from('%PDF-1.7'));

        await expect(handleCreateWorkingCopyFromData(
            context,
            'protected.pdf',
            Uint8Array.of(1),
            undefined,
            oversizedPassword,
        )).rejects.toThrow(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
        await expect(handleCreateWorkingCopyFromPath(
            context,
            protectedPath as TOpenPath,
            undefined,
            null as never,
        )).rejects.toThrow(`PDF password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`);
    });

    it('publishes unsupported durable PDFs as lazy without copying or fingerprinting', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
        process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE = 'lazy';
        const fingerprintHash = vi.fn();
        vi.doMock('@electron/file-access/createOriginalFileContentFingerprintHash', () => ({createOriginalFileContentFingerprintHash: fingerprintHash}));
        try {
            const {createWorkingCopy} = await import('@electron/file-access/workingCopyCreation');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const {getWorkingCopyBackingEntry} = await import('@electron/file-access/workingCopyStore');
            const originalPath = join(tempRoot, 'lazy-original.pdf');
            writeFileSync(originalPath, Buffer.alloc(2 * 1024 * 1024, 17));
            const trustedOriginalPath = allowOpenPath(originalPath);
            expect(trustedOriginalPath).not.toBeNull();

            const workingPath = await createWorkingCopy(trustedOriginalPath!, 7);

            expect(existsSync(workingPath)).toBe(false);
            expect(getWorkingCopyBackingEntry(workingPath, 7)).toMatchObject({
                admissionSnapshot: {size: BigInt(2 * 1024 * 1024)},
                backingState: 'lazy-original',
                originalPath: realpathSync.native(originalPath),
            });
            expect(fingerprintHash).not.toHaveBeenCalled();
        } finally {
            vi.doUnmock('@electron/file-access/createOriginalFileContentFingerprintHash');
        }
    });

    it('serializes explicit directory ensures with background materialization', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
        process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE = 'lazy';
        const {
            createWorkingCopy,
            ensureWorkingCopyDirectory,
        } = await import(
            '@electron/file-access/workingCopyCreation'
        );
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {onWorkingCopyMaterializationProgress} = await import(
            '@electron/file-access/workingCopyMaterialization'
        );
        const originalPath = join(tempRoot, 'serialized-ensure.pdf');
        writeFileSync(originalPath, Buffer.alloc(1024 * 1024 + 17, 23));
        const trustedOriginalPath = allowOpenPath(originalPath);
        const workingPath = await createWorkingCopy(trustedOriginalPath!, 7);
        const operationIds = new Set<string>();
        const removeProgressListener = onWorkingCopyMaterializationProgress(event => {
            if (event.phase === 'copying') {
                operationIds.add(event.operationId);
            }
        });

        try {
            await Promise.all([
                ensureWorkingCopyDirectory(workingPath, 7),
                ensureWorkingCopyDirectory(workingPath, 7),
            ]);
        } finally {
            removeProgressListener();
        }

        expect(operationIds.size).toBe(1);
        expect(readFileSync(workingPath)).toEqual(readFileSync(originalPath));
    }, 30_000);

    it('rejects source replacement during eager non-PDF fallback before registration', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
        process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE = 'background';
        const sourcePath = join(tempRoot, 'replacement-source.djvu');
        const replacementPath = join(tempRoot, 'replacement-source-new.djvu');
        const originalBytes = Buffer.alloc(32 * 1024 * 1024 + 17, 41);
        writeFileSync(sourcePath, originalBytes);
        writeFileSync(replacementPath, Buffer.alloc(originalBytes.byteLength, 97));
        let admissionProbeCount = 0;
        vi.doMock('@electron/file-access/workingCopyStore', async importOriginal => {
            const original = await importOriginal<typeof WorkingCopyStore>();
            return {
                ...original,
                captureWorkingCopyAdmissionSnapshot: async (...args: Parameters<typeof original.captureWorkingCopyAdmissionSnapshot>) => {
                    const snapshot = await original.captureWorkingCopyAdmissionSnapshot(...args);
                    admissionProbeCount += 1;
                    if (admissionProbeCount === 1) {
                        renameSync(sourcePath, join(tempRoot, 'replacement-source-old.djvu'));
                        renameSync(replacementPath, sourcePath);
                    }
                    return snapshot;
                },
            };
        });
        vi.resetModules();
        try {
            const {createWorkingCopy} = await import('@electron/file-access/workingCopyCreation');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const trustedSourcePath = allowOpenPath(sourcePath);
            expect(trustedSourcePath).not.toBeNull();

            const copy = createWorkingCopy(trustedSourcePath!, 7);

            await expect(copy).rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});
            expect(existsSync(join(tempRoot, 'replacement-source-old.djvu'))).toBe(true);
            expect(existsSync(sourcePath)).toBe(true);
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyStore');
            vi.resetModules();
        }
    }, 30_000);

    it('uses background materialization by default after publishing lazy state', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
        const {createWorkingCopy} = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {getWorkingCopyBackingEntry} = await import('@electron/file-access/workingCopyStore');
        const {ensureWorkingCopyMaterialized} = await import(
            '@electron/file-access/workingCopyMaterialization'
        );
        const originalPath = join(tempRoot, 'background-default.pdf');
        const originalBytes = Buffer.alloc(64 * 1024, 21);
        writeFileSync(originalPath, originalBytes);
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const workingPath = await createWorkingCopy(trustedOriginalPath!, 7);
        expect([
            'materializing',
            'materialized',
        ]).toContain(getWorkingCopyBackingEntry(workingPath, 7)?.backingState);
        await ensureWorkingCopyMaterialized(workingPath, {
            ownerWebContentsId: 7,
            reason: 'save',
        });

        expect(readFileSync(workingPath)).toEqual(originalBytes);
        expect(getWorkingCopyBackingEntry(workingPath, 7)?.backingState).toBe('materialized');
    }, 30_000);

    it('records a successful forced clone without starting materialization', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'success';
        const {createWorkingCopy} = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {getWorkingCopyBackingEntry} = await import('@electron/file-access/workingCopyStore');
        const {getWorkingCopyMaterializationFlightCountForTests} = await import(
            '@electron/file-access/workingCopyMaterialization'
        );
        const originalPath = join(tempRoot, 'forced-clone.pdf');
        const originalBytes = Buffer.from([
            2,
            4,
            6,
            8,
        ]);
        writeFileSync(originalPath, originalBytes);
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const workingPath = await createWorkingCopy(trustedOriginalPath!, 7);

        expect(readFileSync(workingPath)).toEqual(originalBytes);
        expect(getWorkingCopyBackingEntry(workingPath, 7)?.backingState).toBe('cloned');
        expect(getWorkingCopyMaterializationFlightCountForTests()).toBe(0);
    });

    it('registers an original-file witness for every mapped working-copy creation route', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'success';
        const {
            createWorkingCopy,
            createWorkingCopyFromData,
            createWorkingCopyFromPath,
        } = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {
            getWorkingCopyOriginalFileExpectation,
            getWorkingCopyRole,
        } = await import('@electron/file-access/workingCopyStore');
        const {originalPathSaveBaseMatches} = await import(
            '@electron/file-access/originalPathSaveWitness'
        );
        const originalPath = join(tempRoot, 'witness-original.pdf');
        const originalBytes = Buffer.from('%PDF-1.7\noriginal witness\n');
        writeFileSync(originalPath, originalBytes);
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const clonedWorkingPath = await createWorkingCopy(trustedOriginalPath!, 7);
        const copiedWorkingPath = await createWorkingCopyFromPath(
            trustedOriginalPath!,
            originalPath,
            8,
        );
        const dataWorkingPath = await createWorkingCopyFromData(
            'witness-original.pdf',
            originalBytes,
            originalPath,
            9,
        );

        for (const [
            workingPath,
            ownerWebContentsId,
        ] of [
                [
                    clonedWorkingPath,
                    7,
                ],
                [
                    copiedWorkingPath,
                    8,
                ],
                [
                    dataWorkingPath,
                    9,
                ],
            ] as const) {
            expect(getWorkingCopyRole(workingPath, ownerWebContentsId)).toBe('current');
            expect(getWorkingCopyOriginalFileExpectation(workingPath, ownerWebContentsId)).toMatchObject({
                ctimeNs: expect.stringMatching(/^\d+$/u),
                deviceId: expect.stringMatching(/^\d+$/u),
                inode: expect.stringMatching(/^\d+$/u),
                mtimeNs: expect.stringMatching(/^\d+$/u),
                size: originalBytes.byteLength,
            });
            await expect(
                originalPathSaveBaseMatches(workingPath, originalPath, ownerWebContentsId),
            ).resolves.toBe(true);
        }
    });

    it('captures a bounded content fingerprint for small Windows mapped working copies', async () => {
        setPlatform('win32');
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'success';
        const {createWorkingCopy} = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {getWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
        const originalPath = join(tempRoot, 'windows-fingerprint-original.pdf');
        writeFileSync(originalPath, Buffer.alloc(256 * 1024, 7));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const workingPath = await createWorkingCopy(trustedOriginalPath!, 7);

        expect(getWorkingCopyOriginalFileExpectation(workingPath, 7)).toMatchObject({contentFingerprint: 'sha256-full-v1:48af473d28c041d4a5de15465f1768fefbfedda7c449580c2f2eb1f7941ad95f'});
    });

    it('keeps large Windows mapped working copies on the bounded stat witness', async () => {
        setPlatform('win32');
        const {
            getWorkingCopyOriginalFileExpectation,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const {clearAllWorkingCopies} = await import('@electron/file-access/workingCopyCleanup');
        const originalPath = join(tempRoot, 'windows-large-original.pdf');
        const workingPath = join(tempRoot, 'windows-large-working.pdf');
        const largeSize = 64 * 1024 * 1024 + 1;
        writeFileSync(originalPath, Buffer.alloc(1));
        writeFileSync(workingPath, Buffer.alloc(1));
        truncateSync(originalPath, largeSize);
        truncateSync(workingPath, 1);

        try {
            await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

            expect(getWorkingCopyOriginalFileExpectation(workingPath, 7)).toMatchObject({size: largeSize});
            expect(getWorkingCopyOriginalFileExpectation(workingPath, 7)?.contentFingerprint).toBeUndefined();
        } finally {
            await clearAllWorkingCopies();
        }
    });

    it('fails closed when a Windows source mutates during fingerprinting', async () => {
        setPlatform('win32');
        const originalPath = join(tempRoot, 'windows-mutating-original.pdf');
        const workingPath = join(tempRoot, 'windows-mutating-working.pdf');
        const sourceBytes = Buffer.alloc(2 * 1024 * 1024, 7);
        writeFileSync(originalPath, sourceBytes);
        writeFileSync(workingPath, Buffer.alloc(1));
        truncateSync(workingPath, 1);
        vi.doMock('fs/promises', async importOriginal => {
            const original = await importOriginal<typeof FsPromises>();
            return {
                ...original,
                open: vi.fn(async (...args: Parameters<typeof original.open>) => {
                    const handle = await original.open(...args);
                    let mutated = false;
                    return Object.assign(Object.create(handle), {
                        close: () => handle.close(),
                        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                            const result = await handle.read(buffer, offset, length, position);
                            if (!mutated) {
                                mutated = true;
                                writeFileSync(originalPath, Buffer.alloc(sourceBytes.length, 19));
                            }
                            return result;
                        },
                        stat: (...statArgs: Parameters<typeof handle.stat>) => handle.stat(...statArgs),
                    }) as Awaited<ReturnType<typeof original.open>>;
                }),
            };
        });
        vi.resetModules();
        const {clearAllWorkingCopies} = await import('@electron/file-access/workingCopyCleanup');

        try {
            const {
                getWorkingCopyOriginalFileExpectation,
                setWorkingCopyOriginalPath,
            } = await import('@electron/file-access/workingCopyStore');

            await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

            expect(getWorkingCopyOriginalFileExpectation(workingPath, 7)).toBeNull();
        } finally {
            await clearAllWorkingCopies();
            vi.doUnmock('fs/promises');
            vi.resetModules();
        }
    });

    it('keeps eager mode and generated-path creation fully materialized', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
        process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE = 'eager';
        const {
            createWorkingCopy,
            createWorkingCopyFromPath,
        } = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {getWorkingCopyBackingEntry} = await import('@electron/file-access/workingCopyStore');
        const originalPath = join(tempRoot, 'eager-original.pdf');
        const originalBytes = Buffer.from([
            1,
            3,
            5,
            7,
        ]);
        writeFileSync(originalPath, originalBytes);
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const eagerWorkingPath = await createWorkingCopy(trustedOriginalPath!, 7);
        expect(readFileSync(eagerWorkingPath)).toEqual(originalBytes);
        expect(getWorkingCopyBackingEntry(eagerWorkingPath, 7)?.backingState).toBe('eager');

        process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE = 'lazy';
        const generatedWorkingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        expect(readFileSync(generatedWorkingPath)).toEqual(originalBytes);
        expect(getWorkingCopyBackingEntry(generatedWorkingPath, 7)?.backingState).toBe('eager');
    });

    it('keeps encrypted PDFs eager and captures a constant-time original stat witness', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
        process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE = 'lazy';
        const writer = vi.fn(async () => ({
            outcome: 'decrypted' as const,
            wasEncrypted: true as const,
            revision: null,
        }));
        vi.doMock('@electron/file-access/workingCopyDecryption', () => ({
            decryptWorkingCopyWithWriter: writer,
            PdfDecryptAttemptError: class PdfDecryptAttemptError extends Error {
                readonly outcome: 'needs-password' | 'unsupported-encryption';

                constructor(outcome: 'needs-password' | 'unsupported-encryption') {
                    super(outcome);
                    this.name = 'PdfDecryptAttemptError';
                    this.outcome = outcome;
                }
            },
        }));
        vi.resetModules();
        try {
            const {createWorkingCopy} = await import('@electron/file-access/workingCopyCreation');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const {getWorkingCopyBackingEntry} = await import('@electron/file-access/workingCopyStore');
            const originalPath = join(tempRoot, 'encrypted-original.pdf');
            writeFileSync(originalPath, Buffer.from('%PDF encrypted bytes /Encrypt'));
            const trustedOriginalPath = allowOpenPath(originalPath);
            expect(trustedOriginalPath).not.toBeNull();

            const workingPath = await createWorkingCopy(trustedOriginalPath!, 7);

            expect(existsSync(workingPath)).toBe(true);
            expect(getWorkingCopyBackingEntry(workingPath, 7)).toMatchObject({
                backingState: 'eager',
                originalFileExpectation: {
                    ctimeNs: expect.stringMatching(/^\d+$/u),
                    deviceId: expect.stringMatching(/^\d+$/u),
                    inode: expect.stringMatching(/^\d+$/u),
                    mtimeNs: expect.stringMatching(/^\d+$/u),
                    size: readFileSync(originalPath).byteLength,
                },
            });
            expect(writer).toHaveBeenCalledWith(expect.any(String), undefined, undefined);
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyDecryption');
            vi.resetModules();
        }
    });

    it('removes a recreated encrypted working copy when the writer still needs a password', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'success';
        const writer = vi.fn()
            .mockResolvedValueOnce({
                outcome: 'decrypted' as const,
                wasEncrypted: true as const,
                revision: null,
            })
            .mockResolvedValueOnce({
                outcome: 'needs-password' as const,
                wasEncrypted: true as const,
                revision: null,
            });
        vi.doMock('@electron/file-access/workingCopyDecryption', () => ({
            decryptWorkingCopyWithWriter: writer,
            PdfDecryptAttemptError: class PdfDecryptAttemptError extends Error {
                readonly outcome: 'needs-password' | 'unsupported-encryption';

                constructor(outcome: 'needs-password' | 'unsupported-encryption') {
                    super(outcome);
                    this.name = 'PdfDecryptAttemptError';
                    this.outcome = outcome;
                }
            },
        }));
        vi.resetModules();
        try {
            const {
                createWorkingCopy,
                ensureWorkingCopyDirectory,
            } = await import('@electron/file-access/workingCopyCreation');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const originalPath = join(tempRoot, 'recreated-encrypted.pdf');
            writeFileSync(originalPath, Buffer.from('%PDF encrypted bytes /Encrypt'));
            const trustedOriginalPath = allowOpenPath(originalPath);
            expect(trustedOriginalPath).not.toBeNull();

            const workingPath = await createWorkingCopy(trustedOriginalPath!, 7);
            const workingDirectory = dirname(workingPath);
            rmSync(workingDirectory, {
                force: true,
                recursive: true,
            });

            await expect(ensureWorkingCopyDirectory(workingPath, 7))
                .rejects.toMatchObject({outcome: 'needs-password'});
            expect(existsSync(workingPath)).toBe(false);
            expect(existsSync(workingDirectory)).toBe(false);
            expect(writer).toHaveBeenCalledTimes(2);
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyDecryption');
            vi.resetModules();
        }
    });

    it('publishes a PDF working copy without starting page identity discovery and joins it before mutation', async () => {
        const pageCount = deferred<number>();
        const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');
        vi.mocked(getPdfPageCount).mockImplementationOnce(() => pageCount.promise);
        const {createWorkingCopyFromPath} = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {awaitPageIdentityStoreInitialization} = await import('@electron/file-access/pageIdentityStore');
        const originalPath = join(tempRoot, 'background-page-identity.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        expect(existsSync(workingPath)).toBe(true);
        expect(getPdfPageCount).not.toHaveBeenCalled();

        let mutationSettled = false;
        const mutation = awaitPageIdentityStoreInitialization(workingPath)
            .finally(() => {
                mutationSettled = true;
            });
        await waitForSettledQueueTurn();
        expect(mutationSettled).toBe(false);

        pageCount.resolve(3);
        await expect(mutation).resolves.toBeUndefined();
        expect(JSON.parse(readFileSync(`${workingPath}.evb-pages.json`, 'utf8'))).toMatchObject({pageIds: expect.arrayContaining([
            expect.any(String),
            expect.any(String),
            expect.any(String),
        ])});
    });

    it('does not stack page-count or fingerprint work across repeated read-only opens', async () => {
        const fingerprintHash = vi.fn();
        vi.doMock('@electron/file-access/createOriginalFileContentFingerprintHash', () => ({createOriginalFileContentFingerprintHash: fingerprintHash}));

        try {
            const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');
            vi.mocked(getPdfPageCount).mockClear();
            const {createWorkingCopyFromPath} = await import('@electron/file-access/workingCopyCreation');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const {clearAllWorkingCopies} = await import('@electron/file-access/workingCopyCleanup');
            const originalPath = join(tempRoot, 'repeat-open.pdf');
            writeFileSync(originalPath, new Uint8Array([
                1,
                2,
                3,
            ]));
            const trustedOriginalPath = allowOpenPath(originalPath);
            expect(trustedOriginalPath).not.toBeNull();

            for (let index = 0; index < 3; index += 1) {
                await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
            }

            expect(getPdfPageCount).not.toHaveBeenCalled();
            expect(fingerprintHash).not.toHaveBeenCalled();
            await clearAllWorkingCopies();
        } finally {
            vi.doUnmock('@electron/file-access/createOriginalFileContentFingerprintHash');
        }
    });

    it('keeps a readable working copy when background page identity discovery fails but blocks mutation', async () => {
        const pageCount = deferred<number>();
        const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');
        vi.mocked(getPdfPageCount).mockImplementationOnce(() => pageCount.promise);
        const {createWorkingCopyFromPath} = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {awaitPageIdentityStoreInitialization} = await import('@electron/file-access/pageIdentityStore');
        const originalPath = join(tempRoot, 'failed-page-identity.pdf');
        writeFileSync(originalPath, new Uint8Array([
            4,
            5,
            6,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            4,
            5,
            6,
        ]));
        const mutation = awaitPageIdentityStoreInitialization(workingPath);
        await vi.waitFor(() => expect(getPdfPageCount).toHaveBeenCalled());
        pageCount.reject(new Error('page count unavailable'));

        await expect(mutation).rejects.toThrow('page count unavailable');
        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            4,
            5,
            6,
        ]));
    });

    it('prunes retired working-copy metadata after its TTL without requiring a later lookup', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
        const {
            getRetiredWorkingCopyOriginalCountForTests,
            rememberRetiredWorkingCopyOriginal,
        } = await import('@electron/file-access/workingCopyStore');

        rememberRetiredWorkingCopyOriginal('/tmp/retired.pdf', '/tmp/original.pdf');
        expect(getRetiredWorkingCopyOriginalCountForTests()).toBe(1);

        await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);

        expect(getRetiredWorkingCopyOriginalCountForTests()).toBe(0);
    });

    it('preserves lazy backing metadata and registration identity after retirement', async () => {
        const {
            captureWorkingCopyAdmissionSnapshot,
            forgetWorkingCopyOriginalPath,
            getWorkingCopyBackingMetadata,
            rememberRetiredWorkingCopyOriginal,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const originalPath = join(tempRoot, 'retired-lazy-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-retired-lazy', 'working.pdf');
        writeFileSync(originalPath, Buffer.alloc(64, 61));
        const admissionSnapshot = await captureWorkingCopyAdmissionSnapshot(originalPath);
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7, {
            admissionSnapshot,
            backingState: 'lazy-original',
            deferOriginalFileExpectation: true,
        });
        const activeMetadata = getWorkingCopyBackingMetadata(workingPath, 7);

        rememberRetiredWorkingCopyOriginal(workingPath, originalPath, 7);
        forgetWorkingCopyOriginalPath(workingPath);

        expect(getWorkingCopyBackingMetadata(workingPath, 7)).toEqual({
            ...activeMetadata,
            retired: true,
        });
    });

    it('never reuses registration IDs after the active registry is cleared', async () => {
        const {
            clearWorkingCopyOriginalPaths,
            getWorkingCopyRegistrationId,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const workingPath = join(tempRoot, 'pdf-work-registration-generation', 'working.pdf');
        await setWorkingCopyOriginalPath(
            workingPath,
            join(tempRoot, 'first.pdf'),
            7,
            {deferOriginalFileExpectation: true},
        );
        const firstRegistrationId = getWorkingCopyRegistrationId(workingPath, 7);

        clearWorkingCopyOriginalPaths();
        await setWorkingCopyOriginalPath(
            workingPath,
            join(tempRoot, 'second.pdf'),
            7,
            {deferOriginalFileExpectation: true},
        );

        expect(getWorkingCopyRegistrationId(workingPath, 7)).toBeGreaterThan(firstRegistrationId ?? 0);
    });

    it('recreates an active working copy directory from the original file', async () => {
        const {
            createWorkingCopyFromPath,
            ensureWorkingCopyDirectory,
        } = await import('@electron/file-access/workingCopyCreation');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const originalPath = join(tempRoot, 'original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!);
        rmSync(dirname(workingPath), {
            force: true,
            recursive: true,
        });

        await expect(ensureWorkingCopyDirectory(workingPath)).resolves.toBe(true);

        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            1,
            2,
            3,
        ]));

        await clearAllWorkingCopies();
    });

    it('recovers a recently cleaned working copy when a stale renderer path is reused', async () => {
        const {
            createWorkingCopyFromPath,
            ensureWorkingCopyDirectory,
        } = await import('@electron/file-access/workingCopyCreation');
        const { getWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            cleanupWorkingCopy,
            clearAllWorkingCopies,
        } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const originalPath = join(tempRoot, 'original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            4,
            5,
            6,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const canonicalOriginalPath = realpathSync.native(originalPath);

        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!);
        await cleanupWorkingCopy(workingPath);
        expect(existsSync(dirname(workingPath))).toBe(false);

        expect(getWorkingCopyOriginalPath(workingPath)).toEqual({
            originalPath: canonicalOriginalPath,
            retired: true,
        });
        await expect(ensureWorkingCopyDirectory(workingPath)).resolves.toBe(true);

        expect(getWorkingCopyOriginalPath(workingPath)).toEqual({
            originalPath: canonicalOriginalPath,
            retired: false,
        });
        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            4,
            5,
            6,
        ]));

        await clearAllWorkingCopies();
    });

    it('resyncs a working copy after it was marked sync-required', async () => {
        const { createWorkingCopyFromPath } = await import('@electron/file-access/workingCopyCreation');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const {
            assertWorkingCopyMutationAllowed,
            getWorkingCopyRevision,
            markWorkingCopySyncRequired,
        } = await import('@electron/file-access/documentRevisionStore');
        const { handleResyncWorkingCopy } = await import('@electron/features/documents/main/workingCopySave');
        const originalPath = join(tempRoot, 'resync-original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        const beforeRevision = await getWorkingCopyRevision(workingPath, 7);
        writeFileSync(originalPath, new Uint8Array([
            9,
            8,
            7,
        ]));
        markWorkingCopySyncRequired(workingPath, 'copy-back failed');

        await expect(handleResyncWorkingCopy({senderId: 7}, workingPath)).resolves.toMatchObject({
            ok: true,
            externalWriteCommitted: false,
            workingCopyRefreshed: true,
        });

        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            9,
            8,
            7,
        ]));
        expect(() => assertWorkingCopyMutationAllowed(workingPath)).not.toThrow();
        const afterRevision = await getWorkingCopyRevision(workingPath, 7);
        expect(afterRevision.contentRevision).toBe(beforeRevision.contentRevision + 1);
        expect(afterRevision.token).not.toBe(beforeRevision.token);

        await clearAllWorkingCopies();
    });

    it('resyncs a journaled sync-required working copy after module reload', async () => {
        const { createWorkingCopyFromPath } = await import('@electron/file-access/workingCopyCreation');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const {
            getWorkingCopyRevision,
            markWorkingCopySyncRequired,
        } = await import('@electron/file-access/documentRevisionStore');
        const originalPath = join(tempRoot, 'resync-reload-original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        const beforeRevision = await getWorkingCopyRevision(workingPath, 7);
        writeFileSync(originalPath, new Uint8Array([
            6,
            5,
            4,
        ]));
        markWorkingCopySyncRequired(workingPath, 'copy-back failed before restart');

        vi.resetModules();
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const {
            assertWorkingCopyMutationAllowed,
            getWorkingCopyRevision: getReloadedWorkingCopyRevision,
        } = await import('@electron/file-access/documentRevisionStore');
        const { readWorkingCopyRevisionJournalEntries } = await import('@electron/file-access/documentRevisionSidecar');
        const { handleResyncWorkingCopy } = await import('@electron/features/documents/main/workingCopySave');

        expect(() => assertWorkingCopyMutationAllowed(workingPath))
            .toThrow('copy-back failed before restart');
        await expect(handleResyncWorkingCopy({senderId: 7}, workingPath)).resolves.toMatchObject({
            ok: true,
            externalWriteCommitted: false,
            workingCopyRefreshed: true,
        });

        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            6,
            5,
            4,
        ]));
        expect(() => assertWorkingCopyMutationAllowed(workingPath)).not.toThrow();
        expect(readWorkingCopyRevisionJournalEntries(workingPath)
            .some(entry => entry.kind === 'working-copy-sync-required')).toBe(false);
        const afterRevision = await getReloadedWorkingCopyRevision(workingPath, 7);
        expect(afterRevision.contentRevision).toBe(beforeRevision.contentRevision + 1);
        expect(afterRevision.token).not.toBe(beforeRevision.token);

        await clearAllWorkingCopies();
    });

    it('preserves sync-required working copies during shutdown cleanup without renderer reporting', async () => {
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const {
            clearWorkingCopySyncRequired,
            markWorkingCopySyncRequired,
        } = await import('@electron/file-access/documentRevisionStore');
        const {
            getWorkingCopyOriginalPath,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const originalPath = join(tempRoot, 'sync-required-shutdown-original.pdf');
        const workingDir = join(tempRoot, 'evb-viewer', 'pdf-work-sync-required-shutdown');
        const workingPath = join(workingDir, 'sync-required-shutdown-original.pdf');

        mkdirSync(workingDir, {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);
        markWorkingCopySyncRequired(workingPath, 'renderer did not acknowledge committed save');

        try {
            await clearAllWorkingCopies();

            expect(existsSync(workingDir)).toBe(true);
            expect(getWorkingCopyOriginalPath(workingPath, 7)).toMatchObject({
                originalPath,
                retired: false,
            });
        } finally {
            clearWorkingCopySyncRequired(workingPath);
            await clearAllWorkingCopies();
        }
    });

    it('preserves WORKING_COPY_MISSING when both working copy and original are gone', async () => {
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');
        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const originalPath = join(tempRoot, 'missing-original.pdf');
        const workingDir = join(tempRoot, 'pdf-work-missing');
        const workingPath = join(workingDir, 'missing-original.pdf');
        await setWorkingCopyOriginalPath(workingPath, originalPath);

        const context = {senderId: 1};
        await expect(handleFileSaveStructured(context, workingPath, {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-missing-save')})).resolves.toMatchObject({
            ok: false,
            reason: 'working-copy-missing',
        });

        await clearAllWorkingCopies();
    });

    it('rejects unmanaged existing paths as managed working-copy sources', async () => {
        const { requireManagedWorkingCopyPath } = await import('@electron/file-access/workingCopyCreation');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const unmanagedPath = join(tempRoot, 'unmanaged.pdf');
        writeFileSync(unmanagedPath, new Uint8Array([
            7,
            8,
            9,
        ]));

        await expect(requireManagedWorkingCopyPath(unmanagedPath))
            .rejects.toThrow('Source path is not a managed working copy');

        await clearAllWorkingCopies();
    });

    it('uses one registration for symlink aliases of a working-copy path', async () => {
        const {
            getWorkingCopyBackingEntry,
            getWorkingCopyRegistrationId,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const {clearAllWorkingCopies} = await import('@electron/file-access/workingCopyCleanup');
        const realDirectory = join(tempRoot, 'evb-viewer', 'pdf-work-canonical');
        const aliasDirectory = join(tempRoot, 'working-copy-alias');
        const realWorkingPath = join(realDirectory, 'document.pdf');
        mkdirSync(realDirectory, {recursive: true});
        writeFileSync(realWorkingPath, new Uint8Array([1]));
        symlinkSync(realDirectory, aliasDirectory, 'dir');
        const aliasedWorkingPath = join(aliasDirectory, 'document.pdf');

        await setWorkingCopyOriginalPath(aliasedWorkingPath, join(tempRoot, 'original.pdf'), 7, {deferOriginalFileExpectation: true});

        expect(getWorkingCopyRegistrationId(realWorkingPath, 7)).not.toBeNull();
        expect(getWorkingCopyBackingEntry(realWorkingPath, 7)).toMatchObject({ownerWebContentsId: 7});
        expect(getWorkingCopyBackingEntry(aliasedWorkingPath, 7))
            .toBe(getWorkingCopyBackingEntry(realWorkingPath, 7));

        await clearAllWorkingCopies();
    });

    it('accepts a lazy managed ref without recreating or revising it', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
        process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE = 'lazy';
        const {
            createWorkingCopy,
            requireManagedWorkingCopyPath,
        } = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {clearAllWorkingCopies} = await import('@electron/file-access/workingCopyCleanup');
        const {getWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        const originalPath = join(tempRoot, 'lazy-managed-ref.pdf');
        writeFileSync(originalPath, Buffer.alloc(64 * 1024, 23));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const workingPath = await createWorkingCopy(trustedOriginalPath!, 7);
        const before = await getWorkingCopyRevision(workingPath, 7);

        await expect(requireManagedWorkingCopyPath(realpathSync.native(dirname(workingPath)) + `/${basename(workingPath)}`, 7))
            .resolves.toBe(realpathSync.native(dirname(workingPath)) + `/${basename(workingPath)}`);

        expect(existsSync(workingPath)).toBe(false);
        await expect(getWorkingCopyRevision(workingPath, 7)).resolves.toEqual(before);
        await clearAllWorkingCopies();
    });

    it('runs lazy working-copy reads against the witnessed original without materializing', async () => {
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
        process.env.EVB_WORKING_COPY_MATERIALIZATION_MODE = 'lazy';
        const {createWorkingCopy} = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {clearAllWorkingCopies} = await import('@electron/file-access/workingCopyCleanup');
        const {runWithWorkingCopyReadBacking} = await import('@electron/file-access/runWithWorkingCopyReadBacking');
        const originalPath = join(tempRoot, 'lazy-read-original.pdf');
        const originalBytes = Buffer.alloc(64 * 1024, 29);
        writeFileSync(originalPath, originalBytes);
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const workingPath = await createWorkingCopy(trustedOriginalPath!, 7);
        let physicalReadPath = '';

        const result = await runWithWorkingCopyReadBacking(
            workingPath,
            async (path) => {
                physicalReadPath = path;
                return readFileSync(path);
            },
            {ownerWebContentsId: 7},
        );

        expect(physicalReadPath).toBe(realpathSync.native(originalPath));
        expect(result).toEqual(originalBytes);
        expect(existsSync(workingPath)).toBe(false);
        await clearAllWorkingCopies();
    });

    it('matches Windows original paths by normalized identity', async () => {
        const workingPath = 'C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\Book.pdf';
        const originalPath = 'C:\\Users\\Alice\\Documents\\Book.pdf';
        const workingDirectory = win32.dirname(workingPath);
        const originalDirectory = win32.dirname(originalPath);
        const nativeRealpath = vi.fn((candidate: string) => {
            const normalizedCandidate = win32.resolve(candidate).toLowerCase();
            if (
                normalizedCandidate === win32.resolve(workingPath).toLowerCase()
                || normalizedCandidate === win32.resolve(originalPath).toLowerCase()
            ) {
                throw new Error('Windows test leaf is not materialized');
            }
            if (normalizedCandidate === win32.resolve(workingDirectory).toLowerCase()) {
                return workingDirectory;
            }
            if (normalizedCandidate === win32.resolve(originalDirectory).toLowerCase()) {
                return originalDirectory;
            }
            throw new Error(`Unexpected Windows path lookup: ${candidate}`);
        });
        vi.doMock('fs', async importOriginal => {
            const original = await importOriginal<typeof NodeFs>();
            return {
                ...original,
                realpathSync: {native: nativeRealpath},
            };
        });
        const spawnSync = vi.fn(() => ({
            stderr: '',
            stdout: 'Case sensitive attribute on directory is disabled.\\n',
        }));
        vi.doMock('node:child_process', async importOriginal => {
            const original = await importOriginal<typeof NodeChildProcess>();
            return {
                ...original,
                spawnSync,
            };
        });
        vi.resetModules();

        let clearAllWorkingCopies: (() => Promise<unknown>) | undefined;
        try {
            const {
                findWorkingCopyPathByOriginalPath,
                isKnownWorkingCopyOriginalPath,
                setWorkingCopyOriginalPath,
            } = await import('@electron/file-access/workingCopyStore');
            clearAllWorkingCopies = (await import('@electron/file-access/workingCopyCleanup')).clearAllWorkingCopies;
            await setWorkingCopyOriginalPath(workingPath, originalPath);

            expect(findWorkingCopyPathByOriginalPath('c:/users/alice/documents/book.pdf')).toBe(workingPath);
            expect(isKnownWorkingCopyOriginalPath('\\\\?\\C:\\Users\\Alice\\Documents\\Book.pdf')).toBe(true);
        } finally {
            await clearAllWorkingCopies?.();
            vi.doUnmock('fs');
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    });

    it('preserves leading and trailing whitespace in distinct working-copy keys', async () => {
        const {
            normalizePathForLookup,
            workingCopyMap,
        } = await import('@electron/file-access/workingCopyStore');
        const leadingPath = ' document-with-space.pdf';
        const trailingPath = 'document-with-space.pdf ';
        const createEntry = (registrationId: number): WorkingCopyStore.IWorkingCopyOriginalEntry => ({
            backingState: 'lazy-original',
            logicalPath: leadingPath,
            originalPath: leadingPath,
            ownerWebContentsId: 42,
            registeredAtMs: Date.now(),
            registrationId,
            role: 'current',
        });
        const leadingEntry = createEntry(1);
        const trailingEntry = createEntry(2);

        try {
            expect(normalizePathForLookup(' \t\n')).toBe('');
            expect(normalizePathForLookup(leadingPath)).not.toBe(normalizePathForLookup(trailingPath));
            workingCopyMap.set(leadingPath, leadingEntry);
            workingCopyMap.set(trailingPath, trailingEntry);

            expect(workingCopyMap.get(leadingPath)).toBe(leadingEntry);
            expect(workingCopyMap.get(trailingPath)).toBe(trailingEntry);
        } finally {
            workingCopyMap.clear();
        }
    });

    it('preserves case for Windows paths when no ancestor can be resolved', async () => {
        const nativeRealpath = vi.fn(() => {
            throw new Error('Windows path has no resolvable ancestor');
        });
        vi.doMock('fs', async importOriginal => {
            const original = await importOriginal<typeof NodeFs>();
            return {
                ...original,
                realpathSync: {native: nativeRealpath},
            };
        });
        vi.resetModules();

        try {
            const {
                normalizePathForLookup,
                workingCopyMap,
            } = await import('@electron/file-access/workingCopyStore');
            const upperCasePath = 'Z:\\unreachable\\pdf-work\\Report.pdf';
            const lowerCasePath = 'Z:\\unreachable\\pdf-work\\report.pdf';
            const upperCaseEntry: WorkingCopyStore.IWorkingCopyOriginalEntry = {
                backingState: 'lazy-original',
                logicalPath: upperCasePath,
                originalPath: upperCasePath,
                ownerWebContentsId: 42,
                registeredAtMs: Date.now(),
                registrationId: 1,
                role: 'current',
            };
            const lowerCaseEntry: WorkingCopyStore.IWorkingCopyOriginalEntry = {
                ...upperCaseEntry,
                logicalPath: lowerCasePath,
                originalPath: lowerCasePath,
                registrationId: 2,
            };

            expect(normalizePathForLookup(upperCasePath)).not.toBe(normalizePathForLookup(lowerCasePath));
            workingCopyMap.set(upperCasePath, upperCaseEntry);
            workingCopyMap.set(lowerCasePath, lowerCaseEntry);

            expect(workingCopyMap.get(upperCasePath)).toBe(upperCaseEntry);
            expect(workingCopyMap.get(lowerCasePath)).toBe(lowerCaseEntry);
        } finally {
            vi.doUnmock('fs');
            vi.resetModules();
        }
    });

    it('preserves missing Windows directory suffixes after resolving a higher ancestor', async () => {
        const shortCommonDirectory = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\evb-viewer-user';
        const longCommonDirectory = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\evb-viewer-user';
        const firstPath = `${shortCommonDirectory}\\pdf-work-first\\document.pdf`;
        const secondPath = `${shortCommonDirectory}\\pdf-work-second\\document.pdf`;
        const nativeRealpath = vi.fn((candidate: string) => {
            if (win32.resolve(candidate) === win32.resolve(shortCommonDirectory)) {
                return longCommonDirectory;
            }
            throw new Error('Windows path is not materialized yet');
        });
        vi.doMock('fs', async importOriginal => {
            const original = await importOriginal<typeof NodeFs>();
            return {
                ...original,
                realpathSync: {native: nativeRealpath},
            };
        });
        const spawnSync = vi.fn(() => ({
            stderr: '',
            stdout: 'Case sensitive attribute on directory is disabled.\\n',
        }));
        vi.doMock('node:child_process', async importOriginal => {
            const original = await importOriginal<typeof NodeChildProcess>();
            return {
                ...original,
                spawnSync,
            };
        });
        vi.resetModules();

        try {
            const {
                normalizePathForLookup,
                workingCopyMap,
            } = await import('@electron/file-access/workingCopyStore');
            const firstEntry: WorkingCopyStore.IWorkingCopyOriginalEntry = {
                backingState: 'lazy-original',
                logicalPath: firstPath,
                originalPath: firstPath,
                ownerWebContentsId: 42,
                registeredAtMs: Date.now(),
                registrationId: 1,
                role: 'current',
            };
            const secondEntry: WorkingCopyStore.IWorkingCopyOriginalEntry = {
                ...firstEntry,
                logicalPath: secondPath,
                originalPath: secondPath,
                registrationId: 2,
            };

            expect(normalizePathForLookup(firstPath)).not.toBe(normalizePathForLookup(secondPath));
            workingCopyMap.set(firstPath, firstEntry);
            workingCopyMap.set(secondPath, secondEntry);

            expect(workingCopyMap.get(firstPath)).toBe(firstEntry);
            expect(workingCopyMap.get(secondPath)).toBe(secondEntry);
            workingCopyMap.clear();
        } finally {
            vi.doUnmock('fs');
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    });

    it('keeps a missing Windows working-copy leaf stable across short-name materialization', async () => {
        const shortDirectory = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\evb-viewer-user\\pdf-work-1';
        const longDirectory = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\evb-viewer-user\\pdf-work-1';
        const shortWorkingPath = `${shortDirectory}\\document.pdf`;
        const longWorkingPath = `${longDirectory}\\document.pdf`;
        const nativeRealpath = vi.fn((candidate: string) => {
            const normalizedCandidate = win32.resolve(candidate);
            if (normalizedCandidate === win32.resolve(shortWorkingPath)) {
                throw new Error('working-copy leaf is not materialized yet');
            }
            if (normalizedCandidate === win32.resolve(shortDirectory)) {
                return longDirectory;
            }
            if (normalizedCandidate === win32.resolve(longWorkingPath)) {
                return longWorkingPath;
            }
            throw new Error(`Unexpected Windows path lookup: ${candidate}`);
        });
        vi.doMock('fs', async importOriginal => {
            const original = await importOriginal<typeof NodeFs>();
            return {
                ...original,
                realpathSync: {native: nativeRealpath},
            };
        });
        const spawnSync = vi.fn(() => ({
            stderr: '',
            stdout: 'Case sensitive attribute on directory is disabled.\\n',
        }));
        vi.doMock('node:child_process', async importOriginal => {
            const original = await importOriginal<typeof NodeChildProcess>();
            return {
                ...original,
                spawnSync,
            };
        });
        vi.resetModules();

        try {
            const {
                getWorkingCopyBackingEntry,
                workingCopyMap,
            } = await import('@electron/file-access/workingCopyStore');
            const entry: WorkingCopyStore.IWorkingCopyOriginalEntry = {
                backingState: 'lazy-original',
                logicalPath: shortWorkingPath,
                originalPath: 'C:\\Users\\runneradmin\\Documents\\document.pdf',
                ownerWebContentsId: 42,
                registeredAtMs: Date.now(),
                registrationId: 1,
                role: 'current',
            };

            // Registration happens before a lazy working-copy leaf exists.
            workingCopyMap.set(shortWorkingPath, entry);
            expect(nativeRealpath).toHaveBeenCalledWith(shortWorkingPath);

            // Materialization makes the same short spelling resolve to the long
            // native path. Both lookups must still address the registered entry.
            nativeRealpath.mockImplementation((candidate: string) => {
                const normalizedCandidate = win32.resolve(candidate);
                if (
                    normalizedCandidate === win32.resolve(shortWorkingPath)
                    || normalizedCandidate === win32.resolve(longWorkingPath)
                ) {
                    return longWorkingPath;
                }
                if (normalizedCandidate === win32.resolve(shortDirectory)) {
                    return longDirectory;
                }
                if (normalizedCandidate === win32.resolve(longDirectory)) {
                    return longDirectory;
                }
                throw new Error(`Unexpected Windows path lookup: ${candidate}`);
            });

            expect(getWorkingCopyBackingEntry(shortWorkingPath, 42)).toBe(entry);
            expect(getWorkingCopyBackingEntry(longWorkingPath, 42)).toBe(entry);
            workingCopyMap.clear();
        } finally {
            vi.doUnmock('fs');
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    });

    it('keeps original-path remapping scoped to the owning sender', async () => {
        const {
            findWorkingCopyPathByOriginalPath,
            isKnownWorkingCopyOriginalPath,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const workingPath = join(tempRoot, 'pdf-work-owned', 'Book.pdf');
        const originalPath = join(tempRoot, 'Book.pdf');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 10);

        expect(findWorkingCopyPathByOriginalPath(originalPath, 10)).toBe(workingPath);
        expect(isKnownWorkingCopyOriginalPath(originalPath, 10)).toBe(true);
        expect(findWorkingCopyPathByOriginalPath(originalPath, 11)).toBeNull();
        expect(isKnownWorkingCopyOriginalPath(originalPath, 11)).toBe(false);

        await clearAllWorkingCopies();
    });

    it('keeps snapshot clones out of original-path current resolution', async () => {
        const {
            createWorkingCopyFromData,
            createWorkingCopyFromPath,
        } = await import('@electron/file-access/workingCopyCreation');
        const {
            findWorkingCopyPathByOriginalPath,
            getWorkingCopyOriginalPath,
            getWorkingCopyRole,
        } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const originalPath = join(tempRoot, 'snapshot-original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            10,
            11,
            12,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const currentWorkingPath = await createWorkingCopyFromPath(trustedOriginalPath!);
        const snapshotWorkingPath = await createWorkingCopyFromPath(currentWorkingPath as TOpenPath, originalPath);
        const dataSnapshotWorkingPath = await createWorkingCopyFromData(
            'snapshot-original.pdf',
            new Uint8Array([
                13,
                14,
                15,
            ]),
            originalPath,
        );

        expect(snapshotWorkingPath).not.toBe(currentWorkingPath);
        expect(getWorkingCopyRole(snapshotWorkingPath)).toBe('snapshot');
        expect(getWorkingCopyRole(dataSnapshotWorkingPath)).toBe('snapshot');
        expect(getWorkingCopyOriginalPath(snapshotWorkingPath)).toMatchObject({originalPath});
        expect(findWorkingCopyPathByOriginalPath(originalPath)).toBe(currentWorkingPath);

        await clearAllWorkingCopies();
    });

    it('promotes the newest remaining current copy when the current mapping is retired', async () => {
        const {
            findWorkingCopyPathByOriginalPath,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const {
            cleanupWorkingCopy,
            clearAllWorkingCopies,
        } = await import('@electron/file-access/workingCopyCleanup');
        const originalPath = join(tempRoot, 'promote-original.pdf');
        const firstWorkingPath = join(tempRoot, 'pdf-work-promote-1', 'promote-original.pdf');
        const secondWorkingPath = join(tempRoot, 'pdf-work-promote-2', 'promote-original.pdf');
        writeFileSync(originalPath, new Uint8Array([1]));
        mkdirSync(dirname(firstWorkingPath), {recursive: true});
        mkdirSync(dirname(secondWorkingPath), {recursive: true});
        writeFileSync(firstWorkingPath, new Uint8Array([1]));
        writeFileSync(secondWorkingPath, new Uint8Array([1]));

        await setWorkingCopyOriginalPath(firstWorkingPath, originalPath);
        await setWorkingCopyOriginalPath(secondWorkingPath, originalPath);

        expect(findWorkingCopyPathByOriginalPath(originalPath)).toBe(secondWorkingPath);
        await cleanupWorkingCopy(secondWorkingPath);

        expect(findWorkingCopyPathByOriginalPath(originalPath)).toBe(firstWorkingPath);

        await clearAllWorkingCopies();
    });

    it('waits for an in-flight mutation before retiring ownership and removing the working directory', async () => {
        const {createWorkingCopyFromPath} = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {cleanupWorkingCopy} = await import('@electron/file-access/workingCopyCleanup');
        const {workingCopyMap} = await import('@electron/file-access/workingCopyStore');
        const {enqueueWorkingCopyMutation} = await import('@electron/file-access/workingCopyMutationQueue');
        const originalPath = join(tempRoot, 'cleanup-during-mutation.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        const mutationStarted = deferred<undefined>();
        const releaseMutation = deferred<undefined>();
        const mutation = enqueueWorkingCopyMutation(workingPath, async () => {
            mutationStarted.resolve(undefined);
            await releaseMutation.promise;
        });
        await mutationStarted.promise;

        const cleanup = cleanupWorkingCopy(workingPath, 7);
        await waitForSettledQueueTurn();

        expect(workingCopyMap.has(workingPath)).toBe(true);
        expect(existsSync(dirname(workingPath))).toBe(true);

        releaseMutation.resolve(undefined);
        await mutation;
        await cleanup;

        expect(workingCopyMap.has(workingPath)).toBe(false);
        expect(existsSync(dirname(workingPath))).toBe(false);
    });

    it('does not let a delayed original expectation update overwrite a newer registration', async () => {
        const actualFs = await import('fs/promises');
        const firstStat = deferred<Awaited<ReturnType<typeof actualFs.stat>>>();
        let firstStatRequested = false;

        try {
            const firstOriginalPath = join(tempRoot, 'first-original.pdf');
            vi.doMock('fs/promises', async (importOriginal) => {
                const original = await importOriginal<typeof FsPromises>();
                return {
                    ...original,
                    stat: vi.fn(async (...args: Parameters<typeof original.stat>) => {
                        if (args[0] === firstOriginalPath && !firstStatRequested) {
                            firstStatRequested = true;
                            return firstStat.promise;
                        }
                        return original.stat(...args);
                    }),
                };
            });
            const {
                getWorkingCopyOriginalFileExpectation,
                getWorkingCopyOriginalPath,
                setWorkingCopyOriginalPath,
            } = await import('@electron/file-access/workingCopyStore');
            const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
            const secondOriginalPath = join(tempRoot, 'second-original.pdf');
            const workingPath = join(tempRoot, 'pdf-work-async-registration', 'working.pdf');
            mkdirSync(dirname(workingPath), {recursive: true});
            writeFileSync(firstOriginalPath, new Uint8Array([1]));
            writeFileSync(secondOriginalPath, new Uint8Array([2]));
            writeFileSync(workingPath, new Uint8Array([3]));

            const firstRegistration = setWorkingCopyOriginalPath(workingPath, firstOriginalPath, 10);
            await vi.waitFor(() => {
                expect(firstStatRequested).toBe(true);
            });
            await setWorkingCopyOriginalPath(workingPath, secondOriginalPath, 10);

            expect(getWorkingCopyOriginalPath(workingPath, 10)).toMatchObject({
                originalPath: secondOriginalPath,
                retired: false,
            });
            expect(getWorkingCopyOriginalFileExpectation(workingPath, 10)).toMatchObject({
                inode: expect.stringMatching(/^\d+$/u),
                size: 1,
            });

            firstStat.resolve(await actualFs.stat(firstOriginalPath, {bigint: true}));
            await firstRegistration;

            expect(getWorkingCopyOriginalPath(workingPath, 10)).toMatchObject({
                originalPath: secondOriginalPath,
                retired: false,
            });
            expect(getWorkingCopyOriginalFileExpectation(workingPath, 10)).toMatchObject({
                inode: expect.stringMatching(/^\d+$/u),
                size: 1,
            });

            await clearAllWorkingCopies();
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it('does not let a delayed expectation refresh overwrite a newer registration', async () => {
        const actualFs = await import('fs/promises');
        const refreshStat = deferred<Awaited<ReturnType<typeof actualFs.stat>>>();
        let firstPathStatCalls = 0;

        try {
            const firstOriginalPath = join(tempRoot, 'refresh-first-original.pdf');
            vi.doMock('fs/promises', async (importOriginal) => {
                const original = await importOriginal<typeof FsPromises>();
                return {
                    ...original,
                    stat: vi.fn(async (...args: Parameters<typeof original.stat>) => {
                        if (args[0] === firstOriginalPath) {
                            firstPathStatCalls += 1;
                            if (firstPathStatCalls === 2) {
                                return refreshStat.promise;
                            }
                        }
                        return original.stat(...args);
                    }),
                };
            });
            const {
                getWorkingCopyOriginalFileExpectation,
                refreshWorkingCopyOriginalFileExpectation,
                setWorkingCopyOriginalPath,
            } = await import('@electron/file-access/workingCopyStore');
            const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
            const secondOriginalPath = join(tempRoot, 'refresh-second-original.pdf');
            const workingPath = join(tempRoot, 'pdf-work-async-refresh', 'working.pdf');
            mkdirSync(dirname(workingPath), {recursive: true});
            writeFileSync(firstOriginalPath, new Uint8Array([1]));
            writeFileSync(secondOriginalPath, new Uint8Array([2]));
            writeFileSync(workingPath, new Uint8Array([3]));

            await setWorkingCopyOriginalPath(workingPath, firstOriginalPath, 10);
            const refreshPromise = refreshWorkingCopyOriginalFileExpectation(workingPath, 10);
            await vi.waitFor(() => {
                expect(firstPathStatCalls).toBe(2);
            });
            await setWorkingCopyOriginalPath(workingPath, secondOriginalPath, 10);

            refreshStat.resolve(await actualFs.stat(firstOriginalPath, {bigint: true}));
            await expect(refreshPromise).resolves.toBe(false);
            expect(getWorkingCopyOriginalFileExpectation(workingPath, 10)).toMatchObject({
                inode: expect.stringMatching(/^\d+$/u),
                size: 1,
            });

            await clearAllWorkingCopies();
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it('removes stale OCR sidecar directories with stale working-copy directories', async () => {
        const { cleanupStaleWorkingCopyDirectories } = await import('@electron/file-access/workingCopyCleanup');
        const appTempDir = join(tempRoot, 'evb-viewer');
        const workDir = join(appTempDir, 'pdf-work-stale-ocr');
        const ocrDir = `${workDir}.ocr`;
        mkdirSync(workDir, {recursive: true});
        mkdirSync(ocrDir, {recursive: true});
        writeFileSync(join(workDir, 'document.pdf'), new Uint8Array([1]));
        writeFileSync(join(ocrDir, 'manifest.json'), '{}');

        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        utimesSync(workDir, staleDate, staleDate);

        await expect(cleanupStaleWorkingCopyDirectories()).resolves.toEqual({
            removedDirectories: 1,
            removedOcrDirectories: 1,
        });
        expect(existsSync(workDir)).toBe(false);
        expect(existsSync(ocrDir)).toBe(false);
    });

    it('removes a stale atomic-replace backup after a Windows promotion crash when its destination survived', async () => {
        setPlatform('win32');
        const {cleanupStaleWorkingCopyDirectories} = await import('@electron/file-access/workingCopyCleanup');
        const appTempDir = join(tempRoot, 'evb-viewer');
        const workDir = join(appTempDir, 'pdf-work-orphaned-atomic-backup');
        const destinationPath = join(workDir, 'document.pdf');
        const backupPath = `${destinationPath}.bak-0123456789abcdef`;
        mkdirSync(workDir, {recursive: true});
        writeFileSync(destinationPath, new Uint8Array([2]));
        writeFileSync(backupPath, new Uint8Array([1]));
        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        utimesSync(backupPath, staleDate, staleDate);

        await cleanupStaleWorkingCopyDirectories();

        expect(existsSync(destinationPath)).toBe(true);
        expect(existsSync(backupPath)).toBe(false);
    });

    it('retains fresh, destinationless, active, and unrelated backup siblings during the Windows sweep', async () => {
        setPlatform('win32');
        const {
            cleanupStaleWorkingCopyDirectories,
            clearAllWorkingCopies,
        } = await import('@electron/file-access/workingCopyCleanup');
        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const appTempDir = join(tempRoot, 'evb-viewer');
        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        const createBackup = (name: string, hasDestination: boolean, backupDate: Date) => {
            const workDir = join(appTempDir, `pdf-work-${name}`);
            const destinationPath = join(workDir, `${name}.pdf`);
            const backupPath = `${destinationPath}.bak-0123456789abcdef`;
            mkdirSync(workDir, {recursive: true});
            if (hasDestination) {
                writeFileSync(destinationPath, new Uint8Array([2]));
            }
            writeFileSync(backupPath, new Uint8Array([1]));
            utimesSync(backupPath, backupDate, backupDate);
            utimesSync(workDir, staleDate, staleDate);
            return {
                backupPath,
                destinationPath,
                workDir,
            };
        };
        const fresh = createBackup('fresh', true, new Date());
        const destinationless = createBackup('destinationless', false, staleDate);
        const active = createBackup('active', true, staleDate);
        const unrelatedWorkDir = join(appTempDir, 'pdf-work-unrelated');
        const unrelatedPath = join(unrelatedWorkDir, 'unrelated.bak-not-an-atomic-backup');
        mkdirSync(unrelatedWorkDir, {recursive: true});
        writeFileSync(unrelatedPath, new Uint8Array([3]));
        utimesSync(unrelatedWorkDir, staleDate, staleDate);
        const unmanagedDir = join(tempRoot, 'user-files');
        const unmanagedDestinationPath = join(unmanagedDir, 'document.pdf');
        const unmanagedBackupPath = `${unmanagedDestinationPath}.bak-0123456789abcdef`;
        mkdirSync(unmanagedDir, {recursive: true});
        writeFileSync(unmanagedDestinationPath, new Uint8Array([4]));
        writeFileSync(unmanagedBackupPath, new Uint8Array([5]));
        utimesSync(unmanagedBackupPath, staleDate, staleDate);
        const originalPath = join(tempRoot, 'active-original.pdf');

        try {
            await setWorkingCopyOriginalPath(active.destinationPath, originalPath, undefined, {deferOriginalFileExpectation: true});
            await cleanupStaleWorkingCopyDirectories();

            expect(existsSync(fresh.backupPath)).toBe(true);
            expect(existsSync(destinationless.backupPath)).toBe(true);
            expect(existsSync(active.backupPath)).toBe(true);
            expect(existsSync(unrelatedPath)).toBe(true);
            expect(existsSync(fresh.workDir)).toBe(true);
            expect(existsSync(destinationless.workDir)).toBe(true);
            expect(existsSync(active.workDir)).toBe(true);
            expect(existsSync(unrelatedWorkDir)).toBe(true);
            expect(existsSync(unmanagedBackupPath)).toBe(true);
        } finally {
            await clearAllWorkingCopies();
        }
    });

    it('never sweeps an actively registered working-copy directory', async () => {
        const {cleanupStaleWorkingCopyDirectories} = await import('@electron/file-access/workingCopyCleanup');
        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const appTempDir = join(tempRoot, 'evb-viewer');
        const workDir = join(appTempDir, 'pdf-work-active-but-old');
        const workingPath = join(workDir, 'document.pdf');
        mkdirSync(workDir, {recursive: true});
        writeFileSync(workingPath, new Uint8Array([1]));
        await setWorkingCopyOriginalPath(workingPath, join(tempRoot, 'original.pdf'), 7, {deferOriginalFileExpectation: true});
        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        utimesSync(workDir, staleDate, staleDate);

        await expect(cleanupStaleWorkingCopyDirectories()).resolves.toEqual({
            removedDirectories: 0,
            removedOcrDirectories: 0,
        });
        expect(existsSync(workingPath)).toBe(true);
    });

    it('bounds stale working-copy stats to eight workers and honors a smaller limit', async () => {
        let activeStats = 0;
        let maximumActiveStats = 0;
        vi.doMock('fs/promises', async (importOriginal) => {
            const actual = await importOriginal<typeof FsPromises>();
            return {
                ...actual,
                stat: async (...args: Parameters<typeof actual.stat>) => {
                    activeStats += 1;
                    maximumActiveStats = Math.max(maximumActiveStats, activeStats);
                    await new Promise(resolve => setTimeout(resolve, 5));
                    try {
                        return await actual.stat(...args);
                    } finally {
                        activeStats -= 1;
                    }
                },
            };
        });
        try {
            const appTempDir = join(tempRoot, 'evb-viewer');
            const createStaleDirectories = (prefix: string) => {
                for (let index = 0; index < 12; index += 1) {
                    const workDir = join(appTempDir, `pdf-work-${prefix}-${index}`);
                    mkdirSync(workDir, {recursive: true});
                    const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
                    utimesSync(workDir, staleDate, staleDate);
                }
            };
            createStaleDirectories('default');
            const { cleanupStaleWorkingCopyDirectories } = await import('@electron/file-access/workingCopyCleanup');

            await cleanupStaleWorkingCopyDirectories();
            expect(maximumActiveStats).toBe(8);

            maximumActiveStats = 0;
            createStaleDirectories('limited');
            await cleanupStaleWorkingCopyDirectories({statConcurrency: 3});
            expect(maximumActiveStats).toBe(3);
        } finally {
            vi.doUnmock('fs/promises');
        }
    });

    it('serializes mutation queue entries that use different spellings of one Windows path', async () => {
        const workingDirectory = 'C:\\Temp\\pdf-work-1';
        const nativeRealpath = vi.fn((candidate: string) => {
            if (win32.resolve(candidate).toLowerCase() === win32.resolve(workingDirectory).toLowerCase()) {
                return workingDirectory;
            }
            throw new Error(`Unexpected Windows path lookup: ${candidate}`);
        });
        vi.doMock('fs', async importOriginal => {
            const original = await importOriginal<typeof NodeFs>();
            return {
                ...original,
                realpathSync: {native: nativeRealpath},
            };
        });
        const spawnSync = vi.fn(() => ({
            stderr: '',
            stdout: 'Case sensitive attribute on directory is disabled.\\n',
        }));
        vi.doMock('node:child_process', async importOriginal => {
            const original = await importOriginal<typeof NodeChildProcess>();
            return {
                ...original,
                spawnSync,
            };
        });
        vi.resetModules();

        try {
            const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
            const blockedMutation = deferred<undefined>();
            const operations: string[] = [];

            const firstMutation = enqueueWorkingCopyMutation('C:\\Temp\\pdf-work-1\\Book.pdf', async () => {
                operations.push('first-start');
                await blockedMutation.promise;
                operations.push('first-end');
            });
            const secondMutation = enqueueWorkingCopyMutation('\\\\?\\c:\\temp\\pdf-work-1\\book.pdf', async () => {
                operations.push('second-start');
            });
            await waitForSettledQueueTurn();

            expect(operations).toEqual(['first-start']);

            blockedMutation.resolve(undefined);
            await Promise.all([
                firstMutation,
                secondMutation,
            ]);

            expect(operations).toEqual([
                'first-start',
                'first-end',
                'second-start',
            ]);
        } finally {
            vi.doUnmock('fs');
            vi.doUnmock('node:child_process');
            vi.resetModules();
        }
    });

    it('waits for queued mutations before clearing all working copies', async () => {
        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const originalPath = join(tempRoot, 'drain-original.pdf');
        const workingDir = join(tempRoot, 'evb-viewer', 'pdf-work-drain');
        const workingPath = join(workingDir, 'drain-original.pdf');
        const blockedMutation = deferred<undefined>();
        const operations: string[] = [];
        mkdirSync(workingDir, {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));
        await setWorkingCopyOriginalPath(workingPath, originalPath);

        const mutation = enqueueWorkingCopyMutation(workingPath, async () => {
            operations.push('mutation-start');
            await blockedMutation.promise;
            operations.push(`dir-exists:${existsSync(workingDir)}`);
        });
        await waitForSettledQueueTurn();

        const clearPromise = clearAllWorkingCopies().then(() => {
            operations.push('clear-done');
        });
        await waitForSettledQueueTurn();

        expect(existsSync(workingDir)).toBe(true);
        expect(operations).toEqual(['mutation-start']);

        blockedMutation.resolve(undefined);
        await mutation;
        await clearPromise;

        expect(operations).toEqual([
            'mutation-start',
            'dir-exists:true',
            'clear-done',
        ]);
        expect(existsSync(workingDir)).toBe(false);
    });

    it('registers queued mutations as critical writes and fail-closes aborted queued entries during shutdown', async () => {
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const {
            beginMainOperationShutdown,
            cancelAllMainOperations,
            drainCriticalMainOperations,
            resetMainOperationLifecycleForTests,
            snapshotMainOperations,
        } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const workingPath = join(tempRoot, 'shutdown-queued.pdf');
        const blockedMutation = deferred<undefined>();
        const operations: string[] = [];
        writeFileSync(workingPath, new Uint8Array([1]));

        const firstMutation = enqueueWorkingCopyMutation(workingPath, async () => {
            operations.push('first-start');
            await blockedMutation.promise;
            operations.push('first-end');
        });
        const secondMutation = enqueueWorkingCopyMutation(workingPath, async () => {
            operations.push('second-start');
        });
        await waitForSettledQueueTurn();

        expect(snapshotMainOperations()).toEqual([
            expect.objectContaining({
                kind: 'critical-write',
                workingCopyPath: workingPath,
            }),
            expect.objectContaining({
                kind: 'critical-write',
                workingCopyPath: workingPath,
            }),
        ]);

        beginMainOperationShutdown('Main process is shutting down');
        cancelAllMainOperations('app shutdown');
        const drainPromise = drainCriticalMainOperations({timeoutMs: 1_000});

        blockedMutation.resolve(undefined);
        await firstMutation;
        await expect(secondMutation).rejects.toThrow('app shutdown');
        await expect(drainPromise).resolves.toEqual({
            completed: true,
            pending: [],
        });
        expect(operations).toEqual([
            'first-start',
            'first-end',
        ]);
        resetMainOperationLifecycleForTests();
    });

    it('rejects new queued mutations with a typed shutdown envelope after admission closes', async () => {
        const { getMainOperationErrorEnvelope } = await import('@contracts/mainOperationErrors');
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const {
            beginMainOperationShutdown,
            resetMainOperationLifecycleForTests,
        } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        beginMainOperationShutdown('Main process is shutting down');

        let caught: unknown;
        try {
            void enqueueWorkingCopyMutation(join(tempRoot, 'late.pdf'), async () => undefined);
        } catch (error) {
            caught = error;
        }

        expect(getMainOperationErrorEnvelope(caught)).toEqual({
            code: 'shutting-down',
            message: 'Main process is shutting down',
        });
        resetMainOperationLifecycleForTests();
    });

    it('marks queued mutation commit once an atomic replacement starts', async () => {
        const { atomicReplace } = await import('@electron/utils/atomicReplace');
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const {
            resetMainOperationLifecycleForTests,
            snapshotMainOperations,
        } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const targetPath = join(tempRoot, 'commit-target.pdf');
        const tempPath = join(tempRoot, 'commit-temp.pdf');
        writeFileSync(targetPath, 'old');
        writeFileSync(tempPath, 'new');

        await enqueueWorkingCopyMutation(targetPath, async () => {
            expect(snapshotMainOperations()).toEqual([expect.objectContaining({
                commitStarted: false,
                workingCopyPath: targetPath,
            })]);
            await atomicReplace(tempPath, targetPath);
            expect(snapshotMainOperations()).toEqual([expect.objectContaining({
                commitStarted: true,
                workingCopyPath: targetPath,
            })]);
        });

        expect(readFileSync(targetPath, 'utf8')).toBe('new');
        resetMainOperationLifecycleForTests();
    });

    it('can durably replace a sidecar without marking user-document commit started', async () => {
        const {atomicReplace} = await import('@electron/utils/atomicReplace');
        const {enqueueWorkingCopyMutation} = await import('@electron/file-access/workingCopyMutationQueue');
        const {
            resetMainOperationLifecycleForTests,
            snapshotMainOperations,
        } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const targetPath = join(tempRoot, 'revision-sidecar.json');
        const tempPath = join(tempRoot, 'revision-sidecar.tmp');
        writeFileSync(targetPath, 'old');
        writeFileSync(tempPath, 'new');

        await enqueueWorkingCopyMutation(targetPath, async () => {
            await atomicReplace(tempPath, targetPath, {markMutationCommitStarted: false});
            expect(snapshotMainOperations()).toEqual([expect.objectContaining({
                commitStarted: false,
                workingCopyPath: targetPath,
            })]);
        });

        expect(readFileSync(targetPath, 'utf8')).toBe('new');
        resetMainOperationLifecycleForTests();
    });
});

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
    await new Promise(resolve => setTimeout(resolve, 20));
}
