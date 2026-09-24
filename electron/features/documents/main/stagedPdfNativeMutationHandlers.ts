import {
    unlink,
    rm,
} from 'node:fs/promises';
import type {IDocumentMutationRevisionOptions} from '@contracts/electronApiDocuments';
import {parseDocumentRef} from '@contracts/documentRef';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {isAllowedOriginalSavePath} from '@electron/file-access/isAllowedOriginalSavePath';
import {createDisposableWorkingCopyFromPath} from '@electron/file-access/workingCopyCreation';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
} from '@electron/file-access/documentMutationGuards';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import {transitionWorkingCopyContentRevision} from '@electron/file-access/documentRevisionStore';
import {copyFileCopyOnWrite} from '@electron/file-access/workingCopyDirectory';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {resolveAllowedWritePath} from '@electron/utils/pathValidator';
import type {IDocumentsSenderIdContext} from '@electron/features/documents/documentsService';
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
        const workingPath = await createDisposableWorkingCopyFromPath(
            toStagedSourcePath(stagedOutput),
            normalizedOriginalPath,
            senderId,
        );
        const documentRef = parseDocumentRef(workingPath);
        if (documentRef === null) {
            throw new Error('Staged working-copy creation returned an invalid document ref');
        }
        return documentRef;
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
    const normalizedWorkingPath = typeof workingCopyPath === 'string'
        ? workingCopyPath.trim()
        : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    const resolvedWorkingPath = await resolveAllowedWritePath(normalizedWorkingPath);
    if (!resolvedWorkingPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);
    if (!expectedDocumentRevisionToken) {
        throw new Error('Native staged working-copy replacement requires the document revision');
    }

    const stagedOutput = await resolveTypedStagedArtifact(context, stagedArtifact);
    try {
        assertConsumableStagedPdf(stagedOutput);
        return await enqueueWorkingCopyMutation(resolvedWorkingPath, async () => {
            await assertQueuedWorkingCopyMutationPreconditions(
                resolvedWorkingPath,
                expectedDocumentRevisionToken,
            );
            await ensureWorkingCopyMaterialized(resolvedWorkingPath, {
                ownerWebContentsId: senderId,
                reason: 'native-mutation',
            });

            const tempPath = `${makeSiblingTempPath(resolvedWorkingPath)}.pdf`;
            let promoted = false as boolean;
            try {
                await copyFileCopyOnWrite(stagedOutput.path, tempPath);
                // The source lease can expire or be invalidated while the
                // copy is in flight. Recheck it before promoting the copy.
                await resolveTypedStagedArtifact(context, stagedOutput);
                await transitionWorkingCopyContentRevision(
                    resolvedWorkingPath,
                    'native-mutation',
                    async () => {
                        await atomicReplace(tempPath, resolvedWorkingPath);
                        promoted = true;
                    },
                    senderId,
                );
                return true;
            } finally {
                if (!promoted) {
                    await unlink(tempPath).catch(() => undefined);
                }
            }
        }, {
            kind: 'native-pdf-mutation-staged-working-copy',
            ...(context.senderId === undefined ? {} : {ownerWebContentsId: context.senderId}),
        });
    } finally {
        releaseManagedTempFileHandle(context, stagedOutput.leaseId);
        await cleanupStagedPath(stagedOutput.path);
    }
}
