import {
    basename,
    extname,
} from 'path';
import type {
    IPdfOptimizeOptions,
    IPdfOptimizeProgress,
    IDocumentMutationRevisionOptions,
} from '@contracts/electronApiDocuments';
import { DOCUMENT_MENU_PLATFORM_FEATURE } from '@contracts/documentsPlatformFeature';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { getWorkingCopyOriginalPath } from '@electron/file-access/workingCopyStore';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
} from '@electron/file-access/documentMutationGuards';
import { allowOpenPath } from '@electron/file-access/openPathCapabilities';
import { addRecentFile } from '@electron/recentFiles';
import { updateRecentFilesMenu } from '@electron/menu';
import { te } from '@electron/te';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import { getErrorMessage } from '@electron/utils/error';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import {
    createRequestId,
    parseRequestId,
    type TRequestId,
} from '@contracts/shared';
import { createLogger } from '@electron/utils/createLogger';
import { showSaveDialogWithExtension } from '@electron/features/documents/main/documentDialogCommon';
import {
    normalizePdfOptimizeOptions,
    optimizePdfToFile,
} from '@electron/features/documents/main/pdfOptimization';
import type { IDocumentsDialogContext } from '@electron/features/documents/documentsContexts';

const logger = createLogger('documents-pdfOptimization');

function getSuggestedOptimizeName(workingPath: string, senderWebContentsId: number) {
    const originalPath = getWorkingCopyOriginalPath(workingPath, senderWebContentsId)?.originalPath;
    const sourceName = originalPath ? basename(originalPath) : basename(workingPath);
    const extension = extname(sourceName).toLowerCase() || '.pdf';
    const stem = basename(sourceName, extname(sourceName));
    return `${stem}-optimized${extension === '.pdf' ? extension : '.pdf'}`;
}

function createOptimizeProgressReporter(
    context: IDocumentsDialogContext,
    requestId: TRequestId,
) {
    const pump = createIpcProgressPump<IPdfOptimizeProgress>({
        channel: DOCUMENT_MENU_PLATFORM_FEATURE.eventChannels.onPdfOptimizeProgress,
        getTarget: () => context.sender,
        getKey: payload => payload.requestId,
        isTerminal: payload => payload.phase === 'complete',
        onError: error => {
            logger.debug(`Failed to send PDF optimize progress: ${getErrorMessage(error)}`);
        },
    });

    return (progress: IPdfOptimizeProgress) => {
        if (progress.requestId === requestId) {
            pump.enqueue(progress);
        }
    };
}

export async function handleOptimizePdfAsCopy(
    context: IDocumentsDialogContext,
    workingPath: string,
    rawOptions: IPdfOptimizeOptions,
    rawRequestId?: string,
    revisionOptions?: IDocumentMutationRevisionOptions,
) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }
    const options = normalizePdfOptimizeOptions(rawOptions);
    const requestId = parseRequestId(normalizeOptionalIpcRequestId(rawRequestId))
        ?? createRequestId('pdf-optimize');
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);

    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
        throw new Error('Working copy path is not managed');
    }

    const targetPath = await showSaveDialogWithExtension(context, {
        title: te('dialogs.saveOptimizedPdfAs'),
        defaultPath: getSuggestedOptimizeName(normalizedWorkingPath, context.senderId),
        filterName: te('dialogs.pdfFiles'),
        extension: 'pdf',
    });
    if (!targetPath) {
        return {
            path: null,
            validation: null,
            preset: options.preset,
            originalBytes: null,
            optimizedBytes: null,
            pageCount: null,
        };
    }

    const result = await enqueueWorkingCopyMutation(normalizedWorkingPath, async operation => {
        await assertQueuedWorkingCopyMutationPreconditions(
            normalizedWorkingPath,
            expectedDocumentRevisionToken,
        );
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, context.senderId)) {
            throw new Error('Working copy path is not managed');
        }

        return optimizePdfToFile(
            normalizedWorkingPath,
            targetPath,
            options,
            {
                requestId,
                signal: operation.signal,
                cancelGroup: operation.cancelGroup,
                onProgress: createOptimizeProgressReporter(context, requestId),
            },
        );
    });

    if (result.path) {
        allowOpenPath(result.path, context.sender);
        await addRecentFile(result.path);
        updateRecentFilesMenu();

        context.parentWindow?.setRepresentedFilename(result.path);
    }

    return result;
}
