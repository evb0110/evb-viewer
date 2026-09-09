import { unlink } from 'fs/promises';
import { basename } from 'path';
import { isErrnoException } from '@contracts/runtimeGuards';
import { resolveAllowedWritePath } from '@electron/utils/pathValidator';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { findPendingOcrResultFileForPath } from '@electron/features/ocr/public/index';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

const logger = createLogger('documents-fileOps');

export async function handleCleanupOcrTemp(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
) {
    const normalizedPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!normalizedPath) {
        return;
    }

    try {
        const resolvedPath = await resolveAllowedWritePath(normalizedPath);
        if (!resolvedPath) {
            return;
        }

        const fileName = basename(resolvedPath);
        const isOcrArtifact = fileName.startsWith('ocr-') || fileName.startsWith('searchable-');

        if (!isOcrArtifact) {
            return;
        }
        if (typeof context.senderId !== 'number' || !findPendingOcrResultFileForPath(context.senderId, resolvedPath)) {
            return;
        }

        try {
            await unlink(resolvedPath);
        } catch (unlinkErr) {
            const code = isErrnoException(unlinkErr) ? unlinkErr.code : undefined;
            if (code !== 'ENOENT') {
                throw unlinkErr;
            }
        }
    } catch (err) {
        logger.warn(`Failed to delete OCR temp file: ${getErrorMessage(err)}`);
    }
}
