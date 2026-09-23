import { getErrorMessage } from '@electron/utils/error';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';
import type { WebContents } from 'electron';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { estimateSizes } from '@electron/features/djvu/main/estimateSizes';
import {
    getDjvuHasText,
    getDjvuMetadata,
    getDjvuOutline,
    getDjvuPageCount,
    getDjvuResolution,
} from '@electron/features/djvu/main/metadata';
import { parseDjvuOutline } from '@electron/features/djvu/main/parseDjvuOutline';
import {
    awaitDurableDjvuConvertJob,
    awaitDurableDjvuOpenJob,
    handleDjvuCancel,
    handleDjvuPrintPath,
    startDurableDjvuConvertJob,
    startDurableDjvuOpenJob,
} from '@electron/features/djvu/main/pdfExport';
import { createLogger } from '@electron/utils/createLogger';
import {
    cleanupDjvuTempPdfPath,
    handleDjvuOpenForViewing,
    isAllowedDjvuViewingPath,
    releaseDjvuViewingPath,
} from '@electron/features/djvu/main/viewing';
import {
    getDjvuPageSizesForViewing,
    getDjvuPageSourceInfoForViewing,
    renderDjvuPagePreview,
} from '@electron/features/djvu/main/pagePreview';
import { isDjvuPath } from '@electron/image/pdfConversion';
import {
    requireOpenPath,
    type TOpenPath,
} from '@electron/file-access/openPathCapabilities';
import { normalizePossiblyEncodedExistingPath } from '@electron/utils/normalizePossiblyEncodedExistingPath';
import { getRecentFiles } from '@electron/recentFiles';
import type {IPlatformMainSenderContext} from '@contracts/platformFeature';
import { cancelConversion } from '@electron/features/djvu/main/ddjvuConversion';
import {
    readDjvuPageText,
    searchDjvuText,
} from '@electron/features/djvu/main/textSearch';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import { isAbortError } from '@electron/utils/abort';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import { pageIndexToPageNumber } from '@contracts/pageNumbers';
import type {
    IDjvuConvertOptions,
    IDjvuOutlineItem,
    IDjvuPagePreviewOptions,
    IDjvuPrintOptions,
    IDjvuTextSearchOptions,
    IDjvuTextSearchProgress,
} from '@contracts/electronApiDjvu';
import {
    createRequestId,
    parseRequestId,
    requireJobId,
    type TJobId,
    type TRequestId,
} from '@contracts/shared';
import { mainJobBroker } from '@electron/resources/jobBroker';
import { getHostResourceProfileSnapshot } from '@electron/resources/hostResourceProfile';

const logger = createLogger('djvu-operations');
export interface IDjvuOperationContext extends IPlatformMainSenderContext<WebContents> {}

interface IDjvuPreviewSenderState {
    latestGenerationsByDocument: Map<string, number>;
    latestRequestIds: Map<string, string>;
    reservedRequestIds: Set<string>;
    pendingRequests: Map<string, {
        abortController: AbortController;
        request: IDjvuPreviewRequest
    }>;
}

interface IDjvuPreviewRequest {
    documentKey: string;
    priority: number;
    requestId: TRequestId;
    requestKey: string;
}

const previewStateBySender = new Map<number, IDjvuPreviewSenderState>();
interface IActiveDjvuPreviewOperation {
    abortController: AbortController;
    cancelGroup: string;
    ownerWebContentsId: number;
    request: IDjvuPreviewRequest;
}

const activePreviewOperationsBySenderRequestKey = new Map<string, IActiveDjvuPreviewOperation>();
const activeEstimateOperationsById = new Map<string, {
    abortController: AbortController;
    documentKey: string;
    ownerWebContentsId: number;
}>();
interface IActiveDjvuTextSearchOperation {
    abortController: AbortController;
    ownerWebContentsId: number;
}

const activeTextSearchesBySenderRequestKey = new Map<string, IActiveDjvuTextSearchOperation>();

