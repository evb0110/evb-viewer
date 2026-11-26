import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {
    type TSearchResultOffset,
    type IPdfSearchResult,
    type IResolvedSearchMatchOptions,
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@contracts/search';
import {
    concatUint8Arrays,
    encodePdfSearchPageRecord,
    isStaleSearchIndexAnswer,
    SEARCH_INDEX_COVERAGE_SCHEMA,
    SEARCH_INDEX_RESPONSE_SCHEMA,
    SEARCH_INDEX_TEXT_BUDGET,
    type IPdfSearchWasmQueryFields,
    type ISearchIndexCoverage,
    type ISearchIndexResponse,
} from '@contracts/searchIndexWire';
import {
    registerMainOperation,
    runWithMainOperationCancellationSignal,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import type {IPageText} from '@electron/features/search/pageText';
import {runPdfSearchWorkerCommand} from '@electron/features/search/pdfSearchWorkerClient';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {
    getWorkingCopyDerivedPath,
    isWorkingCopyDocumentPath,
} from '@electron/file-access/documentStore';
import * as v from 'valibot';

/**
 * A document whose text is indexed for search. The index file is a derived
 * cache keyed by the document revision: `evb-pdf-search.wasm` reports a missing
 * or foreign-revision file as stale and the index is rebuilt from `readPages`.
 */
export interface ISearchIndexedDocument {
    indexPath: string;
    documentRevision: string;
    /** The working copy whose close cancels an index build. */
    workingCopyPath?: string;
    /** The document's page count, so coverage stays whole when the index ends early. */
    readPageCount?(signal: AbortSignal): Promise<number>;
    /** Progress may precede the text; streamed page numbers must not go below it. */
    readPages(signal: AbortSignal, pageCount: number | undefined, onProgress: (pageNumber: number) => void): AsyncIterable<IPageText>;
}

export interface ISearchQueryOptions extends IResolvedSearchMatchOptions {
    pages?: readonly number[];
    limit?: number;
    resultOffset?: TSearchResultOffset;
}

/**
 * Names how page text is extracted. Changing extraction changes this, so
 * indexes built the old way no longer match their document and are rebuilt.
 */
function indexRevision(document: ISearchIndexedDocument) {
    return `text-6:${document.documentRevision}`;
}

export function getSearchIndexPath(documentPath: string) {
    return isWorkingCopyDocumentPath(documentPath)
        ? getWorkingCopyDerivedPath(documentPath, 'search-index')
        : `${documentPath}.evb-search-index`;
}

function unwrapIndexAnswer(value: unknown) {
    return isStaleSearchIndexAnswer(value) ? null : value;
}

interface IIndexBuildFollower {
    /** A page was reached; once its record is buffered, `input.writtenBytes` includes it. */
    onProgress?(pagesScanned: number): void;
}

interface IIndexBuild {
    promise: Promise<ISearchIndexCoverage>;
    followers: Set<IIndexBuildFollower>;
    /** Extracted binary page records held directly in memory for provisional search and indexing. */
    input: {
        chunks: Uint8Array[];
        writtenBytes: number;
        pagesScanned: number;
    };
    cancel: () => void;
}

const builds = new Map<string, IIndexBuild>();

/**
 * Runs a build outside the cancellation of the request that starts it: the
 * build is shared, so the first search's invoke ending must not stop it for
 * the searches that joined it.
 */
const SHARED_BUILD_CANCELLATION = new AbortController().signal;

async function collectIndexInputInMemory(
    pages: AsyncIterable<IPageText>,
    input: IIndexBuild['input'],
    onPage: (page: IPageText) => void,
    signal: AbortSignal,
) {
    let totalTextBytes = 0;
    for await (const page of pages) {
        signal.throwIfAborted();
        const textBytes = Buffer.byteLength(page.text);
        totalTextBytes += textBytes;
        if (
            textBytes > SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes
            || totalTextBytes > SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes
        ) {
            const overBudgetRecord = encodePdfSearchPageRecord({
                pageNumber: page.pageNumber,
                overBudget: true,
            });
            input.chunks.push(overBudgetRecord);
            input.writtenBytes += overBudgetRecord.byteLength;
            return;
        }
        const record = encodePdfSearchPageRecord({
            pageNumber: page.pageNumber,
            text: page.text,
        });
        input.chunks.push(record);
        input.writtenBytes += record.byteLength;
        onPage(page);
    }
}

async function runIndexBuild(
    document: ISearchIndexedDocument,
    followers: ReadonlySet<IIndexBuildFollower>,
    input: IIndexBuild['input'],
    signal: AbortSignal,
) {
    await mkdir(dirname(document.indexPath), {recursive: true});
    const pageCount = await document.readPageCount?.(signal);
    const reportProgress = (pageNumber: number) => {
        input.pagesScanned = Math.max(input.pagesScanned, pageNumber);
        for (const follower of followers) {
            follower.onProgress?.(pageNumber);
        }
    };
    let rawCoverage: unknown;
    try {
        // Extraction finishes and releases its resources before the indexer runs.
        await collectIndexInputInMemory(
            document.readPages(signal, pageCount, reportProgress),
            input,
            page => reportProgress(page.pageNumber),
            signal,
        );
        const pagesBuffer = concatUint8Arrays(input.chunks, input.writtenBytes);
        input.chunks.length = 0;
        rawCoverage = await runPdfSearchWorkerCommand({
            op: 'index',
            indexPath: document.indexPath,
            documentRevision: indexRevision(document),
            ...(pageCount !== undefined && pageCount > 0 ? {pageCount} : {}),
            maxPageTextBytes: SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes,
            maxTotalTextBytes: SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes,
            pagesBuffer,
        }, signal);
    } finally {
        input.chunks.length = 0;
    }
    const parsed = v.safeParse(SEARCH_INDEX_COVERAGE_SCHEMA, unwrapIndexAnswer(rawCoverage), {abortEarly: true});
    if (!parsed.success) {
        throw new Error('evb-pdf-search index returned an invalid coverage report');
    }
    return parsed.output;
}

function startIndexBuild(document: ISearchIndexedDocument, key: string) {
    const operation = registerMainOperation({
        kind: 'abortable-work',
        workingCopyPath: document.workingCopyPath,
        // The build listens to operation.signal; the hook makes it eligible
        // for cancellation when its working copy closes.
        cancel: () => undefined,
    });
    const {signal} = operation;
    const followers = new Set<IIndexBuildFollower>();
    const input: IIndexBuild['input'] = {
        chunks: [],
        writtenBytes: 0,
        pagesScanned: 0,
    };
    // A build that is stopping is no longer joined: a search that arrives
    // while it unwinds starts a fresh build instead of sharing its failure.
    const release = () => {
        if (builds.get(key) === build) {
            builds.delete(key);
        }
    };
    signal.addEventListener('abort', release, {once: true});
    const build: IIndexBuild = {
        promise: runIndexBuild(document, followers, input, signal).finally(() => {
            signal.removeEventListener('abort', release);
            release();
            operation.complete();
        }),
        followers,
        input,
        cancel: () => operation.abort('Search index build canceled'),
    };
    builds.set(key, build);
    return build;
}

/**
 * The document's index build for its revision: the running one, or a new
 * one. A build is not tied to the search that started it, so a newer query
 * joins it. Closing the working copy or shutting down stops it.
 */
function reserveIndexBuild(document: ISearchIndexedDocument) {
    const key = `${document.indexPath}\0${document.documentRevision}`;
    return builds.get(key) ?? runWithMainOperationCancellationSignal(
        SHARED_BUILD_CANCELLATION,
        () => startIndexBuild(document, key),
    );
}

/** Waits for a build, following its progress until it settles or `signal` aborts. */
async function awaitIndexBuild(
    build: IIndexBuild,
    onProgress: ((pagesScanned: number) => void) | undefined,
    signal: AbortSignal | undefined,
) {
    const follower = {...(onProgress === undefined ? {} : {onProgress})};
    build.followers.add(follower);
    try {
        return await awaitWithSignal(build.promise, signal);
    } finally {
        build.followers.delete(follower);
    }
}

/**
 * Builds the document's index once per revision; concurrent callers share
 * the build and its progress. A caller that gives up stops following it.
 */
export function buildSearchIndex(
    document: ISearchIndexedDocument,
    context: {
        signal?: AbortSignal;
        onProgress?: (pagesScanned: number) => void;
    } = {},
): Promise<ISearchIndexCoverage> {
    context.signal?.throwIfAborted();
    const build = reserveIndexBuild(document);
    if (build.input.pagesScanned > 0) {
        context.onProgress?.(build.input.pagesScanned);
    }
    return awaitIndexBuild(build, context.onProgress, context.signal);
}

/** Stops index builds for a document whose revision moved on. */
export function cancelSearchIndexBuilds(indexPath: string) {
    for (const [
        key,
        build,
    ] of builds) {
        if (key.startsWith(`${indexPath}\0`)) {
            build.cancel();
        }
    }
}

const log = createLogger('search-index');

/** The first window of a query over the pages extracted so far, in document order. */
export interface IProvisionalSearchMatches {
    results: IPdfSearchResult[];
    /** A match past the window exists, as in the indexed answer. */
    truncated: boolean;
}

/**
 * Text buffered since the last provisional search must reach this multiple of
 * what it read before the next one, so the rescans of a growing document
 * cost a small multiple of reading it once.
 */
const PROVISIONAL_RESCAN_GROWTH = 1.25;

function searchQueryFields(query: string, options: ISearchQueryOptions): IPdfSearchWasmQueryFields {
    return {
        query,
        limit: options.limit ?? SEARCH_RESULT_LIMIT,
        contextChars: SEARCH_EXCERPT_CONTEXT_CHARS,
        ...(options.resultOffset === undefined ? {} : {resultOffset: options.resultOffset}),
        matchCase: options.matchCase,
        wholeWord: options.wholeWord,
        useRegex: options.useRegex,
        ...(options.pages && options.pages.length > 0 ? {pages: options.pages} : {}),
    };
}

function parseSearchResponse(response: unknown) {
    const parsed = v.safeParse(SEARCH_INDEX_RESPONSE_SCHEMA, response, {abortEarly: true});
    if (!parsed.success) {
        throw new Error('evb-pdf-search returned an invalid search response');
    }
    return parsed.output;
}

/**
 * Streams the first window of a literal query while its index is built. The
 * warm WASM search worker reads the buffered page snapshot directly in memory,
 * so the matches follow the indexed answer's rules with no temp-file round-trip
 * and without blocking the main process. The indexed answer replaces these
 * matches, so a failure only ends them.
 */
function followProvisionalMatches(
    build: IIndexBuild,
    document: ISearchIndexedDocument,
    queryFields: IPdfSearchWasmQueryFields,
    onMatches: (matches: IProvisionalSearchMatches) => void,
) {
    const controller = new AbortController();
    let searchedBytes = 0;
    let reported = false;
    let finished = false;
    let running: Promise<void> | null = null;
    const search = async (pagesBuffer: Uint8Array) => {
        const raw = await runPdfSearchWorkerCommand({
            op: 'searchPages',
            documentRevision: indexRevision(document),
            allowRegex: false,
            pagesBuffer,
            ...queryFields,
        }, controller.signal);
        const response = parseSearchResponse(raw);
        if (controller.signal.aborted || (!reported && response.results.length === 0)) return;
        reported = true;
        onMatches({
            results: response.results,
            truncated: response.truncated,
        });
        // The window holds the first matches in page order; once a match past
        // it exists, more pages cannot change it.
        finished ||= response.truncated;
    };
    const schedule = () => {
        const {
            chunks,
            writtenBytes,
        } = build.input;
        if (
            finished
            || running !== null
            || controller.signal.aborted
            || chunks.length === 0
            || writtenBytes <= searchedBytes * PROVISIONAL_RESCAN_GROWTH
        ) return;
        const snapshot = concatUint8Arrays(chunks);
        searchedBytes = snapshot.byteLength;
        running = search(snapshot).catch((error: unknown) => {
            finished = true;
            if (!controller.signal.aborted) {
                log.debug('Provisional search matches stopped', {error: getErrorMessage(error)});
            }
        }).finally(() => {
            running = null;
            schedule();
        });
    };
    const follower = {onProgress: schedule};
    build.followers.add(follower);
    schedule();
    return async () => {
        controller.abort();
        build.followers.delete(follower);
        while (running !== null) await running;
    };
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined) {
    if (!signal) {
        return promise;
    }
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/** Searches the document, building its index first when it is missing or stale. */
export async function searchIndexedDocument(
    document: ISearchIndexedDocument,
    query: string,
    options: ISearchQueryOptions,
    context: {
        signal?: AbortSignal;
        onIndexProgress?: (pagesScanned: number) => void;
        /**
         * While the index is built, the first window of a literal query as
         * extraction reaches it. The returned response replaces it.
         */
        onProvisionalMatches?: (matches: IProvisionalSearchMatches) => void;
    } = {},
): Promise<ISearchIndexResponse> {
    const queryFields = searchQueryFields(query, options);
    const runSearch = async () => unwrapIndexAnswer(await runPdfSearchWorkerCommand({
        op: 'search',
        indexPath: document.indexPath,
        documentRevision: indexRevision(document),
        ...queryFields,
    }, context.signal));

    let response = await runSearch();
    if (response === null) {
        context.signal?.throwIfAborted();
        const build = reserveIndexBuild(document);
        if (build.input.pagesScanned > 0) {
            context.onIndexProgress?.(build.input.pagesScanned);
        }
        // Only the first window of a literal query is shown before the index
        // exists: rescanning a growing document for a regex that matches empty
        // at every position repeats work the index does once.
        const stopProvisionalMatches = context.onProvisionalMatches && !options.useRegex && (options.resultOffset ?? 0) === 0
            ? followProvisionalMatches(build, document, queryFields, context.onProvisionalMatches)
            : null;
        try {
            await awaitIndexBuild(build, context.onIndexProgress, context.signal);
        } finally {
            await stopProvisionalMatches?.();
        }
        response = await runSearch();
    }
    return parseSearchResponse(response);
}

/** Reports the index coverage, building the index first when needed. */
export async function ensureSearchIndex(
    document: ISearchIndexedDocument,
    context: {
        signal?: AbortSignal;
        onIndexProgress?: (pagesScanned: number) => void;
    } = {},
): Promise<ISearchIndexCoverage> {
    const coverage = unwrapIndexAnswer(await runPdfSearchWorkerCommand({
        op: 'stat',
        indexPath: document.indexPath,
        documentRevision: indexRevision(document),
    }, context.signal));
    const parsed = v.safeParse(SEARCH_INDEX_COVERAGE_SCHEMA, coverage, {abortEarly: true});
    if (parsed.success) {
        return parsed.output;
    }
    return buildSearchIndex(document, {
        ...(context.signal === undefined ? {} : {signal: context.signal}),
        ...(context.onIndexProgress === undefined ? {} : {onProgress: context.onIndexProgress}),
    });
}
