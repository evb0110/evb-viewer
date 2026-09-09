import { app } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import type { ISearchResponse } from '@electron/features/search/protocol';
import type {
    INormalizedPdfSearchRequest,
    INormalizedPdfSearchWarmIndexRequest,
} from '@electron/features/search/searchRequestPayload';
import {findWorkingCopyPathByOriginalPath} from '@electron/file-access/workingCopyStore';
import { getWorkingCopyRevision } from '@electron/file-access/documentRevisionStore';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import {
    registerMainOperation,
    type IRegisteredMainOperation,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import {
    SearchWorkerService,
    getSearchPdfPathKey,
    type ISearchOperationContext,
    type ISearchSenderContext,
} from '@electron/features/search/main/searchWorkerService';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import { resolveUnpackedWorkerPath } from '@electron/utils/workerTask';
import {
    buildSearchErrorEnvelope,
    SearchIpcError,
} from '@electron/features/search/main/searchErrors';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import {
    createRequestId,
    type TRequestId,
} from '@contracts/shared';
import type { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { createLogger } from '@electron/utils/createLogger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function isWorkingCopyPathCandidate(pdfPath: string) {
    return /(?:^|[/\\])pdf-work-[^/\\]+[/\\]/u.test(pdfPath);
}

export function resolveSearchWorkerPath(workerBaseDir = __dirname) {
    const defaultPath = join(workerBaseDir, WORKER_BUNDLES_BY_ID.search.fileName);
    if (!app.isPackaged) {
        return defaultPath;
    }
    return resolveUnpackedWorkerPath(workerBaseDir, WORKER_BUNDLES_BY_ID.search.fileName);
}

export async function resolveSearchablePdfPath(pdfPath: string, senderWebContentsId?: number) {
    if (isWorkingCopyPathCandidate(pdfPath)) {
        const directResolvedPath = await resolveAllowedReadPath(pdfPath);
        if (directResolvedPath) {
            return directResolvedPath;
        }
    }

    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(pdfPath, senderWebContentsId);
    if (mappedWorkingCopyPath) {
        const mappedResolvedPath = await resolveAllowedReadPath(mappedWorkingCopyPath);
        if (mappedResolvedPath) {
            return mappedResolvedPath;
        }
    }

    const directResolvedPath = await resolveAllowedReadPath(pdfPath);
    if (directResolvedPath) {
        return directResolvedPath;
    }

    return null;
}

const log = createLogger('search-ipc');
let activeSearchWorkerService: SearchWorkerService | null = null;

interface ISearchRequestAdmission {
    readonly signal: AbortSignal;
    addWorkingCopyPath: (workingCopyPath: string) => void;
    cancel: (reason: string) => void;
    complete: () => void;
    isCanceled: () => boolean;
    matchesWorkingCopyPath: (workingCopyPath: string) => boolean;
    getSignals: () => readonly AbortSignal[];
}

interface ISearchAdmissionOperation {
    operation: IRegisteredMainOperation;
    workingCopyPath?: string;
}

const pendingSearchRequestAdmissions = new Map<string, Set<ISearchRequestAdmission>>();

function getSearchRequestAdmissionKey(senderId: number, requestId: string) {
    return `${senderId}\0${requestId}`;
}

function getKnownSearchWorkingCopyPath(pdfPath: string, senderId: number) {
    if (isWorkingCopyPathCandidate(pdfPath)) {
        return pdfPath;
    }
    return findWorkingCopyPathByOriginalPath(pdfPath, senderId);
}

function pathsMatch(left: string, right: string) {
    return getSearchPdfPathKey(left) === getSearchPdfPathKey(right);
}

function createSearchRequestAdmission(
    pdfPath: string,
    senderId: number,
    requestId: string,
): ISearchRequestAdmission {
    const controller = new AbortController();
    const operations = new Set<ISearchAdmissionOperation>();
    const key = getSearchRequestAdmissionKey(senderId, requestId);
    let completed = false;

    const cancel = (reason: string) => {
        if (!controller.signal.aborted) {
            controller.abort(new Error(reason));
        }
    };
    const admission: ISearchRequestAdmission = {
        signal: controller.signal,
        addWorkingCopyPath: (workingCopyPath: string) => {
            if (completed || [...operations].some(operation => (
                operation.workingCopyPath !== undefined
                && pathsMatch(operation.workingCopyPath, workingCopyPath)
            ))) {
                return;
            }
            const operation = registerMainOperation({
                kind: 'abortable-work',
                ownerWebContentsId: senderId,
                workingCopyPath,
                cancel,
            });
            operations.add({
                operation,
                workingCopyPath,
            });
        },
        cancel,
        complete: () => {
            if (completed) {
                return;
            }
            completed = true;
            const pending = pendingSearchRequestAdmissions.get(key);
            pending?.delete(admission);
            if (pending?.size === 0) {
                pendingSearchRequestAdmissions.delete(key);
            }
            for (const {operation} of operations) {
                operation.complete();
            }
            operations.clear();
        },
        isCanceled: () => controller.signal.aborted || [...operations].some(({operation}) => operation.signal.aborted),
        matchesWorkingCopyPath: (workingCopyPath: string) => [...operations].some(operation => (
            operation.workingCopyPath !== undefined
            && pathsMatch(operation.workingCopyPath, workingCopyPath)
        )),
        getSignals: () => [
            controller.signal,
            ...[...operations].map(({operation}) => operation.signal),
        ],
    };

    try {
        operations.add({operation: registerMainOperation({
            kind: 'abortable-work',
            ownerWebContentsId: senderId,
            cancel,
        })});
        const knownWorkingCopyPath = getKnownSearchWorkingCopyPath(pdfPath, senderId);
        if (knownWorkingCopyPath) {
            admission.addWorkingCopyPath(knownWorkingCopyPath);
        }
    } catch (error) {
        admission.complete();
        throw error;
    }

    const pending = pendingSearchRequestAdmissions.get(key) ?? new Set<ISearchRequestAdmission>();
    pending.add(admission);
    pendingSearchRequestAdmissions.set(key, pending);
    return admission;
}

function cancelPendingSearchRequests(senderId: number, requestId: string, reason: string) {
    const pending = pendingSearchRequestAdmissions.get(getSearchRequestAdmissionKey(senderId, requestId));
    if (!pending || pending.size === 0) {
        return false;
    }
    for (const admission of pending) {
        admission.cancel(reason);
    }
    return true;
}

function cancelPendingSearchRequestsForSender(senderId: number, reason: string) {
    const keyPrefix = `${senderId}\0`;
    let canceled = false;
    for (const [
        key,
        pending,
    ] of pendingSearchRequestAdmissions) {
        if (!key.startsWith(keyPrefix)) {
            continue;
        }
        for (const admission of pending) {
            admission.cancel(reason);
            canceled = true;
        }
    }
    return canceled;
}

function cancelPendingSearchRequestsForPdfPath(pdfPath: string, reason: string) {
    let canceledCount = 0;
    for (const pending of pendingSearchRequestAdmissions.values()) {
        for (const admission of pending) {
            if (!admission.matchesWorkingCopyPath(pdfPath)) {
                continue;
            }
            admission.cancel(reason);
            canceledCount += 1;
        }
    }
    return canceledCount;
}

function resolveSearchRequestId(requestId: TRequestId | undefined, prefix: string): TRequestId {
    return requestId ?? createRequestId(prefix);
}

function canceledSearchResponse(): ISearchResponse {
    return {
        results: [],
        truncated: false,
        canceled: true,
    };
}

function getSearchWorkerService() {
    activeSearchWorkerService ??= new SearchWorkerService(
        resolveSearchWorkerPath,
        SearchWorkerService.resolveCurrentHostResourcePolicy(),
    );
    return activeSearchWorkerService;
}

export const searchWorkerService = {
    cancelRequestsForPdfPath(pdfPath: string, reason: string) {
        const pendingCanceled = cancelPendingSearchRequestsForPdfPath(pdfPath, reason);
        const activeCanceled = activeSearchWorkerService?.cancelRequestsForPdfPath(pdfPath, reason) ?? 0;
        return pendingCanceled + activeCanceled;
    },
    async cleanupAll(reason: string) {
        await activeSearchWorkerService?.cleanupAll(reason);
    },
    async shutdown(reason: string) {
        await activeSearchWorkerService?.shutdown(reason);
    },
};

function normalizeSearchOperationContext(context: ISearchSenderContext): ISearchOperationContext {
    return {
        sender: context.sender,
        senderId: context.senderId ?? context.sender.id,
    };
}

async function resolveSearchDocumentRevision(
    resolvedPdfPath: string,
    parsedDocumentRevision: TDocumentRevisionToken | undefined,
    senderId: number,
) {
    return parsedDocumentRevision ?? (await getWorkingCopyRevision(resolvedPdfPath, senderId)).token;
}

async function handlePdfSearch(
    context: ISearchSenderContext,
    request: INormalizedPdfSearchRequest,
): Promise<ISearchResponse> {
    const operationContext = normalizeSearchOperationContext(context);
    const {
        pdfPath,
        query,
        pageCount,
        matchCase,
        wholeWord,
        useRegex,
    } = request;

    if (query.length === 0) {
        return {
            results: [],
            truncated: false,
        };
    }

    const requestId = resolveSearchRequestId(request.requestId, 'search');
    const admission = createSearchRequestAdmission(pdfPath, operationContext.senderId, requestId);
    try {
        const resolvedPdfPath = await resolveSearchablePdfPath(pdfPath, operationContext.senderId);
        if (admission.isCanceled()) {
            return canceledSearchResponse();
        }
        if (!resolvedPdfPath) {
            throw new SearchIpcError(buildSearchErrorEnvelope(
                'SEARCH_PATH_DENIED',
                'Invalid PDF path: search only allowed within temp directory',
            ));
        }
        if (isWorkingCopyPathCandidate(resolvedPdfPath)) {
            admission.addWorkingCopyPath(resolvedPdfPath);
        }
        if (admission.isCanceled()) {
            return canceledSearchResponse();
        }

        const service = getSearchWorkerService();
        const dispatchPayload: Parameters<SearchWorkerService['dispatchSearchRequest']>[1] = {
            resolvedPdfPath,
            documentRevision: await resolveSearchDocumentRevision(resolvedPdfPath, request.documentRevision, operationContext.senderId),
            query,
            requestId,
            requestIdPrefix: 'search',
        };
        if (admission.isCanceled()) {
            return canceledSearchResponse();
        }
        if (pageCount !== undefined) {
            dispatchPayload.pageCount = pageCount;
        }
        if (matchCase !== undefined) {
            dispatchPayload.matchCase = matchCase;
        }
        if (wholeWord !== undefined) {
            dispatchPayload.wholeWord = wholeWord;
        }
        if (useRegex !== undefined) {
            dispatchPayload.useRegex = useRegex;
        }

        const dispatchPromise = service.dispatchSearchRequest(operationContext, dispatchPayload, {signals: admission.getSignals()});
        admission.complete();
        return await dispatchPromise;
    } catch (error) {
        if (admission.isCanceled()) {
            return canceledSearchResponse();
        }
        throw error;
    } finally {
        admission.complete();
    }
}

async function handlePdfSearchWarmIndex(
    context: ISearchSenderContext,
    request: INormalizedPdfSearchWarmIndexRequest,
) {
    const operationContext = normalizeSearchOperationContext(context);
    const requestId = resolveSearchRequestId(request.requestId, 'search-warm');
    const admission = createSearchRequestAdmission(request.pdfPath, operationContext.senderId, requestId);
    try {
        const resolvedPdfPath = await resolveSearchablePdfPath(request.pdfPath, operationContext.senderId);
        if (admission.isCanceled()) {
            return true;
        }
        if (!resolvedPdfPath) {
            throw new SearchIpcError(buildSearchErrorEnvelope(
                'SEARCH_PATH_DENIED',
                'Invalid PDF path: search only allowed within temp directory',
            ));
        }
        if (isWorkingCopyPathCandidate(resolvedPdfPath)) {
            admission.addWorkingCopyPath(resolvedPdfPath);
        }
        if (admission.isCanceled()) {
            return true;
        }

        const service = getSearchWorkerService();
        const dispatchPayload: Parameters<SearchWorkerService['dispatchSearchRequest']>[1] = {
            resolvedPdfPath,
            documentRevision: await resolveSearchDocumentRevision(resolvedPdfPath, request.documentRevision, operationContext.senderId),
            query: '',
            warmup: true,
            requestId,
            requestIdPrefix: 'search-warm',
        };
        if (admission.isCanceled()) {
            return true;
        }
        if (request.pageCount !== undefined) {
            dispatchPayload.pageCount = request.pageCount;
        }

        const dispatchPromise = service.dispatchSearchRequest(operationContext, dispatchPayload, {signals: admission.getSignals()});
        admission.complete();
        return await dispatchPromise.then(() => true);
    } catch (error) {
        if (admission.isCanceled()) {
            return true;
        }
        throw error;
    } finally {
        admission.complete();
    }
}

const searchMainBindings = {
    run: handlePdfSearch,
    warmIndex: handlePdfSearchWarmIndex,
    cancel: (context, requestId) => {
        const senderId = context.senderId;
        const pendingCanceled = requestId === undefined
            ? cancelPendingSearchRequestsForSender(senderId, 'explicit cancel request')
            : cancelPendingSearchRequests(senderId, requestId, 'explicit cancel request');
        const activeCancellation = getSearchWorkerService().cancel(context, requestId);
        return {canceled: pendingCanceled || activeCancellation.canceled};
    },
    resetCache: () => getSearchWorkerService().resetCache(),
    subscribeProgress: context => getSearchWorkerService().subscribeProgress(context),
} satisfies TFeatureMainBindings<typeof SEARCH_PLATFORM_FEATURE, IpcMainInvokeEvent>;

export function prepareSearchMainBindings() {
    const serviceConfig = getSearchWorkerService().getConfig();
    log.info(
        'Registering search IPC handlers '
        + `(requestTimeoutMs=${serviceConfig.requestTimeoutMs}, idleTtlMs=${serviceConfig.idleTtlMs}, maxActive=${serviceConfig.maxActive})`,
    );
    return searchMainBindings;
}