function sendDjvuTextSearchProgress(
    context: IDjvuOperationContext,
    progress: IDjvuTextSearchProgress,
) {
    if (context.sender.isDestroyed()) {
        return;
    }
    try {
        // Search progress belongs to the exact WebContents that invoked the
        // operation. BrowserWindow lookup is neither required nor reliable for
        // request-scoped events (for example, during isolated Electron E2E).
        context.sender.send(DJVU_PLATFORM_FEATURE.eventChannels.onTextSearchProgress, progress);
    } catch (error) {
        logger.debug(`Failed to send DjVu text search progress: ${String(error)}`);
    }
}
const previewSenderCleanupById = new Map<number, {stop: () => void}>();
const estimateSenderCleanupById = new Map<number, {stop: () => void}>();
function getPreviewState(senderId: number) {
    const existingState = previewStateBySender.get(senderId);
    if (existingState) {
        return existingState;
    }

    const state: IDjvuPreviewSenderState = {
        latestGenerationsByDocument: new Map(),
        latestRequestIds: new Map(),
        reservedRequestIds: new Set(),
        pendingRequests: new Map(),
    };
    previewStateBySender.set(senderId, state);
    return state;
}

function getPreviewRequestKey(djvuPath: string, pageNumber: number) {
    return `${djvuPath}\u0000${pageNumber}`;
}

function getActivePreviewOperationKey(ownerWebContentsId: number, requestId: string) {
    return `${ownerWebContentsId}\u0000${requestId}`;
}

function getActiveTextSearchKey(ownerWebContentsId: number, requestId: string) {
    return `${ownerWebContentsId}\u0000${requestId}`;
}

function parsePreviewRequestGeneration(requestId: string | undefined) {
    if (!requestId) {
        return null;
    }

    const generationText = requestId.match(/^(\d+):\d+:\d+$/u)?.[1];
    if (!generationText) {
        return null;
    }

    const generation = Number.parseInt(generationText, 10);
    return Number.isSafeInteger(generation) ? generation : null;
}

function createPreviewRequestId(requestId: unknown): TRequestId {
    const parsedRequestId = parseRequestId(requestId);
    return parsedRequestId ?? createRequestId('djvu-preview');
}

function normalizePreviewPriority(priority: number | undefined) {
    return typeof priority === 'number' && Number.isFinite(priority)
        ? priority
        : 0;
}

export function resolveDjvuPreviewBrokerPriority(priority: number) {
    if (priority >= 90) {
        return 'visible' as const;
    }
    if (priority >= 50) {
        return 'foreground' as const;
    }
    if (priority >= 20) {
        return 'user' as const;
    }
    return 'background' as const;
}

async function cancelPreviewOperation(ownerWebContentsId: number, requestId: string, reason: string) {
    const active = activePreviewOperationsBySenderRequestKey.get(
        getActivePreviewOperationKey(ownerWebContentsId, requestId),
    );
    if (!active) {
        return false;
    }
    if (!active.abortController.signal.aborted) {
        active.abortController.abort(new Error(reason));
    }
    await cancelConversion(active.cancelGroup);
    return true;
}

function cancelPreviewOperationsForSender(ownerWebContentsId: number, reason: string) {
    for (const active of activePreviewOperationsBySenderRequestKey.values()) {
        if (active.ownerWebContentsId === ownerWebContentsId) {
            void cancelPreviewOperation(ownerWebContentsId, active.request.requestId, reason);
        }
    }
}

function clearPreviewStateForSender(ownerWebContentsId: number) {
    const state = previewStateBySender.get(ownerWebContentsId);
    if (!state) {
        return;
    }
    state.latestGenerationsByDocument.clear();
    state.latestRequestIds.clear();
    state.reservedRequestIds.clear();
    for (const pending of state.pendingRequests.values()) {
        pending.abortController.abort(new Error('Renderer lifecycle ended'));
    }
    state.pendingRequests.clear();
    previewStateBySender.delete(ownerWebContentsId);
    mainJobBroker.cancelOwner(`djvu-preview:${ownerWebContentsId}`, 'Renderer lifecycle ended');
}

