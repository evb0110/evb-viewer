import { dialog } from 'electron';
import {
    opendir,
    realpath,
    stat,
} from 'fs/promises';
import {
    basename,
    isAbsolute,
    join,
    relative,
    sep,
} from 'path';
import {
    type ICreatePdfFromInputPathsProgress,
    isSupportedOpenPath,
} from '@electron/image/pdfConversion';
import { PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS } from '@electron/image/pdfCombineShared';
import {
    allowOpenPath,
    logRejectedOpenPath,
    requireOpenPath,
    type TOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { getRecentFiles } from '@electron/recentFiles';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import type {
    TOpenBatchProgressOperation,
    TOpenDocumentDirectBatchProgress,
} from '@contracts/electronApiDocuments';
import { DOCUMENT_OPEN_PLATFORM_FEATURE } from '@contracts/documentsPlatformFeature';
import { getErrorMessage } from '@electron/utils/error';
import { normalizeOptionalIpcRequestId } from '@electron/utils/ipcLimits';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';
import { getDocumentsDialogDefaultPath } from '@electron/utils/dialogDefaultPaths';
import type { TOpenFileResult } from '@electron/features/documents/contract';
import { openInputPaths } from '@electron/features/documents/main/openInputPaths.service';
import {
    errorWithDetails,
    showOpenDocumentDialogForContext,
} from '@electron/features/documents/main/documentDialogCommon';
import type {
    IDocumentsDialogContext,
    IDocumentsWebContentsContext,
} from '@electron/features/documents/documentsService';
import {isPdfDecryptPassword} from '@contracts/pdfDecryptSchemas';

const logger = createLogger('documents-dialogs');
const MAX_DIRECT_OPEN_BATCH_PATHS = 512;
const E2E_OPEN_IMAGE_PATH_ENV = 'EVB_E2E_OPEN_IMAGE_PATH';
/**
 * The direct batch open requests this main process can still cancel, keyed by
 * sender and request id. Every request that carries an id is registered, not
 * just a forced combine: a renderer that bounds its own handoff needs the
 * single-PDF open to be cancellable too, and cancellation must never reach a
 * request another window started.
 */
const activeDirectBatchRequests = new Map<string, AbortController>();
const folderEntryCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
});

function isPathInsideDirectory(directoryPath: string, candidatePath: string) {
    const relativePath = relative(directoryPath, candidatePath);
    return relativePath !== ''
        && relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath);
}

export async function collectSupportedFolderPaths(folderPath: string) {
    const supportedPaths: string[] = [];
    const realFolderPath = await realpath(folderPath);
    const directory = await opendir(folderPath);
    for await (const entry of directory) {
        const path = join(folderPath, entry.name);
        if (!isSupportedOpenPath(path)) {
            continue;
        }
        const realPath = await realpath(path).catch(() => null);
        if (
            !realPath
            || !isSupportedOpenPath(realPath)
            || !isPathInsideDirectory(realFolderPath, realPath)
        ) {
            continue;
        }
        const targetStat = await stat(realPath).catch(() => null);
        if (!targetStat?.isFile()) {
            continue;
        }
        supportedPaths.push(path);
        if (supportedPaths.length > MAX_DIRECT_OPEN_BATCH_PATHS) {
            throw new Error(`Open batch exceeds maximum size (${MAX_DIRECT_OPEN_BATCH_PATHS})`);
        }
    }
    return supportedPaths
        .map(path => ({
            path,
            name: basename(path),
        }))
        .sort((left, right) => (
            folderEntryCollator.compare(left.name, right.name)
            || left.name.localeCompare(right.name)
        ))
        .map(entry => entry.path);
}

function getDirectBatchRequestKey(senderId: number, requestId: string) {
    return `${senderId}:${requestId}`;
}

export function handleCancelOpenDocumentDirectBatch(
    context: IDocumentsWebContentsContext,
    requestId: string,
) {
    const normalizedRequestId = normalizeOptionalIpcRequestId(requestId);
    if (!normalizedRequestId) {
        return false;
    }
    const controller = activeDirectBatchRequests.get(
        getDirectBatchRequestKey(context.sender.id, normalizedRequestId),
    );
    if (!controller) {
        return false;
    }
    controller.abort(new DOMException('Document open was canceled.', 'AbortError'));
    return true;
}

