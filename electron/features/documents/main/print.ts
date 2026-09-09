import { shell } from 'electron';
import type { WebContentsPrintOptions } from 'electron';
import { uniq } from 'es-toolkit/array';
import {
    readdir,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    basename,
    extname,
    join,
} from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { cancelNativeCommandGroup } from '@electron/native-tools/runNativeCommand';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import { extractPages } from '@electron/features/page-ops/public';
import type {
    IPdfDataPrintOptions,
    IPdfPathPrintOptions,
} from '@contracts/electronApiDocuments';
import { requirePageNumber } from '@contracts/pageNumbers';
import { PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES } from '@contracts/shared';
import { getAppTempDir } from '@electron/utils/appTempDir';
import type {
    IDocumentsSenderIdContext,
    IDocumentsWindowContext,
} from '@electron/features/documents/documentsService';
import { resolveExistingReadablePdfPath } from '@electron/features/documents/main/documentFilePathResolution';
import { ensureWorkingCopyMaterialized } from '@electron/file-access/workingCopyMaterialization';
import {
    assertPdfPathWithinSizeLimit,
    cleanupPrintTempPath,
    openNativePrintDialogForPath,
    PRINT_DJVU_TEMP_PREFIX,
    schedulePrintTempCleanup,
    validatePdfBytesForHandoff,
    type IPrintPdfResult,
} from '@electron/utils/printHandoff';
import { buildPrintablePdfPath } from '@electron/features/documents/main/buildPrintablePdfPath';

const logger = createLogger('documents-print');
const DEFAULT_APP_TEMP_PREFIX = 'open-in-default-app-';
const PRINT_DATA_TEMP_PREFIX = 'print-data-';
const PRINT_PAGE_TEMP_PREFIX = 'print-pages-';
const PRINT_LAYOUT_TEMP_PREFIX = 'print-layout-';
const PRINT_TEMP_BASENAME_MAX_BYTES = 255;
const DEFAULT_APP_TEMP_CLEANUP_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_APP_TEMP_MAX_AGE_MS = DEFAULT_APP_TEMP_CLEANUP_DELAY_MS;
const scheduledDefaultAppTempCleanup = new Map<string, ReturnType<typeof setTimeout>>();
const activePdfPrintAborters = new Map<string, (reason: string) => void>();

interface IOpenPdfInDefaultAppResult {
    success: boolean;
    error?: string;
}

function normalizePrintableFileName(fileName?: string) {
    const trimmed = typeof fileName === 'string' ? fileName.trim() : '';
    const safeBaseName = Array.from(basename(trimmed || 'document.pdf'))
        .map((character) => {
            if (/[<>:"/\\|?*]/.test(character)) {
                return '-';
            }

            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint < 32 ? '-' : character;
        })
        .join('');
    if (extname(safeBaseName).toLowerCase() === '.pdf') {
        return safeBaseName;
    }
    return `${safeBaseName || 'document'}.pdf`;
}

function buildOpaquePrintTempPath(prefix: string, operationId: string) {
    const tempFileName = `${prefix}${operationId}.pdf`;
    if (Buffer.byteLength(tempFileName, 'utf8') > PRINT_TEMP_BASENAME_MAX_BYTES) {
        throw new Error('Print temporary filename exceeds the filesystem component limit');
    }
    return join(getAppTempDir(), tempFileName);
}

function scheduleDefaultAppTempCleanup(path: string, delayMs = DEFAULT_APP_TEMP_CLEANUP_DELAY_MS) {
    const existingTimer = scheduledDefaultAppTempCleanup.get(path);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        scheduledDefaultAppTempCleanup.delete(path);
        void unlink(path).catch(() => undefined);
    }, delayMs);
    timer.unref();
    scheduledDefaultAppTempCleanup.set(path, timer);
}

async function cleanupDefaultAppTempPath(path: string) {
    const existingTimer = scheduledDefaultAppTempCleanup.get(path);
    if (existingTimer) {
        clearTimeout(existingTimer);
        scheduledDefaultAppTempCleanup.delete(path);
    }

    await unlink(path).catch(() => undefined);
}