function unregisterPreviewSenderCleanupIfIdle(ownerWebContentsId: number) {
    for (const active of activePreviewOperationsBySenderRequestKey.values()) {
        if (active.ownerWebContentsId === ownerWebContentsId) {
            return;
        }
    }
    const cleanup = previewSenderCleanupById.get(ownerWebContentsId);
    if (!cleanup) {
        return;
    }
    cleanup.stop();
    previewSenderCleanupById.delete(ownerWebContentsId);
}

function registerPreviewSenderCleanup(sender: WebContents) {
    const ownerWebContentsId = sender.id;
    if (previewSenderCleanupById.has(ownerWebContentsId)) {
        return;
    }
    const cancel = (reason: string) => {
        clearPreviewStateForSender(ownerWebContentsId);
        cancelPreviewOperationsForSender(ownerWebContentsId, reason);
        unregisterPreviewSenderCleanupIfIdle(ownerWebContentsId);
    };
    const stop = onSenderLifetimeEnd(sender, (end) => {
        cancel(end === 'main-frame-navigation'
            ? 'Renderer navigation canceled DjVu preview operations'
            : 'Renderer lifecycle ended');
    }, {navigation: true});
    previewSenderCleanupById.set(ownerWebContentsId, {stop});
}

function cancelEstimateOperationsForSender(
    ownerWebContentsId: number,
    reason: string,
    exceptDocumentKey?: string,
) {
    for (const [
        operationId,
        active,
    ] of activeEstimateOperationsById.entries()) {
        if (active.ownerWebContentsId !== ownerWebContentsId) {
            continue;
        }
        if (exceptDocumentKey !== undefined && active.documentKey === exceptDocumentKey) {
            continue;
        }
        if (!active.abortController.signal.aborted) {
            active.abortController.abort(new Error(reason));
        }
        activeEstimateOperationsById.delete(operationId);
    }
}

function unregisterEstimateSenderCleanupIfIdle(ownerWebContentsId: number) {
    for (const active of activeEstimateOperationsById.values()) {
        if (active.ownerWebContentsId === ownerWebContentsId) {
            return;
        }
    }
    const cleanup = estimateSenderCleanupById.get(ownerWebContentsId);
    if (!cleanup) {
        return;
    }
    cleanup.stop();
    estimateSenderCleanupById.delete(ownerWebContentsId);
}

function registerEstimateSenderCleanup(sender: WebContents) {
    const ownerWebContentsId = sender.id;
    if (estimateSenderCleanupById.has(ownerWebContentsId)) {
        return;
    }
    const cancel = (reason: string) => {
        cancelEstimateOperationsForSender(ownerWebContentsId, reason);
        unregisterEstimateSenderCleanupIfIdle(ownerWebContentsId);
    };
    const stop = onSenderLifetimeEnd(sender, (end) => {
        cancel(end === 'main-frame-navigation'
            ? 'Renderer navigation canceled DjVu estimate operations'
            : 'Renderer lifecycle ended');
    }, {navigation: true});
    estimateSenderCleanupById.set(ownerWebContentsId, {stop});
}

function cancelSupersededActivePreviewOperations(state: IDjvuPreviewSenderState, ownerWebContentsId: number) {
    for (const active of activePreviewOperationsBySenderRequestKey.values()) {
        if (
            active.ownerWebContentsId === ownerWebContentsId
            && isPreviewRequestSuperseded(state, active.request)
        ) {
            void cancelPreviewOperation(
                ownerWebContentsId,
                active.request.requestId,
                'DjVu preview request superseded',
            );
        }
    }
}

