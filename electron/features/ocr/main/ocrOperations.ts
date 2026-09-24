import type { WebContents } from 'electron';
import { extname } from 'path';
import type {
    IOcrCancelResult,
    IOcrJobStartResult,
} from '@contracts/electronApiOcr';
import {
    createJobId,
    parseJobId,
    requireJobId,
} from '@contracts/shared';
import type { IPlatformMainSenderContext } from '@contracts/platformFeature';
import {AVAILABLE_OCR_LANGUAGES} from '@electron/features/ocr/availableLanguages';
import {
    buildOcrErrorEnvelope,
    OcrPayloadValidationError,
    toOcrErrorEnvelope,
    validateCancelRequestId,
    validateCreateSearchablePdfPayload,
} from '@electron/features/ocr/contracts';
import {
    handleOcrAcknowledgeResultFile,
    handleOcrCancel,
    handleOcrCreateSearchablePdfAsync,
} from '@electron/features/ocr/main/jobManager';
import { createLogger } from '@electron/utils/createLogger';
import {
    readDocumentTextSnapshot,
    readDocumentTextWindow,
} from '@electron/features/ocr/main/documentText';
import { getOcrLanguageModelStates } from '@electron/features/ocr/languageModels';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} from '@electron/utils/pathValidator';
import {requireManagedWorkingCopyPath} from '@electron/file-access/workingCopyCreation';
import {getWorkingCopyBackingEntry} from '@electron/file-access/workingCopyStore';
import {registerMainOperation} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {runWithWorkingCopyReadBacking} from '@electron/file-access/runWithWorkingCopyReadBacking';
import {
    ensureWorkingCopyMaterialized,
    WorkingCopyMaterializationError,
} from '@electron/file-access/workingCopyMaterialization';
import { getErrorMessage } from '@electron/utils/error';

const log = createLogger('ocr-ipc');
type TOcrOperationContext = IPlatformMainSenderContext<WebContents>;

interface ITextReadRequest {
    senderId: number;
    requestId: string;
    controller: AbortController;
}

const activeTextReadRequests = new Map<string, ITextReadRequest>();

function getTextReadRequestKey(senderId: number, requestId: string) {
    return `${senderId}:${requestId}`;
}

function beginTextReadRequest(
    context: TOcrOperationContext,
    requestId: string | undefined,
) {
    if (requestId === undefined) {
        return undefined;
    }
    const request: ITextReadRequest = {
        senderId: context.senderId,
        requestId,
        controller: new AbortController(),
    };
    const key = getTextReadRequestKey(context.senderId, requestId);
    if (activeTextReadRequests.has(key)) {
        throw new Error(`Document text request is already active: ${requestId}`);
    }
    activeTextReadRequests.set(key, request);
    return request;
}

function finishTextReadRequest(request: ITextReadRequest | undefined) {
    if (request) {
        activeTextReadRequests.delete(getTextReadRequestKey(request.senderId, request.requestId));
    }
}

function cancelTextReadRequest(senderId: number, requestId: string) {
    const request = activeTextReadRequests.get(getTextReadRequestKey(senderId, requestId));
    if (!request) {
        return false;
    }
    if (!request.controller.signal.aborted) {
        request.controller.abort(new DOMException('Document text read was canceled.', 'AbortError'));
    }
    return true;
}

function combineAbortSignals(
    operationSignal: AbortSignal,
    requestSignal: AbortSignal | undefined,
) {
    if (!requestSignal) {
        return {
            signal: operationSignal,
            dispose: () => undefined,
        };
    }

    const controller = new AbortController();
    const forwardAbort = (signal: AbortSignal) => {
        if (!controller.signal.aborted) {
            controller.abort(signal.reason);
        }
    };
    const operationAbort = () => forwardAbort(operationSignal);
    const requestAbort = () => forwardAbort(requestSignal);
    operationSignal.addEventListener('abort', operationAbort, {once: true});
    requestSignal.addEventListener('abort', requestAbort, {once: true});
    if (operationSignal.aborted) {
        forwardAbort(operationSignal);
    } else if (requestSignal.aborted) {
        forwardAbort(requestSignal);
    }

    return {
        signal: controller.signal,
        dispose: () => {
            operationSignal.removeEventListener('abort', operationAbort);
            requestSignal.removeEventListener('abort', requestAbort);
        },
    };
}

