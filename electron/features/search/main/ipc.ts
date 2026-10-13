import type { IpcMainInvokeEvent } from 'electron';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import type { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    INormalizedPdfSearchRequest,
    INormalizedPdfSearchWarmIndexRequest,
} from '@contracts/search';
import { validateSearchQuery } from '@pdf-core';
import { getWorkingCopyRevision } from '@electron/file-access/documentRevisionStore';
import {
    findWorkingCopyPathByOriginalPath,
    getWorkingCopyBackingEntry,
} from '@electron/file-access/workingCopyStore';
import { isWorkingCopyDocumentPath } from '@electron/file-access/workingCopyDirectory';
import { ensureWorkingCopyMaterialized } from '@electron/file-access/workingCopyMaterialization';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import {
    createSearchService,
    searchPathDeniedError,
    type ISearchSenderContext,
} from '@electron/features/search/main/searchService';
import { getSearchIndexPath } from '@electron/features/search/searchIndex';
import {
    readPdfPageCount,
    streamPdfPageTexts,
} from '@electron/features/search/pdfPageTexts';

/**
 * A lazily backed working copy has no physical leaf until materialization
 * publishes one. Search reads the whole document, so it waits for that leaf
 * the way page operations do, then searches the copy as a materialized one.
 */
function lazyBackedWorkingCopyPath(pdfPath: string, senderWebContentsId?: number) {
    const candidate = isWorkingCopyDocumentPath(pdfPath)
        ? pdfPath
        : findWorkingCopyPathByOriginalPath(pdfPath, senderWebContentsId);
    if (!candidate) {
        return null;
    }
    const backingState = getWorkingCopyBackingEntry(candidate, senderWebContentsId)?.backingState;
    return backingState === 'lazy-original' || backingState === 'materializing' ? candidate : null;
}

export async function resolveSearchablePdfPath(
    pdfPath: string,
    senderWebContentsId?: number,
    signal?: AbortSignal,
) {
    const lazyBackedPath = lazyBackedWorkingCopyPath(pdfPath, senderWebContentsId);
    if (lazyBackedPath) {
        // The reason only labels the materialization progress; search reads the copy as a page operation does.
        const {physicalWorkingCopyPath} = await ensureWorkingCopyMaterialized(lazyBackedPath, {
            reason: 'page-operation',
            ...(senderWebContentsId === undefined ? {} : {ownerWebContentsId: senderWebContentsId}),
            ...(signal ? {signal} : {}),
        });
        return resolveAllowedReadPath(physicalWorkingCopyPath);
    }
    if (isWorkingCopyDocumentPath(pdfPath)) {
        const directResolvedPath = await resolveAllowedReadPath(pdfPath);
        if (directResolvedPath) {
            return directResolvedPath;
        }
    }
    const mappedWorkingCopyPath = findWorkingCopyPathByOriginalPath(pdfPath, senderWebContentsId);
    const mappedResolvedPath = mappedWorkingCopyPath ? await resolveAllowedReadPath(mappedWorkingCopyPath) : null;
    return mappedResolvedPath ?? await resolveAllowedReadPath(pdfPath);
}

/** The search index of a PDF, built from its text layer. */
export function pdfSearchDocument(pdfPath: string, documentRevision: TDocumentRevisionToken) {
    return {
        indexPath: getSearchIndexPath(pdfPath),
        documentRevision,
        ...(isWorkingCopyDocumentPath(pdfPath) ? {workingCopyPath: pdfPath} : {}),
        readPageCount: (signal: AbortSignal) => readPdfPageCount(pdfPath, signal),
        readPages: (signal: AbortSignal, pageCount: number | undefined, onProgress: (pageNumber: number) => void) => streamPdfPageTexts(pdfPath, {
            signal,
            ...(pageCount === undefined ? {} : {lastPage: pageCount}),
        }, onProgress),
    };
}

export const searchService = createSearchService();

function senderIdOf(context: ISearchSenderContext) {
    return context.senderId ?? context.sender.id;
}

function knownWorkingCopyPath(pdfPath: string, senderId: number) {
    return isWorkingCopyDocumentPath(pdfPath) ? pdfPath : findWorkingCopyPathByOriginalPath(pdfPath, senderId);
}

async function resolvePdfSearchDocument(
    pdfPath: string,
    documentRevision: TDocumentRevisionToken | undefined,
    senderId: number,
    signal: AbortSignal,
) {
    const resolvedPdfPath = await resolveSearchablePdfPath(pdfPath, senderId, signal);
    if (!resolvedPdfPath) {
        throw searchPathDeniedError();
    }
    const revision = documentRevision ?? (await getWorkingCopyRevision(resolvedPdfPath, senderId)).token;
    return pdfSearchDocument(resolvedPdfPath, revision);
}

function handlePdfSearch(context: ISearchSenderContext, request: INormalizedPdfSearchRequest) {
    if (request.query.length === 0) {
        return Promise.resolve({
            results: [],
            truncated: false,
        });
    }
    validateSearchQuery(request.query, request);
    const senderId = senderIdOf(context);
    return searchService.run(context, {
        ...(request.requestId === undefined ? {} : {requestId: request.requestId}),
        requestIdPrefix: 'search',
        query: request.query,
        ...(request.resultOffset === undefined ? {} : {resultOffset: request.resultOffset}),
        matchCase: request.matchCase === true,
        wholeWord: request.wholeWord === true,
        useRegex: request.useRegex === true,
        ...(request.pageCount === undefined ? {} : {pageCount: request.pageCount}),
        workingCopyPath: knownWorkingCopyPath(request.pdfPath, senderId),
        resolveDocument: signal => resolvePdfSearchDocument(request.pdfPath, request.documentRevision, senderId, signal),
    });
}

async function handlePdfSearchWarmIndex(context: ISearchSenderContext, request: INormalizedPdfSearchWarmIndexRequest) {
    const senderId = senderIdOf(context);
    await searchService.run(context, {
        ...(request.requestId === undefined ? {} : {requestId: request.requestId}),
        requestIdPrefix: 'search-warm',
        query: '',
        warmup: true,
        matchCase: false,
        wholeWord: false,
        useRegex: false,
        ...(request.pageCount === undefined ? {} : {pageCount: request.pageCount}),
        workingCopyPath: knownWorkingCopyPath(request.pdfPath, senderId),
        resolveDocument: signal => resolvePdfSearchDocument(request.pdfPath, request.documentRevision, senderId, signal),
    });
    return true;
}

const searchMainBindings = {
    run: handlePdfSearch,
    warmIndex: handlePdfSearchWarmIndex,
    cancel: (context, requestId) => searchService.cancel(context, requestId),
    // Indexes live on disk beside their document and carry its revision.
    resetCache: () => true,
    subscribeProgress: context => searchService.subscribeProgress(context),
} satisfies TFeatureMainBindings<typeof SEARCH_PLATFORM_FEATURE, IpcMainInvokeEvent>;

export function prepareSearchMainBindings() {
    return searchMainBindings;
}
