import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    mkdir,
    rm,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    type TSearchResultOffset,
    type IPdfSearchResult,
    type IResolvedSearchMatchOptions,
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
} from '@contracts/search';
import {
    isStaleSearchIndexAnswer,
    SEARCH_INDEX_COVERAGE_SCHEMA,
    SEARCH_INDEX_RESPONSE_SCHEMA,
    SEARCH_INDEX_TEXT_BUDGET,
    type ISearchIndexCoverage,
    type ISearchIndexResponse,
} from '@contracts/searchIndexWire';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {
    registerMainOperation,
    runWithMainOperationCancellationSignal,
} from '@electron/operation-lifecycle/mainOperationLifecycle';
import type { IPageText } from '@electron/features/search/pageText';
import { writeSearchIndexInput } from '@electron/features/search/writeSearchIndexInput';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    getWorkingCopyDerivedPath,
    isWorkingCopyDocumentPath,
} from '@electron/file-access/documentStore';
import * as v from 'valibot';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A document whose text is indexed for search. The index file is a derived
 * cache keyed by the document revision: `evb-pdf-search` reports a missing
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

function resolvePdfSearchBinary() {
    const binaryPath = resolveNativeToolPath({
        binaryName: process.platform === 'win32' ? 'evb-pdf-search.exe' : 'evb-pdf-search',
        crateName: 'pdf-search',
        currentDir: __dirname,
        isPackaged: __dirname.includes('app.asar'),
    });
    if (!binaryPath) {
        throw new Error('evb-pdf-search is unavailable');
    }
    return binaryPath;
}

function parseOutput(stdout: string) {
    const value: unknown = JSON.parse(stdout);
    return isStaleSearchIndexAnswer(value) ? null : value;
}

interface IIndexBuildFollower {
    /** A page was reached; once its text is written, `input.writtenBytes` includes it. */
    onProgress?(pagesScanned: number): void;
}