function shouldSweepManagedTempPdf(entry: string) {
    if (extname(entry).toLowerCase() !== '.pdf') {
        return false;
    }

    return entry.startsWith(DEFAULT_APP_TEMP_PREFIX)
        || entry.startsWith(PRINT_DATA_TEMP_PREFIX)
        || entry.startsWith(PRINT_DJVU_TEMP_PREFIX)
        || entry.startsWith(PRINT_PAGE_TEMP_PREFIX)
        || entry.startsWith(PRINT_LAYOUT_TEMP_PREFIX);
}

export async function sweepStaleDefaultAppTempPdfs(maxAgeMs = DEFAULT_APP_TEMP_MAX_AGE_MS) {
    const tempDir = getAppTempDir();
    const now = Date.now();

    let entries: string[] = [];
    try {
        entries = await readdir(tempDir);
    } catch {
        return;
    }

    await Promise.all(entries.map(async (entry) => {
        if (!shouldSweepManagedTempPdf(entry)) {
            return;
        }

        const path = join(tempDir, entry);
        try {
            const fileStat = await stat(path);
            const lastTouchedAt = Math.max(fileStat.mtimeMs, fileStat.ctimeMs);
            if (!Number.isFinite(lastTouchedAt) || now - lastTouchedAt < maxAgeMs) {
                return;
            }
        } catch {
            return;
        }

        await cleanupDefaultAppTempPath(path);
        await cleanupPrintTempPath(path);
    }));
}

async function openPdfInDefaultApp(path: string): Promise<IOpenPdfInDefaultAppResult> {
    try {
        const result = await shell.openPath(path);
        if (!result) {
            return { success: true };
        }

        return {
            success: false,
            error: result,
        };
    } catch (error) {
        logger.warn(`Failed to open PDF in the default app: ${getErrorMessage(error)}`);
        return {
            success: false,
            error: error instanceof Error ? getErrorMessage(error) : 'Failed to open the default PDF app',
        };
    }
}

async function resolveReadablePdfPathForSender(filePath: string, senderId?: number, signal?: AbortSignal) {
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, senderId);
    const materialized = await ensureWorkingCopyMaterialized(resolvedPath, {
        reason: 'print-external',
        ...(senderId === undefined ? {} : {ownerWebContentsId: senderId}),
        ...(signal ? {signal} : {}),
    });
    return materialized.physicalWorkingCopyPath;
}

function normalizePrintPageNumbers(pageNumbers?: number[]) {
    if (!Array.isArray(pageNumbers) || pageNumbers.length === 0) {
        return null;
    }

    const normalized = uniq(pageNumbers);
    if (normalized.some(pageNumber => !Number.isInteger(pageNumber) || pageNumber < 1)) {
        throw new Error('Invalid print page numbers');
    }

    return normalized
        .sort((left, right) => left - right)
        .map(pageNumber => requirePageNumber(pageNumber));
}

function normalizePdfPathPrintOptions(options?: IPdfPathPrintOptions): IPdfPathPrintOptions {
    const viewMode = options?.viewMode ?? 'single';
    const orientation = options?.orientation ?? 'auto';
    if (
        options?.requestId !== undefined
        && (typeof options.requestId !== 'string' || options.requestId.length === 0 || options.requestId.length > 128)
    ) {
        throw new Error('Invalid print request ID');
    }
    const pageNumbers = normalizePrintPageNumbers(options?.pageNumbers);
    return {
        viewMode,
        orientation,
        ...(pageNumbers ? {pageNumbers} : {}),
        ...(options?.requestId === undefined ? {} : {requestId: options.requestId}),
    };
}

function buildNativePathPrintOptions(
    stagedPageCount?: number,
): WebContentsPrintOptions {
    return stagedPageCount === undefined
        ? {}
        : {pageRanges: [{
            from: 0,
            to: stagedPageCount - 1,
        }]};
}

