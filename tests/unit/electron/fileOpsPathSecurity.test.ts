import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';
import type * as TViMockOriginalModule2 from '@electron/file-access/originalPathSaveWitness';
import type * as NodeFs from 'node:fs';
import type * as NodeFsPromises from 'node:fs/promises';
import type * as TPdfConformance from '@electron/features/documents/main/pdfConformance';
import type * as TChildProcess from 'node:child_process';
import type * as TNativeChildProcess from '@electron/utils/nativeChildProcess';
import type * as TNativeToolPaths from '@electron/pdf/nativeToolPaths';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    dirname,
    join,
    resolve,
    sep,
} from 'node:path';
import {escapeRegExp} from 'es-toolkit/string';
import {
    Readable,PassThrough,
} from 'node:stream';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import {
    markUnprovenNativeTermination, getUnprovenNativeTerminationDetail,
} from '@electron/utils/nativeTerminationProof';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn<(path: string) => boolean>(),
    lstatSync: vi.fn<(path: string) => { isSymbolicLink: () => boolean; }>(),
    realpathSync: vi.fn<(path: string) => string>(),
    statSync: vi.fn<(path: string) => {
        size: number;
        mtimeMs?: number;
    }>(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    copyFile: vi.fn(),
    cp: vi.fn(),
    readdir: vi.fn(),
    rm: vi.fn(),
    access: vi.fn(),
    lstat: vi.fn<(path: string) => Promise<{ isSymbolicLink: () => boolean; }>>(),
    realpath: vi.fn<(path: string) => Promise<string>>(),
    stat: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
    open: vi.fn(),
    isAllowedReadPath: vi.fn<(path: string) => boolean>(),
    isAllowedWritePath: vi.fn<(path: string) => boolean>(),
    resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(),
    resolveAllowedWritePath: vi.fn<(path: string) => Promise<string | null>>(),
    analyzePdfConformanceFile: vi.fn(),
    validatePdfFile: vi.fn(),
    nativeSpawn: vi.fn(),
    nativeTermination: vi.fn(),
    consumeAllowedDocxWritePath: vi.fn<(path: string, senderId: number) => boolean>(),
    findWorkingCopyPathByOriginalPath: vi.fn<(path: string, senderId?: number) => string | null>(),
    getWorkingCopyBackingEntry: vi.fn(),
    admittedWorkingCopyBackingEntry: null as typeof TViMockOriginalModule.getWorkingCopyBackingEntry | null,
    getWorkingCopyOriginalPath: vi.fn(),
    captureWorkingCopyAdmissionSnapshot: vi.fn(),
    transitionWorkingCopyBackingState: vi.fn(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    transitionWorkingCopyContentRevision: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn<(path: string, senderId?: number) => Promise<boolean>>(),
    originalPathSaveBaseMatches: vi.fn(),
    isAllowedDjvuViewingPath: vi.fn<(path: string) => boolean>(),
    findOcrResultForDocument: vi.fn(),
    backingSwapCacheInvalidator: null as null | ((logicalRef: string, previousPhysicalPath: string) => Promise<void> | void),
    ensureWorkingCopyMaterialized: vi.fn(),
}));

vi.mock('fs', () => ({
    constants: {
        COPYFILE_FICLONE: 2,
        COPYFILE_FICLONE_FORCE: 4,
    },
    createReadStream: () => Readable.from(Buffer.from([
        1,
        2,
        3,
    ])),
    existsSync: (path: string) => mocks.existsSync(path),
    lstatSync: (path: string) => mocks.lstatSync(path),
    realpathSync: (path: string) => mocks.realpathSync(path),
    statSync: (path: string) => mocks.statSync(path),
}));

vi.mock('fs/promises', () => ({
    cp: mocks.cp,
    copyFile: mocks.copyFile,
    readFile: mocks.readFile,
    readdir: mocks.readdir,
    writeFile: mocks.writeFile,
    access: mocks.access,
    lstat: mocks.lstat,
    realpath: mocks.realpath,
    stat: mocks.stat,
    unlink: mocks.unlink,
    rename: mocks.rename,
    rm: mocks.rm,
    open: mocks.open,
}));

vi.mock('@electron/utils/pathValidator', () => ({
    describeReadPathValidationForDiagnostics: () => 'validator-diagnostics-stub',
    getManagedTempPathAccessDecision: vi.fn(() => undefined),
    setManagedTempPathAccessValidator: vi.fn(),
    isAllowedReadPath: mocks.isAllowedReadPath,
    isAllowedWritePath: mocks.isAllowedWritePath,
    resolveAllowedReadPath: mocks.resolveAllowedReadPath,
    resolveAllowedWritePath: mocks.resolveAllowedWritePath,
}));