function recordPreviewRequest(state: IDjvuPreviewSenderState, ownerWebContentsId: number, request: IDjvuPreviewRequest) {
    state.latestRequestIds.set(request.requestKey, request.requestId);

    const generation = parsePreviewRequestGeneration(request.requestId);
    if (generation !== null) {
        state.latestGenerationsByDocument.set(
            request.documentKey,
            Math.max(state.latestGenerationsByDocument.get(request.documentKey) ?? generation, generation),
        );
    }

    for (const [
        pendingRequestId,
        pending,
    ] of state.pendingRequests) {
        if (
            !state.reservedRequestIds.has(pendingRequestId)
            && pendingRequestId !== request.requestId
            && isPreviewRequestSuperseded(state, pending.request)
        ) {
            pending.abortController.abort(new Error('DjVu preview request superseded'));
            state.pendingRequests.delete(pendingRequestId);
        }
    }

    cancelSupersededActivePreviewOperations(state, ownerWebContentsId);
}

function isPreviewRequestSuperseded(state: IDjvuPreviewSenderState, request: IDjvuPreviewRequest) {
    if (state.latestRequestIds.get(request.requestKey) !== request.requestId) {
        return true;
    }

    const generation = parsePreviewRequestGeneration(request.requestId);
    return generation !== null
        && generation < (state.latestGenerationsByDocument.get(request.documentKey) ?? generation);
}

async function runCoalescedPreviewRequest<TResult>(
    sender: WebContents,
    documentKey: string,
    requestKey: string,
    requestId: TRequestId,
    priority: number,
    render: (
        operation: {
            cancelGroup: string;
            signal: AbortSignal;
        },
    ) => Promise<TResult>,
) {
    const senderId = sender.id;
    const maxInFlight = getHostResourceProfileSnapshot().tier === 'low' ? 1 : 2;
    const state = getPreviewState(senderId);
    const request: IDjvuPreviewRequest = {
        documentKey,
        priority,
        requestId,
        requestKey,
    };
    const hasImmediateReservation = state.reservedRequestIds.size < maxInFlight;
    if (hasImmediateReservation) {
        state.reservedRequestIds.add(requestId);
    }
    const abortController = new AbortController();
    state.pendingRequests.set(requestId, {
        abortController,
        request,
    });
    recordPreviewRequest(state, senderId, request);

    if (!hasImmediateReservation && isPreviewRequestSuperseded(state, request)) {
        throw new Error('DjVu preview request superseded');
    }

    const brokerLease = await mainJobBroker.acquire({
        ownerId: `djvu-preview:${senderId}`,
        kind: 'djvu-preview',
        priority: resolveDjvuPreviewBrokerPriority(priority),
        perOwnerLimit: maxInFlight,
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 64 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        signal: abortController.signal,
    }).catch((error: unknown) => {
        state.reservedRequestIds.delete(requestId);
        state.pendingRequests.delete(requestId);
        throw error;
    });
    state.pendingRequests.delete(requestId);
    try {
        if (sender.isDestroyed()) {
            throw new Error('DjVu preview operation canceled');
        }
        if (!hasImmediateReservation && isPreviewRequestSuperseded(state, request)) {
            throw new Error('DjVu preview request superseded');
        }
        const operationKey = getActivePreviewOperationKey(senderId, request.requestId);
        const cancelGroup = `djvu-preview:${senderId}:${request.requestId}`;
        const mainOperation = registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: senderId,
            workingCopyPath: documentKey,
            cancel: (reason) => {
                abortController.abort(new Error(reason));
                void cancelConversion(cancelGroup);
            },
        });
        registerPreviewSenderCleanup(sender);
        const activeOperation: IActiveDjvuPreviewOperation = {
            abortController,
            cancelGroup,
            ownerWebContentsId: senderId,
            request,
        };
        activePreviewOperationsBySenderRequestKey.set(operationKey, activeOperation);
        const abortMainOperation = () => {
            if (!abortController.signal.aborted) {
                abortController.abort(new Error('DjVu preview operation canceled'));
            }
            void cancelConversion(cancelGroup);
        };
        mainOperation.signal.addEventListener('abort', abortMainOperation, { once: true });
        try {
            return await render({
                cancelGroup,
                signal: abortController.signal,
            });
        } finally {
            mainOperation.signal.removeEventListener('abort', abortMainOperation);
            if (activePreviewOperationsBySenderRequestKey.get(operationKey) === activeOperation) {
                activePreviewOperationsBySenderRequestKey.delete(operationKey);
            }
            mainOperation.complete();
        }
    } finally {
        brokerLease.release();
        state.reservedRequestIds.delete(requestId);
        state.pendingRequests.delete(requestId);
        if (state.latestRequestIds.get(requestKey) === requestId) {
            state.latestRequestIds.delete(requestKey);
        }
        if (state.latestRequestIds.size === 0 && state.reservedRequestIds.size === 0) {
            previewStateBySender.delete(senderId);
        }
        unregisterPreviewSenderCleanupIfIdle(senderId);
    }
}