function getPdfPrintAborterKey(senderId: number | undefined, requestId: string) {
    return `${senderId ?? 'unscoped'}\0${requestId}`;
}

function abortPrintController(controller: AbortController, reason: string) {
    if (!controller.signal.aborted) {
        controller.abort(new Error(reason));
    }
}

function registerPdfPrintOperation(
    context: IDocumentsSenderIdContext,
    requestId: string | undefined,
    cancel?: (reason: string) => void,
) {
    const requestAbortController = new AbortController();
    const cancelOperation = (reason: string) => {
        abortPrintController(requestAbortController, reason);
        cancel?.(reason);
    };
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ...(context.senderId === undefined ? {} : {ownerWebContentsId: context.senderId}),
        cancel: cancelOperation,
    });
    const aborterKey = requestId === undefined
        ? null
        : getPdfPrintAborterKey(context.senderId, requestId);
    if (aborterKey !== null) {
        activePdfPrintAborters.set(aborterKey, cancelOperation);
    }
    return {
        signal: AbortSignal.any([
            mainOperation.signal,
            requestAbortController.signal,
        ]),
        complete: () => {
            if (aborterKey !== null && activePdfPrintAborters.get(aborterKey) === cancelOperation) {
                activePdfPrintAborters.delete(aborterKey);
            }
            mainOperation.complete();
        },
    };
}

export function handleCancelPdfPrint(
    context: IDocumentsSenderIdContext,
    requestId: string,
): Promise<{canceled: boolean}> {
    const abort = activePdfPrintAborters.get(getPdfPrintAborterKey(context.senderId, requestId));
    if (!abort) {
        return Promise.resolve({canceled: false});
    }
    abort('PDF print canceled');
    return Promise.resolve({canceled: true});
}

export async function handlePrintPdfData(
    context: IDocumentsWindowContext,
    data: Uint8Array,
    fileName?: string,
    options?: IPdfDataPrintOptions,
): Promise<IPrintPdfResult> {
    validatePdfBytesForHandoff(data, 'print');

    const ownerWindow = context.window ?? undefined;
    const tempFileName = `${PRINT_DATA_TEMP_PREFIX}${randomUUID()}-${normalizePrintableFileName(fileName)}`;
    const tempPath = join(getAppTempDir(), tempFileName);
    const requestId = options?.requestId;
    const operation = registerPdfPrintOperation(context, requestId);
    let shouldRetainTempPdf = false;

    try {
        operation.signal.throwIfAborted();
        await writeFile(tempPath, Buffer.from(data));
        operation.signal.throwIfAborted();
        const onNativeDialogOpened = requestId === undefined
            ? undefined
            : () => context.onNativePrintDialogOpened?.(requestId);
        const result = await openNativePrintDialogForPath(
            ownerWindow,
            tempPath,
            {},
            fileName,
            {
                ...(onNativeDialogOpened ? {onNativeDialogOpened} : {}),
                signal: operation.signal,
            },
        );
        if (result.success) {
            shouldRetainTempPdf = true;
            schedulePrintTempCleanup(tempPath);
        }
        return result;
    } finally {
        operation.complete();
        if (!shouldRetainTempPdf) {
            await cleanupPrintTempPath(tempPath);
        }
    }
}

export async function handleOpenPdfInDefaultAppData(
    data: Uint8Array,
    fileName?: string,
): Promise<IOpenPdfInDefaultAppResult> {
    validatePdfBytesForHandoff(data, 'PDF handoff');

    const tempFileName = `${DEFAULT_APP_TEMP_PREFIX}${randomUUID()}-${normalizePrintableFileName(fileName)}`;
    const tempPath = join(getAppTempDir(), tempFileName);
    try {
        await writeFile(tempPath, Buffer.from(data));
        const result = await openPdfInDefaultApp(tempPath);
        if (result.success) {
            scheduleDefaultAppTempCleanup(tempPath);
            return result;
        }

        await cleanupDefaultAppTempPath(tempPath);
        return result;
    } catch (error) {
        await cleanupDefaultAppTempPath(tempPath);
        throw error;
    }
}

