import type * as TViMockOriginalModule from '@electron/file-access/isAllowedOriginalSavePath';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireLeaseId} from '@contracts/shared';

const mocks = vi.hoisted(() => ({
    resolveTypedStagedArtifact: vi.fn(),
    releaseManagedTempFileHandle: vi.fn(),
    createDisposableWorkingCopyFromPath: vi.fn(),
    isAllowedOriginalSavePath: vi.fn(),
    resolveAllowedWritePath: vi.fn(),
    enqueueWorkingCopyMutation: vi.fn(),
    assertQueuedWorkingCopyMutationPreconditions: vi.fn(),
    ensureWorkingCopyMaterialized: vi.fn(),
    copyFileCopyOnWrite: vi.fn(),
    makeSiblingTempPath: vi.fn(),
    atomicReplace: vi.fn(),
    transitionWorkingCopyContentRevision: vi.fn(),
    clearWorkingCopyOcrArtifacts: vi.fn(),
}));

vi.mock('@electron/features/documents/main/managedTempFileHandles', () => ({
    releaseManagedTempFileHandle: (...args: unknown[]) => mocks.releaseManagedTempFileHandle(...args),
    resolveTypedStagedArtifact: (...args: unknown[]) => mocks.resolveTypedStagedArtifact(...args),
}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({createDisposableWorkingCopyFromPath: (...args: unknown[]) => mocks.createDisposableWorkingCopyFromPath(...args)}));
vi.mock('@electron/file-access/isAllowedOriginalSavePath', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    isAllowedOriginalSavePath: (...args: unknown[]) => mocks.isAllowedOriginalSavePath(...args),
}));
vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedWritePath: (...args: unknown[]) => mocks.resolveAllowedWritePath(...args)}));
vi.mock('@electron/file-access/documentMutationGuards', () => ({
    assertQueuedWorkingCopyMutationPreconditions: (...args: unknown[]) => (
        mocks.assertQueuedWorkingCopyMutationPreconditions(...args)
    ),
    normalizeExpectedDocumentRevisionToken: (value: unknown) => (
        typeof value === 'object' && value !== null && 'expectedDocumentRevisionToken' in value
            ? (value as {expectedDocumentRevisionToken: string}).expectedDocumentRevisionToken
            : null
    ),
}));
vi.mock('@electron/file-access/workingCopyMutationQueue', () => ({
    clearWorkingCopyOcrArtifacts: (...args: unknown[]) => mocks.clearWorkingCopyOcrArtifacts(...args),
    enqueueWorkingCopyMutation: (...args: unknown[]) => mocks.enqueueWorkingCopyMutation(...args),
}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({ensureWorkingCopyMaterialized: (...args: unknown[]) => mocks.ensureWorkingCopyMaterialized(...args)}));
vi.mock('@electron/file-access/workingCopyDirectory', () => ({copyFileCopyOnWrite: (...args: unknown[]) => mocks.copyFileCopyOnWrite(...args)}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: unknown[]) => mocks.makeSiblingTempPath(...args),
}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({transitionWorkingCopyContentRevision: (...args: unknown[]) => (
    mocks.transitionWorkingCopyContentRevision(...args)
)}));

const revision = requireDocumentRevisionToken('revision-1');

function createArtifact(path: string): ITypedStagedArtifact {
    return {
        receiptVersion: 1,
        artifactKind: 'pdf',
        path: requireDocumentRef(path),
        size: 3,
        sha256: 'a'.repeat(64),
        fileIdentity: {
            platform: 'posix',
            deviceId: '1',
            inode: '2',
        },
        validations: {
            qpdfCheck: false,
            tailCheck: true,
            semanticCheck: true,
            semanticScopeSha256: 'b'.repeat(64),
            fsynced: true,
        },
        leaseId: requireLeaseId('staged-lease'),
        revision,
    };
}

