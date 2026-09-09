import { stat } from 'fs/promises';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    getCompactSearchIndexPath,
    loadCompactSearchIndex,
    persistCompactSearchIndex,
} from '@electron/features/search/searchIndexSidecar';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { requirePageNumber } from '@contracts/pageNumbers';

export const NATIVE_SEARCH_INDEX_SCHEMA_VERSION = COMPACT_SEARCH_INDEX_SCHEMA_VERSION;
export const NATIVE_SEARCH_INDEX_MAGIC = COMPACT_SEARCH_INDEX_MAGIC;

const log = createLogger('native-search-index');

interface INativeSearchIndexInput {
    documentRevision: {token: TDocumentRevisionToken};
    pages: Array<{
        pageNumber: number;
        text: string;
    }>;
    pageCount?: number;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

export function getNativeSearchIndexPath(pdfPath: string) {
    return getCompactSearchIndexPath(pdfPath);
}

async function statMtimeMs(filePath: string) {
    try {
        const fileStat = await stat(filePath);
        return typeof fileStat.mtimeMs === 'number' && Number.isFinite(fileStat.mtimeMs)
            ? fileStat.mtimeMs
            : null;
    } catch {
        return null;
    }
}

async function shouldRewriteNativeSearchIndex(
    pdfPath: string,
    index: INativeSearchIndexInput,
    documentRevision: TDocumentRevisionToken,
) {
    const [
        nativeMtimeMs,
        jsonMtimeMs,
    ] = await Promise.all([
        statMtimeMs(getNativeSearchIndexPath(pdfPath)),
        statMtimeMs(`${pdfPath}.index.json`),
    ]);
    if (nativeMtimeMs === null || (jsonMtimeMs !== null && jsonMtimeMs > nativeMtimeMs)) {
        return true;
    }
    return !await loadCompactSearchIndex(pdfPath, {
        documentRevision,
        expectedPageCount: index.pageCount ?? index.pages.length,
        metadataOnly: true,
    });
}

export async function persistNativeSearchIndex(
    pdfPath: string,
    index: INativeSearchIndexInput,
    documentRevision: TDocumentRevisionToken,
    signal?: AbortSignal,
) {
    await persistCompactSearchIndex(pdfPath, {
        documentRevision,
        pageCount: index.pageCount ?? index.pages.length,
        pages: index.pages.map(page => ({
            ...page,
            pageNumber: requirePageNumber(page.pageNumber),
        })),
    }, signal);
    log.debug(`Native search index saved successfully: ${getNativeSearchIndexPath(pdfPath)}`);
}

export async function ensureNativeSearchIndexBestEffort(
    pdfPath: string,
    index: INativeSearchIndexInput,
    documentRevision: TDocumentRevisionToken,
    signal?: AbortSignal,
) {
    try {
        throwIfAborted(signal);
        if (!(await shouldRewriteNativeSearchIndex(pdfPath, index, documentRevision))) {
            return;
        }
        await persistNativeSearchIndex(pdfPath, index, documentRevision, signal);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        log.debug(`Failed to save native search index: ${getErrorMessage(error)}`);
    }
}
