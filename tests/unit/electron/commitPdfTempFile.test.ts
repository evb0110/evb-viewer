import type * as TViMockOriginalModule from '@electron/file-access/workingCopyMutationCommitSignal';
import type * as TViMockOriginalModule2 from '@electron/resources/jobBroker';
import type * as TViMockOriginalModule3 from '@electron/pdf/nativeToolPaths';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { commitPdfTempFile } from '@electron/features/documents/main/commitPdfTempFile';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireLeaseId } from '@contracts/shared';

const mocks = vi.hoisted(() => ({
    acquire: vi.fn(),
    atomicReplace: vi.fn(),
    runDocumentSaveUtilityProcess: vi.fn(),
    stat: vi.fn(),
    resolveTypedStagedArtifact: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({stat: mocks.stat}));
vi.mock('electron', () => ({utilityProcess: {fork: vi.fn()}}));
vi.mock('@electron-worker-bundles/electronWorkerBundles.js', () => ({WORKER_BUNDLES_BY_ID: {'document-save-utility': {fileName: 'document-save-utility.mjs'}}}));
vi.mock('@electron/utils/workerTask', () => ({resolveUnpackedWorkerPath: vi.fn(() => '/tmp/worker.mjs')}));
vi.mock('@electron/utils/atomicReplace', () => ({atomicReplace: mocks.atomicReplace}));
vi.mock('@electron/file-access/workingCopyMutationCommitSignal', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    markActiveWorkingCopyMutationCommitStarted: vi.fn(),
}));
vi.mock('@electron/resources/jobBroker', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    mainJobBroker: {acquire: mocks.acquire},
}));
vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal_2) => ({
    ...(await importOriginal_2<typeof TViMockOriginalModule3>()),
    getPdfNativeToolPaths: vi.fn(() => ({qpdf: '/tmp/qpdf'})),
}));
vi.mock('@electron/features/documents/main/managedTempFileHandles', () => ({resolveTypedStagedArtifact: mocks.resolveTypedStagedArtifact}));
vi.mock('@electron/features/documents/main/fingerprintFileWithUtilityProcess', () => ({runDocumentSaveUtilityProcess: mocks.runDocumentSaveUtilityProcess}));

describe('commitPdfTempFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resolveTypedStagedArtifact.mockImplementation(async (_context, artifact) => artifact);
        mocks.acquire.mockResolvedValue({release: vi.fn()});
        mocks.atomicReplace.mockResolvedValue(undefined);
        mocks.runDocumentSaveUtilityProcess.mockResolvedValue({
            bytes: 100,
            sha256: 'a'.repeat(64),
        });
    });

    it('rejects a source stat failure', async () => {
        mocks.stat.mockRejectedValueOnce(new Error('source disappeared'));

        await expect(commitPdfTempFile('/tmp/missing.pdf', '/tmp/output.pdf'))
            .rejects.toThrow('source disappeared');
    });

    it('rejects a broker admission failure', async () => {
        mocks.acquire.mockRejectedValueOnce(new Error('admission unavailable'));

        await expect(commitPdfTempFile('/tmp/source.pdf', '/tmp/output.pdf', {
            expectedBytes: 1,
            changedObjectRefs: ['1 0 R'],
        })).rejects.toThrow('admission unavailable');
    });

    it('rejects an authoritative receipt resolution failure', async () => {
        mocks.resolveTypedStagedArtifact.mockRejectedValueOnce(new Error('receipt altered'));

        await expect(commitPdfTempFile('/tmp/source.pdf', '/tmp/output.pdf', {receipt: {
            artifact: {
                receiptVersion: 1,
                artifactKind: 'pdf',
                path: requireDocumentRef('/tmp/source.pdf'),
                size: 100,
                sha256: 'a'.repeat(64),
                fileIdentity: {
                    platform: 'posix',
                    deviceId: '1',
                    inode: '2',
                },
                validations: {
                    qpdfCheck: false,
                    tailCheck: false,
                    semanticCheck: false,
                    fsynced: false,
                },
                leaseId: requireLeaseId('lease-1'),
                revision: null,
            },
            context: {senderId: 42},
        }})).rejects.toThrow('receipt altered');
        expect(mocks.stat).not.toHaveBeenCalled();
    });

    it('uses an unchanged authoritative receipt without restating a small source', async () => {
        const artifact = {
            receiptVersion: 1 as const,
            artifactKind: 'pdf' as const,
            path: requireDocumentRef('/tmp/source.pdf'),
            size: 100,
            sha256: 'a'.repeat(64),
            fileIdentity: {
                platform: 'posix' as const,
                deviceId: '1',
                inode: '2',
            },
            validations: {
                qpdfCheck: false,
                tailCheck: false,
                semanticCheck: false,
                fsynced: false,
            },
            leaseId: requireLeaseId('lease-1'),
            revision: null,
        };

        await expect(commitPdfTempFile('/tmp/source.pdf', '/tmp/output.pdf', {receipt: {
            artifact,
            context: {senderId: 42},
        }})).resolves.toBeNull();

        expect(mocks.resolveTypedStagedArtifact).toHaveBeenCalledWith(
            {senderId: 42},
            artifact,
        );
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/source.pdf', '/tmp/output.pdf');
    });

    it('rejects an authoritative receipt resolved for another source path', async () => {
        const artifact = {
            receiptVersion: 1 as const,
            artifactKind: 'pdf' as const,
            path: requireDocumentRef('/tmp/source.pdf'),
            size: 100,
            sha256: 'a'.repeat(64),
            fileIdentity: {
                platform: 'posix' as const,
                deviceId: '1',
                inode: '2',
            },
            validations: {
                qpdfCheck: false,
                tailCheck: false,
                semanticCheck: false,
                fsynced: false,
            },
            leaseId: requireLeaseId('lease-1'),
            revision: null,
        };
        mocks.resolveTypedStagedArtifact.mockResolvedValueOnce({
            ...artifact,
            path: '/tmp/other.pdf',
        });

        await expect(commitPdfTempFile('/tmp/source.pdf', '/tmp/output.pdf', {receipt: {
            artifact,
            context: {senderId: 42},
        }})).rejects.toThrow('does not identify');
    });

    it('validates utility-process saves before publishing with the live destination witness', async () => {
        const assertDestinationCurrent = vi.fn().mockResolvedValue(undefined);

        await expect(commitPdfTempFile('/tmp/source.pdf', '/tmp/output.pdf', {
            expectedBytes: 100,
            changedObjectRefs: ['1 0 R'],
            assertDestinationCurrent,
        })).resolves.toEqual({
            bytes: 100,
            sha256: 'a'.repeat(64),
        });

        expect(mocks.runDocumentSaveUtilityProcess).toHaveBeenCalledWith(expect.objectContaining({request: expect.objectContaining({
            type: 'commit',
            validateOnly: true,
        })}));
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/source.pdf', '/tmp/output.pdf', {assertDestinationCurrent});
        expect(mocks.runDocumentSaveUtilityProcess.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.atomicReplace.mock.invocationCallOrder[0]!);
    });
});
