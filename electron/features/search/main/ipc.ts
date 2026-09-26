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
import { findWorkingCopyPathByOriginalPath } from '@electron/file-access/workingCopyStore';
import { isWorkingCopyDocumentPath } from '@electron/file-access/workingCopyDirectory';
import { resolveAllowedReadPath } from '@electron/utils/pathValidator';
import {
    createSearchService,
    searchPathDeniedError,
    type ISearchSenderContext,
} from '@electron/features/search/main/searchService';
import { getSearchIndexPath } from '@electron/features/search/searchIndex';
import { streamPdfPageTexts } from '@electron/features/search/pdfPageTexts';

export async function resolveSearchablePdfPath(pdfPath: string, senderWebContentsId?: number) {
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
        readPages: (signal: AbortSignal) => streamPdfPageTexts(pdfPath, {signal}),
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
) {
    const resolvedPdfPath = await resolveSearchablePdfPath(pdfPath, senderId);
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
        matchCase: request.matchCase === true,
        wholeWord: request.wholeWord === true,
        useRegex: request.useRegex === true,
        ...(request.pageCount === undefined ? {} : {pageCount: request.pageCount}),
        workingCopyPath: knownWorkingCopyPath(request.pdfPath, senderId),
        resolveDocument: () => resolvePdfSearchDocument(request.pdfPath, request.documentRevision, senderId),
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
        resolveDocument: () => resolvePdfSearchDocument(request.pdfPath, request.documentRevision, senderId),
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