function requireDjvuOpenPath(
    path: unknown,
    owner?: WebContents,
    options: { requireExists?: boolean } = {},
): TOpenPath {
    const rawPath = typeof path === 'string' ? path.trim() : '';
    const normalizedPath = rawPath
        ? (normalizePossiblyEncodedExistingPath(rawPath) ?? rawPath)
        : '';
    if (!normalizedPath) {
        throw new Error('Invalid DjVu path');
    }
    if (!isDjvuPath(normalizedPath)) {
        throw new Error('Invalid DjVu file type');
    }
    if (options.requireExists !== false && !existsSync(normalizedPath)) {
        throw new Error(`DjVu file not found: ${normalizedPath}`);
    }
    return requireOpenPath(normalizedPath, owner);
}

/**
 * Opening-frame prewarm is intentionally read-only and runs before a Recent
 * item is clicked, so it must not grant the renderer general file access or an
 * active viewing lease. Accept only a canonical path already present in the
 * application's persisted Recent list; all render operations continue to use
 * `requireDjvuOpenPath` plus `isAllowedDjvuViewingPath`.
 */
async function requireDjvuPageSourceInfoPath(path: unknown, owner: WebContents) {
    try {
        return requireDjvuOpenPath(path, owner);
    } catch (error) {
        const rawPath = typeof path === 'string' ? path.trim() : '';
        const normalizedPath = rawPath
            ? normalizePossiblyEncodedExistingPath(rawPath)
            : null;
        if (!normalizedPath || !isDjvuPath(normalizedPath)) {
            throw error;
        }
        const recentFiles = await getRecentFiles();
        const isPersistedRecent = recentFiles.some(file => (
            normalizePossiblyEncodedExistingPath(String(file.originalPath)) === normalizedPath
        ));
        if (!isPersistedRecent) {
            throw error;
        }
        return normalizedPath as TOpenPath;
    }
}

function normalizeDjvuReleasePath(path: unknown, owner?: WebContents) {
    const normalizedPath = typeof path === 'string' ? path.trim() : '';
    if (!normalizedPath) {
        throw new Error('Invalid DjVu path');
    }
    if (!isDjvuPath(normalizedPath)) {
        throw new Error('Invalid DjVu file type');
    }
    try {
        return requireOpenPath(normalizedPath, owner);
    } catch {
        // The file may have been moved after opening; fall back to the renderer-held path for cleanup.
    }
    return resolve(normalizedPath);
}

export function handleDjvuStartOpenForViewingOperation(
    context: IDjvuOperationContext,
    djvuPath: string,
    requestId: TRequestId,
) {
    const path = requireDjvuOpenPath(djvuPath, context.sender);
    const jobId = requireJobId(`djvu-open-${context.senderId}-${requestId}`);
    startDurableDjvuOpenJob(
        context,
        jobId,
        path,
        signal => handleDjvuOpenForViewing(context, path, signal, false),
    );
    return Promise.resolve({
        jobId,
        requestId,
    });
}