function createOpenBatchProgressReporter(
    sender: Electron.WebContents,
    requestId: string,
    operation: TOpenBatchProgressOperation,
) {
    const pump = createIpcProgressPump<TOpenDocumentDirectBatchProgress>({
        channel: DOCUMENT_OPEN_PLATFORM_FEATURE.eventChannels.onOpenDocumentDirectBatchProgress,
        getTarget: () => sender,
        getKey: payload => payload.requestId,
        isTerminal: payload => payload.processed >= payload.total,
        onError: error => {
            logger.debug(`Failed to send open-batch progress update: ${String(error)}`);
        },
    });
    return (progress: ICreatePdfFromInputPathsProgress) => {
        pump.enqueue({
            operation,
            requestId,
            ...progress,
        });
    };
}

async function allowRecentFileOpenPath(filePath: string, owner: Electron.WebContents) {
    const normalizedPath = filePath;
    const recentFiles = await getRecentFiles();
    if (!recentFiles.some(file => file.originalPath === normalizedPath)) {
        return null;
    }

    return allowOpenPath(normalizedPath, owner);
}

async function openDocumentsFromDialog(
    context: IDocumentsDialogContext,
    options: {
        title: string;
        extensions: string[];
        failureMessage: string;
    },
): Promise<TOpenFileResult | null> {
    const {
        failureMessage,
        ...dialogOptions
    } = options;
    const result = await showOpenDocumentDialogForContext(context, dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    try {
        return await openInputPaths(result.filePaths, {}, context.sender);
    } catch (err) {
        logger.error(`${failureMessage}: ${getErrorMessage(err)}`, {
            code: 'MAIN_DOCUMENT_OPEN_FAILED',
            context: {},
            cause: err,
        });
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenPdfDirect(
    context: IDocumentsWebContentsContext,
    filePath: unknown,
    password?: unknown,
): Promise<TOpenFileResult | null> {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        logger.warn('openDocumentDirect received empty path');
        return null;
    }
    if (password !== undefined && !isPdfDecryptPassword(password)) {
        throw new Error(te('errors.file.invalid'));
    }

    let normalizedPath: TOpenPath;
    try {
        normalizedPath = requireOpenPath(filePath, context.sender);
    } catch {
        const recentOpenPath = await allowRecentFileOpenPath(filePath, context.sender);
        if (!recentOpenPath) {
            logRejectedOpenPath(filePath);
            throw new Error(te('errors.file.invalid'));
        }
        normalizedPath = recentOpenPath;
    }

    logger.info(`openDocumentDirect request: ${normalizedPath}`);
    try {
        const result = await openInputPaths(
            [normalizedPath],
            password === undefined ? {} : {password},
            context.sender,
        );
        logger.info(`openDocumentDirect result for ${normalizedPath}: ${result?.kind ?? 'null'}`);
        return result;
    } catch (err) {
        logger.error(`Failed to create working copy: ${getErrorMessage(err)}`, {
            code: 'MAIN_DOCUMENT_OPEN_FAILED',
            context: {},
            cause: err,
        });
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenPdfDirectBatch(
    context: IDocumentsWebContentsContext,
    filePaths: unknown,
    requestId?: string,
    batchOptions?: {forceCombine?: boolean},
): Promise<TOpenFileResult | null> {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return null;
    }
    if (filePaths.length > MAX_DIRECT_OPEN_BATCH_PATHS) {
        throw new Error(`Open batch exceeds maximum size (${MAX_DIRECT_OPEN_BATCH_PATHS})`);
    }

    try {
        const normalizedPaths = filePaths.filter((path): path is string => typeof path === 'string' && path.length > 0)
            .map(path => requireOpenPath(path, context.sender));

        const normalizedRequestId = normalizeOptionalIpcRequestId(requestId) ?? '';
        const abortController = normalizedRequestId ? new AbortController() : null;
        const requestKey = abortController
            ? getDirectBatchRequestKey(context.sender.id, normalizedRequestId)
            : null;
        if (requestKey && abortController) {
            activeDirectBatchRequests.get(requestKey)?.abort(new Error('Superseded document open request'));
            activeDirectBatchRequests.set(requestKey, abortController);
        }
        const options = normalizedRequestId
            ? {onCombineProgress: createOpenBatchProgressReporter(context.sender, normalizedRequestId, 'document-open')}
            : {};
        try {
            return await openInputPaths(normalizedPaths, {
                ...options,
                forceCombine: batchOptions?.forceCombine === true,
                ...(abortController ? {signal: abortController.signal} : {}),
            }, context.sender);
        } finally {
            if (requestKey && activeDirectBatchRequests.get(requestKey) === abortController) {
                activeDirectBatchRequests.delete(requestKey);
            }
        }
    } catch (err) {
        logger.error(`Failed to create working copy from batch: ${getErrorMessage(err)}`, {
            code: 'MAIN_DOCUMENT_OPEN_FAILED',
            context: {},
            cause: err,
        });
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenPdfDialog(context: IDocumentsDialogContext): Promise<TOpenFileResult | null> {
    return openDocumentsFromDialog(context, {
        title: te('dialogs.openDocument'),
        extensions: [
            'pdf',
            'djvu',
            'djv',
            ...PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
        ],
        failureMessage: 'Failed to create working copy',
    });
}

export async function handleOpenFolderDialog(context: IDocumentsDialogContext): Promise<TOpenFileResult | null> {
    const dialogOptions = {
        title: te('dialogs.openFolder'),
        defaultPath: getDocumentsDialogDefaultPath(),
        properties: ['openDirectory'],
    } satisfies Electron.OpenDialogOptions;

    const result = context.parentWindow
        ? await dialog.showOpenDialog(context.parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    const folderPath = result.filePaths[0]!;

    let sortedSupportedPaths: string[];
    try {
        sortedSupportedPaths = await collectSupportedFolderPaths(folderPath);
    } catch (err) {
        logger.error(`Failed to read folder contents: ${getErrorMessage(err)}`, {
            code: 'MAIN_DOCUMENT_OPEN_FAILED',
            context: {},
            cause: err,
        });
        throw errorWithDetails(te('errors.file.open'), err);
    }

    if (sortedSupportedPaths.length === 0) {
        throw new Error(te('errors.file.folderEmpty'));
    }

    try {
        return await openInputPaths(sortedSupportedPaths, {}, context.sender);
    } catch (err) {
        logger.error(`Failed to open folder contents: ${getErrorMessage(err)}`, {
            code: 'MAIN_DOCUMENT_OPEN_FAILED',
            context: {},
            cause: err,
        });
        throw errorWithDetails(te('errors.file.open'), err);
    }
}

export async function handleOpenCombineDialog(context: IDocumentsDialogContext): Promise<TOpenFileResult | null> {
    return openDocumentsFromDialog(context, {
        title: te('dialogs.combineFiles'),
        extensions: [
            'pdf',
            ...PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS.map(ext => ext.slice(1)),
        ],
        failureMessage: 'Failed to combine files',
    });
}

export async function handleOpenImageDialog(context: IDocumentsDialogContext) {
    const e2eImagePath = process.env[E2E_OPEN_IMAGE_PATH_ENV]?.trim();
    if (e2eImagePath) {
        if (!isAbsolute(e2eImagePath)) {
            throw new Error(E2E_OPEN_IMAGE_PATH_ENV + ' must be an absolute path');
        }
        const imageStat = await stat(e2eImagePath).catch(() => null);
        if (!imageStat?.isFile()) {
            throw new Error(E2E_OPEN_IMAGE_PATH_ENV + ' must point to an image file');
        }
        allowOpenPath(e2eImagePath, context.sender);
        return e2eImagePath;
    }

    const dialogOptions = {
        title: te('dialogs.openImage'),
        defaultPath: getDocumentsDialogDefaultPath(),
        filters: [{
            name: te('dialogs.imagesFilter'),
            extensions: [
                'apng',
                'avif',
                'bmp',
                'gif',
                'jpeg',
                'jpg',
                'png',
                'svg',
                'svgz',
                'webp',
                'ico',
            ],
        }],
        properties: ['openFile'],
    } satisfies Electron.OpenDialogOptions;
    const result = context.parentWindow
        ? await dialog.showOpenDialog(context.parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
        return null;
    }

    const imagePath = result.filePaths[0] ?? null;
    if (imagePath) {
        allowOpenPath(imagePath, context.sender);
    }
    return imagePath;
}
