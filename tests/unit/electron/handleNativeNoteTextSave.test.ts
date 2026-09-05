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
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    truncateSync,
    writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import {
    appendFile,
    copyFile,
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { PDF_NATIVE_MUTATION_LIMITS } from '@contracts/nativePdfMutations';
import {requireDocumentRevisionToken} from '@contracts';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {createNativeIncrementalMutationSemanticScopeSha256} from '@electron/features/documents/main/documentSaveUtilityProtocol';

const mocks = vi.hoisted(() => ({
    runNativeToolCommand: vi.fn(),
    isNativePageOpsDisabled: vi.fn(),
    resolveNativePageOpsPath: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(),
    getWorkingCopyOriginalFileExpectation: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    isAllowedOriginalSavePath: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
    atomicReplace: vi.fn(),
    publishImmutableFileAtomic: vi.fn(),
    copyFileCopyOnWrite: vi.fn(),
    assertWorkingCopyMutationAllowed: vi.fn(),
    assertWorkingCopyResyncAllowed: vi.fn(),
    assertWorkingCopyRevisionCurrent: vi.fn(),
    transitionWorkingCopyContentRevision: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    markWorkingCopySyncRequired: vi.fn(),
    resolveManagedTempFileHandle: vi.fn(async (_context: unknown, handle: unknown) => handle),
    resolveTypedStagedArtifact: vi.fn(async (_context: unknown, artifact: unknown) => artifact),
    createOpaqueNativePdfStagedArtifact: vi.fn(),
    createTypedStagedArtifactForTrustedSiblingCopy: vi.fn(),
    releaseManagedTempFileHandle: vi.fn((_context: unknown, _leaseId: string) => true),
    transitionOriginalAndWorkingCopyRevision: vi.fn(),
    commitPdfTempFile: vi.fn(),
    fingerprintFileWithUtilityProcess: vi.fn(),
    loggerDebug: vi.fn(),
    loggerWarn: vi.fn(),
    ensureWorkingCopyMaterialized: vi.fn(),
    getPdfNativeToolPaths: vi.fn(() => ({qpdf: '/native/qpdf'})),
}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/features/page-ops/public', () => ({
    isNativePageOpsDisabled: (...args: unknown[]) => mocks.isNativePageOpsDisabled(...args),
    resolveNativePageOpsPath: (...args: unknown[]) => mocks.resolveNativePageOpsPath(...args),
}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => mocks.getPdfNativeToolPaths()}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyOriginalPath: (...args: unknown[]) => mocks.getWorkingCopyOriginalPath(...args),
    getWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.getWorkingCopyOriginalFileExpectation(...args),
    findWorkingCopyPathByOriginalPath: (...args: unknown[]) => mocks.findWorkingCopyPathByOriginalPath(...args),
    normalizePathForLookup: (path: string) => path.trim(),
    refreshWorkingCopyOriginalFileExpectation: (...args: unknown[]) => mocks.refreshWorkingCopyOriginalFileExpectation(...args),
}));
vi.mock('@electron/file-access/isAllowedOriginalSavePath', () => ({isAllowedOriginalSavePath: (...args: unknown[]) => mocks.isAllowedOriginalSavePath(...args)}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({
    assertWorkingCopyMutationAllowed: (...args: unknown[]) => mocks.assertWorkingCopyMutationAllowed(...args),
    assertWorkingCopyResyncAllowed: (...args: unknown[]) => mocks.assertWorkingCopyResyncAllowed(...args),
    assertWorkingCopyRevisionCurrent: (...args: unknown[]) => mocks.assertWorkingCopyRevisionCurrent(...args),
    transitionWorkingCopyContentRevision: (...args: unknown[]) => mocks.transitionWorkingCopyContentRevision(...args),
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    markWorkingCopySyncRequired: (...args: unknown[]) => mocks.markWorkingCopySyncRequired(...args),
}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: [string, string]) => mocks.copyFileCopyOnWrite(...args)}));
vi.mock('@electron/file-access/documentFileWriteAtomic', () => ({publishImmutableFileAtomic: (...args: unknown[]) => mocks.publishImmutableFileAtomic(...args)}));
vi.mock('@electron/features/documents/main/managedTempFileHandles', () => ({
    createOpaqueNativePdfStagedArtifact: (...args: unknown[]) =>
        mocks.createOpaqueNativePdfStagedArtifact(...args),
    createTypedStagedArtifactForTrustedSiblingCopy: (...args: unknown[]) =>
        mocks.createTypedStagedArtifactForTrustedSiblingCopy(...args),
    releaseManagedTempFileHandle: (context: unknown, leaseId: string) => mocks.releaseManagedTempFileHandle(context, leaseId),
    resolveManagedTempFileHandle: (context: unknown, handle: unknown) => mocks.resolveManagedTempFileHandle(context, handle),
    resolveTypedStagedArtifact: (context: unknown, artifact: unknown) => mocks.resolveTypedStagedArtifact(context, artifact),
}));
vi.mock('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision', () => ({transitionOriginalAndWorkingCopyRevision: (...args: unknown[]) => mocks.transitionOriginalAndWorkingCopyRevision(...args)}));
vi.mock('@electron/features/documents/main/commitPdfTempFile', () => ({commitPdfTempFile: (...args: unknown[]) => mocks.commitPdfTempFile(...args)}));
vi.mock('@electron/features/documents/main/fingerprintFileWithUtilityProcess', () => ({fingerprintFileWithUtilityProcess: (...args: unknown[]) => mocks.fingerprintFileWithUtilityProcess(...args)}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({ensureWorkingCopyMaterialized: (...args: unknown[]) => mocks.ensureWorkingCopyMaterialized(...args)}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: (...args: unknown[]) => mocks.loggerDebug(...args),
    info: vi.fn(),
    warn: (...args: unknown[]) => mocks.loggerWarn(...args),
    error: vi.fn(),
})}));

function createOriginalFileExpectationForTest(originalPath: string) {
    const originalStat = statSync(originalPath, {bigint: true});
    return {
        deviceId: originalStat.dev.toString(),
        inode: originalStat.ino.toString(),
        mtimeNs: originalStat.mtimeNs.toString(),
        ctimeNs: originalStat.ctimeNs.toString(),
        mtimeMs: Number(originalStat.mtimeNs) / 1_000_000,
        size: Number(originalStat.size),
    };
}

interface INativeBookmarkTestItem {
    title: string;
    pageIndex: number | null;
    namedDest: string | null;
    bold: boolean;
    italic: boolean;
    color: string | null;
    items: INativeBookmarkTestItem[];
}

interface ITestTrustedFingerprint {
    bytes: number;
    sha256: string;
}

interface ITestTypedStagedArtifactOptions {trustedFingerprint?: ITestTrustedFingerprint;}

interface ITestTypedStagedArtifactSource {
    size: number;
    sha256: string;
}

function createNativeFreeTextNote() {
    return {
        pageIndex: 0,
        stableKey: 'uid:0:pdfjs_internal_editor_0',
        text: 'Editor note',
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.0016,
            height: 0.0016,
        },
    };
}

function createNativeFreeTextEditor() {
    return {
        pageIndex: 0,
        stableKey: 'pdfjs_internal_editor_0',
        text: 'Editor text',
        rect: [
            0.1,
            0.2,
            0.4,
            0.3,
        ] as [number, number, number, number],
        rotation: 0 as const,
        fontSize: 12,
        color: [
            17,
            24,
            39,
        ] as [number, number, number],
    };
}

