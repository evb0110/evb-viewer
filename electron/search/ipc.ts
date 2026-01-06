import type { IpcMainInvokeEvent } from 'electron';
import {ipcMain} from 'electron';
import {
    existsSync,
    statSync,
} from 'fs';
import type { IPdfSearchIndex } from '@electron/search/index-builder';
import {
    buildSearchIndex,
    loadSearchIndex,
} from '@electron/search/index-builder';
import { createLogger } from '@electron/utils/logger';

const log = createLogger('search-ipc');

interface ISearchExcerpt {
    prefix: boolean;
    suffix: boolean;
    before: string;
    match: string;
    after: string;
}

interface ISearchMatch {
    pageNumber: number;
    matchIndex: number;
    startOffset: number;
    endOffset: number;
    excerpt: ISearchExcerpt;
}

interface ISearchRequest {
    pdfPath: string;
    query: string;
    requestId?: string;
    pageCount?: number;
}

interface ISearchResponse {
    results: ISearchMatch[];
    truncated: boolean;
}

interface ISearchProgress {
    requestId: string;
    processed: number;
    total: number;
}

type TCachedIndex = {
    mtimeMs: number;
    index: IPdfSearchIndex;
    lowerTexts: string[];
};

const indexCache = new Map<string, TCachedIndex>();
const latestSearchBySender = new Map<number, string>();

const SEARCH_RESULT_LIMIT = 500;
const EXCERPT_CONTEXT_CHARS = 40;

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

    const beforeNormalized = beforeRaw.replace(/\s+/g, ' ').trimStart();
    const afterNormalized = afterRaw.replace(/\s+/g, ' ').trimEnd();

    const isWordChar = (ch: string) => /[0-9A-Za-z]/.test(ch);
    const matchLen = match.length;

    let before = beforeNormalized;
    let after = afterNormalized;

    if (matchLen >= 4 && matchLen > 0) {
        const beforeHasBoundaryWhitespace = /\s$/.test(beforeRaw);
        const afterHasBoundaryWhitespace = /^\s/.test(afterRaw);

        const beforeLast = beforeNormalized.at(-1) ?? '';
        const matchFirst = match.at(0) ?? '';
        const matchLast = match.at(-1) ?? '';
        const afterFirst = afterNormalized.at(0) ?? '';

        if (!beforeHasBoundaryWhitespace && beforeLast && matchFirst && isWordChar(beforeLast) && isWordChar(matchFirst)) {
            before = `${beforeNormalized} `;
        }

        const looksLikePluralSuffix = afterNormalized === 's' || afterNormalized.startsWith('s ');
        if (
            !afterHasBoundaryWhitespace
            && !looksLikePluralSuffix
            && matchLast
            && afterFirst
            && isWordChar(matchLast)
            && isWordChar(afterFirst)
        ) {
            after = ` ${afterNormalized}`;
        }
    }

    return {
        prefix: excerptStart > 0,
        suffix: excerptEnd < text.length,
        before,
        match,
        after,
    };
}

function sendProgress(event: IpcMainInvokeEvent, progress: ISearchProgress) {
    event.sender.send('pdf:search:progress', progress);
}

async function loadCachedIndex(pdfPath: string): Promise<TCachedIndex | null> {
    const indexPath = getIndexPath(pdfPath);
    if (!existsSync(indexPath)) {
        indexCache.delete(pdfPath);
        return null;
    }

    const mtimeMs = statSync(indexPath).mtimeMs;
    const cached = indexCache.get(pdfPath);
    if (cached && cached.mtimeMs === mtimeMs) {
        return cached;
    }

    const index = await loadSearchIndex(pdfPath);
    if (!index) {
        indexCache.delete(pdfPath);
        return null;
    }

    const lowerTexts = index.pages.map(page => (page.text ?? '').toLowerCase());
    const entry: TCachedIndex = {
        mtimeMs,
        index,
        lowerTexts,
    };
    indexCache.set(pdfPath, entry);
    return entry;
}