export function handleDjvuAwaitOpenJobOperation(context: IDjvuOperationContext, jobId: TJobId) {
    return awaitDurableDjvuOpenJob(context, jobId);
}

export function handleDjvuReleaseViewingPath(
    context: IDjvuOperationContext,
    djvuPath: string,
) {
    releaseDjvuViewingPath(
        context,
        normalizeDjvuReleasePath(djvuPath, context.sender),
    );
}

export function handleDjvuStartConvertToPdfOperation(
    context: IDjvuOperationContext,
    djvuPath: string,
    outputPath: string,
    options: IDjvuConvertOptions,
) {
    const requestId = options.requestId!;
    const jobId = requireJobId(`djvu-convert-${context.senderId}-${requestId}`);
    const path = requireDjvuOpenPath(djvuPath, context.sender);
    startDurableDjvuConvertJob(
        context,
        path,
        outputPath,
        {
            ...options,
            jobId,
        },
    );
    return Promise.resolve({
        jobId,
        requestId,
    });
}

export function handleDjvuAwaitConvertJobOperation(context: IDjvuOperationContext, jobId: TJobId) {
    return awaitDurableDjvuConvertJob(context, jobId);
}

export function handleDjvuPrintPathOperation(
    context: IDjvuOperationContext,
    djvuPath: string,
    options: IDjvuPrintOptions,
) {
    return handleDjvuPrintPath(
        context,
        requireDjvuOpenPath(djvuPath, context.sender),
        options,
    );
}

export async function handleDjvuCancelOperation(
    context: IDjvuOperationContext,
    jobId: TJobId,
) {
    return handleDjvuCancel(context, jobId);
}

export async function handleDjvuCancelPagePreview(
    context: IDjvuOperationContext,
    requestId: TRequestId,
) {
    const pending = previewStateBySender.get(context.senderId)?.pendingRequests.get(requestId);
    if (pending && !pending.abortController.signal.aborted) {
        pending.abortController.abort(new Error('DjVu preview request canceled'));
        return {canceled: true};
    }

    const active = activePreviewOperationsBySenderRequestKey.get(
        getActivePreviewOperationKey(context.senderId, requestId),
    );
    if (!active) {
        return { canceled: false };
    }
    const canceled = await cancelPreviewOperation(
        context.senderId,
        requestId,
        'DjVu preview request canceled',
    );
    return { canceled };
}

