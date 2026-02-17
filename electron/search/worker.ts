import { parentPort } from 'worker_threads';
import { stat } from 'fs/promises';
import type { IPdfSearchIndex } from '@electron/search/index-builder';
import {
    buildSearchIndex,
    loadSearchIndex,
} from '@electron/search/index-builder';
import {
    EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@electron/config/constants';
import { createLogger } from '@electron/utils/logger';

interface ISearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

interface ISearchMatch {
    pageNumber: number;
    pageMatchIndex: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: ISearchExcerpt;
}

interface ISearchRequest {
    requestId: string;
    pdfPath: string;
    query: string;
    pageCount?: number;
}

interface ISearchResponse {
    results: ISearchMatch[];
    truncated: boolean;
}

type TCachedIndex = {
    mtimeMs: number;
    index: IPdfSearchIndex;
    lowerTexts: string[];
};

type TWorkerInboundMessage =
    | {
        type: 'search';
        payload: ISearchRequest;
    }
    | {
        type: 'cancel';
        requestId: string;
    }
    | {type: 'reset-cache';};

type TWorkerOutboundMessage =
    | {
        type: 'progress';
        requestId: string;
        processed: number;
        total: number;
    }
    | {
        type: 'complete';
        requestId: string;
        response: ISearchResponse;
    }
    | {
        type: 'cancelled';
        requestId: string;
    }
    | {
        type: 'error';
        requestId: string;
        error: string;
    };

const PROGRESS_THROTTLE_MS = 60;
const indexCache = new Map<string, TCachedIndex>();
const cancelledRequests = new Set<string>();
const progressSentAt = new Map<string, number>();
const log = createLogger('search-worker');

function postMessage(message: TWorkerOutboundMessage) {
    parentPort?.postMessage(message);
}

async function fileExists(filePath: string) {
    try {
        await stat(filePath);
        return true;
    } catch {
        return false;
    }
}

function getIndexPath(pdfPath: string) {
    return `${pdfPath}.index.json`;
}

function buildExcerpt(
    text: string,
    startOffset: number,
    endOffset: number,
): ISearchExcerpt {
    const excerptStart = Math.max(0, startOffset - EXCERPT_CONTEXT_CHARS);
    const excerptEnd = Math.min(text.length, endOffset + EXCERPT_CONTEXT_CHARS);

    const beforeRaw = text.slice(excerptStart, startOffset);
    const match = text.slice(startOffset, endOffset);
    const afterRaw = text.slice(endOffset, excerptEnd);

    const before = beforeRaw.replace(/\s+/g, ' ').trimStart();
    const after = afterRaw.replace(/\s+/g, ' ').trimEnd();

    return {
        prefix: excerptStart > 0,
        suffix: excerptEnd < text.length,
        before,
        match,
        after,
    };
}

function isCancelled(requestId: string) {
    return cancelledRequests.has(requestId);
}

function sendProgress(
    requestId: string,
    processed: number,
    total: number,
    force = false,
) {
    const now = Date.now();
    const lastSentAt = progressSentAt.get(requestId) ?? 0;
    if (
        !force
        && processed !== 0
        && processed !== total
        && now - lastSentAt < PROGRESS_THROTTLE_MS
    ) {
        return;
    }

    progressSentAt.set(requestId, now);
    postMessage({
        type: 'progress',
        requestId,
        processed,
        total,
    });
}

async function loadCachedIndex(pdfPath: string): Promise<TCachedIndex | null> {
    const indexPath = getIndexPath(pdfPath);

    let mtimeMs: number;
    try {
        mtimeMs = (await stat(indexPath)).mtimeMs;
    } catch {
        indexCache.delete(pdfPath);
        return null;
    }

    const cached = indexCache.get(pdfPath);
    if (cached && cached.mtimeMs === mtimeMs) {
        return cached;
    }

    const index = await loadSearchIndex(pdfPath);
    if (!index) {
        indexCache.delete(pdfPath);
        return null;
    }

    const entry: TCachedIndex = {
        mtimeMs,
        index,
        lowerTexts: index.pages.map(page => (page.text ?? '').toLowerCase()),
    };
    indexCache.set(pdfPath, entry);
    return entry;
}

async function cacheBuiltIndex(
    pdfPath: string,
    index: IPdfSearchIndex,
): Promise<TCachedIndex> {
    const indexPath = getIndexPath(pdfPath);
    let mtimeMs: number;
    try {
        mtimeMs = (await stat(indexPath)).mtimeMs;
    } catch {
        mtimeMs = Date.now();
    }

    const entry: TCachedIndex = {
        mtimeMs,
        index,
        lowerTexts: index.pages.map(page => (page.text ?? '').toLowerCase()),
    };
    indexCache.set(pdfPath, entry);
    return entry;
}

async function ensureSearchIndex(
    pdfPath: string,
    options: { pageCount?: number },
): Promise<TCachedIndex> {
    const expectedCount = options.pageCount;

    let entry = await loadCachedIndex(pdfPath);
    if (!entry) {
        entry = await cacheBuiltIndex(
            pdfPath,
            await buildSearchIndex(pdfPath, [], { pageCount: expectedCount }),
        );
        return entry;
    }

    if (
        typeof expectedCount === 'number'
        && expectedCount > 0
        && entry.index.pages.length < expectedCount
    ) {
        entry = await cacheBuiltIndex(
            pdfPath,
            await buildSearchIndex(pdfPath, [], { pageCount: expectedCount }),
        );
    } else if (typeof expectedCount === 'number' && expectedCount > 0) {
        const inRangeCount = entry.index.pages.reduce((count, page) => (
            count + (page.pageNumber >= 1 && page.pageNumber <= expectedCount ? 1 : 0)
        ), 0);

        if (inRangeCount < expectedCount) {
            entry = await cacheBuiltIndex(
                pdfPath,
                await buildSearchIndex(pdfPath, [], { pageCount: expectedCount }),
            );
        }
    }

    return entry;
}

async function processSearchRequest(request: ISearchRequest) {
    const {
        requestId,
        pdfPath,
        query,
        pageCount,
    } = request;

    try {
        cancelledRequests.delete(requestId);
        progressSentAt.delete(requestId);

        if (!pdfPath || !(await fileExists(pdfPath))) {
            throw new Error(`PDF not found: ${pdfPath}`);
        }

        if (!query || query.trim().length === 0) {
            postMessage({
                type: 'complete',
                requestId,
                response: {
                    results: [],
                    truncated: false,
                },
            });
            return;
        }

        const normalizedQuery = query.trim();
        const lowerQuery = normalizedQuery.toLowerCase();
        const indexEntry = await ensureSearchIndex(pdfPath, { pageCount });

        if (isCancelled(requestId)) {
            postMessage({
                type: 'cancelled',
                requestId,
            });
            return;
        }

        const totalPages = typeof pageCount === 'number' && pageCount > 0
            ? pageCount
            : (indexEntry.index.pageCount ?? indexEntry.index.pages.length);

        sendProgress(requestId, 0, totalPages, true);

        const results: ISearchMatch[] = [];
        let globalMatchIndex = 0;
        let processedCount = 0;
        let truncated = false;

        for (let pageIdx = 0; pageIdx < indexEntry.index.pages.length; pageIdx += 1) {
            if (isCancelled(requestId)) {
                postMessage({
                    type: 'cancelled',
                    requestId,
                });
                return;
            }

            const page = indexEntry.index.pages[pageIdx]!;
            if (page.pageNumber < 1) {
                continue;
            }
            if (page.pageNumber > totalPages) {
                break;
            }

            const pageText = page.text ?? '';

            if (pageText) {
                const lowerPageText = indexEntry.lowerTexts[pageIdx] ?? pageText.toLowerCase();
                let position = 0;
                let pageMatchIndex = 0;

                while ((position = lowerPageText.indexOf(lowerQuery, position)) !== -1) {
                    const startOffset = position;
                    const endOffset = position + normalizedQuery.length;

                    results.push({
                        pageNumber: page.pageNumber,
                        pageMatchIndex,
                        matchIndex: globalMatchIndex,
                        startOffset,
                        endOffset,
                        excerpt: buildExcerpt(pageText, startOffset, endOffset),
                    });

                    pageMatchIndex += 1;
                    globalMatchIndex += 1;
                    position += normalizedQuery.length;

                    if (results.length >= SEARCH_RESULT_LIMIT) {
                        truncated = true;
                        break;
                    }
                }
            }

            processedCount += 1;
            sendProgress(requestId, processedCount, totalPages);

            if (truncated) {
                break;
            }
        }

        if (processedCount < totalPages) {
            sendProgress(requestId, totalPages, totalPages, true);
        } else {
            sendProgress(requestId, processedCount, totalPages, true);
        }

        postMessage({
            type: 'complete',
            requestId,
            response: {
                results,
                truncated,
            },
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        postMessage({
            type: 'error',
            requestId,
            error: `Search failed: ${errMsg}`,
        });
    } finally {
        progressSentAt.delete(request.requestId);
        cancelledRequests.delete(request.requestId);
    }
}

parentPort?.on('message', (message: TWorkerInboundMessage) => {
    if (message.type === 'cancel') {
        cancelledRequests.add(message.requestId);
        return;
    }

    if (message.type === 'reset-cache') {
        indexCache.clear();
        return;
    }

    if (message.type === 'search') {
        void processSearchRequest(message.payload);
    }
});

log.debug('Search worker initialized');
