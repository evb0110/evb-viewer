import { stat } from 'node:fs/promises';
import { mainJobBroker } from '@electron/resources/jobBroker';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import type {IDocumentsSenderIdContext} from '@electron/features/documents/documentsContexts';
import {resolveTypedStagedArtifact} from '@electron/features/documents/main/managedTempFileHandles';
import {validateDocumentSaveStagingFile} from '@electron/features/documents/main/fingerprintFileWithUtilityProcess';

const SAVE_UTILITY_THRESHOLD = 64 * 1024 * 1024;

function shouldUseDocumentSaveUtility(bytes: number) {
    return bytes >= SAVE_UTILITY_THRESHOLD;
}

/**
 * Verifies a PDF a save wrote before it is published: a large output or a targeted edit is validated asynchronously
 * in main under the job broker (with native qpdf child commands). The caller commits it.
 */
export async function verifyPdfTempFile(sourcePath: string, options: {
    expectedBytes?: number;
    signal?: AbortSignal;
    ownerId?: string;
    changedObjectRefs?: string[];
    receipt?: {
        artifact: ITypedStagedArtifact;
        context: IDocumentsSenderIdContext;
    };
} = {}) {
    const signal = options.signal;
    const stagedArtifact = options.receipt === undefined
        ? undefined
        : await resolveTypedStagedArtifact(
            options.receipt.context,
            options.receipt.artifact,
        );
    if (stagedArtifact !== undefined && stagedArtifact.path !== sourcePath) {
        throw new Error('Staged artifact receipt does not identify the PDF commit source');
    }
    if (
        stagedArtifact !== undefined
        && options.expectedBytes !== undefined
        && options.expectedBytes !== stagedArtifact.size
    ) {
        throw new Error('Staged artifact receipt size does not match the PDF commit request');
    }
    const expectedBytes = options.expectedBytes
        ?? stagedArtifact?.size
        ?? (await stat(sourcePath)).size;
    if (!shouldUseDocumentSaveUtility(expectedBytes) && !options.changedObjectRefs?.length) {
        return null;
    }
    return mainJobBroker.run({
        ownerId: options.ownerId ?? `document-save:${sourcePath}`,
        kind: 'document-save-utility',
        priority: 'user',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 256 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 4,
        },
        ...(signal ? {signal} : {}),
    }, ({onTerminationProof}) => validateDocumentSaveStagingFile({
        type: 'validate',
        sourcePath,
        expectedBytes,
        validationBinary: getPdfNativeToolPaths().qpdf,
        ...(options.changedObjectRefs?.length ? {changedObjectRefs: options.changedObjectRefs} : {}),
        ...(stagedArtifact === undefined ? {} : {stagedArtifact}),
    }, {
        timeoutMs: 10 * 60_000,
        ...(signal ? {signal} : {}),
        onTerminationProof,
    }));
}