export async function handleDjvuSearchText(
    context: IDjvuOperationContext,
    djvuPath: string,
    query: string,
    options: IDjvuTextSearchOptions,
) {
    const requestId = options.requestId;
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    const operationKey = getActiveTextSearchKey(context.senderId, requestId);
    const previous = activeTextSearchesBySenderRequestKey.get(operationKey);
    previous?.abortController.abort(new Error('DjVu text search superseded'));
    const abortController = new AbortController();
    const activeOperation: IActiveDjvuTextSearchOperation = {
        abortController,
        ownerWebContentsId: context.senderId,
    };
    activeTextSearchesBySenderRequestKey.set(operationKey, activeOperation);
    let lastProcessedPage = 0;
    const isCurrentGeneration = () => (
        activeTextSearchesBySenderRequestKey.get(operationKey) === activeOperation
    );
    const canceledResponse = () => ({
        results: [],
        truncated: false,
        canceled: true,
    });
    const emitCanceledProgress = () => {
        sendDjvuTextSearchProgress(context, {
            requestId,
            processed: lastProcessedPage,
            total: options.pageCount,
            status: 'canceled',
            canceled: true,
        });
    };
    const stopSenderLifetime = onSenderLifetimeEnd(context.sender, () => {
        abortController.abort(new Error('Renderer lifecycle ended'));
    });

    try {
        const response = await searchDjvuText(normalizedDjvuPath, {
            requestId,
            pageCount: options.pageCount,
            query,
            matchOptions: {
                matchCase: Boolean(options.matchCase),
                wholeWord: Boolean(options.wholeWord),
                useRegex: Boolean(options.useRegex),
            },
            signal: abortController.signal,
            onPageProcessed(processed) {
                if (!isCurrentGeneration()) {
                    return;
                }
                lastProcessedPage = Math.max(lastProcessedPage, processed);
            },
            onProgress(progress) {
                if (!isCurrentGeneration()) {
                    return;
                }
                lastProcessedPage = Math.max(lastProcessedPage, progress.processed);
                sendDjvuTextSearchProgress(context, progress);
            },
        });
        if (!isCurrentGeneration()) {
            return canceledResponse();
        }
        if (abortController.signal.aborted) {
            emitCanceledProgress();
            return canceledResponse();
        }
        sendDjvuTextSearchProgress(context, {
            requestId,
            processed: lastProcessedPage,
            total: options.pageCount,
            status: 'success',
            truncated: response.truncated,
        });
        return response;
    } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) {
            if (isCurrentGeneration()) {
                emitCanceledProgress();
            }
            return canceledResponse();
        }
        if (!isCurrentGeneration()) {
            return canceledResponse();
        }
        sendDjvuTextSearchProgress(context, {
            requestId,
            processed: lastProcessedPage,
            total: options.pageCount,
            status: 'failed',
            error: getErrorMessage(error),
        });
        throw error;
    } finally {
        if (isCurrentGeneration()) {
            activeTextSearchesBySenderRequestKey.delete(operationKey);
        }
        stopSenderLifetime();
    }
}

export function handleDjvuCancelTextSearch(
    context: IDjvuOperationContext,
    requestId: TRequestId,
) {
    const operation = activeTextSearchesBySenderRequestKey.get(
        getActiveTextSearchKey(context.senderId, requestId),
    );
    if (!operation || operation.abortController.signal.aborted) {
        return Promise.resolve({canceled: false});
    }
    operation.abortController.abort(new Error('DjVu text search canceled'));
    return Promise.resolve({canceled: true});
}

export async function handleDjvuGetInfo(
    context: IDjvuOperationContext,
    djvuPath: string,
): Promise<{
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    hasText: boolean;
    metadata: Record<string, string>;
}> {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    const [
        pageCount,
        sourceDpi,
        outlineSexp,
        hasText,
        metadata,
    ] = await Promise.all([
        getDjvuPageCount(normalizedDjvuPath),
        getDjvuResolution(normalizedDjvuPath),
        getDjvuOutline(normalizedDjvuPath),
        getDjvuHasText(normalizedDjvuPath),
        getDjvuMetadata(normalizedDjvuPath),
    ]);

    const bookmarks = parseDjvuOutline(outlineSexp);

    return {
        pageCount,
        sourceDpi,
        hasBookmarks: bookmarks.length > 0,
        hasText,
        metadata,
    };
}

export async function handleDjvuEstimateSizes(
    context: IDjvuOperationContext,
    djvuPath: string,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    cancelEstimateOperationsForSender(
        context.senderId,
        'DjVu estimate request superseded',
        normalizedDjvuPath,
    );

    const abortController = new AbortController();
    const operationId = `djvu-estimate-${randomUUID()}`;
    const mainOperation = registerMainOperation({
        kind: 'abortable-work',
        ownerWebContentsId: context.senderId,
        workingCopyPath: normalizedDjvuPath,
        cancel: (reason) => {
            if (!abortController.signal.aborted) {
                abortController.abort(new Error(reason));
            }
        },
    });
    const abortMainOperation = () => {
        if (!abortController.signal.aborted) {
            abortController.abort(new Error('DjVu estimate operation canceled'));
        }
    };

    activeEstimateOperationsById.set(operationId, {
        abortController,
        documentKey: normalizedDjvuPath,
        ownerWebContentsId: context.senderId,
    });
    registerEstimateSenderCleanup(context.sender);
    mainOperation.signal.addEventListener('abort', abortMainOperation, { once: true });
    try {
        const pageCount = await getDjvuPageCount(normalizedDjvuPath, { signal: abortController.signal });
        return await estimateSizes(normalizedDjvuPath, pageCount, { signal: abortController.signal });
    } finally {
        mainOperation.signal.removeEventListener('abort', abortMainOperation);
        activeEstimateOperationsById.delete(operationId);
        unregisterEstimateSenderCleanupIfIdle(context.senderId);
        mainOperation.complete();
    }
}