describe('staged native PDF mutation handlers', () => {
    let directory = '';

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'evb-staged-native-handler-'));
        vi.clearAllMocks();
        mocks.isAllowedOriginalSavePath.mockReturnValue(true);
        mocks.resolveAllowedWritePath.mockImplementation(async (path: string) => path);
        mocks.releaseManagedTempFileHandle.mockReturnValue(true);
        mocks.createDisposableWorkingCopyFromPath.mockResolvedValue('/tmp/native-clone.pdf');
        mocks.assertQueuedWorkingCopyMutationPreconditions.mockResolvedValue(undefined);
        mocks.ensureWorkingCopyMaterialized.mockResolvedValue(undefined);
        mocks.copyFileCopyOnWrite.mockResolvedValue(undefined);
        mocks.makeSiblingTempPath.mockImplementation((path: string) => `${path}.tmp`);
        mocks.atomicReplace.mockResolvedValue(undefined);
        mocks.transitionWorkingCopyContentRevision.mockImplementation(async (
            _path: string,
            _reason: string,
            promote: () => Promise<void>,
        ) => promote());
        mocks.clearWorkingCopyOcrArtifacts.mockResolvedValue(undefined);
        mocks.enqueueWorkingCopyMutation.mockImplementation(async (
            _path: string,
            operation: () => Promise<boolean>,
        ) => operation());
    });

    afterEach(async () => {
        await rm(directory, {
            recursive: true,
            force: true,
        });
    });

    it('clones a verified receipt without consulting or writing the original', async () => {
        const stagedPath = join(directory, 'staged.pdf');
        const artifact = createArtifact(stagedPath);
        mocks.resolveTypedStagedArtifact.mockResolvedValue(artifact);
        const {handleCloneStagedPdfNativeMutationToWorkingCopy} = await import(
            '@electron/features/documents/main/stagedPdfNativeMutationHandlers'
        );

        await expect(handleCloneStagedPdfNativeMutationToWorkingCopy(
            {senderId: 42},
            artifact,
            '/tmp/original.pdf',
        )).resolves.toBe('/tmp/native-clone.pdf');

        expect(mocks.resolveTypedStagedArtifact).toHaveBeenCalledWith({senderId: 42}, artifact);
        expect(mocks.createDisposableWorkingCopyFromPath).toHaveBeenCalledWith(
            stagedPath,
            '/tmp/original.pdf',
            42,
        );
        expect(mocks.releaseManagedTempFileHandle).toHaveBeenCalledWith({senderId: 42}, 'staged-lease');
        expect(mocks.enqueueWorkingCopyMutation).not.toHaveBeenCalled();
    });

    it('rechecks the receipt before promoting only the working copy and releases it on rejection', async () => {
        const stagedPath = join(directory, 'staged.pdf');
        const artifact = createArtifact(stagedPath);
        mocks.resolveTypedStagedArtifact
            .mockResolvedValueOnce(artifact)
            .mockRejectedValueOnce(new Error('staged artifact stat witness changed'));
        const {handleReplaceWorkingCopyFromStagedPdfNativeMutation} = await import(
            '@electron/features/documents/main/stagedPdfNativeMutationHandlers'
        );

        await expect(handleReplaceWorkingCopyFromStagedPdfNativeMutation(
            {senderId: 42},
            '/tmp/working.pdf',
            artifact,
            {expectedDocumentRevisionToken: revision},
        )).rejects.toThrow('stat witness changed');

        expect(mocks.assertQueuedWorkingCopyMutationPreconditions).toHaveBeenCalledWith(
            '/tmp/working.pdf',
            revision,
        );
        expect(mocks.copyFileCopyOnWrite).toHaveBeenCalledWith(
            stagedPath,
            '/tmp/working.pdf.tmp.pdf',
        );
        expect(mocks.transitionWorkingCopyContentRevision).not.toHaveBeenCalled();
        expect(mocks.clearWorkingCopyOcrArtifacts).not.toHaveBeenCalled();
        expect(mocks.releaseManagedTempFileHandle).toHaveBeenCalledWith({senderId: 42}, 'staged-lease');
    });

    it('rejects a receipt from another renderer before touching any path', async () => {
        const artifact = createArtifact(join(directory, 'staged.pdf'));
        mocks.resolveTypedStagedArtifact.mockRejectedValue(new Error('belongs to another renderer'));
        const {handleCloneStagedPdfNativeMutationToWorkingCopy} = await import(
            '@electron/features/documents/main/stagedPdfNativeMutationHandlers'
        );

        await expect(handleCloneStagedPdfNativeMutationToWorkingCopy(
            {senderId: 7},
            artifact,
            '/tmp/original.pdf',
        )).rejects.toThrow('another renderer');

        expect(mocks.createDisposableWorkingCopyFromPath).not.toHaveBeenCalled();
        expect(mocks.releaseManagedTempFileHandle).not.toHaveBeenCalled();
    });
});