function createNativeBookmark(title = 'Chapter'): INativeBookmarkTestItem {
    return {
        title,
        pageIndex: 0,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items: [],
    };
}

function createDeepNativeBookmarkItems(depth: number) {
    const root = createNativeBookmark('Root');
    let current = root;
    for (let index = 0; index < depth; index += 1) {
        const child = createNativeBookmark(`Child ${index}`);
        current.items = [child];
        current = child;
    }
    return [root];
}

function createNativeShape() {
    return {
        type: 'rectangle' as const,
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.2,
        color: '#336699',
        opacity: 0.5,
        strokeWidth: 3,
    };
}

function createNativePlacedImage() {
    return {
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.2,
        rotationDegrees: 0,
        mimeType: 'image/jpeg' as const,
        source: {
            path: '/tmp/image.jpg',
            size: 3,
            sha256: 'a'.repeat(64),
            leaseId: 'image-lease',
            revision: null,
        },
    };
}

function createUnboundNativeMarkupMutation() {
    return {markup: {
        overrides: [],
        hints: [{
            subtype: 'Highlight' as const,
            pageIndex: 0,
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.3,
                height: 0.2,
            },
            color: '#facc15',
            id: 'markup-identity-1',
            pageMarkupIndex: 0,
            source: 'editor-live' as const,
            appAnnotationId: 'app-markup-identity-1',
        }],
    }};
}

const nativeMarkupIdentityBinding = {
    annotationId: 'app-markup-identity-1',
    pdfRef: '84 0 R',
};

const nativeShapeIdentityBinding = {
    annotationId: 'shape-identity-1',
    pdfRef: '85 0 R',
};

function createUnboundNativeMarkupAndShapeMutation() {
    return {
        ...createUnboundNativeMarkupMutation(),
        shapes: {
            totalPages: 1,
            rewriteShapeState: true,
            shapes: [{
                type: 'rectangle' as const,
                pageIndex: 0,
                x: 0.2,
                y: 0.3,
                width: 0.2,
                height: 0.1,
                color: '#336699',
                opacity: 0.8,
                strokeWidth: 2,
                stableKey: 'shape-identity-1',
            }],
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        },
    };
}

async function writeEmptyIdentityBindingsIfRequested(args: readonly string[]) {
    const identityBindingsIndex = args.indexOf('--identity-bindings-file');
    if (identityBindingsIndex < 0) {
        return;
    }
    const identityBindingsPath = args[identityBindingsIndex + 1];
    if (!identityBindingsPath) {
        throw new Error('Missing identity bindings output path');
    }
    await writeFile(identityBindingsPath, '[]');
}

function createOpaqueStagedArtifact(path: string): ITypedStagedArtifact {
    return {
        receiptVersion: 2,
        artifactKind: 'pdf',
        path,
        size: 3,
        fileIdentity: {
            platform: 'posix',
            deviceId: '1',
            inode: '2',
        },
        validations: {
            qpdfCheck: false,
            tailCheck: true,
            semanticCheck: true,
            semanticScopeSha256: createNativeIncrementalMutationSemanticScopeSha256(),
            fsynced: true,
        },
        leaseId: 'staged-native-output',
        revision: null,
    };
}

