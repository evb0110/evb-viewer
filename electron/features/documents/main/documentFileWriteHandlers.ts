import {
    basename,
    dirname,
    extname,
    join,
} from 'path';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {createReadStream} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { unlink } from 'node:fs/promises';
import {requireDocumentRef} from '@contracts/documentRef';
import {resolveAllowedReadPath} from '@electron/utils/pathValidator';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import type { IDocumentMutationRevisionOptions } from '@contracts/electronApiDocuments';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    commitDocumentMutation,
    normalizeExpectedDocumentRevisionToken,
    requireOpenDocument,
} from '@electron/file-access/documentStore';
import {
    normalizeIpcWritePayload,
    writeFileAtomic,
} from '@electron/file-access/documentFileWriteAtomic';
import {validatePdfFile} from '@electron/features/documents/main/pdfConformance';
import { normalizeNonEmptyPath } from '@electron/features/documents/main/documentFilePathResolution';
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

export async function handleFileWrite(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    data: unknown,
    options?: IDocumentMutationRevisionOptions,
) {
    const senderId = requireSenderId(context);
    const entry = requireOpenDocument(normalizeNonEmptyPath(filePath), senderId);
    const payload = normalizeIpcWritePayload(data);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    return enqueueWorkingCopyMutation(entry.ref, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(entry.ref, expectedDocumentRevisionToken);
        // Beside the revisions, so the commit moves it in; a crash leaves nothing the manifest names.
        const tempPath = join(dirname(entry.ref), `.write-${randomUUID()}.tmp`);
        try {
            await writeFileAtomic(tempPath, payload);
            const validation = await validatePdfFile(tempPath);
            if (!validation.isValid) {
                throw new Error(`PDF write verification failed: ${validation.errors.join('; ')}`);
            }
            await commitDocumentMutation(entry, expectedDocumentRevisionToken, {kind: 'move', file: tempPath}, 'write');
        } finally {
            await unlink(tempPath).catch(() => undefined);
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
    const entry = requireOpenDocument(normalizeNonEmptyPath(workingCopyPath), senderId);
    const normalizedSourcePath = normalizeNonEmptyPath(sourcePath);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const resolvedSourcePath = await resolveAllowedReadPath(normalizedSourcePath);
    if (!resolvedSourcePath) {
        throw new Error('Invalid source path: OCR result must be within temp directory');
    }
    assertOcrPdfResultSourcePath(resolvedSourcePath);

    return enqueueWorkingCopyMutation(entry.ref, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(entry.ref, expectedDocumentRevisionToken);
        if (!expectedDocumentRevisionToken) {
            throw new Error('OCR apply requires the source document revision');
        }
        const pendingResult = findOcrResultForDocument(
            resolvedSourcePath,
            requireDocumentRef(entry.ref),
            expectedDocumentRevisionToken,
        );
        if (!pendingResult) {
            throw new Error('Invalid source path: OCR result is not authorized for this document revision');
        }
        if (await sha256File(resolvedSourcePath) !== pendingResult.resultSha256) {
            throw new Error('OCR result content hash does not match the verified worker result');
        }
        await commitDocumentMutation(entry, expectedDocumentRevisionToken, {kind: 'rewrite', source: resolvedSourcePath}, 'ocr-apply');
        return true;
    });
}