interface IIndexBuild {
    promise: Promise<ISearchIndexCoverage>;
    followers: Set<IIndexBuildFollower>;
    /** The extracted text, and the length of its complete page lines. */
    input: {
        path: string;
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
    let result: Awaited<ReturnType<typeof runNativeToolCommand>>;
    try {
        // Extraction ends, and releases what it held, before the indexer starts.
        await writeSearchIndexInput(input.path, document.readPages(signal, pageCount, reportProgress), (page, writtenBytes) => {
            input.writtenBytes = writtenBytes;
            reportProgress(page.pageNumber);
        }, signal);
        result = await runNativeToolCommand(resolvePdfSearchBinary(), [
            'index',
            '--out',
            document.indexPath,
            '--document-revision',
            indexRevision(document),
            ...(pageCount !== undefined && pageCount > 0 ? [
                '--page-count',
                String(pageCount),
            ] : []),
            '--max-page-text-bytes',
            String(SEARCH_INDEX_TEXT_BUDGET.maxPageTextBytes),
            '--max-total-text-bytes',
            String(SEARCH_INDEX_TEXT_BUDGET.maxTotalTextBytes),
        ], {
            commandLabel: 'evb-pdf-search(index)',
            signal,
            stdin: (async function* readInput() { yield* createReadStream(input.path, {encoding: 'utf8'}); })(),
        });
    } finally {
        await rm(input.path, {force: true});
    }
    const parsed = v.safeParse(SEARCH_INDEX_COVERAGE_SCHEMA, parseOutput(result.stdout), {abortEarly: true});
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
    const input = {
        path: `${document.indexPath}.${randomUUID()}.input`,
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
 * joins it. Closing the working copy or shutting down stops it. The page text
 * is extracted into a file beside the index before the indexer starts, and
 * opened only as the indexer reads it, so a failed start leaves no open file.
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
 * Text written since the last provisional search must reach this multiple of
 * what it read before the next one, so the rescans of a growing document
 * cost a small multiple of reading it once.
 */
const PROVISIONAL_RESCAN_GROWTH = 1.25;

function searchQueryArgs(query: string, options: ISearchQueryOptions) {
    return [
        '--query',
        query,
        '--limit',
        String(options.limit ?? SEARCH_RESULT_LIMIT),
        '--context',
        String(SEARCH_EXCERPT_CONTEXT_CHARS),
        ...(options.resultOffset === undefined ? [] : [
            '--result-offset',
            options.resultOffset === 'last' ? '-1' : String(options.resultOffset),
        ]),
        ...(options.matchCase ? ['--match-case'] : []),
        ...(options.wholeWord ? ['--whole-word'] : []),
        ...(options.useRegex ? ['--regex'] : []),
        ...(options.pages && options.pages.length > 0 ? [
            '--pages',
            options.pages.join(','),
        ] : []),
    ];
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
 * indexer's own searcher reads the text the build has written so far, so the
 * matches follow the indexed answer's rules and the matching runs outside the
 * main process: a JavaScript regex here blocked it for a third of a second on
 * one page of blank layout space. A search that joins a running build starts
 * from everything the build has already written. The indexed answer replaces
 * these matches, so a failure only ends them.
 */
function followProvisionalMatches(
    build: IIndexBuild,
    document: ISearchIndexedDocument,
    queryArgs: readonly string[],
    onMatches: (matches: IProvisionalSearchMatches) => void,
) {
    const controller = new AbortController();
    let searchedBytes = 0;
    let reported = false;
    let finished = false;
    let running: Promise<void> | null = null;
    const search = async (path: string, writtenBytes: number) => {
        const result = await runNativeToolCommand(resolvePdfSearchBinary(), [
            'search',
            '--pages-from-stdin',
            '--document-revision',
            indexRevision(document),
            ...queryArgs,
        ], {
            commandLabel: 'evb-pdf-search(provisional search)',
            maxStdoutBytes: 16 * 1024 * 1024,
            signal: controller.signal,
            stdin: (async function* readWrittenPages() {
                yield* createReadStream(path, {
                    start: 0,
                    end: writtenBytes - 1,
                    encoding: 'utf8',
                });
            })(),
        });
        const response = parseSearchResponse(JSON.parse(result.stdout));
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
            path, writtenBytes,
        } = build.input;
        if (finished || running !== null || controller.signal.aborted
            || writtenBytes <= searchedBytes * PROVISIONAL_RESCAN_GROWTH) return;
        searchedBytes = writtenBytes;
        running = search(path, writtenBytes).catch((error: unknown) => {
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

async function runIndexQuery(command: 'search' | 'stat', args: string[], signal: AbortSignal | undefined) {
    const result = await runNativeToolCommand(resolvePdfSearchBinary(), [
        command,
        ...args,
    ], {
        commandLabel: `evb-pdf-search(${command})`,
        maxStdoutBytes: 16 * 1024 * 1024,
        ...(signal === undefined ? {} : {signal}),
    });
    return parseOutput(result.stdout);
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
    const queryArgs = searchQueryArgs(query, options);
    const args = [
        '--index',
        document.indexPath,
        '--document-revision',
        indexRevision(document),
        ...queryArgs,
    ];
    let response = await runIndexQuery('search', args, context.signal);
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
            ? followProvisionalMatches(build, document, queryArgs, context.onProvisionalMatches)
            : null;
        try {
            await awaitIndexBuild(build, context.onIndexProgress, context.signal);
        } finally {
            await stopProvisionalMatches?.();
        }
        response = await runIndexQuery('search', args, context.signal);
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
    const coverage = await runIndexQuery('stat', [
        '--index',
        document.indexPath,
        '--document-revision',
        indexRevision(document),
    ], context.signal);
    const parsed = v.safeParse(SEARCH_INDEX_COVERAGE_SCHEMA, coverage, {abortEarly: true});
    if (parsed.success) {
        return parsed.output;
    }
    return buildSearchIndex(document, {
        ...(context.signal === undefined ? {} : {signal: context.signal}),
        ...(context.onIndexProgress === undefined ? {} : {onProgress: context.onIndexProgress}),
    });
}