function cacheBuiltIndex(pdfPath: string, index: IPdfSearchIndex): TCachedIndex {
    const indexPath = getIndexPath(pdfPath);
    const mtimeMs = existsSync(indexPath) ? statSync(indexPath).mtimeMs : Date.now();
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
    options: {pageCount?: number;},
): Promise<TCachedIndex> {
    const expectedCount = options.pageCount;

    let entry = await loadCachedIndex(pdfPath);
    if (!entry) {
        log.debug(`No index found for ${pdfPath}, building base index`);
        entry = cacheBuiltIndex(
            pdfPath,
            await buildSearchIndex(pdfPath, [], { pageCount: expectedCount }),
        );
        return entry;
    }

    if (typeof expectedCount === 'number' && expectedCount > 0 && entry.index.pages.length < expectedCount) {
        log.debug(`Index incomplete (have=${entry.index.pages.length}, expected=${expectedCount}), rebuilding`);
        entry = cacheBuiltIndex(
            pdfPath,
            await buildSearchIndex(pdfPath, [], { pageCount: expectedCount }),
        );
    } else if (typeof expectedCount === 'number' && expectedCount > 0) {
        const inRangeCount = entry.index.pages.reduce((count, page) => (
            count + (page.pageNumber >= 1 && page.pageNumber <= expectedCount ? 1 : 0)
        ), 0);

        if (inRangeCount < expectedCount) {
            log.debug(`Index missing pages (have=${inRangeCount}, expected=${expectedCount}), rebuilding`);
            entry = cacheBuiltIndex(
                pdfPath,
                await buildSearchIndex(pdfPath, [], { pageCount: expectedCount }),
            );
        }
    }

    return entry;
}

/**
 * Search a PDF using cached index (for OCR'd PDFs) or pdftotext (for user PDFs)
 */
async function handlePdfSearch(
    event: IpcMainInvokeEvent,
    request: ISearchRequest,
): Promise<ISearchResponse> {
    const {
        pdfPath,
        query,
        requestId: requestIdRaw,
        pageCount,
    } = request;

    const requestId = requestIdRaw || `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    latestSearchBySender.set(event.sender.id, requestId);

    log.debug(`Search requested: pdfPath=${pdfPath}, query="${query}", requestId=${requestId}`);

    if (!pdfPath || !existsSync(pdfPath)) {
        throw new Error(`PDF not found: ${pdfPath}`);
    }

    if (!query || query.trim().length === 0) {
        return {
            results: [],
            truncated: false,
        };
    }

    const normalizedQuery = query.trim();
    const lowerQuery = normalizedQuery.toLowerCase();

    const shouldCancel = () => latestSearchBySender.get(event.sender.id) !== requestId;

    try {
        const indexEntry = await ensureSearchIndex(
            pdfPath,
            { pageCount },
        );

        const totalPages = typeof pageCount === 'number' && pageCount > 0
            ? pageCount
            : (indexEntry.index.pageCount ?? indexEntry.index.pages.length);

        log.debug(`Searching ${totalPages} pages for "${query}"`);

        sendProgress(event, {
            requestId,
            processed: 0,
            total: totalPages, 
        });

        const results: ISearchMatch[] = [];
        let globalMatchIndex = 0;
        let processedCount = 0;
        let truncated = false;

        for (let pageIdx = 0; pageIdx < indexEntry.index.pages.length; pageIdx += 1) {
            if (shouldCancel()) {
                log.debug(`Search canceled: requestId=${requestId}`);
                return {
                    results: [],
                    truncated: false,
                };
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

                while ((position = lowerPageText.indexOf(lowerQuery, position)) !== -1) {
                    const startOffset = position;
                    const endOffset = position + normalizedQuery.length;

                    results.push({
                        pageNumber: page.pageNumber,
                        matchIndex: globalMatchIndex,
                        startOffset,
                        endOffset,
                        excerpt: buildExcerpt(pageText, startOffset, endOffset),
                    });

                    globalMatchIndex += 1;
                    position += normalizedQuery.length;

                    if (results.length >= SEARCH_RESULT_LIMIT) {
                        truncated = true;
                        break;
                    }
                }
            }

            processedCount += 1;
            sendProgress(event, {
                requestId,
                processed: processedCount,
                total: totalPages, 
            });

            if (truncated) {
                break;
            }
        }

        if (processedCount < totalPages) {
            sendProgress(event, {
                requestId,
                processed: totalPages,
                total: totalPages, 
            });
        }

        log.debug(`Total matches found: ${results.length}${truncated ? ' (truncated)' : ''}`);
        return {
            results,
            truncated,
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Search error: ${errMsg}`);
        throw new Error(`Search failed: ${errMsg}`);
    }
}

export function registerSearchHandlers() {
    ipcMain.handle('pdf:search', handlePdfSearch);
    ipcMain.handle('pdf:search:resetCache', () => {
        indexCache.clear();
        return true;
    });
}

/**
 * Public function to build index during OCR completion
 */
export async function saveOcrIndex(
    pdfPath: string,
    pageData: Array<{
        pageNumber: number;
        words: Array<{
            text: string;
            x: number;
            y: number;
            width: number;
            height: number;
        }>;
        text?: string;
        pageWidth?: number;
        pageHeight?: number;
    }>,
    pageCount?: number,
): Promise<void> {
    try {
        await buildSearchIndex(pdfPath, pageData, { pageCount });
        indexCache.delete(pdfPath);
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to save OCR index: ${errMsg}`);
        // Non-blocking - don't fail OCR if index save fails
    }
}