export async function handleDjvuGetPageSizes(
    context: IDjvuOperationContext,
    djvuPath: string,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    if (!isAllowedDjvuViewingPath(normalizedDjvuPath, context.senderId)) {
        throw new Error('DjVu viewing path is not active');
    }
    const pageCount = await getDjvuPageCount(normalizedDjvuPath);
    return getDjvuPageSizesForViewing(normalizedDjvuPath, pageCount);
}

export async function handleDjvuGetPageText(
    context: IDjvuOperationContext,
    djvuPath: string,
    pageNumber: number,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    if (!isAllowedDjvuViewingPath(normalizedDjvuPath, context.senderId)) {
        throw new Error('DjVu viewing path is not active');
    }
    return readDjvuPageText(normalizedDjvuPath, pageNumber);
}

function mapDjvuOutlineItem(item: IPdfBookmarkEntry): IDjvuOutlineItem {
    return {
        title: item.title,
        pageNumber: item.pageIndex === null ? null : pageIndexToPageNumber(item.pageIndex),
        children: item.items.map(mapDjvuOutlineItem),
    };
}

export async function handleDjvuGetOutline(
    context: IDjvuOperationContext,
    djvuPath: string,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    if (!isAllowedDjvuViewingPath(normalizedDjvuPath, context.senderId)) {
        throw new Error('DjVu viewing path is not active');
    }
    return parseDjvuOutline(
        await getDjvuOutline(normalizedDjvuPath),
    ).map(mapDjvuOutlineItem);
}

export async function handleDjvuGetPageSourceInfo(
    context: IDjvuOperationContext,
    djvuPath: string,
    pageNumber: number,
) {
    const normalizedDjvuPath = await requireDjvuPageSourceInfoPath(djvuPath, context.sender);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        throw new Error(`Invalid DjVu page number: ${pageNumber}`);
    }
    return getDjvuPageSourceInfoForViewing(normalizedDjvuPath, pageNumber);
}

export async function handleDjvuRenderPagePreview(
    context: IDjvuOperationContext,
    djvuPath: string,
    pageNumber: number,
    options?: IDjvuPagePreviewOptions,
) {
    const normalizedDjvuPath = requireDjvuOpenPath(djvuPath, context.sender);
    if (!isAllowedDjvuViewingPath(normalizedDjvuPath, context.senderId)) {
        throw new Error('DjVu viewing path is not active');
    }
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error(`Invalid DjVu page number: ${pageNumber}`);
    }
    const previewRequestId = createPreviewRequestId(options?.previewRequestId);
    return runCoalescedPreviewRequest(
        context.sender,
        normalizedDjvuPath,
        getPreviewRequestKey(normalizedDjvuPath, pageNumber),
        previewRequestId,
        normalizePreviewPriority(options?.previewPriority),
        operation => renderDjvuPagePreview(normalizedDjvuPath, pageNumber, {
            ...options,
            previewRequestId,
        }, operation),
    );
}

export async function handleDjvuCleanupTemp(
    _context: IDjvuOperationContext,
    tempPdfPath: string,
) {
    if (!tempPdfPath) {
        return;
    }

    try {
        await cleanupDjvuTempPdfPath(tempPdfPath);
    } catch (error) {
        logger.warn(`Failed to cleanup temporary DjVu PDF: ${String(error)}`);
    }
}