vi.mock('@electron/features/documents/main/pdfConformance', async (importOriginal) => ({
    ...(await importOriginal<typeof TPdfConformance>()),
    analyzePdfConformanceFile: mocks.analyzePdfConformanceFile,
    validatePdfFile: mocks.validatePdfFile,
}));
vi.mock('child_process', async importOriginal => ({
    ...(await importOriginal<typeof TChildProcess>()),
    spawn: mocks.nativeSpawn,
}));
vi.mock('@electron/utils/nativeChildProcess', async importOriginal => ({
    ...(await importOriginal<typeof TNativeChildProcess>()),
    terminateDetachedChildProcess: mocks.nativeTermination,
}));
vi.mock('@electron/pdf/nativeToolPaths', async importOriginal => ({
    ...(await importOriginal<typeof TNativeToolPaths>()),
    getPdfNativeToolPaths: () => ({qpdf: '/mock/qpdf'}),
}));
vi.mock('@electron/features/page-ops/main/resolveNativePageOpsPath', () => ({resolveNativePageOpsPath: () => '/mock/page-ops'}));
vi.mock('@electron/file-access/docxExportPaths', () => ({consumeAllowedDocxWritePath: mocks.consumeAllowedDocxWritePath}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory}));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => {
    const actual = await importOriginal<typeof TViMockOriginalModule>();
    mocks.admittedWorkingCopyBackingEntry = actual.getWorkingCopyBackingEntry;
    return {
        ...actual,
        captureWorkingCopyAdmissionSnapshot: mocks.captureWorkingCopyAdmissionSnapshot,
        getWorkingCopyOwnerWebContentsId: () => undefined,
        findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath,
        getWorkingCopyBackingEntry: mocks.getWorkingCopyBackingEntry,
        getWorkingCopyOriginalPath: mocks.getWorkingCopyOriginalPath,
        normalizePathForLookup: (path: string) => path.trim().replace(/^\/var(?=\/)/u, '/private/var'),
        refreshWorkingCopyOriginalFileExpectation: mocks.refreshWorkingCopyOriginalFileExpectation,
        transitionWorkingCopyBackingState: mocks.transitionWorkingCopyBackingState,
        workingCopyAdmissionSnapshotsMatch: (
            left: {
                size: bigint;
                mtimeNs: bigint;
            },
            right: {
                size: bigint;
                mtimeNs: bigint;
            },
        ) => left.size === right.size && left.mtimeNs === right.mtimeNs,
    };
});
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({
    ensureWorkingCopyMaterialized: (...args: unknown[]) => mocks.ensureWorkingCopyMaterialized(...args),
    onWorkingCopyBackingSwapCacheInvalidation: (
        invalidator: (logicalRef: string, previousPhysicalPath: string) => Promise<void> | void,
    ) => {
        mocks.backingSwapCacheInvalidator = invalidator;
        return () => {
            mocks.backingSwapCacheInvalidator = null;
        };
    },
    WorkingCopyMaterializationError: class WorkingCopyMaterializationError extends Error {
        readonly code: string;

        constructor(code: string, message: string, options: {cause?: unknown} = {}) {
            super(message, options.cause === undefined ? undefined : {cause: options.cause});
            this.name = 'WorkingCopyMaterializationError';
            this.code = code;
        }
    },
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({
    clearWorkingCopyRevisionInitializations: vi.fn(),
    forgetWorkingCopyRevisionInitialization: vi.fn(),
    hasWorkingCopySyncRequired: () => false,
    markWorkingCopyContentChanged: mocks.markWorkingCopyContentChanged,
    transitionWorkingCopyContentRevision: mocks.transitionWorkingCopyContentRevision,
}));
vi.mock('@electron/file-access/documentMutationGuards', () => ({
    assertQueuedWorkingCopyMutationPreconditions: vi.fn(),
    assertWorkingCopyMutationAllowed: vi.fn(),
    normalizeExpectedDocumentRevisionToken: (options?: { expectedDocumentRevisionToken?: string | null; } | null) =>
        options?.expectedDocumentRevisionToken?.trim() ?? null,
}));
vi.mock('@electron/file-access/originalPathSaveWitness', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    originalPathSaveBaseMatches: mocks.originalPathSaveBaseMatches,
}));
vi.mock('@electron/features/djvu/public', () => ({isAllowedDjvuViewingPath: mocks.isAllowedDjvuViewingPath}));
vi.mock('@electron/features/ocr/public/index', () => ({findOcrResultForDocument: mocks.findOcrResultForDocument}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const {
    clearCachedRangeReadHandlesForTests,
    getRangeReadCacheStatsForTests,
    handleFileRead,
    handleFileReadRange,
    handleFileStat,
    resolveOriginalBackedReadTransport,
} = await import('@electron/features/documents/main/documentFileReadHandlers');
const { resolveExistingReadablePdfPath } = await import('@electron/features/documents/main/documentFilePathResolution');
const {
    handleFileWrite,
    handleFileWriteDocx,
    handleReplaceWorkingCopyFromPath,
} = await import('@electron/features/documents/main/documentFileWriteHandlers');
const {
    handleAnalyzePdfConformance,
    handleValidatePdfPath,
} = await import('@electron/features/documents/main/documentPdfValidationHandlers');
const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
const { cancelMainOperationsForClosingWorkingCopy } = await import('@electron/operation-lifecycle/mainOperationLifecycle');

describe('fileOps path security', () => {
    const readContext = {senderId: 42};
    const writeContext = {senderId: 42};
    let previousForcedCloneResult: string | undefined;
    const lazyOriginalEntry = () => ({
        admissionSnapshot: {
            size: 123n,
            mtimeNs: 1_000_000n,
        },
        backingState: 'lazy-original',
        originalPath: '/Users/alice/Documents/file.pdf',
        ownerWebContentsId: 42,
        registeredAtMs: 1,
        registrationId: 7,
        role: 'current',
    });

    beforeEach(async () => {
        previousForcedCloneResult = process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'success';
        await clearCachedRangeReadHandlesForTests();
        vi.resetAllMocks();

        mocks.existsSync.mockReturnValue(true);
        mocks.isAllowedReadPath.mockReturnValue(true);
        mocks.isAllowedWritePath.mockReturnValue(true);
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/safe.pdf');
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/safe.pdf');
        mocks.consumeAllowedDocxWritePath.mockReturnValue(true);
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(null);
        mocks.getWorkingCopyOriginalPath.mockReturnValue(null);
        mocks.captureWorkingCopyAdmissionSnapshot.mockResolvedValue({
            size: 123n,
            mtimeNs: 1_000_000n,
        });
        mocks.refreshWorkingCopyOriginalFileExpectation.mockResolvedValue(true);
        mocks.originalPathSaveBaseMatches.mockResolvedValue(true);
        mocks.markWorkingCopyContentChanged.mockResolvedValue({});
        mocks.transitionWorkingCopyContentRevision.mockImplementation(async (
            _path: string,
            _reason: string,
            commit: (revision: unknown) => Promise<void>,
        ) => {
            await commit({token: 'next-revision'});
            return {token: 'next-revision'};
        });
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
        mocks.isAllowedDjvuViewingPath.mockReturnValue(false);
        mocks.findOcrResultForDocument.mockImplementation((pdfPath: string) => (
            pdfPath === '/tmp/electron-test/ocr-1-merged.pdf'
                ? {
                    requestId: 'ocr-1',
                    resultSha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
                }
                : null
        ));
        mocks.readFile.mockImplementation(async (path: string) => {
            if (path.endsWith('.evb-atomic-replace.json')) {
                throw Object.assign(new Error('No replacement journal'), {code: 'ENOENT'});
            }
            return Buffer.from([
                1,
                2,
                3,
            ]);
        });
        mocks.analyzePdfConformanceFile.mockResolvedValue({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
        mocks.lstatSync.mockReturnValue({ isSymbolicLink: () => false });
        mocks.realpathSync.mockImplementation((path: string) => path);
        mocks.statSync.mockReturnValue({
            size: 123,
            mtimeMs: 1,
        });
        mocks.access.mockResolvedValue(undefined);
        mocks.lstat.mockResolvedValue({ isSymbolicLink: () => false });
        mocks.realpath.mockImplementation(async (path: string) => path);
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 123,
            mtimeMs: 1,
        });
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.readdir.mockResolvedValue([]);
        mocks.rm.mockResolvedValue(undefined);
        mocks.rename.mockResolvedValue(undefined);
        mocks.unlink.mockResolvedValue(undefined);
        mocks.open.mockImplementation(async () => ({
            writeFile: mocks.writeFile,
            sync: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
            read: vi.fn(async (buffer: Buffer) => ({
                bytesRead: buffer.byteLength,
                buffer,
            })),
        }));
    });

    afterEach(() => {
        if (previousForcedCloneResult === undefined) {
            delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        } else {
            process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = previousForcedCloneResult;
        }
    });

    it('rejects read when pathValidator blocks a symlink path', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);

        await expect(
            handleFileRead(
                {},
                '/tmp/electron-test/symlink.pdf',
            ),
        ).rejects.toThrow('Invalid file path: reads only allowed within temp directory');

        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('rejects write when pathValidator blocks a symlink path', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue(null);

        await expect(
            handleFileWrite(
                writeContext,
                '/tmp/electron-test/symlink-output.pdf',
                new Uint8Array([9]),
            ),
        ).rejects.toThrow('Invalid file path: writes only allowed within temp directory');

        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('materializes managed working copies before writing temp PDF bytes', async () => {
        await handleFileWrite(
            writeContext,
            '/tmp/electron-test/safe.pdf',
            new Uint8Array([9]),
        );

        expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledWith('/tmp/electron-test/safe.pdf', {
            ownerWebContentsId: 42,
            reason: 'first-mutation',
        });
        expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledOnce();
        expect(mocks.ensureWorkingCopyMaterialized.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.writeFile.mock.invocationCallOrder[0]!);
        expect(mocks.writeFile).toHaveBeenCalledWith(new Uint8Array([9]));
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/[.]tmp$/u),
            '/tmp/electron-test/safe.pdf',
        );
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('joins an in-flight background materialization before staging write bytes', async () => {
        const backgroundFlight = deferred<{
            logicalRef: string;
            physicalWorkingCopyPath: string;
            sourceFingerprint: string;
        }>();
        mocks.ensureWorkingCopyMaterialized.mockReturnValue(backgroundFlight.promise);

        const writePromise = handleFileWrite(
            writeContext,
            '/tmp/electron-test/safe.pdf',
            new Uint8Array([9]),
        );
        await waitForSettledQueueTurn();

        expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledOnce();
        expect(mocks.writeFile).not.toHaveBeenCalled();

        backgroundFlight.resolve({
            logicalRef: '/tmp/electron-test/safe.pdf',
            physicalWorkingCopyPath: '/tmp/electron-test/safe.pdf',
            sourceFingerprint: 'sha256-full-v1:joined',
        });
        await writePromise;

        expect(mocks.writeFile).toHaveBeenCalledWith(new Uint8Array([9]));
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalledOnce();
    });

    it('queues managed working copy writes behind pending mutations', async () => {
        const blockedMutation = deferred<undefined>();
        const queuedMutation = enqueueWorkingCopyMutation('/tmp/electron-test/safe.pdf', () => blockedMutation.promise);

        const writePromise = handleFileWrite(
            writeContext,
            '/tmp/electron-test/safe.pdf',
            new Uint8Array([9]),
        );
        await waitForSettledQueueTurn();

        expect(mocks.writeFile).not.toHaveBeenCalled();
        blockedMutation.resolve(undefined);
        await queuedMutation;
        await writePromise;
        expect(mocks.writeFile).toHaveBeenCalledWith(new Uint8Array([9]));
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('allows writes through standard macOS temp path aliases', async () => {
        const aliasPath = resolve('/var/folders/evb/safe.pdf');
        const aliasSegment = resolve('/var');
        mocks.resolveAllowedWritePath.mockResolvedValue(aliasPath);
        mocks.lstatSync.mockImplementation((path: string) => ({isSymbolicLink: () => path === aliasSegment}));
        mocks.realpathSync.mockImplementation((path: string) => (path === aliasSegment ? resolve('/private/var') : path));

        // The /var -> /private/var allowance names POSIX system paths, never Windows junctions.
        if (process.platform === 'win32') {
            await expect(handleFileWrite(writeContext, aliasPath, new Uint8Array([9])))
                .rejects.toThrow(`Invalid file path: symlink path segment is not allowed (${aliasSegment})`);
            expect(mocks.open).not.toHaveBeenCalled();
            return;
        }

        await handleFileWrite(
            writeContext,
            '/var/folders/evb/safe.pdf',
            new Uint8Array([9]),
        );

        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(new RegExp(`${escapeRegExp(`${join('/var/folders/evb')}${sep}`)}.*[.]tmp$`, 'u')),
            '/var/folders/evb/safe.pdf',
        );
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('rejects writes through non-system symlink path segments', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/link/safe.pdf');
        mocks.lstatSync.mockImplementation((path: string) => ({isSymbolicLink: () => path === resolve('/tmp/electron-test/link')}));

        await expect(
            handleFileWrite(
                writeContext,
                '/tmp/electron-test/link/safe.pdf',
                new Uint8Array([9]),
            ),
        ).rejects.toThrow(`Invalid file path: symlink path segment is not allowed (${resolve('/tmp/electron-test/link')})`);

        expect(mocks.open).not.toHaveBeenCalled();
    });

    it('does not write temp PDF bytes when materialization fails', async () => {
        const error = Object.assign(new Error('The original document is unavailable'), {
            code: 'SOURCE_BACKING_UNAVAILABLE',
            retryable: false,
        });
        mocks.ensureWorkingCopyMaterialized.mockRejectedValue(error);

        await expect(
            handleFileWrite(
                writeContext,
                '/tmp/electron-test/safe.pdf',
                new Uint8Array([9]),
            ),
        ).rejects.toMatchObject({ code: 'SOURCE_BACKING_UNAVAILABLE' });

        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('fails closed when temp staging races working-copy cleanup', async () => {
        const enoent = new Error('missing parent');
        Object.assign(enoent, { code: 'ENOENT' });
        mocks.writeFile.mockRejectedValueOnce(enoent);

        await expect(handleFileWrite(
            writeContext,
            '/tmp/electron-test/safe.pdf',
            new Uint8Array([9]),
        )).rejects.toMatchObject({code: 'ENOENT'});

        expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledOnce();
        expect(mocks.writeFile).toHaveBeenCalledOnce();
        expect(mocks.transitionWorkingCopyContentRevision).not.toHaveBeenCalled();
    });

    it('atomically replaces a managed working copy from an OCR result file path', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/work.pdf');
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/ocr-1-merged.pdf');

        await handleReplaceWorkingCopyFromPath(
            writeContext,
            '/tmp/electron-test/work.pdf',
            '/tmp/electron-test/ocr-1-merged.pdf',
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-ocr')},
        );

        expect(mocks.ensureWorkingCopyMaterialized).toHaveBeenCalledWith('/tmp/electron-test/work.pdf', {
            ownerWebContentsId: 42,
            reason: 'ocr-persist',
        });
        expect(mocks.copyFile).toHaveBeenCalledWith(
            '/tmp/electron-test/ocr-1-merged.pdf',
            expect.stringMatching(new RegExp(`^${escapeRegExp(`${join('/tmp/electron-test')}${sep}.`)}[0-9a-f]{16}\\.tmp$`, 'u')),
        );
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(new RegExp(`^${escapeRegExp(`${join('/tmp/electron-test')}${sep}.`)}[0-9a-f]{16}\\.tmp$`, 'u')),
            '/tmp/electron-test/work.pdf',
        );
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('refreshes the original save base after an OCR replacement when the previous base still matches', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/work.pdf');
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/ocr-1-merged.pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({
            originalPath: '/Users/alice/Documents/book.pdf',
            retired: false,
        });
        mocks.originalPathSaveBaseMatches.mockResolvedValue(true);

        await handleReplaceWorkingCopyFromPath(
            writeContext,
            '/tmp/electron-test/work.pdf',
            '/tmp/electron-test/ocr-1-merged.pdf',
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-ocr')},
        );

        expect(mocks.originalPathSaveBaseMatches).toHaveBeenCalledWith(
            '/tmp/electron-test/work.pdf',
            '/Users/alice/Documents/book.pdf',
            42,
        );
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledWith(
            '/tmp/electron-test/work.pdf',
            42,
        );
        expect(mocks.rename.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.refreshWorkingCopyOriginalFileExpectation.mock.invocationCallOrder[0]!);
        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalled();
    });

    it('preserves the stale-original guard after an OCR replacement when the previous base no longer matches', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/work.pdf');
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/ocr-1-merged.pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({
            originalPath: '/Users/alice/Documents/book.pdf',
            retired: false,
        });
        mocks.originalPathSaveBaseMatches.mockResolvedValue(false);

        await handleReplaceWorkingCopyFromPath(
            writeContext,
            '/tmp/electron-test/work.pdf',
            '/tmp/electron-test/ocr-1-merged.pdf',
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-ocr')},
        );

        expect(mocks.copyFile).toHaveBeenCalled();
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).not.toHaveBeenCalled();
    });

    it('rejects working-copy replacement from non-OCR source file names', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/work.pdf');
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/unrelated.pdf');

        await expect(
            handleReplaceWorkingCopyFromPath(
                writeContext,
                '/tmp/electron-test/work.pdf',
                '/tmp/electron-test/unrelated.pdf',
            ),
        ).rejects.toThrow('Invalid source path: only OCR result files can replace a working copy');

        expect(mocks.copyFile).not.toHaveBeenCalled();
    });

    it('rejects working-copy replacement from OCR-looking files without pending-result ownership', async () => {
        mocks.resolveAllowedWritePath.mockResolvedValue('/tmp/electron-test/work.pdf');
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/electron-test/ocr-2-merged.pdf');

        await expect(
            handleReplaceWorkingCopyFromPath(
                writeContext,
                '/tmp/electron-test/work.pdf',
                '/tmp/electron-test/ocr-2-merged.pdf',
                {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-ocr')},
            ),
        ).rejects.toThrow('Invalid source path: OCR result is not authorized for this document revision');

        expect(mocks.copyFile).not.toHaveBeenCalled();
    });

    it('falls back to mapped working copy for original file path reads', async () => {
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(false);
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/mapped.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/electron-test/mapped.pdf');

        const content = await handleFileRead(readContext, '/Users/alice/Documents/file.pdf');

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 42);
        expect(mocks.readFile).toHaveBeenCalledWith('/tmp/electron-test/mapped.pdf');
        expect(content).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
    });

    it('reads a user-approved image path for page annotation placement', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue('/Users/alice/Pictures/signature.png');

        const content = await handleFileRead(readContext, '/Users/alice/Pictures/signature.png');
        const metadata = await handleFileStat(readContext, '/Users/alice/Pictures/signature.png');

        expect(mocks.readFile).toHaveBeenCalledWith('/Users/alice/Pictures/signature.png');
        expect(content).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
        expect(metadata).toEqual({
            size: 123,
            modifiedAt: 1,
        });
    });

    it('resolves lazy-original documents to their logical managed reference', async () => {
        const entry = lazyOriginalEntry();
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(false);
        mocks.existsSync.mockReturnValue(false);
        mocks.resolveAllowedReadPath.mockResolvedValue('/Users/alice/Documents/file.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/electron-test/lazy.pdf');
        mocks.getWorkingCopyBackingEntry.mockImplementation((path: string) =>
            path === '/tmp/electron-test/lazy.pdf' ? entry : null);

        await expect(
            resolveExistingReadablePdfPath('/Users/alice/Documents/file.pdf', 42),
        ).resolves.toBe('/tmp/electron-test/lazy.pdf');
    });

    it('reads lazy-original documents through a checked cached source handle', async () => {
        const entry = {
            ...lazyOriginalEntry(),
            admissionSnapshot: {
                size: 2n,
                mtimeNs: 1_000_000n,
            },
        };
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
            buffer.set([
                8,
                9,
            ], offset);
            return {bytesRead: length};
        });
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(entry);
        mocks.captureWorkingCopyAdmissionSnapshot.mockResolvedValue({
            size: 2n,
            mtimeNs: 1_000_000n,
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        await expect(
            handleFileRead(readContext, '/tmp/electron-test/lazy.pdf'),
        ).resolves.toEqual(new Uint8Array([
            8,
            9,
        ]));

        expect(mocks.ensureWorkingCopyDirectory).not.toHaveBeenCalled();
        // Pre-read admission assert plus the post-read torn-write assert.
        expect(mocks.captureWorkingCopyAdmissionSnapshot).toHaveBeenCalledTimes(2);
        expect(mocks.open).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 'r');
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('stats lazy-original documents against the admission witness', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(lazyOriginalEntry());

        await expect(
            handleFileStat(readContext, '/tmp/electron-test/lazy.pdf'),
        ).resolves.toEqual({
            size: 123,
            modifiedAt: 1,
        });

        expect(mocks.captureWorkingCopyAdmissionSnapshot).toHaveBeenCalledTimes(1);
        expect(mocks.stat).not.toHaveBeenCalled();
    });

    it('runs lazy-original probes against the witnessed source without materializing', async () => {
        mocks.getWorkingCopyBackingEntry.mockReturnValue(lazyOriginalEntry());
        const transport = resolveOriginalBackedReadTransport('/tmp/electron-test/lazy.pdf', 42);
        const probe = vi.fn(async () => 'geometry');

        await expect(transport?.read(probe)).resolves.toBe('geometry');

        expect(probe).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf');
        expect(mocks.captureWorkingCopyAdmissionSnapshot).toHaveBeenCalledTimes(2);
        expect(mocks.ensureWorkingCopyMaterialized).not.toHaveBeenCalled();
        expect(mocks.stat).not.toHaveBeenCalled();
    });

    it('returns a typed error when the lazy-original registration swaps during a probe', async () => {
        const originalEntry = lazyOriginalEntry();
        mocks.getWorkingCopyBackingEntry.mockReturnValue(originalEntry);
        const transport = resolveOriginalBackedReadTransport('/tmp/electron-test/lazy.pdf', 42);
        mocks.getWorkingCopyBackingEntry
            .mockReturnValueOnce(originalEntry)
            .mockReturnValue({
                ...originalEntry,
                registrationId: 8,
            });

        await expect(transport?.read(async () => 'geometry'))
            .rejects
            .toMatchObject({code: 'WORKING_COPY_REGISTRATION_CHANGED'});

        expect(mocks.ensureWorkingCopyMaterialized).not.toHaveBeenCalled();
    });

    it('normalizes a disappearing lazy source during a failed probe to a typed error', async () => {
        const originalEntry = lazyOriginalEntry();
        mocks.getWorkingCopyBackingEntry.mockReturnValue(originalEntry);
        const transport = resolveOriginalBackedReadTransport('/tmp/electron-test/lazy.pdf', 42);
        mocks.captureWorkingCopyAdmissionSnapshot
            .mockResolvedValueOnce(originalEntry.admissionSnapshot)
            .mockRejectedValueOnce(Object.assign(new Error('missing'), {code: 'ENOENT'}));

        await expect(transport?.read(async () => {
            throw Object.assign(new Error('spawn source missing'), {code: 'ENOENT'});
        })).rejects.toMatchObject({code: 'SOURCE_BACKING_UNAVAILABLE'});

        expect(mocks.ensureWorkingCopyMaterialized).not.toHaveBeenCalled();
    });

    it('fails a lazy-original read before admission when the source witness changed', async () => {
        const entry = lazyOriginalEntry();
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(entry);
        mocks.captureWorkingCopyAdmissionSnapshot.mockResolvedValue({
            size: 124n,
            mtimeNs: 1_000_000n,
        });

        await expect(
            handleFileRead(readContext, '/tmp/electron-test/lazy.pdf'),
        ).rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});

        expect(mocks.open).not.toHaveBeenCalled();
        expect(mocks.transitionWorkingCopyBackingState).toHaveBeenCalledWith(
            '/tmp/electron-test/lazy.pdf',
            7,
            'lazy-original',
            expect.objectContaining({sourceBackingErrorCode: 'SOURCE_BACKING_CHANGED'}),
        );
    });

    it('discards short lazy-original reads when the post-read witness changed', async () => {
        const entry = lazyOriginalEntry();
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer, offset: number) => {
            if (read.mock.calls.length > 1) {
                return {bytesRead: 0};
            }
            buffer.set([
                4,
                5,
            ], offset);
            return {bytesRead: 2};
        });
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(entry);
        mocks.captureWorkingCopyAdmissionSnapshot
            .mockResolvedValueOnce(entry.admissionSnapshot)
            .mockResolvedValueOnce({
                size: 123n,
                mtimeNs: 2_000_000n,
            });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        await expect(
            handleFileRead(readContext, '/tmp/electron-test/lazy.pdf'),
        ).rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});

        expect(mocks.transitionWorkingCopyBackingState).toHaveBeenCalledWith(
            '/tmp/electron-test/lazy.pdf',
            7,
            'lazy-original',
            expect.objectContaining({sourceBackingErrorCode: 'SOURCE_BACKING_CHANGED'}),
        );
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('rejects a lazy-original range when the source changes after a full range read', async () => {
        const entry = lazyOriginalEntry();
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer, offset: number) => {
            buffer.set([
                4,
                5,
            ], offset);
            return {bytesRead: 2};
        });
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(entry);
        mocks.captureWorkingCopyAdmissionSnapshot
            .mockResolvedValueOnce(entry.admissionSnapshot)
            .mockResolvedValueOnce({
                size: 123n,
                mtimeNs: 2_000_000n,
            });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        await expect(
            handleFileReadRange(readContext, '/tmp/electron-test/lazy.pdf', 0, 2),
        ).rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});

        expect(mocks.captureWorkingCopyAdmissionSnapshot).toHaveBeenCalledTimes(2);
        expect(mocks.transitionWorkingCopyBackingState).toHaveBeenCalledWith(
            '/tmp/electron-test/lazy.pdf',
            7,
            'lazy-original',
            expect.objectContaining({sourceBackingErrorCode: 'SOURCE_BACKING_CHANGED'}),
        );
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('fails lazy-original reads with a typed unavailable error', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(lazyOriginalEntry());
        mocks.captureWorkingCopyAdmissionSnapshot.mockRejectedValue(
            Object.assign(new Error('missing'), {code: 'ENOENT'}),
        );

        await expect(
            handleFileRead(readContext, '/tmp/electron-test/lazy.pdf'),
        ).rejects.toMatchObject({code: 'SOURCE_BACKING_UNAVAILABLE'});

        expect(mocks.open).not.toHaveBeenCalled();
    });

    it('falls back to mapped working copy for original file path stats', async () => {
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(false);
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/mapped.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/electron-test/mapped.pdf');

        const result = await handleFileStat(readContext, '/Users/alice/Documents/file.pdf');

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 42);
        expect(mocks.statSync).toHaveBeenCalledWith('/tmp/electron-test/mapped.pdf');
        expect(result).toEqual({
            size: 123,
            modifiedAt: 1,
        });
    });

    it('falls back to mapped working copy for original file path range reads', async () => {
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(false);
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/mapped.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockImplementation(path => (
            path === '/Users/alice/Documents/file.pdf' ? '/tmp/electron-test/mapped.pdf' : null
        ));
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer) => {
            buffer.set([
                4,
                5,
            ]);
            return { bytesRead: 2 };
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const content = await handleFileReadRange(readContext, '/Users/alice/Documents/file.pdf', 10, 2);

        expect(mocks.findWorkingCopyPathByOriginalPath).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 42);
        expect(mocks.open).toHaveBeenCalledWith('/tmp/electron-test/mapped.pdf', 'r');
        expect(content).toEqual(new Uint8Array([
            4,
            5,
        ]));
        expect(close).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalled();
    });

    it('reads an original that a published working copy still names without keeping its handle', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue('/Users/alice/Documents/file.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockImplementation(path => (
            path === '/Users/alice/Documents/file.pdf' ? '/tmp/electron-test/mapped.pdf' : null
        ));
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer) => {
            buffer.set([
                6,
                7,
            ]);
            return { bytesRead: 2 };
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const content = await handleFileReadRange(readContext, '/Users/alice/Documents/file.pdf', 0, 2);

        expect(content).toEqual(new Uint8Array([
            6,
            7,
        ]));
        expect(close).toHaveBeenCalledTimes(1);
        expect(getRangeReadCacheStatsForTests()).toMatchObject({handles: 0});
    });

    it('recreates managed working copies before range reads when direct temp resolution misses', async () => {
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/electron-test/work.pdf');
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer) => {
            buffer.set([
                7,
                8,
            ]);
            return { bytesRead: 2 };
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const content = await handleFileReadRange(readContext, '/tmp/electron-test/work.pdf', 10, 2);

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith('/tmp/electron-test/work.pdf', 42);
        expect(mocks.open).toHaveBeenCalledWith('/tmp/electron-test/work.pdf', 'r');
        expect(content).toEqual(new Uint8Array([
            7,
            8,
        ]));
        expect(close).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalled();
    });

    it('reuses cached range read handles while the file is unchanged', async () => {
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
            buffer.fill(6, 0, length);
            return { bytesRead: length };
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);
        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 2, 2);

        expect(mocks.open).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(2);
        expect(close).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('caches original-backed range read handles until backing-swap invalidation', async () => {
        const entry = {
            ...lazyOriginalEntry(),
            backingState: 'materializing',
        };
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
            buffer.fill(5, 0, length);
            return {bytesRead: length};
        });
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(entry);
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        await handleFileReadRange(readContext, '/tmp/electron-test/lazy.pdf', 0, 2);
        await handleFileReadRange(readContext, '/tmp/electron-test/lazy.pdf', 2, 2);

        expect(mocks.open).toHaveBeenCalledTimes(1);
        expect(mocks.open).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 'r');
        expect(mocks.captureWorkingCopyAdmissionSnapshot).toHaveBeenCalledTimes(4);
        expect(close).not.toHaveBeenCalled();

        await mocks.backingSwapCacheInvalidator?.(
            '/tmp/electron-test/lazy.pdf',
            '/Users/alice/Documents/file.pdf',
        );

        expect(close).toHaveBeenCalledTimes(1);
        expect(getRangeReadCacheStatsForTests()).toMatchObject({
            handles: 0,
            pendingOpens: 0,
        });
    });

    it('closes the original after a read that finishes once its copy is published', async () => {
        const entry = {
            ...lazyOriginalEntry(),
            backingState: 'materializing',
        };
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
            entry.backingState = 'materialized';
            buffer.fill(5, 0, length);
            return {bytesRead: length};
        });
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(entry);
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        await handleFileReadRange(readContext, '/tmp/electron-test/lazy.pdf', 0, 2);

        expect(mocks.open).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf', 'r');
        expect(close).toHaveBeenCalledTimes(1);
        expect(getRangeReadCacheStatsForTests()).toMatchObject({handles: 0});
    });

    it('whole-file read that finishes after its copy publishes closes the original', async () => {
        const entry = {
            ...lazyOriginalEntry(),
            backingState: 'materializing',
        };
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(entry);
        mocks.open.mockImplementation(async (path: string) => openTrackedHandle(path, async () => {
            entry.backingState = 'materialized';
        }));

        await expect(handleFileRead(readContext, '/tmp/electron-test/lazy.pdf')).resolves.toHaveLength(123);

        expect(countOpenHandles('/Users/alice/Documents/file.pdf')).toBe(0);
        expect(getRangeReadCacheStatsForTests()).toMatchObject({handles: 0});
    });

    it('concurrent original-backed acquisitions share one handle across LRU eviction', async () => {
        const logicalPath = '/tmp/electron-test/lazy.pdf';
        const originalPath = '/Users/alice/Documents/file.pdf';
        const oldestPath = '/tmp/electron-test/oldest.pdf';
        const oldestEntered = deferred<undefined>();
        const releaseOldest = deferred<undefined>();
        mocks.resolveAllowedReadPath.mockImplementation(async (path: string) => path);
        mocks.getWorkingCopyBackingEntry.mockImplementation((path: string) => (
            path === logicalPath ? lazyOriginalEntry() : null
        ));
        mocks.open.mockImplementation(async (path: string) => openTrackedHandle(path, async () => {
            if (path === oldestPath) {
                oldestEntered.resolve(undefined);
                await releaseOldest.promise;
            }
        }));

        const oldestRead = handleFileReadRange(readContext, oldestPath, 0, 2);
        await oldestEntered.promise;
        for (let index = 0; index < 5; index += 1) {
            await handleFileReadRange(readContext, `/tmp/electron-test/cache-${index}.pdf`, 0, 2);
        }
        // Both original reads wait in the eviction loop for the busy oldest handle.
        const firstOriginalRead = handleFileReadRange(readContext, logicalPath, 0, 2);
        const secondOriginalRead = handleFileReadRange(readContext, logicalPath, 32, 2);
        try {
            await waitForSettledQueueTurn();
            expect(countOpenHandles(oldestPath)).toBe(1);
            expect(countOpenHandles(originalPath)).toBe(0);
            releaseOldest.resolve(undefined);
            const bytes = await Promise.all([
                oldestRead,
                firstOriginalRead,
                secondOriginalRead,
            ]);
            expect(bytes.map(value => value.byteLength)).toEqual([
                2,
                2,
                2,
            ]);
            expect(countOpenHandles(originalPath)).toBe(1);
        } finally {
            releaseOldest.resolve(undefined);
            await Promise.allSettled([
                oldestRead,
                firstOriginalRead,
                secondOriginalRead,
            ]);
            await clearCachedRangeReadHandlesForTests();
        }
        expect(openFileHandles.size).toBe(0);
    });

    it('publication overlapping a retried original open leaves no path epoch', async () => {
        const logicalPath = '/tmp/electron-test/lazy.pdf';
        const originalPath = '/Users/alice/Documents/file.pdf';
        const entry = lazyOriginalEntry();
        const firstOpened = deferred<undefined>();
        const releaseFirstOpen = deferred<undefined>();
        const retryOpened = deferred<undefined>();
        const releaseRetryOpen = deferred<undefined>();
        let opens = 0;
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(entry);
        mocks.open.mockImplementation(async (path: string) => {
            opens += 1;
            if (opens === 1) {
                firstOpened.resolve(undefined);
                await releaseFirstOpen.promise;
            } else if (opens === 2) {
                retryOpened.resolve(undefined);
                await releaseRetryOpen.promise;
            }
            return openTrackedHandle(path);
        });

        const reading = handleFileReadRange(readContext, logicalPath, 0, 2);
        await firstOpened.promise;
        entry.backingState = 'materialized';
        // The publication's invalidation waits for the first open, which the epoch
        // change makes stale, so the retried open is still pending when it settles.
        const publication = mocks.backingSwapCacheInvalidator?.(logicalPath, originalPath);
        releaseFirstOpen.resolve(undefined);
        await retryOpened.promise;
        await publication;
        releaseRetryOpen.resolve(undefined);

        await expect(reading).resolves.toHaveLength(2);
        expect(countOpenHandles(originalPath)).toBe(0);
        expect(getRangeReadCacheStatsForTests()).toMatchObject({
            handles: 0,
            pathEpochs: 0,
        });
    });

    it('shares and invalidates original-backed range handles across macOS path aliases', async () => {
        const aliasPath = '/var/folders/evb/lazy.pdf';
        const canonicalPath = '/private/var/folders/evb/lazy.pdf';
        const entry = {
            ...lazyOriginalEntry(),
            backingState: 'materializing',
            originalPath: canonicalPath,
        };
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer, _offset: number, length: number) => {
            buffer.fill(5, 0, length);
            return {bytesRead: length};
        });
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.getWorkingCopyBackingEntry.mockImplementation((path: string) =>
            path === aliasPath || path === canonicalPath ? entry : null);
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        await handleFileReadRange(readContext, canonicalPath, 0, 2);
        await handleFileReadRange(readContext, aliasPath, 2, 2);
        await enqueueWorkingCopyMutation(aliasPath, async () => undefined);

        await waitForSettledQueueTurn();

        expect(mocks.open).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledTimes(1);
        expect(getRangeReadCacheStatsForTests()).toMatchObject({
            handles: 0,
            pendingOpens: 0,
            pathEpochs: 0,
        });
    });

    it('reopens cached range read handles when file metadata changes', async () => {
        const firstClose = vi.fn(async () => {});
        const secondClose = vi.fn(async () => {});
        mocks.statSync
            .mockReturnValueOnce({
                size: 123,
                mtimeMs: 1,
            })
            .mockReturnValueOnce({
                size: 123,
                mtimeMs: 2,
            });
        mocks.open
            .mockResolvedValueOnce({
                close: firstClose,
                read: vi.fn(async (buffer: Buffer) => {
                    buffer.fill(1);
                    return { bytesRead: buffer.byteLength };
                }),
            })
            .mockResolvedValueOnce({
                close: secondClose,
                read: vi.fn(async (buffer: Buffer) => {
                    buffer.fill(2);
                    return { bytesRead: buffer.byteLength };
                }),
            });

        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);
        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 2, 2);

        expect(mocks.open).toHaveBeenCalledTimes(2);
        expect(firstClose).toHaveBeenCalledTimes(1);
        expect(secondClose).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(secondClose).toHaveBeenCalledTimes(1);
    });

    it('keeps every handle owned when a stale cached handle closes under a concurrent reopen', async () => {
        let mtimeMs = 1;
        mocks.statSync.mockImplementation(() => ({
            size: 123,
            mtimeMs,
        }));
        const firstRead = deferred<undefined>();
        const firstReadEntered = deferred<undefined>();
        const closes: Array<ReturnType<typeof vi.fn>> = [];
        mocks.open.mockImplementation(async () => {
            const blocks = closes.length === 0;
            const close = vi.fn(async () => {});
            closes.push(close);
            return {
                close,
                read: vi.fn(async (buffer: Buffer) => {
                    if (blocks) {
                        firstReadEntered.resolve(undefined);
                        await firstRead.promise;
                    }
                    buffer.fill(1);
                    return { bytesRead: buffer.byteLength };
                }),
            };
        });

        const blockedRead = handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);
        await firstReadEntered.promise;
        mtimeMs = 2;
        const staleRead = handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 2, 2);
        const concurrentRead = handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 4, 2);
        try {
            await waitForSettledQueueTurn();
            expect(closes).toHaveLength(1);
            expect(closes[0]).not.toHaveBeenCalled();
            firstRead.resolve(undefined);
            const bytes = await Promise.all([
                blockedRead,
                staleRead,
                concurrentRead,
            ]);
            expect(bytes.map(value => [...value])).toEqual([
                [
                    1,
                    1,
                ],
                [
                    1,
                    1,
                ],
                [
                    1,
                    1,
                ],
            ]);
        } finally {
            firstRead.resolve(undefined);
            await Promise.allSettled([
                blockedRead,
                staleRead,
                concurrentRead,
            ]);
            await clearCachedRangeReadHandlesForTests();
        }

        expect(closes).toHaveLength(2);
        expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
    });

    it('closes cached range read handles after working copy mutations settle', async () => {
        const close = vi.fn(async () => {});
        mocks.open.mockResolvedValue({
            close,
            read: vi.fn(async (buffer: Buffer) => {
                buffer.fill(3);
                return { bytesRead: buffer.byteLength };
            }),
        });

        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);
        await enqueueWorkingCopyMutation('/tmp/electron-test/safe.pdf', async () => undefined);

        await waitForSettledQueueTurn();
        expect(close).toHaveBeenCalledTimes(1);
        expect(getRangeReadCacheStatsForTests()).toMatchObject({
            handles: 0,
            pendingOpens: 0,
            pathEpochs: 0,
        });
    });

    it('closes cached range read handles before a working copy mutation starts', async () => {
        const events: string[] = [];
        const close = vi.fn(async () => {
            events.push('close');
        });
        mocks.open.mockResolvedValue({
            close,
            read: vi.fn(async (buffer: Buffer) => {
                buffer.fill(3);
                return {bytesRead: buffer.byteLength};
            }),
        });

        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);
        await enqueueWorkingCopyMutation('/tmp/electron-test/safe.pdf', async () => {
            events.push('mutation');
        });

        expect(events).toEqual([
            'close',
            'mutation',
        ]);
    });

    it('blocks range-read reopen until a Windows deny-delete mutation failure settles', async () => {
        const firstClose = vi.fn(async () => {});
        const secondClose = vi.fn(async () => {});
        const firstRead = vi.fn(async (buffer: Buffer) => {
            buffer.fill(3);
            return {bytesRead: buffer.byteLength};
        });
        const secondRead = vi.fn(async (buffer: Buffer) => {
            buffer.fill(4);
            return {bytesRead: buffer.byteLength};
        });
        mocks.open
            .mockResolvedValueOnce({
                close: firstClose,
                read: firstRead,
            })
            .mockResolvedValueOnce({
                close: secondClose,
                read: secondRead,
            });

        await handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);

        const mutationStarted = deferred<undefined>();
        const releaseMutation = deferred<undefined>();
        const denyDelete = Object.assign(new Error('sharing violation'), {code: 'EACCES'});
        const mutation = enqueueWorkingCopyMutation('/tmp/electron-test/safe.pdf', async () => {
            mutationStarted.resolve(undefined);
            await releaseMutation.promise;
            throw denyDelete;
        });
        await mutationStarted.promise;

        const rangeRead = handleFileReadRange(
            readContext,
            '/tmp/electron-test/safe.pdf',
            0,
            2,
        );
        await waitForSettledQueueTurn();
        expect(mocks.open).toHaveBeenCalledTimes(1);

        releaseMutation.resolve(undefined);
        await expect(mutation).rejects.toBe(denyDelete);
        await expect(rangeRead).resolves.toEqual(new Uint8Array([
            4,
            4,
        ]));
        expect(mocks.open).toHaveBeenCalledTimes(2);
        expect(firstClose).toHaveBeenCalledOnce();
        expect(secondClose).not.toHaveBeenCalled();
    });

    it('invalidates cached range handles across macOS temp path aliases', async () => {
        const aliasPath = '/var/folders/evb/safe.pdf';
        const canonicalPath = '/private/var/folders/evb/safe.pdf';
        const close = vi.fn(async () => {});
        mocks.resolveAllowedReadPath.mockResolvedValue(canonicalPath);
        mocks.open.mockResolvedValue({
            close,
            read: vi.fn(async (buffer: Buffer) => {
                buffer.fill(3);
                return {bytesRead: buffer.byteLength};
            }),
        });

        await handleFileReadRange(readContext, canonicalPath, 0, 2);
        await enqueueWorkingCopyMutation(aliasPath, async () => undefined);

        await waitForSettledQueueTurn();

        expect(close).toHaveBeenCalledTimes(1);
        expect(getRangeReadCacheStatsForTests()).toMatchObject({
            handles: 0,
            pendingOpens: 0,
            pathEpochs: 0,
        });
    });

    it('does not retain path epochs for mutations without cached range reads', async () => {
        await enqueueWorkingCopyMutation('/tmp/electron-test/never-read.pdf', async () => undefined);

        await waitForSettledQueueTurn();

        expect(getRangeReadCacheStatsForTests().pathEpochs).toBe(0);
    });

    it('closes and retries a pending range handle opened across a working-copy mutation', async () => {
        const firstOpen = deferred<{
            close: ReturnType<typeof vi.fn>;
            read: ReturnType<typeof vi.fn>;
        }>();
        const firstClose = vi.fn(async () => {});
        const firstRead = vi.fn(async () => ({bytesRead: 0}));
        const secondClose = vi.fn(async () => {});
        const secondRead = vi.fn(async (buffer: Buffer) => {
            buffer.fill(9);
            return {bytesRead: buffer.byteLength};
        });
        mocks.open
            .mockImplementationOnce(() => firstOpen.promise)
            .mockResolvedValueOnce({
                close: secondClose,
                read: secondRead,
            });

        const rangeRead = handleFileReadRange(
            readContext,
            '/tmp/electron-test/safe.pdf',
            0,
            2,
        );
        await vi.waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1));
        const mutation = enqueueWorkingCopyMutation('/tmp/electron-test/safe.pdf', async () => undefined);
        firstOpen.resolve({
            close: firstClose,
            read: firstRead,
        });

        await expect(mutation).resolves.toBeUndefined();
        await expect(rangeRead).resolves.toEqual(new Uint8Array([
            9,
            9,
        ]));
        expect(mocks.open).toHaveBeenCalledTimes(2);
        expect(firstRead).not.toHaveBeenCalled();
        expect(firstClose).toHaveBeenCalledTimes(1);
        expect(secondClose).not.toHaveBeenCalled();
    });

    it('waits for an active range read to release before a mutation starts', async () => {
        const readResult = deferred<{bytesRead: number}>();
        const close = vi.fn(async () => {});
        const read = vi.fn((buffer: Buffer) => {
            buffer.fill(4);
            return readResult.promise;
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const rangeRead = handleFileReadRange(
            readContext,
            '/tmp/electron-test/safe.pdf',
            0,
            2,
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        let mutationStarted = false;
        const mutation = enqueueWorkingCopyMutation('/tmp/electron-test/safe.pdf', async () => {
            mutationStarted = true;
        });
        await waitForSettledQueueTurn();

        expect(close).not.toHaveBeenCalled();
        expect(mutationStarted).toBe(false);
        readResult.resolve({bytesRead: 2});
        await expect(rangeRead).resolves.toEqual(new Uint8Array([
            4,
            4,
        ]));
        expect(close).toHaveBeenCalledTimes(1);
        await expect(mutation).resolves.toBeUndefined();
        expect(mutationStarted).toBe(true);
    });

    it('cancels a mutation without waiting forever for an active range read', async () => {
        const {cancelMainOperationsForOwner} = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const readResult = deferred<{bytesRead: number}>();
        const close = vi.fn(async () => {});
        const read = vi.fn((buffer: Buffer) => {
            buffer.fill(4);
            return readResult.promise;
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const rangeRead = handleFileReadRange(
            readContext,
            '/tmp/electron-test/safe.pdf',
            0,
            2,
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        const mutationBody = vi.fn(async () => undefined);
        const mutation = enqueueWorkingCopyMutation(
            '/tmp/electron-test/safe.pdf',
            mutationBody,
            {ownerWebContentsId: 42},
        );
        await waitForSettledQueueTurn();

        cancelMainOperationsForOwner(42, 'renderer lifecycle ended');
        await expect(mutation).rejects.toThrow('renderer lifecycle ended');
        expect(mutationBody).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();

        readResult.resolve({bytesRead: 2});
        await expect(rangeRead).resolves.toEqual(new Uint8Array([
            4,
            4,
        ]));
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    });

    it('retains native read bytes across timeout and a successor write until actual settlement', async () => {
        const fixture = await createContentFixture();
        const entered = deferred<undefined>();
        const readGate = deferred<undefined>();
        const writing = deferred<undefined>();
        const writeGate = deferred<undefined>();
        let first: Promise<void> | undefined;
        let second: Promise<void> | undefined;
        mocks.analyzePdfConformanceFile.mockImplementation(async () => {
            const bytes = await fixture.fs.readFile(fixture.path, 'utf8');
            entered.resolve(undefined);
            await readGate.promise;
            expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe(bytes);
            return {saveRestrictions: [bytes]};
        });
        const analysis = handleAnalyzePdfConformance(readContext, fixture.path);
        await entered.promise;
        vi.useFakeTimers();
        try {
            first = enqueueWorkingCopyMutation(fixture.path, () => fixture.fs.writeFile(fixture.path, 'forbidden'));
            const refused = expect(first).rejects.toThrow('Mutation-start preparation timed out after 30000ms');
            await waitForSettledQueueTurn();
            await vi.advanceTimersByTimeAsync(30_000);
            await refused;
            expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('before');

            second = enqueueWorkingCopyMutation(fixture.path, async () => {
                await fixture.fs.writeFile(fixture.path, 'partial');
                writing.resolve(undefined);
                await writeGate.promise;
                await fixture.fs.writeFile(fixture.path, 'after');
            });
            await waitForSettledQueueTurn();
            expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('before');
            readGate.resolve(undefined);
            await expect(analysis).resolves.toMatchObject({saveRestrictions: ['before']});
            await writing.promise;
            let nextReadSettled = false;
            const nextRead = handleAnalyzePdfConformance(readContext, fixture.path).then((result) => {
                nextReadSettled = true;
                return result;
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(nextReadSettled).toBe(false);
            writeGate.resolve(undefined);
            await second;
            await expect(nextRead).resolves.toMatchObject({saveRestrictions: ['after']});
            expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('after');
        } finally {
            readGate.resolve(undefined);
            writeGate.resolve(undefined);
            vi.useRealTimers();
            await Promise.allSettled([
                analysis,
                first,
                second,
            ]);
            await clearCachedRangeReadHandlesForTests();
            await fixture.dispose();
        }
    });

    it('waits for acknowledged native cancellation before releasing content to a write', async () => {
        const fixture = await createContentFixture();
        const entered = deferred<undefined>();
        const actualSettlement = deferred<undefined>();
        let signal: AbortSignal | undefined;
        mocks.analyzePdfConformanceFile.mockImplementation(async (_path, options: {signal: AbortSignal}) => {
            signal = options.signal;
            entered.resolve(undefined);
            await actualSettlement.promise;
            throw signal.reason;
        });
        const analysis = handleAnalyzePdfConformance(readContext, fixture.path);
        const analysisRefused = expect(analysis).rejects.toThrow('Working copy is closing');
        await entered.promise;
        try {
            cancelMainOperationsForClosingWorkingCopy(fixture.path, 'Working copy is closing',
                {isRegistrationCurrent: () => true});
            expect(signal?.aborted).toBe(true);
            const mutation = enqueueWorkingCopyMutation(fixture.path, () => fixture.fs.writeFile(fixture.path, 'after'));
            await waitForSettledQueueTurn();
            expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('before');
            actualSettlement.resolve(undefined);
            await analysisRefused;
            await mutation;
            expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('after');
        } finally {
            actualSettlement.resolve(undefined);
            await Promise.allSettled([
                analysis,
                analysisRefused,
            ]);
            await clearCachedRangeReadHandlesForTests();
            await fixture.dispose();
        }
    });

    it('awaits active handle closure before completing backing-swap invalidation', async () => {
        const readResult = deferred<{bytesRead: number}>();
        const close = vi.fn(async () => {});
        const read = vi.fn((buffer: Buffer) => {
            buffer.fill(4);
            return readResult.promise;
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const rangeRead = handleFileReadRange(
            readContext,
            '/tmp/electron-test/safe.pdf',
            0,
            2,
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
        const invalidation = Promise.resolve(
            mocks.backingSwapCacheInvalidator?.(
                '/tmp/electron-test/safe.pdf',
                '/Users/alice/Documents/file.pdf',
            ),
        );
        let invalidationSettled = false;
        void invalidation.then(() => {
            invalidationSettled = true;
        });
        await waitForSettledQueueTurn();

        expect(invalidationSettled).toBe(false);
        expect(close).not.toHaveBeenCalled();
        readResult.resolve({bytesRead: 2});
        await expect(rangeRead).resolves.toEqual(new Uint8Array([
            4,
            4,
        ]));
        await invalidation;
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('allows direct reads for DjVu files approved for native viewing', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.realpath.mockResolvedValue('/Users/alice/Documents/file.djvu');

        const content = await handleFileRead({}, '/Users/alice/Documents/file.djvu');

        expect(mocks.isAllowedDjvuViewingPath).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu');
        expect(mocks.readFile).toHaveBeenCalledWith(resolve('/Users/alice/Documents/file.djvu'));
        expect(content).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
    });

    it('allows direct stats for DjVu files approved for native viewing', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.realpath.mockResolvedValue('/Users/alice/Documents/file.djvu');

        const result = await handleFileStat({}, '/Users/alice/Documents/file.djvu');

        expect(mocks.isAllowedDjvuViewingPath).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu');
        expect(mocks.statSync).toHaveBeenCalledWith(resolve('/Users/alice/Documents/file.djvu'));
        expect(result).toEqual({
            size: 123,
            modifiedAt: 1,
        });
    });

    it('allows direct range reads for DjVu files approved for native viewing', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.realpath.mockResolvedValue('/Users/alice/Documents/file.djvu');
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer) => {
            buffer.set([
                6,
                7,
            ]);
            return { bytesRead: 2 };
        });
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const content = await handleFileReadRange({}, '/Users/alice/Documents/file.djvu', 10, 2);

        expect(mocks.isAllowedDjvuViewingPath).toHaveBeenCalledWith('/Users/alice/Documents/file.djvu');
        expect(mocks.open).toHaveBeenCalledWith(resolve('/Users/alice/Documents/file.djvu'), 'r');
        expect(content).toEqual(new Uint8Array([
            6,
            7,
        ]));
        expect(close).not.toHaveBeenCalled();
        await clearCachedRangeReadHandlesForTests();
        expect(close).toHaveBeenCalled();
    });

    it('still rejects direct PDF source reads outside the temp sandbox', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);

        await expect(
            handleFileRead(
                {},
                '/Users/alice/Documents/file.pdf',
            ),
        ).rejects.toThrow('Invalid file path: reads only allowed within temp directory');

        expect(mocks.isAllowedDjvuViewingPath).not.toHaveBeenCalled();
    });

    it('routes PDF conformance checks through the worker-backed helper', async () => {
        const result = await handleAnalyzePdfConformance(readContext, '/tmp/electron-test/safe.pdf');

        expect(mocks.analyzePdfConformanceFile).toHaveBeenCalledWith(
            '/tmp/electron-test/safe.pdf',
            {markerEvidence: 'full'},
        );
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(result).toEqual({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
    });

    it('cancels PDF conformance when its logical working copy is released', async () => {
        const workingCopyPath = '/tmp/electron-test/safe.pdf';
        mocks.getWorkingCopyBackingEntry.mockReturnValue({
            ...lazyOriginalEntry(),
            backingState: 'materialized',
        });
        let analysisSignal: AbortSignal | undefined;
        mocks.analyzePdfConformanceFile.mockImplementation((_path: string, options: {signal?: AbortSignal}) => {
            analysisSignal = options.signal;
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {once: true});
            });
        });

        const analysis = handleAnalyzePdfConformance(readContext, workingCopyPath);
        await vi.waitFor(() => expect(analysisSignal).toBeInstanceOf(AbortSignal));
        expect(mocks.analyzePdfConformanceFile).toHaveBeenCalledWith(
            workingCopyPath,
            expect.objectContaining({signal: analysisSignal}),
        );

        cancelMainOperationsForClosingWorkingCopy(
            workingCopyPath,
            'Working copy is closing',
            {isRegistrationCurrent: () => true},
        );
        expect(analysisSignal?.aborted).toBe(true);
        await expect(analysis).rejects.toThrow('Working copy is closing');
    });

    it('validates lazy-original PDFs through their checked source backing', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.existsSync.mockReturnValue(false);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(lazyOriginalEntry());

        const result = await handleValidatePdfPath(readContext, '/tmp/electron-test/lazy.pdf');

        expect(mocks.validatePdfFile).toHaveBeenCalledWith('/Users/alice/Documents/file.pdf');
        expect(mocks.captureWorkingCopyAdmissionSnapshot).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
    });

    it('analyzes lazy-original PDFs through their checked source backing', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.existsSync.mockReturnValue(false);
        mocks.getWorkingCopyBackingEntry.mockReturnValue(lazyOriginalEntry());

        await handleAnalyzePdfConformance(readContext, '/tmp/electron-test/lazy.pdf');

        expect(mocks.analyzePdfConformanceFile).toHaveBeenCalledWith(
            '/Users/alice/Documents/file.pdf',
            expect.objectContaining({
                markerEvidence: 'full',
                signal: expect.any(AbortSignal),
            }),
        );
        expect(mocks.captureWorkingCopyAdmissionSnapshot).toHaveBeenCalledTimes(2);
    });

    it('rejects invalid DOCX write payloads before consuming the approved path', async () => {
        await expect(
            handleFileWriteDocx(
                writeContext,
                '/tmp/electron-test/export.docx',
                'not-bytes',
            ),
        ).rejects.toThrow('Invalid data: must be a Uint8Array');

        expect(mocks.consumeAllowedDocxWritePath).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('consumes DOCX write grants for the invoking sender only', async () => {
        await handleFileWriteDocx(
            writeContext,
            '/tmp/electron-test/export.docx',
            new Uint8Array([9]),
        );

        expect(mocks.consumeAllowedDocxWritePath).toHaveBeenCalledWith('/tmp/electron-test/export.docx', 42);
        expect(mocks.open).toHaveBeenCalledWith(
            expect.stringMatching(new RegExp(`^${escapeRegExp(`${dirname(resolve('/tmp/electron-test/export.docx'))}${sep}.`)}[0-9a-f]{16}\\.tmp$`, 'u')),
            'wx',
        );
        expect(mocks.writeFile).toHaveBeenCalledWith(new Uint8Array([9]));
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(new RegExp(`^${escapeRegExp(`${dirname(resolve('/tmp/electron-test/export.docx'))}${sep}.`)}[0-9a-f]{16}\\.tmp$`, 'u')),
            resolve('/tmp/electron-test/export.docx'),
        );
    });

    it('serializes concurrent first range handle opens for the same path', async () => {
        const firstOpen = deferred<{
            close: ReturnType<typeof vi.fn>;
            read: ReturnType<typeof vi.fn>;
        }>();
        const close = vi.fn(async () => {});
        const read = vi.fn(async (buffer: Buffer, _offset: number, length: number, position: number) => {
            buffer.fill(position === 0 ? 1 : 2, 0, length);
            return { bytesRead: length };
        });
        mocks.open.mockImplementationOnce(() => firstOpen.promise);

        const firstRead = handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 0, 2);
        const secondRead = handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 2, 2);
        await vi.waitFor(() => {
            expect(mocks.open).toHaveBeenCalledTimes(1);
        });

        firstOpen.resolve({
            close,
            read,
        });

        await expect(firstRead).resolves.toEqual(new Uint8Array([
            1,
            1,
        ]));
        await expect(secondRead).resolves.toEqual(new Uint8Array([
            2,
            2,
        ]));
        expect(mocks.open).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it('coalesces identical concurrent range reads', async () => {
        const pendingRead = deferred<{bytesRead: number}>();
        const close = vi.fn(async () => {});
        const read = vi.fn((buffer: Buffer) => pendingRead.promise.then((result) => {
            buffer.fill(7);
            return result;
        }));
        mocks.open.mockResolvedValue({
            close,
            read,
        });

        const firstRead = handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 4, 2);
        const secondRead = handleFileReadRange(readContext, '/tmp/electron-test/safe.pdf', 4, 2);
        await vi.waitFor(() => {
            expect(read).toHaveBeenCalledTimes(1);
        });
        expect(getRangeReadCacheStatsForTests()).toMatchObject({pendingReads: 1});
        pendingRead.resolve({bytesRead: 2});

        await expect(Promise.all([
            firstRead,
            secondRead,
        ])).resolves.toEqual([
            new Uint8Array([
                7,
                7,
            ]),
            new Uint8Array([
                7,
                7,
            ]),
        ]);
        expect(read).toHaveBeenCalledTimes(1);
        expect(getRangeReadCacheStatsForTests()).toMatchObject({pendingReads: 0});
    });
});

describe('content settlement refusal', () => {
    it.each([
        'close',
        'unproven',
    ])('reads a seventh healthy file while an older %s failure retains one of six real handles', async failureKind => {
        await clearCachedRangeReadHandlesForTests();
        vi.resetModules();
        const readers = await import('@electron/features/documents/main/documentFileReadHandlers');
        const queue = await import('@electron/file-access/workingCopyMutationQueue');
        const quarantine = await import('@electron/file-access/workingCopyQuarantine');
        const fixture = await createContentFixture();
        const failure = failureKind === 'unproven'
            ? markUnprovenNativeTermination(new Error('Old reader is still alive'), 'old native tree is unproven')
            : new Error('Old real handle failed to close');
        if (failureKind === 'close') mocks.open.mockImplementation(async (path: string) => {
            const handle = await fixture.fs.open(path, 'r');
            fixture.handles.push(handle);
            return path === fixture.path ? {
                read: handle.read.bind(handle),
                close: async () => { throw failure; },
            } : handle;
        });
        try {
            if (failureKind === 'unproven') {
                await expect(readers.withContentReadLease(fixture.path, async () => { throw failure; })).rejects.toBe(failure);
            } else {
                await readers.withContentReadLease(fixture.path, handle => handle.read(Buffer.alloc(6), 0, 6, 0));
                await expect(queue.enqueueWorkingCopyMutation(fixture.path, async () => undefined)).rejects.toBe(failure);
            }
            for (let index = 0; index < 6; index += 1) {
                const path = join(dirname(fixture.path), `healthy-${index}.pdf`);
                const expected = `complete healthy bytes ${index}`;
                await fixture.fs.writeFile(path, expected);
                expect(await readers.withContentReadLease(path, async handle => {
                    const bytes = Buffer.alloc(expected.length);
                    const {bytesRead} = await handle.read(bytes, 0, bytes.length, 0);
                    expect(bytesRead).toBe(bytes.length);
                    return bytes.toString('utf8');
                })).toBe(expected);
                expect(fixture.handles.filter(handle => handle.fd >= 0).length).toBeLessThanOrEqual(6);
                expect(quarantine.isWorkingCopyQuarantined(path)).toBe(false);
            }
            expect(fixture.handles[0]?.fd).toBeGreaterThanOrEqual(0);
            await expect(readers.withContentReadLease(fixture.path, async () => 'forbidden read')).rejects.toBe(failure);
            await expect(queue.enqueueWorkingCopyMutation(fixture.path,
                () => fixture.fs.writeFile(fixture.path, 'forbidden write'))).rejects.toBe(failure);
            expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('before');
            expect(quarantine.isWorkingCopyQuarantined(fixture.path)).toBe(failureKind === 'unproven');
        } finally {
            await readers.closeCachedRangeReadHandles().catch(() => undefined);
            await fixture.dispose();
            quarantine.clearWorkingCopyQuarantinesForTests();
            vi.resetModules();
        }
    });

    it.each([
        'opening',
        'save',
        'full',
        'fallback',
        'worker-frame',
    ] as const)('retains admitted bytes after actual native adapter termination is unproven during %s validation', async purpose => {
        await clearCachedRangeReadHandlesForTests();
        vi.resetModules();
        const readers = await import('@electron/features/documents/main/documentFileReadHandlers');
        const validation = await import('@electron/features/documents/main/documentPdfValidationHandlers');
        const actualValidation = await vi.importActual<typeof TPdfConformance>('@electron/features/documents/main/pdfConformance');
        const pathAnalysis = await import('@electron/features/documents/main/pdfConformancePathAnalysis');
        const wire = await import('@electron/utils/workerTask');
        const queue = await import('@electron/file-access/workingCopyMutationQueue');
        const quarantine = await import('@electron/file-access/workingCopyQuarantine');
        const store = await import('@electron/file-access/workingCopyStore');
        const fixture = await createContentFixture();
        await store.setWorkingCopyOriginalPath(fixture.path, join(dirname(fixture.path), 'source.pdf'), 42,
            {
                backingState: 'materialized',
                deferOriginalFileExpectation: true,
            });
        if (!mocks.admittedWorkingCopyBackingEntry) throw new Error('Missing actual working-copy admission');
        mocks.getWorkingCopyBackingEntry.mockImplementation(mocks.admittedWorkingCopyBackingEntry);
        const children: Array<EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough
        }> = [];
        const entered = deferred<undefined>();
        const termination = vi.fn(async () => false);
        if (purpose === 'fallback') termination.mockResolvedValueOnce(true);
        mocks.nativeTermination.mockImplementation(termination);
        mocks.nativeSpawn.mockImplementation(() => {
            const child = Object.assign(new EventEmitter(), {
                pid: 987654,
                exitCode: null,
                signalCode: null,
                stdout: new PassThrough(),
                stderr: new PassThrough(),
            });
            children.push(child);
            entered.resolve(undefined);
            return child;
        });
        mocks.validatePdfFile.mockImplementation(actualValidation.validatePdfFile);
        vi.stubEnv('EVB_APP_TEMP_NAMESPACE', '');
        vi.useFakeTimers();
        try {
            const read = purpose === 'worker-frame'
                ? readers.withContentReadLease(fixture.path, async () => {
                    try {
                        await pathAnalysis.validatePdfStructureFromPath(fixture.path);
                    } catch (error) {
                        throw new wire.WorkerTaskError(structuredClone(wire.createWorkerTaskErrorFrame(error)));
                    }
                })
                : validation.handleValidatePdfPath({senderId: 42}, fixture.path,
                    purpose === 'full' || purpose === 'fallback' ? undefined : {purpose});
            const observed = read.catch((error: unknown) => error);
            await entered.promise;
            await vi.advanceTimersByTimeAsync(purpose === 'opening' || purpose === 'save' ? 10_000
                : purpose === 'worker-frame' ? 600_000 : purpose === 'fallback' ? 630_000 : 30_000);
            const failure: unknown = await observed;
            expect(failure).toBeInstanceOf(Error);
            const detail = getUnprovenNativeTerminationDetail(failure);
            expect(detail).toContain('process tree (pid=987654) was not proven dead');
            expect(detail).toContain(purpose === 'fallback' || purpose === 'worker-frame'
                ? 'evb-pdf-page-ops(pdf-conformance)' : 'qpdf(validate-pdf');
            expect(children).toHaveLength(purpose === 'fallback' ? 2 : 1);
            expect(quarantine.isWorkingCopyQuarantined(fixture.path)).toBe(true);
            expect(quarantine.isWorkingCopyQuarantined(join(dirname(fixture.path), 'source.pdf'))).toBe(false);
            const refusingWrite = queue.enqueueWorkingCopyMutation(fixture.path,
                () => fixture.fs.writeFile(fixture.path, 'forbidden'));
            await expect(refusingWrite).rejects.toBe(failure);
            expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('before');
            expect(fixture.handles.every(handle => handle.fd >= 0)).toBe(true);
            await expect(readers.withContentReadLease(fixture.path, async () => undefined)).rejects.toBe(failure);
        } finally {
            vi.useRealTimers();
            vi.unstubAllEnvs();
            for (const child of children) {
                child.stdout.destroy();
                child.stderr.destroy();
                child.removeAllListeners();
            }
            await fixture.dispose();
            quarantine.clearWorkingCopyQuarantinesForTests();
            vi.resetModules();
        }
    });

    it.each([
        'close',
        'unproven',
    ])('retains content when %s settlement cannot be proven', async (failureKind) => {
        await clearCachedRangeReadHandlesForTests();
        vi.resetModules();
        const readers = await import('@electron/features/documents/main/documentFileReadHandlers');
        const validation = await import('@electron/features/documents/main/documentPdfValidationHandlers');
        const queue = await import('@electron/file-access/workingCopyMutationQueue');
        const fixture = await createContentFixture();
        const store = await import('@electron/file-access/workingCopyStore');
        const quarantine = await import('@electron/file-access/workingCopyQuarantine');
        await store.setWorkingCopyOriginalPath(fixture.path, join(dirname(fixture.path), 'source.pdf'), 42,
            {
                backingState: 'materialized',
                deferOriginalFileExpectation: true,
            });
        if (!mocks.admittedWorkingCopyBackingEntry) throw new Error('Missing actual working-copy admission');
        mocks.getWorkingCopyBackingEntry.mockImplementation(mocks.admittedWorkingCopyBackingEntry);
        const failure = failureKind === 'unproven'
            ? markUnprovenNativeTermination(new Error('Native tree termination is unproven'), 'test child is not confirmed gone')
            : new Error('Actual handle close failed');
        if (failureKind === 'unproven') {
            mocks.analyzePdfConformanceFile.mockRejectedValueOnce(failure);
            await expect(validation.handleAnalyzePdfConformance({senderId: 42}, fixture.path)).rejects.toBe(failure);
        } else {
            mocks.analyzePdfConformanceFile.mockResolvedValue({saveRestrictions: []});
            mocks.open.mockImplementation(async (...args: Parameters<typeof fixture.fs.open>) => {
                const handle = await fixture.fs.open(...args);
                fixture.handles.push(handle);
                return {
                    read: handle.read.bind(handle),
                    close: async () => { throw failure; },
                };
            });
            await validation.handleAnalyzePdfConformance({senderId: 42}, fixture.path);
        }
        try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                await expect(queue.enqueueWorkingCopyMutation(fixture.path,
                    () => fixture.fs.writeFile(fixture.path, 'forbidden'))).rejects.toBe(failure);
                expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('before');
            }
            await expect(validation.handleAnalyzePdfConformance({senderId: 42}, fixture.path)).rejects.toBe(failure);
            await expect(readers.closeCachedRangeReadHandles()).rejects.toBe(failure);
            expect(fixture.handles.every(handle => handle.fd >= 0)).toBe(true);
            if (failureKind === 'unproven') {
                expect(getUnprovenNativeTerminationDetail(failure)).toBe('test child is not confirmed gone');
                expect(quarantine.isWorkingCopyQuarantined(fixture.path)).toBe(true);
                const lifecycle = await import('@electron/operation-lifecycle/mainOperationLifecycle');
                expect(lifecycle.snapshotMainOperations().filter(operation => operation.workingCopyPath === fixture.path)).toEqual([]);
                const {cleanupWorkingCopy} = await import('@electron/file-access/workingCopyCleanup');
                await expect(cleanupWorkingCopy(fixture.path, 42)).resolves.toBe(false);
                expect(store.workingCopyMap.has(fixture.path)).toBe(false);
                expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('before');
                await store.setWorkingCopyOriginalPath(fixture.path, join(dirname(fixture.path), 'new-source.pdf'), 42,
                    {
                        backingState: 'materialized',
                        deferOriginalFileExpectation: true,
                    });
                await expect(queue.enqueueWorkingCopyMutation(fixture.path,
                    () => fixture.fs.writeFile(fixture.path, 'forbidden'))).rejects.toBe(failure);
                expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('before');
                expect(quarantine.isWorkingCopyQuarantined(join(dirname(fixture.path), '.', 'document.pdf'))).toBe(true);
                if (process.platform === 'win32') expect(quarantine.isWorkingCopyQuarantined(fixture.path.toUpperCase())).toBe(true);
            }
        } finally {
            // This unit has no native child; its real Node handles are disposed
            // by the fixture owner. The production entry still refuses reuse.
            await fixture.dispose();
            quarantine.clearWorkingCopyQuarantinesForTests();
            vi.resetModules();
        }
    });

    it('quarantines the admitted lazy logical copy while retaining its original and other logical copies', async () => {
        vi.resetModules();
        const validation = await import('@electron/features/documents/main/documentPdfValidationHandlers');
        const readers = await import('@electron/features/documents/main/documentFileReadHandlers');
        const store = await import('@electron/file-access/workingCopyStore');
        const quarantine = await import('@electron/file-access/workingCopyQuarantine');
        const fixture = await createContentFixture();
        const logicalPath = join(dirname(fixture.path), 'logical.pdf');
        const otherLogicalPath = join(dirname(fixture.path), 'other.pdf');
        await fixture.fs.writeFile(logicalPath, 'logical bytes');
        const originalStat = await fixture.fs.stat(fixture.path, {bigint: true});
        const admissionSnapshot = {
            size: originalStat.size,
            mtimeNs: originalStat.mtimeNs,
        };
        for (const [
            path,
            senderId,
        ] of [
                [
                    logicalPath,
                    42,
                ],
                [
                    otherLogicalPath,
                    43,
                ],
            ] as const) {
            await store.setWorkingCopyOriginalPath(path, fixture.path, senderId,
                {
                    backingState: 'lazy-original',
                    deferOriginalFileExpectation: true,
                    admissionSnapshot,
                });
        }
        if (!mocks.admittedWorkingCopyBackingEntry) throw new Error('Missing actual working-copy admission');
        mocks.getWorkingCopyBackingEntry.mockImplementation(mocks.admittedWorkingCopyBackingEntry);
        mocks.captureWorkingCopyAdmissionSnapshot.mockResolvedValue(admissionSnapshot);
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        const failure = markUnprovenNativeTermination(new Error('Lazy native reader did not terminate'), 'lazy child termination unproven');
        mocks.analyzePdfConformanceFile.mockRejectedValueOnce(failure);
        try {
            const alias = `${dirname(fixture.path)}/unused/../logical.pdf`;
            await expect(validation.handleAnalyzePdfConformance({senderId: 42}, alias)).rejects.toBe(failure);
            expect(quarantine.isWorkingCopyQuarantined(logicalPath)).toBe(true);
            expect(quarantine.isWorkingCopyQuarantined(alias)).toBe(true);
            expect(quarantine.isWorkingCopyQuarantined(fixture.path)).toBe(false);
            expect(quarantine.isWorkingCopyQuarantined(otherLogicalPath)).toBe(false);
            const {cleanupWorkingCopy} = await import('@electron/file-access/workingCopyCleanup');
            await expect(cleanupWorkingCopy(logicalPath, 42)).resolves.toBe(false);
            expect(store.workingCopyMap.has(logicalPath)).toBe(false);
            expect(store.workingCopyMap.has(otherLogicalPath)).toBe(true);
            expect(await fixture.fs.readFile(logicalPath, 'utf8')).toBe('logical bytes');
            expect(await fixture.fs.readFile(fixture.path, 'utf8')).toBe('before');
            await expect(Promise.resolve(mocks.backingSwapCacheInvalidator?.(logicalPath, fixture.path))).rejects.toBe(failure);
            await expect(readers.closeCachedRangeReadHandles()).rejects.toBe(failure);
            expect(fixture.handles.every(handle => handle.fd >= 0)).toBe(true);
        } finally {
            await fixture.dispose();
            quarantine.clearWorkingCopyQuarantinesForTests();
            vi.resetModules();
        }
    });
});

