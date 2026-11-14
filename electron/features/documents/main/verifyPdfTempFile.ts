import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mainJobBroker } from '@electron/resources/jobBroker';
import type { IJobBrokerLease } from '@electron/resources/jobBroker';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import type {IDocumentsSenderIdContext} from '@electron/features/documents/documentsContexts';
import {resolveTypedStagedArtifact} from '@electron/features/documents/main/managedTempFileHandles';
import {runDocumentSaveUtilityProcess} from '@electron/features/documents/main/fingerprintFileWithUtilityProcess';
import {DOCUMENT_SAVE_SERVICE_NAME} from '@electron/processDeathRecovery';

const SAVE_UTILITY_THRESHOLD = 64 * 1024 * 1024;

function shouldUseDocumentSaveUtility(bytes: number) {
    return bytes >= SAVE_UTILITY_THRESHOLD;
}

/**
 * Verifies a PDF a save wrote before it is published: a large output or a targeted edit is validated by the document
 * save utility, in its own process. The caller commits it.
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
    let lease: IJobBrokerLease | undefined;
    let utilityOwnsLease = false;
    try {
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
        lease = await mainJobBroker.acquire({
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
        });
        utilityOwnsLease = true;
        const result = await runDocumentSaveUtilityProcess({
            cwd: dirname(sourcePath),
            serviceName: DOCUMENT_SAVE_SERVICE_NAME,
            utilityName: 'Document save utility',
            timeoutMs: 10 * 60_000,
            ...(signal ? {signal} : {}),
            request: {
                type: 'validate',
                sourcePath,
                expectedBytes,
                validationBinary: getPdfNativeToolPaths().qpdf,
                ...(options.changedObjectRefs?.length ? {changedObjectRefs: options.changedObjectRefs} : {}),
                ...(stagedArtifact === undefined ? {} : {stagedArtifact}),
            },
            resourceLease: lease,
        });
        return result;
    } finally {
        if (!utilityOwnsLease) {
            lease?.release();
        }
    }
}