export async function handleOcrGetLanguages() {
    const modelStates = new Map(
        (await getOcrLanguageModelStates()).map(item => [
            item.code,
            item.state,
        ]),
    );
    return AVAILABLE_OCR_LANGUAGES.map(language => ({
        ...language,
        modelState: modelStates.get(language.code) ?? 'missing',
    }));
}

export async function handleResolveDocumentTextCatalog(
    context: TOcrOperationContext,
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    pageCount?: number,
    requestId?: string,
) {
    const request = beginTextReadRequest(context, requestId);
    try {
        const logicalPath = await validateOcrSourcePdfPath(workingCopyPath, context.senderId);
        request?.controller.signal.throwIfAborted();
        return await runCancellableTextRead(
            context,
            logicalPath,
            signal => runWithWorkingCopyReadBacking(
                logicalPath,
                physicalPath => readDocumentTextSnapshot(logicalPath, physicalPath, documentRevision, pageCount, signal),
                {ownerWebContentsId: context.senderId},
            ),
            request,
        );
    } finally {
        finishTextReadRequest(request);
    }
}

export async function handleResolveDocumentTextCatalogWindow(
    context: TOcrOperationContext,
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
    firstPage: number,
    lastPage: number,
    pageCount?: number,
    requestId?: string,
) {
    const request = beginTextReadRequest(context, requestId);
    try {
        const logicalPath = await validateOcrSourcePdfPath(workingCopyPath, context.senderId);
        request?.controller.signal.throwIfAborted();
        return await runCancellableTextRead(
            context,
            logicalPath,
            signal => runWithWorkingCopyReadBacking(
                logicalPath,
                physicalPath => readDocumentTextWindow(
                    logicalPath,
                    physicalPath,
                    documentRevision,
                    {
                        firstPage,
                        lastPage,
                        pageCount,
                    },
                    signal,
                ),
                {ownerWebContentsId: context.senderId},
            ),
            request,
        );
    } finally {
        finishTextReadRequest(request);
    }
}

// Desktop OCR writes its text into the PDF, where the viewer's own text layer
// reads it, so no page carries separate OCR text.
export async function handleResolveDocumentOcrAvailability(
    context: TOcrOperationContext,
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
) {
    await validateOcrSourcePdfPath(workingCopyPath, context.senderId);
    return {
        documentRevision,
        pageCount: 0,
        mappedPageCount: 0,
        pageRanges: [],
        rangesComplete: true,
    };
}

export async function handleResolveDocumentOcrPage(
    context: TOcrOperationContext,
    workingCopyPath: string,
    documentRevision: TDocumentRevisionToken,
) {
    await validateOcrSourcePdfPath(workingCopyPath, context.senderId);
    return {
        documentRevision,
        pageCount: 0,
        page: null,
    };
}

// Text reads join the main operation lifecycle so a working-copy close or
// shutdown aborts them instead of racing the file deletion. The signal carries
// the cancellation; the hook only makes the read eligible for close cancellation.
async function runCancellableTextRead<T>(
    context: TOcrOperationContext,
    logicalPath: string,
    read: (signal: AbortSignal) => Promise<T>,
    request?: ITextReadRequest,
) {
    const operation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: logicalPath,
        cancel: reason => log.debug(`Document text read cancelled: ${reason}`),
    });
    const combinedSignal = combineAbortSignals(operation.signal, request?.controller.signal);
    try {
        return await read(combinedSignal.signal);
    } finally {
        combinedSignal.dispose();
        operation.complete();
    }
}

async function validateOcrSourcePdfPath(sourcePdfPath: string, senderWebContentsId: number) {
    let managedSourcePdfPath: string;
    try {
        managedSourcePdfPath = await requireManagedWorkingCopyPath(sourcePdfPath, senderWebContentsId);
    } catch (error) {
        throw new OcrPayloadValidationError(`sourcePdfPath is not a managed working copy: ${getErrorMessage(error)}`);
    }
    const backingEntry = getWorkingCopyBackingEntry(managedSourcePdfPath, senderWebContentsId);
    const isLazyBacking = backingEntry?.backingState === 'lazy-original'
        || backingEntry?.backingState === 'materializing';
    const allowedLogicalPath = isLazyBacking
        ? await resolveAllowedWritePath(managedSourcePdfPath)
        : await resolveAllowedReadPath(managedSourcePdfPath);
    if (!allowedLogicalPath) {
        throw new OcrPayloadValidationError('sourcePdfPath must be inside the temporary working directory');
    }

    if (extname(managedSourcePdfPath).toLowerCase() !== '.pdf') {
        throw new OcrPayloadValidationError('sourcePdfPath must point to a PDF file');
    }

    return managedSourcePdfPath;
}

