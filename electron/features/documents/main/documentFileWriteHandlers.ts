import {
    basename,
    extname,
    resolve,
} from 'path';
import { createHash } from 'node:crypto';
import {createReadStream} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { unlink } from 'node:fs/promises';
import {requireDocumentRef} from '@contracts/documentRef';
import {
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} from '@electron/utils/pathValidator';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import type { IDocumentMutationRevisionOptions } from '@contracts/electronApiDocuments';
import {transitionWorkingCopyContentRevision} from '@electron/file-access/documentRevisionStore';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
} from '@electron/file-access/documentMutationGuards';
import { consumeAllowedDocxWritePath } from '@electron/file-access/docxExportPaths';
import {
    copyFileAtomic,
    normalizeIpcWritePayload,
    writeFileAtomic,
} from '@electron/file-access/documentFileWriteAtomic';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {validatePdfFile} from '@electron/features/documents/main/pdfConformance';
import { normalizeNonEmptyPath } from '@electron/features/documents/main/documentFilePathResolution';
import {
    getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import { originalPathSaveBaseMatches } from '@electron/file-access/originalPathSaveWitness';
import { findOcrResultForDocument } from '@electron/features/ocr/public/index';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';

function requireSenderId(context: IDocumentsSenderIdContext) {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

async function sha256File(path: string) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
}

function assertOcrPdfResultSourcePath(resolvedPath: string) {
    const fileName = basename(resolvedPath).toLowerCase();
    if (extname(fileName) !== '.pdf') {
        throw new Error('Invalid source path: OCR result must be a PDF');
    }
    if (!fileName.startsWith('ocr-') && !fileName.startsWith('searchable-')) {
        throw new Error('Invalid source path: only OCR result files can replace a working copy');
    }
}

async function shouldRefreshOriginalSaveBaseAfterWorkingCopyReplacement(
    workingCopyPath: string,
    senderWebContentsId: number,
) {
    const mapping = getWorkingCopyOriginalPath(workingCopyPath, senderWebContentsId);
    if (!mapping) {
        return false;
    }

    return originalPathSaveBaseMatches(workingCopyPath, mapping.originalPath, senderWebContentsId);
}

export async function handleFileWrite(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    data: unknown,
    options?: IDocumentMutationRevisionOptions,
) {
    const senderId = requireSenderId(context);
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    return enqueueWorkingCopyMutation(resolvedPath, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(resolvedPath, expectedDocumentRevisionToken);
        await ensureWorkingCopyMaterialized(resolvedPath, {
            ownerWebContentsId: senderId,
            reason: 'first-mutation',
        });
        const tempPath = makeSiblingTempPath(resolvedPath);
        let committed = false as boolean;
        try {
            await writeFileAtomic(tempPath, payload);
            const validation = await validatePdfFile(tempPath);
            if (!validation.isValid) {
                throw new Error(`PDF write verification failed: ${validation.errors.join('; ')}`);
            }
            await transitionWorkingCopyContentRevision(
                resolvedPath,
                'write',
                async () => {
                    await atomicReplace(tempPath, resolvedPath);
                    committed = true;
                },
                senderId,
            );
        } finally {
            if (!committed) await unlink(tempPath).catch(() => undefined);
        }
        return true;
    });
}

export async function handleReplaceWorkingCopyFromPath(
    context: IDocumentsSenderIdContext,
    workingCopyPath: unknown,
    sourcePath: unknown,
    options?: IDocumentMutationRevisionOptions,
) {
    const senderId = requireSenderId(context);
    const normalizedWorkingCopyPath = normalizeNonEmptyPath(workingCopyPath);
    const normalizedSourcePath = normalizeNonEmptyPath(sourcePath);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const allowedWorkingCopyPath = await resolveAllowedWritePath(normalizedWorkingCopyPath);
    if (!allowedWorkingCopyPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }
    const allowedSourcePath = await resolveAllowedReadPath(normalizedSourcePath);
    if (!allowedSourcePath) {
        throw new Error('Invalid source path: OCR result must be within temp directory');
    }
    const resolvedWorkingCopyPath = allowedWorkingCopyPath;
    const resolvedSourcePath = allowedSourcePath;
    assertOcrPdfResultSourcePath(resolvedSourcePath);

    return enqueueWorkingCopyMutation(resolvedWorkingCopyPath, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(
            resolvedWorkingCopyPath,
            expectedDocumentRevisionToken,
        );
        await ensureWorkingCopyMaterialized(resolvedWorkingCopyPath, {
            ownerWebContentsId: senderId,
            reason: 'ocr-persist',
        });
        if (!expectedDocumentRevisionToken) {
            throw new Error('OCR apply requires the source document revision');
        }
        const pendingResult = findOcrResultForDocument(
            resolvedSourcePath,
            requireDocumentRef(resolvedWorkingCopyPath),
            expectedDocumentRevisionToken,
        );
        if (!pendingResult) {
            throw new Error('Invalid source path: OCR result is not authorized for this document revision');
        }
        if (await sha256File(resolvedSourcePath) !== pendingResult.resultSha256) {
            throw new Error('OCR result content hash does not match the verified worker result');
        }
        const shouldRefreshOriginalSaveBase = await shouldRefreshOriginalSaveBaseAfterWorkingCopyReplacement(
            resolvedWorkingCopyPath,
            senderId,
        );
        const tempPath = makeSiblingTempPath(resolvedWorkingCopyPath);
        let committed = false as boolean;
        try {
            await copyFileAtomic(resolvedSourcePath, tempPath);
            await transitionWorkingCopyContentRevision(
                resolvedWorkingCopyPath,
                'ocr-apply',
                async () => {
                    await atomicReplace(tempPath, resolvedWorkingCopyPath);
                    committed = true;
                },
                senderId,
            );
        } finally {
            if (!committed) await unlink(tempPath).catch(() => undefined);
        }
        if (shouldRefreshOriginalSaveBase) {
            if (!await refreshWorkingCopyOriginalFileExpectation(resolvedWorkingCopyPath, senderId)) {
                throw new Error('Working copy registration changed before original expectation refresh completed');
            }
        }
        return true;
    });
}

export async function handleFileWriteDocx(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    data: unknown,
) {
    const senderId = requireSenderId(context);
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    if (!consumeAllowedDocxWritePath(normalizedPath, senderId)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    await writeFileAtomic(resolve(normalizedPath), payload);
    return true;
}
