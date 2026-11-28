import {basename} from 'node:path';
import type {IpcMainInvokeEvent} from 'electron';
import type {TFeatureMainBindings} from '@contracts/platformFeature';
import type {SEARCH_PLATFORM_FEATURE} from '@contracts/searchPlatformFeature';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {INormalizedPdfSearchRequest, INormalizedPdfSearchWarmIndexRequest} from '@contracts/search';
import {validateSearchQuery} from '@pdf-core';
import {
    ensureWorkingCopyMaterialized,
    findWorkingCopyPathByOriginalPath,
    getOpenDocument,
    getWorkingCopyBackingEntry,
    getWorkingCopyOwnerWebContentsId,
    getWorkingCopyRevision,
    isWorkingCopyDocumentPath,
} from '@electron/file-access/documentStore';
import {normalizePathForLookup} from '@electron/file-access/normalizePathForLookup';
import {isWorkingCopyQuarantined} from '@electron/file-access/workingCopyQuarantine';
import {resolveAllowedReadPath} from '@electron/utils/pathValidator';
import {createSearchService, searchPathDeniedError, type ISearchSenderContext} from '@electron/features/search/main/searchService';
import {evictSearchIndexCache, getSearchIndexPath} from '@electron/features/search/searchIndex';
import {streamPdfPageTexts} from '@electron/features/search/pdfPageTexts';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';

/**
 * A lazily backed working copy has no physical leaf until materialization
 * publishes one. Search reads the whole document, so it waits for that leaf
 * the way page operations do, then searches the copy as a materialized one.
 */
function lazyBackedWorkingCopyPath(pdfPath: string, senderWebContentsId?: number) {
    const candidate = isWorkingCopyDocumentPath(pdfPath) ? pdfPath : findWorkingCopyPathByOriginalPath(pdfPath, senderWebContentsId);
    if (!candidate) {
        return null;
    }
    return getWorkingCopyBackingEntry(candidate, senderWebContentsId) ? candidate : null;
}

export async function resolveSearchablePdfPath(pdfPath: string, senderWebContentsId?: number, signal?: AbortSignal) {
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
    return mappedResolvedPath ?? (await resolveAllowedReadPath(pdfPath));
}

function resolveCurrentRevisionTextIdentity(
    openDoc: ReturnType<typeof getOpenDocument>,
    pdfPath: string,
    documentRevision: TDocumentRevisionToken,
): string | null {
    if (!openDoc?.session || !openDoc.doc || openDoc.session.token() !== documentRevision) {
        return null;
    }
    const state = openDoc.doc.state();
    if (state.damaged || state.textIdentity === null) {
        return null;
    }
    const normalizedPdfPath = normalizePathForLookup(pdfPath) || pdfPath;
    const normalizedRef = normalizePathForLookup(openDoc.ref) || openDoc.ref;
    if (normalizedPdfPath === normalizedRef) {
        return state.textIdentity;
    }
    if (state.current !== null) {
        return basename(pdfPath) === state.current.file ? state.textIdentity : null;
    }
    if (state.destination !== null) {
        const normalizedDest = normalizePathForLookup(state.destination) || state.destination;
        return normalizedPdfPath === normalizedDest ? state.textIdentity : null;
    }
    return null;
}

/**
 * The search index of a PDF, built from its text layer. `pdfPath` is the file
 * the text is read from; when it belongs to an open document, the index and its
 * build belong to that document's ref, so closing the document or moving its
 * revision on stops the build before the document's files go.
 */
export function pdfSearchDocument(pdfPath: string, documentRevision: TDocumentRevisionToken) {
    const openDoc = getOpenDocument(pdfPath);
    const workingCopyPath = openDoc?.ref;
    const textIdentity = resolveCurrentRevisionTextIdentity(openDoc, pdfPath, documentRevision);
    return {
        indexPath: getSearchIndexPath(workingCopyPath ?? pdfPath),
        documentRevision,
        ...(textIdentity === null ? {} : {textIdentity}),
        ...(workingCopyPath === undefined ? {} : {workingCopyPath}),
        readPageCount: (signal: AbortSignal) => getPdfPageCount(pdfPath, {signal}),
        readPages: (signal: AbortSignal, pageCount: number | undefined, onProgress: (pageNumber: number) => void) =>
            streamPdfPageTexts(
                pdfPath,
                {
                    signal,
                    visiblePageOnly: true,
                    ...(pageCount === undefined ? {} : {lastPage: pageCount}),
                },
                onProgress,
            ),
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
    // Another window's working copy is not this one's to read, whatever
    // revision the request names; nor is a retired copy whose bytes are kept
    // in quarantine after no window owns it any more.
    if (
        !resolvedPdfPath ||
        [pdfPath, resolvedPdfPath].some((path) => {
            const owner = getWorkingCopyOwnerWebContentsId(path);
            return owner === undefined ? isWorkingCopyQuarantined(path) : owner !== senderId;
        })
    ) {
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
        resolveDocument: (signal) => resolvePdfSearchDocument(request.pdfPath, request.documentRevision, senderId, signal),
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
        resolveDocument: (signal) => resolvePdfSearchDocument(request.pdfPath, request.documentRevision, senderId, signal),
    });
    return true;
}

const searchMainBindings = {
    run: handlePdfSearch,
    warmIndex: handlePdfSearchWarmIndex,
    cancel: (context, requestId) => searchService.cancel(context, requestId),
    // Evict in-worker cached search index bytes; on-disk indexes carry their revision/text identity.
    resetCache: () => {
        evictSearchIndexCache();
        return true;
    },
    subscribeProgress: (context) => searchService.subscribeProgress(context),
} satisfies TFeatureMainBindings<typeof SEARCH_PLATFORM_FEATURE, IpcMainInvokeEvent>;

export function prepareSearchMainBindings() {
    return searchMainBindings;
}
