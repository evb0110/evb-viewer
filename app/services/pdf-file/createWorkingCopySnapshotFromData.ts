import {IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES} from '@contracts/electronApiDocuments';
import type {IDocumentsFileIoCapability, IDocumentsWorkingCopyCapability} from '@contracts/electronApiDocuments';
import type {TDocumentRef} from '@contracts/documentRef';

type TSnapshotFileCapability = Pick<IDocumentsFileIoCapability, 'getDocumentRevision' | 'savePdfData'>;
type TSnapshotWorkingCopyCapability = Pick<
    IDocumentsWorkingCopyCapability,
    'cleanupFile' | 'createWorkingCopyFromData' | 'createWorkingCopyFromPath'
>;

export async function createWorkingCopySnapshotFromData(input: {
    data: Uint8Array;
    fileName: string;
    sourcePath?: TDocumentRef | undefined;
    originalPath?: TDocumentRef | undefined;
    files: TSnapshotFileCapability;
    workingCopies: TSnapshotWorkingCopyCapability;
}) {
    if (input.data.byteLength <= IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES) {
        return input.workingCopies.createWorkingCopyFromData(input.fileName, input.data, input.originalPath);
    }

    if (typeof input.files.savePdfData !== 'function') {
        throw new Error('Large PDF snapshot staging requires chunked PDF persistence support');
    }
    if (!input.sourcePath) {
        throw new Error('Large PDF snapshot staging requires a working source path');
    }

    const snapshotPath = await input.workingCopies.createWorkingCopyFromPath(input.sourcePath, input.originalPath);
    try {
        const revision = await input.files.getDocumentRevision(snapshotPath);
        const validation = await input.files.savePdfData(snapshotPath, input.data, {
            expectedDocumentRevisionToken: revision.token,
            workingCopyOnly: true,
        });
        if (!validation.isValid) {
            throw new Error(validation.errors.join('\n') || 'Large PDF snapshot validation failed');
        }
        return snapshotPath;
    } catch (error) {
        await input.workingCopies.cleanupFile(snapshotPath).catch(() => undefined);
        throw error;
    }
}