async function createContentFixture() {
    const fs = await vi.importActual<typeof NodeFsPromises>('node:fs/promises');
    const syncFs = await vi.importActual<typeof NodeFs>('node:fs');
    const directory = await fs.mkdtemp(join(tmpdir(), 'native-content-'));
    const path = join(directory, 'document.pdf');
    await fs.writeFile(path, 'before');
    const handles: Array<Awaited<ReturnType<typeof fs.open>>> = [];
    mocks.existsSync.mockReturnValue(true);
    mocks.realpathSync.mockImplementation(value => value);
    mocks.isAllowedReadPath.mockReturnValue(true);
    mocks.resolveAllowedReadPath.mockResolvedValue(path);
    mocks.getWorkingCopyBackingEntry.mockReturnValue({backingState: 'materialized'});
    mocks.statSync.mockImplementation(value => syncFs.statSync(value));
    mocks.open.mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        handles.push(handle);
        return handle;
    });
    return {
        fs,
        path,
        handles,
        async dispose() {
            await Promise.all(handles.filter(handle => handle.fd >= 0).map(handle => handle.close()));
            await fs.rm(directory, {
                recursive: true,
                force: true,
            });
        },
    };
}

// Live handles from the mocked `open`, removed again when the handle closes.
const openFileHandles = new Set<{path: string}>();

function openTrackedHandle(path: string, beforeRead: () => Promise<void> = async () => undefined) {
    const record = {path};
    openFileHandles.add(record);
    return {
        close: vi.fn(async () => {
            openFileHandles.delete(record);
        }),
        read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
            await beforeRead();
            buffer.fill(5, offset, offset + length);
            return {bytesRead: length};
        }),
    };
}

function countOpenHandles(path: string) {
    return [...openFileHandles].filter(record => record.path === path).length;
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
    await Promise.resolve();
    await Promise.resolve();
}