async function validateOcrPersistenceSourcePdfPath(sourcePdfPath: string, senderWebContentsId: number) {
    let materializedSourcePdfPath: string;
    try {
        materializedSourcePdfPath = (
            await ensureWorkingCopyMaterialized(sourcePdfPath, {
                ownerWebContentsId: senderWebContentsId,
                reason: 'ocr-persist',
            })
        ).physicalWorkingCopyPath;
    } catch (error) {
        if (error instanceof WorkingCopyMaterializationError) {
            throw error;
        }
        throw new OcrPayloadValidationError(`sourcePdfPath is not a managed working copy: ${getErrorMessage(error)}`);
    }
    return validateOcrSourcePdfPath(materializedSourcePdfPath, senderWebContentsId);
}

export async function handleOcrCreateSearchablePdf(
    context: TOcrOperationContext,
    sourcePdfPathPayload: unknown,
    pagesPayload: unknown,
    requestIdPayload: unknown,
    renderDpiOrOptionsPayload?: unknown,
): Promise<IOcrJobStartResult> {
    let jobId = parseJobId(requestIdPayload) ?? createJobId('ocr');

    try {
        const payload = validateCreateSearchablePdfPayload(
            sourcePdfPathPayload,
            pagesPayload,
            requestIdPayload,
            renderDpiOrOptionsPayload,
        );

        jobId = requireJobId(payload.requestId);
        const validatedSourcePdfPath = await validateOcrPersistenceSourcePdfPath(
            payload.sourcePdfPath,
            context.senderId,
        );
        const result = await handleOcrCreateSearchablePdfAsync(
            context,
            validatedSourcePdfPath,
            payload.pages,
            payload.requestId,
            payload.options,
        );

        if (!result.started && result.error) {
            const {
                errorCode,
                ...publicResult
            } = result;
            return {
                ...publicResult,
                errorEnvelope: buildOcrErrorEnvelope(
                    errorCode ?? 'OCR_INTERNAL_ERROR',
                    result.error,
                    {retryable: true},
                ),
            };
        }

        return result;
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error, 'OCR_INTERNAL_ERROR', true);
        log.warn(`ocr:createSearchablePdf rejected: ${envelope.message}`);
        return {
            started: false,
            jobId,
            error: envelope.message,
            errorEnvelope: envelope,
        };
    }
}

export function handleOcrCancelValidated(
    context: TOcrOperationContext,
    requestIdPayload: unknown,
): IOcrCancelResult {
    try {
        const requestId = validateCancelRequestId(requestIdPayload);
        const textReadCanceled = cancelTextReadRequest(context.senderId, requestId);
        const jobResult = handleOcrCancel(context, requestId);
        return textReadCanceled && !jobResult.canceled
            ? {canceled: true}
            : jobResult;
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error);
        log.warn(`ocr:cancel rejected: ${envelope.message}`);
        return {
            canceled: false,
            reason: 'invalid-request',
            error: envelope.message,
            errorEnvelope: envelope,
        };
    }
}

export async function handleOcrAcknowledgeResultFileValidated(
    context: TOcrOperationContext,
    requestIdPayload: unknown,
    pdfPathPayload?: unknown,
    documentRefPayload?: unknown,
    sourceDocumentRevisionTokenPayload?: unknown,
) {
    try {
        return await handleOcrAcknowledgeResultFile(
            context,
            requestIdPayload,
            pdfPathPayload,
            documentRefPayload,
            sourceDocumentRevisionTokenPayload,
        );
    } catch (error) {
        const envelope = toOcrErrorEnvelope(error);
        log.warn(`ocr:ackResultFile rejected: ${envelope.message}`);
        return {
            cleaned: false,
            error: envelope.message,
            errorEnvelope: envelope,
        };
    }
}