describe('handleNativeNoteTextSave', () => {
    let tempRoot = '';
    const context = {senderId: 42};
    const revisionOptions = {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-native-mutation')};

    function createOriginalMutationFixture(originalContents = 'original-before') {
        const requestedWorkingPath = join(tempRoot, 'requested-working.pdf');
        const latestWorkingPath = join(tempRoot, 'latest-working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const tempPath = `${originalPath}.tmp`;
        writeFileSync(requestedWorkingPath, 'working-before');
        writeFileSync(latestWorkingPath, 'latest-before');
        writeFileSync(originalPath, originalContents);
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(latestWorkingPath);
        return {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        };
    }

    beforeEach(() => {
        vi.resetAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-native-note-save-test-'));
        mocks.makeSiblingTempPath.mockImplementation((targetPath: string) => `${targetPath}.tmp`);
        mocks.isNativePageOpsDisabled.mockReturnValue(false);
        mocks.resolveNativePageOpsPath.mockReturnValue('/native/evb-pdf-page-ops');
        mocks.getPdfNativeToolPaths.mockReturnValue({qpdf: '/native/qpdf'});
        mocks.isAllowedOriginalSavePath.mockReturnValue(true);
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.ensureWorkingCopyMaterialized.mockImplementation(async (path: string) => ({
            logicalRef: path,
            physicalWorkingCopyPath: path,
            sourceFingerprint: '',
        }));
        mocks.assertWorkingCopyMutationAllowed.mockReturnValue(undefined);
        mocks.assertWorkingCopyRevisionCurrent.mockResolvedValue(undefined);
        mocks.transitionWorkingCopyContentRevision.mockImplementation(async (
            workingCopyPath: string,
            reason: string,
            commit: (revision: unknown) => Promise<void>,
        ) => {
            const previousBytes = await readFile(workingCopyPath);
            const revision = {
                token: requireDocumentRevisionToken('revision-after-native-mutation'),
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
        mocks.markWorkingCopyContentChanged.mockResolvedValue(undefined);
        mocks.markWorkingCopySyncRequired.mockReturnValue(undefined);
        mocks.commitPdfTempFile.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await copyFile(sourcePath, targetPath);
            await unlink(sourcePath).catch(() => undefined);
        });
        mocks.publishImmutableFileAtomic.mockImplementation(async (
            sourcePath: string,
            targetPath: string,
            options?: {assertDestinationCurrent?: () => Promise<void>},
        ) => {
            await options?.assertDestinationCurrent?.();
            await copyFile(sourcePath, targetPath);
        });
        mocks.createOpaqueNativePdfStagedArtifact.mockImplementation(async (
            _context: unknown,
            path: string,
            validations: {
                qpdfCheck: boolean;
                tailCheck: boolean;
                semanticCheck: boolean;
                fsynced: boolean;
                semanticScopeSha256?: string;
            },
            _options?: ITestTypedStagedArtifactOptions,
        ) => {
            const bytes = await readFile(path);
            return {
                receiptVersion: 2,
                artifactKind: 'pdf',
                path,
                size: bytes.byteLength,
                fileIdentity: {
                    platform: 'posix',
                    deviceId: '1',
                    inode: '2',
                },
                validations,
                leaseId: path === `${join(tempRoot, 'staged-original.pdf')}.tmp.pdf`
                    ? 'staged-native-output-copy'
                    : 'staged-native-output',
                revision: null,
            };
        });
        mocks.createTypedStagedArtifactForTrustedSiblingCopy.mockImplementation(async (
            _callContext: unknown,
            sourceArtifact: ITestTypedStagedArtifactSource,
            path: string,
            _originalPath: string,
            validations: {
                qpdfCheck: boolean;
                tailCheck: boolean;
                semanticCheck: boolean;
                fsynced: boolean;
                semanticScopeSha256?: string;
            },
        ) => ({
            ...sourceArtifact,
            receiptVersion: 1 as const,
            path,
            validations,
        }));
        mocks.fingerprintFileWithUtilityProcess.mockImplementation(async (path: string) => {
            const bytes = await readFile(path);
            return {
                bytes: bytes.byteLength,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            };
        });
        mocks.transitionOriginalAndWorkingCopyRevision.mockImplementation(async (input: {
            workingCopyPath: string;
            originalPath: string;
            captureOriginalWitness?: () => Promise<{
                assertCurrent: () => Promise<void>;
                close: () => Promise<void>;
            } | null>;
            publishOriginal: (assertDestinationCurrent?: () => Promise<void>) => Promise<void>;
            afterWorkingCopySync?: () => Promise<void>;
            onPhase?: (phase: string, durationMs: number) => void;
        }) => {
            input.onPhase?.('test-transition', 1);
            const witness = await input.captureOriginalWitness?.() ?? null;
            if (input.captureOriginalWitness && !witness) {
                return null;
            }
            const originalBefore = await readFile(input.originalPath);
            const workingBefore = await readFile(input.workingCopyPath);
            try {
                await input.publishOriginal(witness ? () => witness.assertCurrent() : undefined);
                await copyFile(input.originalPath, input.workingCopyPath);
                await input.afterWorkingCopySync?.();
            } catch (error) {
                await Promise.all([
                    writeFile(input.originalPath, originalBefore),
                    writeFile(input.workingCopyPath, workingBefore),
                ]);
                throw error;
            } finally {
                await witness?.close();
            }
            return {token: requireDocumentRevisionToken('revision-after-native-mutation')};
        });
        mocks.getWorkingCopyOriginalFileExpectation.mockImplementation((workingPath: string, senderWebContentsId?: number) => {
            const original = mocks.getWorkingCopyOriginalPath(workingPath, senderWebContentsId);
            return original?.originalPath
                ? createOriginalFileExpectationForTest(original.originalPath)
                : null;
        });
        mocks.refreshWorkingCopyOriginalFileExpectation.mockReturnValue(true);
        mocks.atomicReplace.mockImplementation(async (
            sourcePath: string,
            targetPath: string,
            options?: {assertDestinationCurrent?: () => Promise<void>},
        ) => {
            await options?.assertDestinationCurrent?.();
            await copyFile(sourcePath, targetPath);
            await unlink(sourcePath);
        });
        mocks.copyFileCopyOnWrite.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await copyFile(sourcePath, targetPath);
        });
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('runs the native append command against a temp snapshot and syncs the refreshed working copy', async () => {
        const {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args).toEqual(expect.arrayContaining([
                '--input',
                tempPath,
                '--output',
                tempPath,
                '--qpdf',
                '/native/qpdf',
                '--append',
            ]));
            await appendFile(tempPath, '\n% native incremental update');
        });
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const result = await handleNativeNoteTextSave(context, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'', revisionOptions);

        expect(result).toMatchObject({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
            },
        });
        expect(mocks.copyFileCopyOnWrite).toHaveBeenNthCalledWith(1, requestedWorkingPath, tempPath);
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                'update-note-text',
                '--input',
                tempPath,
                '--output',
                tempPath,
            ]),
            expect.objectContaining({
                cancelGroup: expect.stringMatching(/^working-copy-mutation:/u),
                commandLabel: 'evb-pdf-page-ops(update-note-text)',
                signal: expect.any(AbortSignal),
            }),
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith(
            tempPath,
            originalPath,
            expect.objectContaining({assertDestinationCurrent: expect.any(Function)}),
        );
        expect(mocks.copyFileCopyOnWrite).not.toHaveBeenCalledWith(originalPath, requestedWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native incremental update');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('uses one externally staged copy for a 700 MiB native mutation save', async () => {
        const {
            requestedWorkingPath,
            tempPath,
        } = createOriginalMutationFixture();
        const largeWorkingCopyBytes = 700 * 1024 * 1024 + 1;
        truncateSync(requestedWorkingPath, largeWorkingCopyBytes);
        mocks.copyFileCopyOnWrite.mockImplementationOnce(async (_sourcePath: string, targetPath: string) => {
            writeFileSync(targetPath, '');
            truncateSync(targetPath, largeWorkingCopyBytes);
        });
        mocks.runNativeToolCommand.mockResolvedValue(undefined);
        mocks.transitionOriginalAndWorkingCopyRevision.mockResolvedValueOnce({token: requireDocumentRevisionToken('revision-after-native-mutation')});
        const {handleNativeNoteTextSave} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );

        const result = await handleNativeNoteTextSave(
            context,
            requestedWorkingPath,
            [{
                objectNumber: 42,
                generationNumber: 0,
                text: 'Updated large note',
            }],
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );
        expect(result).toMatchObject({applied: true});

        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledOnce();
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledWith(requestedWorkingPath, tempPath);
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                '--input',
                tempPath,
                '--output',
                tempPath,
                '--append',
                '--append-in-place',
            ]),
            expect.anything(),
        );
    });

    it('propagates materialization failure before fingerprinting or native staging', async () => {
        const requestedWorkingPath = join(tempRoot, 'lazy-working.pdf');
        const originalPath = join(tempRoot, 'lazy-original.pdf');
        writeFileSync(originalPath, 'original-before');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        const failure = Object.assign(new Error('The original document is unavailable'), {
            code: 'SOURCE_BACKING_UNAVAILABLE',
            retryable: false,
        });
        mocks.ensureWorkingCopyMaterialized.mockRejectedValue(failure);
        const {handleNativeNoteTextSave} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );

        await expect(handleNativeNoteTextSave(
            context,
            requestedWorkingPath,
            [{
                objectNumber: 42,
                generationNumber: 0,
                text: 'Updated note',
            }],
            'D:20260609133855+03\'00\'',
            revisionOptions,
        )).rejects.toBe(failure);

        expect(mocks.fingerprintFileWithUtilityProcess).not.toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(mocks.makeSiblingTempPath).not.toHaveBeenCalled();
        expect(readFileSync(originalPath, 'utf8')).toBe('original-before');
    });

    it('rolls back both targets when post-commit working-copy sync fails', async () => {
        const {
            requestedWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(requestedWorkingPath);
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await appendFile(tempPath, '\n% native incremental update');
        });
        mocks.refreshWorkingCopyOriginalFileExpectation.mockRejectedValueOnce(new Error('sync failed'));
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const result = await handleNativeNoteTextSave(context, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'', revisionOptions);

        expect(result).toEqual({
            applied: false,
            validation: null,
            error: {
                code: 'native-failure',
                message: 'sync failed',
            },
        });
        expect(mocks.atomicReplace).toHaveBeenCalledWith(
            tempPath,
            originalPath,
            expect.objectContaining({assertDestinationCurrent: expect.any(Function)}),
        );
        expect(readFileSyncUtf8(originalPath)).toBe('original-before');
        expect(readFileSyncUtf8(requestedWorkingPath)).toBe('working-before');
    });

    it('preserves typed native error codes when the mutation falls back', async () => {
        const {requestedWorkingPath} = createOriginalMutationFixture();
        mocks.runNativeToolCommand.mockRejectedValue(Object.assign(
            new Error('Native mutation input exceeds limits'),
            {code: 'too-large'},
        ));
        const {handleNativeNoteTextSave} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );

        const result = await handleNativeNoteTextSave(context, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'', revisionOptions);

        expect(result).toEqual({
            applied: false,
            validation: null,
            error: {
                code: 'too-large',
                message: 'Native mutation input exceeds limits',
            },
        });
    });

    it('runs the native note changes append command for FreeText note upserts', async () => {
        const {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args[0]).toBe('save-note-changes');
            const changesFilePath = args[args.indexOf('--changes-file') + 1];
            if (!changesFilePath) {
                throw new Error('Missing changes file path');
            }
            const changesPayload = JSON.parse(readFileSync(changesFilePath, 'utf8')) as {deletes?: unknown[]};
            expect(changesPayload.deletes).toMatchObject([
                {
                    pageIndex: 0,
                    objectNumber: 3856,
                    generationNumber: 0,
                },
                {
                    pageIndex: 0,
                    stableKey: 'uid:0:pdfjs_internal_editor_0',
                    createdAt: 1781009077000,
                },
            ]);
            expect(args).toEqual(expect.arrayContaining([
                '--changes-file',
                expect.stringMatching(/changes\.json$/u),
                '--append',
            ]));
            await appendFile(tempPath, '\n% native note changes');
        });
        const { handleNativeNoteChangesSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const freeTextNotes = [{
            pageIndex: 0,
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            text: 'Editor note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
        }];
        const result = await handleNativeNoteChangesSave(
            context,
            requestedWorkingPath,
            {
                updates: [],
                freeTextNotes,
                deletes: [
                    {
                        pageIndex: 0,
                        objectNumber: 3856,
                        generationNumber: 0,
                    },
                    {
                        pageIndex: 0,
                        stableKey: 'uid:0:pdfjs_internal_editor_0',
                        createdAt: 1781009077000,
                    },
                ],
            },
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );

        expect(result).toMatchObject({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
            },
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                'save-note-changes',
                '--input',
                tempPath,
                '--output',
                tempPath,
            ]),
            expect.objectContaining({commandLabel: 'evb-pdf-page-ops(save-note-changes)'}),
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith(
            tempPath,
            originalPath,
            expect.objectContaining({assertDestinationCurrent: expect.any(Function)}),
        );
        expect(mocks.copyFileCopyOnWrite).not.toHaveBeenCalledWith(originalPath, requestedWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native note changes');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('commits a metadata-only mutation save to the original document', async () => {
        const {
            requestedWorkingPath,
            latestWorkingPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args[0]).toBe('save-mutations');
            await appendFile(tempPath, '\n% native metadata-only changes');
        });
        const { handleNativePdfMutationsSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const result = await handleNativePdfMutationsSave(
            context,
            requestedWorkingPath,
            {
                pageLabels: {
                    totalPages: 3,
                    ranges: [{
                        startPage: 1,
                        style: 'r',
                        prefix: 'intro-',
                        startNumber: 2,
                    }],
                },
                bookmarks: {
                    totalPages: 3,
                    untitledLabel: 'Untitled',
                    items: [{
                        title: 'Chapter 1',
                        pageIndex: 0,
                        namedDest: null,
                        bold: true,
                        italic: false,
                        color: '#336699',
                        items: [],
                    }],
                },
            },
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );

        expect(result).toMatchObject({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
            },
        });
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native metadata-only changes');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('runs the generic native mutation append command for mixed native changes', async () => {
        const {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args[0]).toBe('save-mutations');
            const mutationsFilePath = args[args.indexOf('--mutations-file') + 1];
            if (!mutationsFilePath) {
                throw new Error('Missing mutations file path');
            }
            const mutationsPayload = JSON.parse(readFileSync(mutationsFilePath, 'utf8')) as {
                pageLabels?: unknown;
                bookmarks?: unknown;
                shapes?: {
                    shapes?: unknown[];
                    deletedAnnotationIds?: string[];
                    deletedStableKeys?: string[];
                };
                markup?: {
                    overrides?: unknown[];
                    hints?: unknown[];
                };
            };
            expect(mutationsPayload.pageLabels).toMatchObject({
                totalPages: 3,
                ranges: [{
                    startPage: 1,
                    style: 'r',
                    prefix: 'intro-',
                    startNumber: 2,
                }],
            });
            expect(mutationsPayload.bookmarks).toMatchObject({
                totalPages: 3,
                untitledLabel: 'Untitled',
                items: [{
                    title: 'Chapter 1',
                    pageIndex: 0,
                }],
            });
            expect(mutationsPayload.shapes).toMatchObject({
                totalPages: 3,
                rewriteShapeState: true,
                shapes: [{
                    type: 'rectangle',
                    pageIndex: 0,
                    stableKey: 'evb-shape:shape-1',
                }],
                deletedAnnotationIds: ['44R'],
                deletedStableKeys: ['evb-shape:deleted'],
            });
            expect(mutationsPayload.markup).toMatchObject({
                overrides: [[
                    '44R',
                    'Squiggly',
                ]],
                hints: [expect.objectContaining({
                    subtype: 'Squiggly',
                    annotationId: '44R',
                    color: '#22c55e',
                })],
            });
            expect(args).toEqual(expect.arrayContaining([
                '--mutations-file',
                expect.stringMatching(/mutations\.json$/u),
                '--append',
            ]));
            await writeEmptyIdentityBindingsIfRequested(args);
            await appendFile(tempPath, '\n% native metadata changes');
        });
        const { handleNativePdfMutationsSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const result = await handleNativePdfMutationsSave(
            context,
            requestedWorkingPath,
            {
                pageLabels: {
                    totalPages: 3,
                    ranges: [{
                        startPage: 1,
                        style: 'r',
                        prefix: 'intro-',
                        startNumber: 2,
                    }],
                },
                bookmarks: {
                    totalPages: 3,
                    untitledLabel: 'Untitled',
                    items: [{
                        title: 'Chapter 1',
                        pageIndex: 0,
                        namedDest: null,
                        bold: true,
                        italic: false,
                        color: '#336699',
                        items: [],
                    }],
                },
                shapes: {
                    totalPages: 3,
                    rewriteShapeState: true,
                    shapes: [{
                        id: 'shape-1',
                        type: 'rectangle',
                        pageIndex: 0,
                        x: 0.1,
                        y: 0.2,
                        width: 0.3,
                        height: 0.2,
                        color: '#336699',
                        fillColor: '#abcdef',
                        opacity: 0.5,
                        strokeWidth: 3,
                        stableKey: 'evb-shape:shape-1',
                    }],
                    deletedAnnotationIds: ['44R'],
                    deletedStableKeys: ['evb-shape:deleted'],
                },
                markup: {
                    overrides: [[
                        '44R',
                        'Squiggly',
                    ]],
                    hints: [{
                        subtype: 'Squiggly',
                        pageIndex: 0,
                        markerRect: {
                            left: 0.1,
                            top: 0.2,
                            width: 0.3,
                            height: 0.2,
                        },
                        annotationId: '44R',
                        color: '#22c55e',
                        id: 'markup-1',
                        pageMarkupIndex: 0,
                        source: 'editor-live',
                    }],
                },
            },
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );

        expect(result).toMatchObject({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
            },
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                'save-mutations',
                '--input',
                tempPath,
                '--output',
                tempPath,
            ]),
            expect.objectContaining({commandLabel: 'evb-pdf-page-ops(save-mutations)'}),
        );
        expect(mocks.atomicReplace).toHaveBeenCalledWith(
            tempPath,
            originalPath,
            expect.objectContaining({assertDestinationCurrent: expect.any(Function)}),
        );
        expect(mocks.copyFileCopyOnWrite).not.toHaveBeenCalledWith(originalPath, requestedWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native metadata changes');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('returns the native identity report for newly allocated markup', async () => {
        const {
            requestedWorkingPath,
            latestWorkingPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            const identityBindingsPath = args[args.indexOf('--identity-bindings-file') + 1];
            if (!identityBindingsPath) {
                throw new Error('Missing identity bindings output path');
            }
            await Promise.all([
                appendFile(tempPath, '\n% native markup identity'),
                writeFile(identityBindingsPath, JSON.stringify([nativeMarkupIdentityBinding])),
            ]);
        });
        const {handleNativePdfMutationsSave} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );

        const result = await handleNativePdfMutationsSave(
            context,
            requestedWorkingPath,
            createUnboundNativeMarkupMutation(),
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );

        expect(result).toMatchObject({
            applied: true,
            identityBindings: [nativeMarkupIdentityBinding],
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                '--identity-bindings-file',
                expect.stringMatching(/identity-bindings\.json$/u),
            ]),
            expect.any(Object),
        );
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native markup identity');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('requests and returns bindings for mixed new markup and shape mutations', async () => {
        const {
            requestedWorkingPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            const identityBindingsPath = args[args.indexOf('--identity-bindings-file') + 1];
            if (!identityBindingsPath) {
                throw new Error('Missing identity bindings output path');
            }
            await Promise.all([
                appendFile(tempPath, '\n% native mixed identity'),
                writeFile(identityBindingsPath, JSON.stringify([
                    nativeMarkupIdentityBinding,
                    nativeShapeIdentityBinding,
                ])),
            ]);
        });
        const {handleNativePdfMutationsSave} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );

        const result = await handleNativePdfMutationsSave(
            context,
            requestedWorkingPath,
            createUnboundNativeMarkupAndShapeMutation(),
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );

        expect(result).toMatchObject({
            applied: true,
            identityBindings: [
                nativeMarkupIdentityBinding,
                nativeShapeIdentityBinding,
            ],
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                '--identity-bindings-file',
                expect.stringMatching(/identity-bindings\.json$/u),
            ]),
            expect.any(Object),
        );
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native mixed identity');
    });

    it('refreshes only the requesting working copy when another current copy is queued', async () => {
        const {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture();
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await appendFile(tempPath, '\n% native incremental update');
        });
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockedLatestMutation = deferred<undefined>();
        const blockingMutation = enqueueWorkingCopyMutation(latestWorkingPath, () => blockedLatestMutation.promise);
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const savePromise = handleNativeNoteTextSave(context, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'', revisionOptions);
        await expect(savePromise).resolves.toMatchObject({applied: true});
        expect(mocks.atomicReplace).toHaveBeenCalledWith(
            tempPath,
            originalPath,
            expect.objectContaining({assertDestinationCurrent: expect.any(Function)}),
        );
        expect(mocks.copyFileCopyOnWrite).not.toHaveBeenCalledWith(originalPath, requestedWorkingPath);
        expect(mocks.copyFileCopyOnWrite).not.toHaveBeenCalledWith(originalPath, latestWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toContain('% native incremental update');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');

        blockedLatestMutation.resolve(undefined);
        await blockingMutation;
    });

    it('skips original-path native saves when the original no longer matches the working-copy base', async () => {
        const {
            requestedWorkingPath,
            latestWorkingPath,
            originalPath,
            tempPath,
        } = createOriginalMutationFixture('external-change');
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: 1,
            size: 1,
        });
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await appendFile(tempPath, '\n% native incremental update');
        });
        const { handleNativeNoteTextSave } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const result = await handleNativeNoteTextSave(context, requestedWorkingPath, [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'', revisionOptions);

        expect(result).toEqual({
            applied: false,
            validation: null,
        });
        expect(mocks.runNativeToolCommand).toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledWith(requestedWorkingPath, tempPath);
        expect(mocks.copyFileCopyOnWrite).not.toHaveBeenCalledWith(originalPath, requestedWorkingPath);
        expect(readFileSyncUtf8(requestedWorkingPath)).toBe('working-before');
        expect(readFileSyncUtf8(originalPath)).toBe('external-change');
        expect(readFileSyncUtf8(latestWorkingPath)).toBe('latest-before');
    });

    it('rejects a stale working-copy revision inside the queue before cloning', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        writeFileSync(workingPath, 'base-before');
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockedMutation = deferred<undefined>();
        const queuedMutation = enqueueWorkingCopyMutation(workingPath, async () => {
            await blockedMutation.promise;
            writeFileSync(workingPath, 'changed-before-native');
        });
        mocks.assertWorkingCopyRevisionCurrent.mockRejectedValueOnce(new Error('stale revision'));
        const { handleNativePdfMutationsApplyToWorkingCopy } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const savePromise = handleNativePdfMutationsApplyToWorkingCopy(
            context,
            workingPath,
            {placedImages: [{
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 0,
                mimeType: 'image/jpeg',
                source: createNativePlacedImage().source,
            }]},
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );
        await waitForSettledQueueTurn();

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        blockedMutation.resolve(undefined);
        await queuedMutation;
        await expect(savePromise).rejects.toThrow('stale revision');
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(readFileSyncUtf8(workingPath)).toBe('changed-before-native');
        expect(mocks.assertWorkingCopyRevisionCurrent).toHaveBeenCalledWith(
            workingPath,
            revisionOptions.expectedDocumentRevisionToken,
        );
        expect(mocks.fingerprintFileWithUtilityProcess).not.toHaveBeenCalled();
    });

    it('stages native output without exposing it and commits the verified artifact once', async () => {
        const workingPath = join(tempRoot, 'staged-working.pdf');
        const originalPath = join(tempRoot, 'staged-original.pdf');
        writeFileSync(workingPath, 'base-before');
        writeFileSync(originalPath, 'base-before');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(workingPath);
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args).toEqual(expect.arrayContaining([
                'save-mutations',
                '--qpdf',
                '/native/qpdf',
                '--append',
            ]));
            const outputIndex = args.indexOf('--output') + 1;
            const outputPath = args[outputIndex];
            if (!outputPath) throw new Error('missing output path');
            await appendFile(outputPath, '\n% staged mutation');
        });
        const {
            handleCommitStagedPdfNativeMutations,
            handleNativePdfMutationsApplyToWorkingCopy,
        } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const staged = await handleNativePdfMutationsApplyToWorkingCopy(
            context,
            workingPath,
            {placedImages: [createNativePlacedImage()]},
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );

        expect(staged).toMatchObject({
            applied: true,
            validation: {isValid: true},
            nativeMutationPostconditionsVerified: true,
            stagedOutput: {
                leaseId: 'staged-native-output',
                validations: {
                    qpdfCheck: false,
                    tailCheck: true,
                    semanticCheck: true,
                    fsynced: true,
                    semanticScopeSha256: createNativeIncrementalMutationSemanticScopeSha256(),
                },
            },
        });
        expect(staged.stagedOutput?.path).toBe(`${workingPath}.tmp.pdf`);
        expect(readFileSyncUtf8(workingPath)).toBe('base-before');
        expect(readFileSyncUtf8(originalPath)).toBe('base-before');
        expect(staged.stagedOutput && readFileSyncUtf8(staged.stagedOutput.path)).toContain('% staged mutation');
        expect(mocks.fingerprintFileWithUtilityProcess).not.toHaveBeenCalled();
        if (!staged.stagedOutput) {
            throw new Error('Expected a staged artifact');
        }

        const committed = await handleCommitStagedPdfNativeMutations(
            context,
            workingPath,
            staged.stagedOutput,
            {
                ...revisionOptions,
                changedObjectRefs: ['44 0 R'],
            },
        );

        expect(committed).toMatchObject({
            applied: true,
            validation: {isValid: true},
        });
        expect(readFileSyncUtf8(workingPath)).toContain('% staged mutation');
        expect(readFileSyncUtf8(originalPath)).toContain('% staged mutation');
        expect(mocks.transitionOriginalAndWorkingCopyRevision).toHaveBeenCalledOnce();
        expect(mocks.resolveTypedStagedArtifact).toHaveBeenCalledTimes(2);
        expect(mocks.publishImmutableFileAtomic).toHaveBeenCalledWith(
            staged.stagedOutput.path,
            originalPath,
            expect.objectContaining({assertDestinationCurrent: expect.any(Function)}),
        );
        expect(mocks.commitPdfTempFile).not.toHaveBeenCalled();
        expect(mocks.releaseManagedTempFileHandle).toHaveBeenCalledWith(context, 'staged-native-output');
        expect(mocks.releaseManagedTempFileHandle).toHaveBeenCalledTimes(1);
        expect(mocks.refreshWorkingCopyOriginalFileExpectation).toHaveBeenCalledTimes(2);
        expect(mocks.releaseManagedTempFileHandle.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.refreshWorkingCopyOriginalFileExpectation.mock.invocationCallOrder[1]!);
    });

    it('resolves the original mapping when a queued staged commit starts executing', async () => {
        const workingPath = join(tempRoot, 'queued-staged-working.pdf');
        const firstOriginalPath = join(tempRoot, 'queued-staged-first.pdf');
        const secondOriginalPath = join(tempRoot, 'queued-staged-second.pdf');
        const stagedPath = join(tempRoot, 'queued-staged-output.pdf');
        writeFileSync(workingPath, 'working-before');
        writeFileSync(firstOriginalPath, 'first-before');
        writeFileSync(secondOriginalPath, 'second-before');
        writeFileSync(stagedPath, 'staged-output');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath: firstOriginalPath});
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(workingPath);
        const {enqueueWorkingCopyMutation} = await import('@electron/file-access/workingCopyMutationQueue');
        const blockedMutation = deferred<undefined>();
        const queuedMutation = enqueueWorkingCopyMutation(workingPath, () => blockedMutation.promise);
        const {handleCommitStagedPdfNativeMutations} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );

        const commitPromise = handleCommitStagedPdfNativeMutations(
            context,
            workingPath,
            createOpaqueStagedArtifact(stagedPath),
            revisionOptions,
        );
        await waitForSettledQueueTurn();
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath: secondOriginalPath});
        blockedMutation.resolve(undefined);
        await queuedMutation;

        await expect(commitPromise).resolves.toMatchObject({applied: true});
        expect(readFileSyncUtf8(firstOriginalPath)).toBe('first-before');
        expect(readFileSyncUtf8(secondOriginalPath)).toBe('staged-output');
        expect(mocks.transitionOriginalAndWorkingCopyRevision).toHaveBeenCalledWith(
            expect.objectContaining({originalPath: secondOriginalPath}),
        );
        expect(mocks.publishImmutableFileAtomic).toHaveBeenCalledWith(
            stagedPath,
            secondOriginalPath,
            expect.objectContaining({assertDestinationCurrent: expect.any(Function)}),
        );
    });

    it('preserves native markup identity bindings through staged publication', async () => {
        const workingPath = join(tempRoot, 'identity-staged-working.pdf');
        const originalPath = join(tempRoot, 'identity-staged-original.pdf');
        writeFileSync(workingPath, 'base-before');
        writeFileSync(originalPath, 'base-before');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(workingPath);
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            const outputPath = args[args.indexOf('--output') + 1];
            const identityBindingsPath = args[args.indexOf('--identity-bindings-file') + 1];
            if (!outputPath || !identityBindingsPath) {
                throw new Error('Missing native staged identity output path');
            }
            await Promise.all([
                appendFile(outputPath, '\n% staged native markup identity'),
                writeFile(identityBindingsPath, JSON.stringify([nativeMarkupIdentityBinding])),
            ]);
        });
        const {
            handleCommitStagedPdfNativeMutations,
            handleNativePdfMutationsApplyToWorkingCopy,
        } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        const staged = await handleNativePdfMutationsApplyToWorkingCopy(
            context,
            workingPath,
            createUnboundNativeMarkupMutation(),
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );

        expect(staged).toMatchObject({
            applied: true,
            identityBindings: [nativeMarkupIdentityBinding],
        });
        if (!staged.stagedOutput) {
            throw new Error('Expected native staged markup output');
        }
        if (!staged.identityBindings) {
            throw new Error('Expected native staged markup identity bindings');
        }

        const committed = await handleCommitStagedPdfNativeMutations(
            context,
            workingPath,
            staged.stagedOutput,
            {
                ...revisionOptions,
                identityBindings: staged.identityBindings,
            },
        );

        expect(committed).toMatchObject({
            applied: true,
            identityBindings: [nativeMarkupIdentityBinding],
        });
        expect(readFileSyncUtf8(workingPath)).toContain('% staged native markup identity');
        expect(readFileSyncUtf8(originalPath)).toContain('% staged native markup identity');
    });

    it('reports a post-commit expectation refresh failure after releasing the staged artifact', async () => {
        const {
            requestedWorkingPath,
            originalPath,
        } = createOriginalMutationFixture();
        const stagedPath = join(tempRoot, 'refresh-failure.pdf');
        writeFileSync(stagedPath, 'staged-output');
        const stagedArtifact = createOpaqueStagedArtifact(stagedPath);
        mocks.refreshWorkingCopyOriginalFileExpectation
            .mockReturnValueOnce(true)
            .mockReturnValueOnce(false);
        const {handleCommitStagedPdfNativeMutations} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );

        const result = await handleCommitStagedPdfNativeMutations(
            context,
            requestedWorkingPath,
            stagedArtifact,
            revisionOptions,
        );

        expect(result).toMatchObject({
            applied: true,
            syncError: 'Working copy registration changed after native mutation commit',
        });
        expect(readFileSyncUtf8(originalPath)).toBe('staged-output');
        expect(mocks.releaseManagedTempFileHandle).toHaveBeenCalledOnce();
        expect(() => statSync(stagedPath)).toThrow();
    });

    it('releases and removes the staged artifact when its queued commit rejects', async () => {
        const {requestedWorkingPath} = createOriginalMutationFixture();
        const stagedPath = join(tempRoot, 'rejected-commit.pdf');
        writeFileSync(stagedPath, 'staged-output');
        const stagedArtifact = createOpaqueStagedArtifact(stagedPath);
        mocks.transitionOriginalAndWorkingCopyRevision.mockRejectedValueOnce(new Error('commit rejected'));
        const {handleCommitStagedPdfNativeMutations} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );

        await expect(handleCommitStagedPdfNativeMutations(
            context,
            requestedWorkingPath,
            stagedArtifact,
            revisionOptions,
        )).rejects.toThrow('commit rejected');

        expect(mocks.releaseManagedTempFileHandle).toHaveBeenCalledOnce();
        expect(() => statSync(stagedPath)).toThrow();
    });

    it('continues cap-plus-one note mutations with bounded native appends', async () => {
        const {
            requestedWorkingPath,
            tempPath,
        } = createOriginalMutationFixture();
        const payloads: Array<{
            command: string;
            payload: Record<string, unknown>
        }> = [];
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            const payloadFlag = args[0] === 'update-note-text' ? '--updates-file' : '--changes-file';
            const payloadPath = args[args.indexOf(payloadFlag) + 1];
            if (!payloadPath) {
                throw new Error(`Missing ${payloadFlag} path`);
            }
            payloads.push({
                command: args[0]!,
                payload: JSON.parse(readFileSync(payloadPath, 'utf8')) as Record<string, unknown>,
            });
            await appendFile(tempPath, '\n% native bounded note continuation');
        });
        const {
            handleNativeNoteChangesSave,
            handleNativeNoteTextSave,
        } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');
        const modifiedAt = 'D:20260609133855+03\'00\'';

        await expect(handleNativeNoteTextSave(
            context,
            requestedWorkingPath,
            Array.from({length: PDF_NATIVE_MUTATION_LIMITS.noteTextUpdates + 1}, (_, index) => ({
                objectNumber: index + 1,
                generationNumber: 0,
                text: `Updated note ${index}`,
            })),
            modifiedAt,
            revisionOptions,
        )).resolves.toMatchObject({applied: true});

        await expect(handleNativeNoteChangesSave(
            context,
            requestedWorkingPath,
            {freeTextNotes: Array.from(
                {length: PDF_NATIVE_MUTATION_LIMITS.noteChanges + 1},
                createNativeFreeTextNote,
            )},
            modifiedAt,
            revisionOptions,
        )).resolves.toMatchObject({applied: true});

        expect(payloads.map(({
            command,
            payload,
        }) => [
            command,
            (payload.updates as unknown[] | undefined)?.length ?? (payload.freeTextNotes as unknown[] | undefined)?.length,
        ])).toEqual([
            [
                'update-note-text',
                PDF_NATIVE_MUTATION_LIMITS.noteTextUpdates,
            ],
            [
                'update-note-text',
                1,
            ],
            [
                'save-note-changes',
                PDF_NATIVE_MUTATION_LIMITS.noteChanges,
            ],
            [
                'save-note-changes',
                1,
            ],
        ]);
        expect(mocks.runNativeToolCommand).toHaveBeenCalledTimes(4);
        expect(mocks.transitionOriginalAndWorkingCopyRevision).toHaveBeenCalledTimes(2);
    });

    it('keeps a split generic mutation set in one revision and staged commit', async () => {
        const {
            requestedWorkingPath,
            tempPath,
        } = createOriginalMutationFixture();
        const payloads: Array<Record<string, unknown>> = [];
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args[0]).toBe('save-mutations');
            expect(args).toEqual(expect.arrayContaining([
                '--input',
                tempPath,
                '--output',
                tempPath,
                '--append',
            ]));
            const payloadPath = args[args.indexOf('--mutations-file') + 1];
            if (!payloadPath) {
                throw new Error('Missing mutations file path');
            }
            payloads.push(JSON.parse(readFileSync(payloadPath, 'utf8')) as Record<string, unknown>);
            await writeEmptyIdentityBindingsIfRequested(args);
            await appendFile(tempPath, '\n% native generic continuation');
        });
        const {handleNativePdfMutationsSave} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );

        const result = await handleNativePdfMutationsSave(
            context,
            requestedWorkingPath,
            {
                updates: Array.from(
                    {length: PDF_NATIVE_MUTATION_LIMITS.noteChanges + 1},
                    (_, index) => ({
                        objectNumber: index + 1,
                        generationNumber: 0,
                        text: `Updated note ${index}`,
                    }),
                ),
                freeTextNotes: Array.from(
                    {length: PDF_NATIVE_MUTATION_LIMITS.noteChanges + 1},
                    (_, index) => ({
                        ...createNativeFreeTextNote(),
                        stableKey: `note-${index}`,
                    }),
                ),
            },
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );

        expect(result).toMatchObject({applied: true});
        expect(payloads).toHaveLength(3);
        expect(payloads[0]!.continuation).toBeUndefined();
        expect(payloads.slice(1).every(payload =>
            (payload.continuation as {family?: string} | undefined)?.family === 'notes',
        )).toBe(true);
        expect(payloads.reduce(
            (count, payload) => count + ((payload.updates as unknown[] | undefined)?.length ?? 0),
            0,
        )).toBe(PDF_NATIVE_MUTATION_LIMITS.noteChanges + 1);
        expect(payloads.reduce(
            (count, payload) => count + ((payload.freeTextNotes as unknown[] | undefined)?.length ?? 0),
            0,
        )).toBe(PDF_NATIVE_MUTATION_LIMITS.noteChanges + 1);
        for (const payload of payloads) {
            expect(
                ((payload.updates as unknown[] | undefined)?.length ?? 0)
                + ((payload.freeTextNotes as unknown[] | undefined)?.length ?? 0),
            ).toBeLessThanOrEqual(PDF_NATIVE_MUTATION_LIMITS.noteChanges);
        }
        expect(mocks.assertWorkingCopyRevisionCurrent).toHaveBeenCalledOnce();
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledOnce();
        expect(mocks.transitionOriginalAndWorkingCopyRevision).toHaveBeenCalledOnce();
    });

    it('continues every capped mutation family through one native revision', async () => {
        const {
            requestedWorkingPath,
            tempPath,
        } = createOriginalMutationFixture();
        const payloads: Array<Record<string, unknown>> = [];
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args[0]).toBe('save-mutations');
            const payloadPath = args[args.indexOf('--mutations-file') + 1];
            if (!payloadPath) {
                throw new Error('Missing mutations file path');
            }
            payloads.push(JSON.parse(readFileSync(payloadPath, 'utf8')) as Record<string, unknown>);
            await writeEmptyIdentityBindingsIfRequested(args);
            await appendFile(tempPath, '\n% native all-family continuation');
        });
        const {handleNativePdfMutationsSave} = await import(
            '@electron/features/documents/main/nativePdfMutationSaveHandlers'
        );
        const cap = PDF_NATIVE_MUTATION_LIMITS;
        const result = await handleNativePdfMutationsSave(
            context,
            requestedWorkingPath,
            {
                updates: Array.from({length: cap.noteTextUpdates + 1}, (_, index) => ({
                    objectNumber: index + 1,
                    generationNumber: 0,
                    text: `Updated note ${index}`,
                })),
                textBoxes: Array.from({length: cap.textBoxes + 1}, (_, index) => ({
                    ...createNativeFreeTextEditor(),
                    stableKey: `editor-${index}`,
                })),
                pageLabels: {
                    totalPages: cap.pageLabelRanges + 1,
                    ranges: Array.from({length: cap.pageLabelRanges + 1}, (_, index) => ({
                        startPage: index + 1,
                        style: 'D',
                        prefix: `${index}-`,
                        startNumber: 1,
                    })),
                },
                bookmarks: {
                    totalPages: 3,
                    untitledLabel: 'Untitled',
                    items: Array.from({length: cap.bookmarkItems + 1}, (_, index) => createNativeBookmark(`Chapter ${index}`)),
                },
                shapes: {
                    totalPages: 3,
                    rewriteShapeState: true,
                    shapes: Array.from({length: cap.shapes + 1}, (_, index) => ({
                        ...createNativeShape(),
                        id: `shape-${index}`,
                    })),
                    deletedAnnotationIds: [],
                    deletedStableKeys: [],
                },
                markup: {
                    overrides: Array.from({length: cap.markupItems + 1}, (_, index) => [
                        `${index + 1}R`,
                        'Highlight',
                    ] as const),
                    hints: [],
                },
                placedImages: Array.from({length: cap.placedImages + 1}, (_, index) => ({
                    ...createNativePlacedImage(),
                    stableKey: `image-${index}`,
                })),
            },
            'D:20260609133855+03\'00\'',
            revisionOptions,
        );

        expect(result).toMatchObject({applied: true});
        expect(payloads.length).toBeGreaterThan(1);
        expect(payloads.reduce((count, payload) => count + ((payload.updates as unknown[] | undefined)?.length ?? 0), 0))
            .toBe(cap.noteTextUpdates + 1);
        expect(payloads.reduce((count, payload) => count + ((payload.textBoxes as unknown[] | undefined)?.length ?? 0), 0))
            .toBe(cap.textBoxes + 1);
        expect(payloads.reduce((count, payload) => count + ((payload.pageLabels as {ranges?: unknown[]} | undefined)?.ranges?.length ?? 0), 0))
            .toBe(cap.pageLabelRanges + 1);
        expect(payloads.reduce((count, payload) => count + ((payload.bookmarks as {items?: unknown[]} | undefined)?.items?.length ?? 0), 0))
            .toBe(cap.bookmarkItems + 1);
        expect(payloads.reduce((count, payload) => count + ((payload.shapes as {shapes?: unknown[]} | undefined)?.shapes?.length ?? 0), 0))
            .toBe(cap.shapes + 1);
        expect(payloads.reduce((count, payload) => count + ((payload.markup as {overrides?: unknown[]} | undefined)?.overrides?.length ?? 0), 0))
            .toBe(cap.markupItems + 1);
        expect(payloads.reduce((count, payload) => count + ((payload.placedImages as unknown[] | undefined)?.length ?? 0), 0))
            .toBe(cap.placedImages + 1);
        expect(payloads.flatMap(payload => (payload.updates as Array<{objectNumber?: number}> | undefined) ?? [])
            .map(update => update.objectNumber))
            .toEqual(Array.from({length: cap.noteTextUpdates + 1}, (_, index) => index + 1));
        expect(payloads.flatMap(payload => (payload.textBoxes as Array<{stableKey?: string}> | undefined) ?? [])
            .map(editor => editor.stableKey))
            .toEqual(Array.from({length: cap.textBoxes + 1}, (_, index) => `editor-${index}`));
        expect(payloads.flatMap(payload => (payload.pageLabels as {ranges?: Array<{startPage?: number}>} | undefined)?.ranges ?? [])
            .map(range => range.startPage))
            .toEqual(Array.from({length: cap.pageLabelRanges + 1}, (_, index) => index + 1));
        expect(payloads.flatMap(payload => (payload.bookmarks as {items?: Array<{title?: string}>} | undefined)?.items ?? [])
            .map(item => item.title))
            .toEqual(Array.from({length: cap.bookmarkItems + 1}, (_, index) => `Chapter ${index}`));
        expect(payloads.flatMap(payload => (payload.shapes as {shapes?: Array<{id?: string}>} | undefined)?.shapes ?? [])
            .map(shape => shape.id))
            .toEqual(Array.from({length: cap.shapes + 1}, (_, index) => `shape-${index}`));
        expect(payloads.flatMap(payload => (payload.markup as {overrides?: Array<readonly [string, string]>} | undefined)?.overrides ?? [])
            .map(([annotationId]) => annotationId))
            .toEqual(Array.from({length: cap.markupItems + 1}, (_, index) => `${index + 1}R`));
        expect(payloads.flatMap(payload => (payload.placedImages as Array<{stableKey?: string}> | undefined) ?? [])
            .map(image => image.stableKey))
            .toEqual(Array.from({length: cap.placedImages + 1}, (_, index) => `image-${index}`));
        for (const payload of payloads) {
            expect((payload.updates as unknown[] | undefined)?.length ?? 0).toBeLessThanOrEqual(cap.noteTextUpdates);
            expect((payload.textBoxes as unknown[] | undefined)?.length ?? 0).toBeLessThanOrEqual(cap.textBoxes);
            expect((payload.pageLabels as {ranges?: unknown[]} | undefined)?.ranges?.length ?? 0).toBeLessThanOrEqual(cap.pageLabelRanges);
            expect((payload.bookmarks as {items?: unknown[]} | undefined)?.items?.length ?? 0).toBeLessThanOrEqual(cap.bookmarkItems);
            expect((payload.shapes as {shapes?: unknown[]} | undefined)?.shapes?.length ?? 0).toBeLessThanOrEqual(cap.shapes);
            expect((payload.markup as {overrides?: unknown[]} | undefined)?.overrides?.length ?? 0).toBeLessThanOrEqual(cap.markupItems);
            expect((payload.placedImages as unknown[] | undefined)?.length ?? 0).toBeLessThanOrEqual(cap.placedImages);
        }
        expect(payloads[0]!.continuation).toBeUndefined();
        expect(new Set(payloads.slice(1).map(payload => (
            payload.continuation as {family?: string} | undefined
        )?.family))).toEqual(new Set([
            'notes',
            'textBoxes',
            'pageLabels',
            'bookmarks',
            'shapes',
            'markup',
            'placedImages',
        ]));
        expect(mocks.assertWorkingCopyRevisionCurrent).toHaveBeenCalledOnce();
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledOnce();
        expect(mocks.transitionOriginalAndWorkingCopyRevision).toHaveBeenCalledOnce();
    });

    it('rejects malformed and per-item native mutation limit violations before native execution', async () => {
        const {
            handleNativePdfMutationsApplyToWorkingCopy,
            handleNativePdfMutationsSave,
        } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');
        const workingPath = join(tempRoot, 'working.pdf');
        const modifiedAt = 'D:20260609133855+03\'00\'';

        await expect(handleNativePdfMutationsSave(
            context,
            workingPath,
            {bookmarks: {
                totalPages: 3,
                untitledLabel: 'Untitled',
                items: createDeepNativeBookmarkItems(PDF_NATIVE_MUTATION_LIMITS.bookmarkDepth + 1),
            }},
            modifiedAt,
        )).rejects.toThrow('maximum bookmark depth');

        await expect(handleNativePdfMutationsSave(
            context,
            workingPath,
            {shapes: {
                totalPages: 3,
                rewriteShapeState: true,
                shapes: [{
                    ...createNativeShape(),
                    points: Array.from({length: PDF_NATIVE_MUTATION_LIMITS.shapePoints + 1}, () => ({
                        x: 0.1,
                        y: 0.2,
                    })),
                }],
                deletedAnnotationIds: [],
                deletedStableKeys: [],
            }},
            modifiedAt,
        )).rejects.toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.shapePoints} points`);

        await expect(handleNativePdfMutationsSave(
            context,
            workingPath,
            {markup: {
                overrides: [],
                hints: [{
                    subtype: 'Highlight',
                    pageIndex: 0,
                    markerRect: {
                        left: 0.1,
                        top: 0.2,
                        width: 0.3,
                        height: 0.2,
                    },
                    markupGeometry: Array.from(
                        {length: PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems + 1},
                        () => ({
                            left: 0.1,
                            top: 0.2,
                            width: 0.1,
                            height: 0.2,
                        }),
                    ),
                }],
            }},
            modifiedAt,
        )).rejects.toThrow(`at most ${PDF_NATIVE_MUTATION_LIMITS.markupGeometryItems} rectangles`);

        await expect(handleNativePdfMutationsApplyToWorkingCopy(
            context,
            workingPath,
            {placedImages: [{
                ...createNativePlacedImage(),
                source: {
                    ...createNativePlacedImage().source,
                    size: PDF_NATIVE_MUTATION_LIMITS.placedImageBytes + 1,
                },
            }]},
            modifiedAt,
            revisionOptions,
        )).rejects.toThrow('bounded non-empty image bytes');

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });

    it('rejects working-copy native mutations without a document revision', async () => {
        const { handleNativePdfMutationsApplyToWorkingCopy } = await import('@electron/features/documents/main/nativePdfMutationSaveHandlers');

        await expect(handleNativePdfMutationsApplyToWorkingCopy(
            context,
            join(tempRoot, 'working.pdf'),
            {placedImages: [{
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 0,
                mimeType: 'image/jpeg',
                source: createNativePlacedImage().source,
            }]},
            'D:20260609133855+03\'00\'',
            undefined as never,
        )).rejects.toThrow('Document revision token is required');
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(mocks.fingerprintFileWithUtilityProcess).not.toHaveBeenCalled();
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
