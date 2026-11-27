import {describe, expect, it, vi} from 'vitest';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireDocumentRef} from '@contracts/documentRef';
import {IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES} from '@contracts/electronApiDocuments';
import {requireEpochMs} from '@contracts/timestamps';
import {createWorkingCopySnapshotFromData} from '@app/services/pdf-file/createWorkingCopySnapshotFromData';
import type {IDocumentsFileIoCapability, IDocumentsWorkingCopyCapability} from '@contracts/electronApiDocuments';

function createHarness() {
    const workingCopies = {
        cleanupFile: vi.fn<IDocumentsWorkingCopyCapability['cleanupFile']>(async () => undefined),
        createWorkingCopyFromData: vi.fn<IDocumentsWorkingCopyCapability['createWorkingCopyFromData']>(async () =>
            requireDocumentRef('/tmp/direct.pdf'),
        ),
        createWorkingCopyFromPath: vi.fn<IDocumentsWorkingCopyCapability['createWorkingCopyFromPath']>(async () =>
            requireDocumentRef('/tmp/staged.pdf'),
        ),
    };
    const files = {
        getDocumentRevision: vi.fn<IDocumentsFileIoCapability['getDocumentRevision']>(async () => ({
            version: 1,
            documentRef: requireDocumentRef('/tmp/staged.pdf'),
            token: requireDocumentRevisionToken('stage-revision'),
            contentRevision: 1,
            authority: 'electron-working-copy' as const,
            mintedAt: requireEpochMs(1),
        })),
        savePdfData: vi.fn<IDocumentsFileIoCapability['savePdfData']>(async () => ({
            isValid: true,
            tool: 'qpdf' as const,
            errors: [],
            warnings: [],
        })),
    };
    return {
        files,
        workingCopies,
    };
}

describe('createWorkingCopySnapshotFromData', () => {
    it('uses direct staging for small in-memory snapshots without a source path', async () => {
        const harness = createHarness();
        const data = new Uint8Array([1, 2, 3]);

        await expect(
            createWorkingCopySnapshotFromData({
                data,
                fileName: 'snapshot.pdf',
                files: harness.files,
                workingCopies: harness.workingCopies,
            }),
        ).resolves.toBe('/tmp/direct.pdf');

        expect(harness.workingCopies.createWorkingCopyFromData).toHaveBeenCalledWith('snapshot.pdf', data, undefined);
        expect(harness.workingCopies.createWorkingCopyFromPath).not.toHaveBeenCalled();
    });

    it('keeps the exact direct IPC ceiling on the direct path', async () => {
        const harness = createHarness();
        const data = new Uint8Array(IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES);

        await expect(
            createWorkingCopySnapshotFromData({
                data,
                fileName: 'snapshot.pdf',
                sourcePath: requireDocumentRef('/tmp/source.pdf'),
                files: harness.files,
                workingCopies: harness.workingCopies,
            }),
        ).resolves.toBe('/tmp/direct.pdf');

        expect(harness.workingCopies.createWorkingCopyFromData).toHaveBeenCalledTimes(1);
        const directArgs = harness.workingCopies.createWorkingCopyFromData.mock.calls[0]!;
        expect(directArgs[0]).toBe('snapshot.pdf');
        expect(directArgs[1]).toBe(data);
        expect(directArgs[2]).toBeUndefined();
        expect(harness.workingCopies.createWorkingCopyFromPath).not.toHaveBeenCalled();
    });

    it('stages 16 MiB plus one byte through chunked working-copy-only persistence', async () => {
        const harness = createHarness();
        const data = new Uint8Array(IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES + 1);

        await expect(
            createWorkingCopySnapshotFromData({
                data,
                fileName: 'snapshot.pdf',
                sourcePath: requireDocumentRef('/tmp/source.pdf'),
                originalPath: requireDocumentRef('/tmp/original.pdf'),
                files: harness.files,
                workingCopies: harness.workingCopies,
            }),
        ).resolves.toBe('/tmp/staged.pdf');

        expect(harness.workingCopies.createWorkingCopyFromData).not.toHaveBeenCalled();
        expect(harness.workingCopies.createWorkingCopyFromPath).toHaveBeenCalledWith('/tmp/source.pdf', '/tmp/original.pdf');
        expect(harness.files.savePdfData).toHaveBeenCalledTimes(1);
        const saveArgs = harness.files.savePdfData.mock.calls[0]!;
        expect(saveArgs[0]).toBe('/tmp/staged.pdf');
        expect(saveArgs[1]).toBe(data);
        expect(saveArgs[2]).toEqual({
            expectedDocumentRevisionToken: requireDocumentRevisionToken('stage-revision'),
            workingCopyOnly: true,
        });
    });

    it('cleans the staged clone when validation fails', async () => {
        const harness = createHarness();
        harness.files.savePdfData.mockResolvedValueOnce({
            isValid: false,
            tool: 'qpdf',
            errors: ['invalid snapshot'],
            warnings: [],
        });

        await expect(
            createWorkingCopySnapshotFromData({
                data: new Uint8Array(IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES + 1),
                fileName: 'snapshot.pdf',
                sourcePath: requireDocumentRef('/tmp/source.pdf'),
                files: harness.files,
                workingCopies: harness.workingCopies,
            }),
        ).rejects.toThrow('invalid snapshot');
        expect(harness.workingCopies.cleanupFile).toHaveBeenCalledWith('/tmp/staged.pdf');
    });

    it('rejects large in-memory staging without a source path', async () => {
        const harness = createHarness();

        await expect(
            createWorkingCopySnapshotFromData({
                data: new Uint8Array(IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES + 1),
                fileName: 'snapshot.pdf',
                files: harness.files,
                workingCopies: harness.workingCopies,
            }),
        ).rejects.toThrow('Large PDF snapshot staging requires a working source path');

        expect(harness.workingCopies.createWorkingCopyFromData).not.toHaveBeenCalled();
        expect(harness.workingCopies.createWorkingCopyFromPath).not.toHaveBeenCalled();
    });
});