export async function handleOpenPdfInDefaultAppPath(
    context: IDocumentsSenderIdContext,
    filePath: string,
    _fileName?: string,
): Promise<IOpenPdfInDefaultAppResult> {
    const resolvedPath = await resolveReadablePdfPathForSender(filePath, context.senderId);
    await assertPdfPathWithinSizeLimit(resolvedPath);
    return openPdfInDefaultApp(resolvedPath);
}

export async function handlePrintPdfPath(
    context: IDocumentsWindowContext,
    filePath: string,
    _fileName?: string,
    options?: IPdfPathPrintOptions,
): Promise<IPrintPdfResult> {
    const ownerWindow = context.window ?? undefined;
    const normalizedOptions = normalizePdfPathPrintOptions(options);
    const requestId = normalizedOptions.requestId;
    const onNativeDialogOpened = requestId === undefined
        ? undefined
        : () => context.onNativePrintDialogOpened?.(requestId);
    const normalizedPageNumbers = normalizedOptions.pageNumbers;
    const requiresLayoutComposition = normalizedOptions.viewMode !== 'single'
        || normalizedOptions.orientation !== 'auto';
    const operationId = randomUUID();
    const cancelGroup = `print-selected-pages:${operationId}`;
    const operation = registerPdfPrintOperation(
        context,
        requestId,
        normalizedPageNumbers && !requiresLayoutComposition
            ? () => cancelNativeCommandGroup(cancelGroup)
            : undefined,
    );
    let tempPath: string | null = null;
    let shouldRetainTempPdf = false;
    try {
        const resolvedPath = await resolveReadablePdfPathForSender(filePath, context.senderId, operation.signal);
        await assertPdfPathWithinSizeLimit(resolvedPath);
        operation.signal.throwIfAborted();
        if (requiresLayoutComposition) {
            const sourceStat = await stat(resolvedPath);
            if (sourceStat.size > PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES) {
                throw new Error('PDF is too large for advanced print layout');
            }
            tempPath = buildOpaquePrintTempPath(PRINT_LAYOUT_TEMP_PREFIX, operationId);
            await buildPrintablePdfPath({
                inputPath: resolvedPath,
                outputPath: tempPath,
                printOptions: normalizedOptions,
                signal: operation.signal,
            });
            operation.signal.throwIfAborted();
            await assertPdfPathWithinSizeLimit(tempPath);
            const result = await openNativePrintDialogForPath(
                ownerWindow,
                tempPath,
                {},
                _fileName,
                {
                    ...(onNativeDialogOpened ? {onNativeDialogOpened} : {}),
                    signal: operation.signal,
                },
            );
            if (result.success) {
                shouldRetainTempPdf = true;
                schedulePrintTempCleanup(tempPath);
            }
            return result;
        }
        if (!normalizedPageNumbers) {
            return await openNativePrintDialogForPath(
                ownerWindow,
                resolvedPath,
                buildNativePathPrintOptions(),
                _fileName,
                {
                    ...(onNativeDialogOpened ? {onNativeDialogOpened} : {}),
                    signal: operation.signal,
                },
            );
        }
        tempPath = buildOpaquePrintTempPath(PRINT_PAGE_TEMP_PREFIX, operationId);
        await extractPages(resolvedPath, tempPath, normalizedPageNumbers, {
            cancelGroup,
            signal: operation.signal,
        });
        const result = await openNativePrintDialogForPath(
            ownerWindow,
            tempPath,
            buildNativePathPrintOptions(normalizedPageNumbers.length),
            _fileName,
            {
                ...(onNativeDialogOpened ? {onNativeDialogOpened} : {}),
                signal: operation.signal,
            },
        );
        if (result.success) {
            shouldRetainTempPdf = true;
            schedulePrintTempCleanup(tempPath);
        }
        return result;
    } finally {
        operation.complete();
        if (!shouldRetainTempPdf && tempPath !== null) {
            await cleanupPrintTempPath(tempPath);
        }
    }
}
