import {rm} from 'node:fs/promises';
import type {IDocumentMutationRevisionOptions} from '@contracts/electronApiDocuments';
import {requireDocumentRef} from '@contracts/documentRef';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {isAllowedOriginalSavePath} from '@electron/file-access/isAllowedOriginalSavePath';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    commitDocumentMutation,
    normalizeExpectedDocumentRevisionToken,
    requireOpenDocument,
} from '@electron/file-access/documentStore';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import type {IDocumentsSenderIdContext} from '@electron/features/documents/documentsContexts';
import {createDocumentForOriginal} from '@electron/features/documents/main/documentWorkingCopyHandlers';
import {
    releaseManagedTempFileHandle,
    resolveTypedStagedArtifact,
} from '@electron/features/documents/main/managedTempFileHandles';
import type {TOpenPath} from '@electron/file-access/openPathCapabilities';

function requireSenderId(context: IDocumentsSenderIdContext) {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

function normalizeOptionalOriginalPath(originalPath: unknown) {
    if (originalPath === undefined || originalPath === null) {
        return undefined;
    }
    if (typeof originalPath !== 'string' || originalPath.trim().length === 0) {
        throw new Error('Invalid original path');
    }
    const normalizedPath = originalPath.trim();
    if (!isAllowedOriginalSavePath(normalizedPath)) {
        throw new Error('Invalid original path');
    }
    return normalizedPath;
}

function assertConsumableStagedPdf(artifact: ITypedStagedArtifact) {
    if (
        artifact.size <= 0
        || !artifact.validations.tailCheck
        || !artifact.validations.semanticCheck
        || !artifact.validations.fsynced
    ) {
        throw new Error('Native PDF staged artifact is not fully validated');
    }
}

async function cleanupStagedPath(path: string) {
    await rm(path, {force: true}).catch(() => undefined);
}

// The resolved receipt lease is the only admission for a staged path; no
// renderer open-path capability is ever granted for it.
function toStagedSourcePath(stagedOutput: ITypedStagedArtifact) {
    return stagedOutput.path as string as TOpenPath;
}

/**
 * Consumes a lease-backed native mutation receipt into a disposable snapshot.
 * The receipt is the only authority used to read the staged path. It is
 * released on every successful resolution path, and the original document is
 * never opened or written here.
 */
export async function handleCloneStagedPdfNativeMutationToWorkingCopy(
    context: IDocumentsSenderIdContext,
    stagedArtifact: ITypedStagedArtifact,
    originalPath?: string,
) {
    const senderId = requireSenderId(context);
    const stagedOutput = await resolveTypedStagedArtifact(context, stagedArtifact);
    try {
        assertConsumableStagedPdf(stagedOutput);
        const normalizedOriginalPath = normalizeOptionalOriginalPath(originalPath);
        const entry = await createDocumentForOriginal(toStagedSourcePath(stagedOutput), normalizedOriginalPath, senderId);
        return requireDocumentRef(entry.ref);
    } finally {
        releaseManagedTempFileHandle(context, stagedOutput.leaseId);
        await cleanupStagedPath(stagedOutput.path);
    }
}

/**
 * Replaces only a managed working copy with a lease-backed native mutation.
 * The original path is deliberately not consulted, so page operations can
 * refresh the working document without committing user data.
 */
export async function handleReplaceWorkingCopyFromStagedPdfNativeMutation(
    context: IDocumentsSenderIdContext,
    workingCopyPath: unknown,
    stagedArtifact: ITypedStagedArtifact,
    revisionOptions: IDocumentMutationRevisionOptions,
) {
    const senderId = requireSenderId(context);
    const entry = requireOpenDocument(typeof workingCopyPath === 'string' ? workingCopyPath.trim() : '', senderId);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);
    if (!expectedDocumentRevisionToken) {
        throw new Error('Native staged working-copy replacement requires the document revision');
    }

    const stagedOutput = await resolveTypedStagedArtifact(context, stagedArtifact);
    try {
        assertConsumableStagedPdf(stagedOutput);
        return await enqueueWorkingCopyMutation(entry.ref, async () => {
            await assertQueuedWorkingCopyMutationPreconditions(entry.ref, expectedDocumentRevisionToken);
            await commitDocumentMutation(entry, expectedDocumentRevisionToken, {kind: 'move', file: stagedOutput.path}, 'native-mutation');
            return true;
        }, {
            kind: 'native-pdf-mutation-staged-working-copy',
            ownerWebContentsId: senderId,
        });
    } finally {
        releaseManagedTempFileHandle(context, stagedOutput.leaseId);
        await cleanupStagedPath(stagedOutput.path);
    }
}
