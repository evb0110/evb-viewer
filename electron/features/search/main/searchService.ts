import type { WebContents } from 'electron';
import {
    isSearchErrorEnvelope,
    type IPdfSearchProgress,
    type IPdfSearchResponse,
    type ISearchErrorEnvelope,
} from '@contracts/search';
import { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import {
    createRequestId,
    type TRequestId,
} from '@contracts/shared';
import { normalizePathForLookup } from '@electron/file-access/workingCopyStore';
import {
    createMainJobRegistry,
    type TMainJobErrorKind,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import {
    buildSearchErrorEnvelope,
    SearchIpcError,
    toSearchIpcError,
} from '@electron/features/search/main/searchErrors';
import {
    cancelSearchIndexBuilds,
    ensureSearchIndex,
    getSearchIndexPath,
    searchIndexedDocument,
    type ISearchIndexedDocument,
    type ISearchQueryOptions,
} from '@electron/features/search/searchIndex';
import { getErrorMessage } from '@electron/utils/error';

export interface ISearchSenderContext {
    sender: WebContents;
    senderId?: number;
}

export interface ISearchJobRequest extends ISearchQueryOptions {
    requestId?: TRequestId;
    requestIdPrefix: string;
    query: string;
    warmup?: boolean;
    pageCount?: number;
    /** The working copy the request reads, when known before it resolves. */
    workingCopyPath?: string | null;
    resolveDocument: (signal: AbortSignal) => Promise<ISearchIndexedDocument>;
}

function toSearchRegistryError(cause: unknown, kind: TMainJobErrorKind) {
    if (isSearchErrorEnvelope(cause)) {
        return cause;
    }
    if (kind === 'duplicate-job-id') {
        return buildSearchErrorEnvelope('SEARCH_INVALID_PAYLOAD', getErrorMessage(cause) || 'Duplicate search request');
    }
    return toSearchIpcError(cause).errorEnvelope;
}

function getSearchPdfPathKey(pdfPath: string) {
    return normalizePathForLookup(pdfPath) || pdfPath;
}

/**
 * Runs document searches as main jobs: one job per request, with progress and
 * cancellation through the job registry. Split panes share one renderer, so a
 * search ends only through its own request or its document's revision moving on.
 */
export function createSearchService() {
    const replay = SEARCH_PLATFORM_FEATURE.events.onProgress.subscription.replay;
    const jobs = createMainJobRegistry<IPdfSearchProgress, IPdfSearchResponse, ISearchErrorEnvelope>({
        retention: {
            eventReplayTtlMs: replay.terminalRetentionMs,
            terminalRecordTtlMs: replay.terminalRetentionMs,
        },
        progress: {
            channel: SEARCH_PLATFORM_FEATURE.eventChannels.onProgress,
            intervalMs: replay.intervalMs,
            getEventKey: progress => replay.key(progress) || null,
        },
        toError: toSearchRegistryError,
        terminalProgress: {
            completed: (latest, result) => ({
                requestId: latest.requestId,
                processed: result.coverage?.pagesScanned ?? latest.processed,
                total: result.coverage?.pageCount ?? latest.total,
                ...(result.coverage ? {coverage: result.coverage} : {}),
                status: 'success',
            }),
            canceled: latest => ({
                requestId: latest.requestId,
                processed: 0,
                total: latest.total,
                canceled: true,
                status: 'canceled',
            }),
            failed: (latest, error) => ({
                requestId: latest.requestId,
                processed: 0,
                total: latest.total,
                status: 'failed',
                error: error.message,
            }),
        },
    });
    async function runSearch(context: ISearchSenderContext, request: ISearchJobRequest) {
        const requestId = request.requestId ?? createRequestId(request.requestIdPrefix);
        const total = request.pageCount ?? 0;
        const handle = jobs.start({
            jobId: requestId,
            owner: {sender: context.sender},
            operation: {
                kind: 'abortable-work',
                ...(request.workingCopyPath ? {workingCopyPath: request.workingCopyPath} : {}),
            },
            // A page that goes away keeps no reader for its results; a shared index build continues.
            ownerLifecycle: {
                destroyed: 'cancel',
                renderProcessGone: 'cancel',
                mainFrameNavigation: 'cancel',
            },
            initialProgress: {
                requestId,
                processed: 0,
                total,
                status: 'running',
            },
            run: async ({
                publish, signal,
            }) => {
                const document = await request.resolveDocument(signal);
                const onIndexProgress = (pagesScanned: number) => publish({
                    requestId,
                    processed: pagesScanned,
                    total: Math.max(total, pagesScanned),
                    status: 'running',
                });
                if (request.warmup) {
                    const coverage = await ensureSearchIndex(document, {
                        signal,
                        onIndexProgress,
                    });
                    return {
                        results: [],
                        truncated: false,
                        coverage,
                    };
                }
                const response = await searchIndexedDocument(document, request.query, request, {
                    signal,
                    onIndexProgress,
                });
                publish({
                    requestId,
                    processed: response.coverage.pagesScanned,
                    total: response.pageCount,
                    coverage: response.coverage,
                    status: 'running',
                });
                return {
                    results: response.results,
                    truncated: response.truncated,
                    coverage: response.coverage,
                };
            },
        });
        const terminal = await handle.terminal;
        if (terminal.status === 'completed') {
            return terminal.result;
        }
        if (terminal.status === 'canceled') {
            return {
                results: [],
                truncated: false,
                canceled: true,
            } satisfies IPdfSearchResponse;
        }
        throw new SearchIpcError(terminal.error);
    }

    return {
        run: runSearch,
        subscribeProgress(context: ISearchSenderContext) {
            jobs.subscribeOwner({sender: context.sender});
        },
        /** Without a request id, cancels every search the renderer still runs. */
        cancel(context: ISearchSenderContext, requestId?: TRequestId) {
            return {canceled: requestId === undefined
                ? jobs.cancelWhere(snapshot => snapshot.owner.webContentsId === context.sender.id, 'explicit cancel request') > 0
                : jobs.cancel(requestId, {sender: context.sender}, 'explicit cancel request')};
        },
        /** Cancels searches and index builds for a document whose revision moved on. */
        cancelRequestsForPdfPath(pdfPath: string, reason: string) {
            const key = getSearchPdfPathKey(pdfPath);
            cancelSearchIndexBuilds(getSearchIndexPath(pdfPath));
            return jobs.cancelWhere(
                snapshot => snapshot.workingCopyPath !== undefined && getSearchPdfPathKey(snapshot.workingCopyPath) === key,
                reason,
            );
        },
        cancelAll: (reason: string) => jobs.cancelWhere(() => true, reason),
        shutdown: () => jobs.dispose(),
    };
}

export function searchPathDeniedError() {
    return new SearchIpcError(buildSearchErrorEnvelope(
        'SEARCH_PATH_DENIED',
        'Invalid PDF path: search only allowed within temp directory',
    ));
}
