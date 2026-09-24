import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    SEARCH_EXCERPT_CONTEXT_CHARS,
    SEARCH_RESULT_LIMIT,
    SEARCH_WIRE_CODEC,
    type IPdfSearchResult,
} from '@contracts/search';
import { isRecord } from '@contracts/runtimeGuards';
import { resolveNativeToolPath } from '@electron/native-tools/resolveNativeToolPath';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';
import type { IPageText } from '@electron/features/search/pageText';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ISearchIndexCoverage {
    pageCount: number;
    pagesScanned: number;
    pagesWritten: number;
    truncated: boolean;
    missingTextPageSample: number[];
}

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
    readPages(signal: AbortSignal): AsyncIterable<IPageText>;
}

export interface ISearchQueryOptions {
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
    pages?: readonly number[];
    limit?: number;
}

export interface ISearchIndexResponse {
    results: IPdfSearchResult[];
    truncated: boolean;
    pageCount: number;
    coverage: ISearchIndexCoverage;
}

/**
 * Names how page text is extracted. Changing extraction changes this, so
 * indexes built the old way no longer match their document and are rebuilt.
 */
const INDEX_TEXT_VERSION = 'text-2';

function indexRevision(document: ISearchIndexedDocument) {
    return `${INDEX_TEXT_VERSION}:${document.documentRevision}`;
}

export function getSearchIndexPath(documentPath: string) {
    return `${documentPath}.evb-search-index`;
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

function isCoverage(value: unknown): value is ISearchIndexCoverage {
    return isRecord(value)
        && Number.isSafeInteger(value.pageCount)
        && Number.isSafeInteger(value.pagesScanned)
        && Number.isSafeInteger(value.pagesWritten)
        && typeof value.truncated === 'boolean'
        && Array.isArray(value.missingTextPageSample)
        && value.missingTextPageSample.every(page => Number.isSafeInteger(page));
}

function parseOutput(stdout: string) {
    const value: unknown = JSON.parse(stdout);
    if (isRecord(value) && value.stale === true) {
        return null;
    }
    return value;
}

interface IIndexBuild {
    promise: Promise<ISearchIndexCoverage>;
    listeners: Set<(pagesScanned: number) => void>;
    cancel: () => void;
}

const builds = new Map<string, IIndexBuild>();

async function* toJsonLines(pages: AsyncIterable<IPageText>, onPage: (pageNumber: number) => void) {
    for await (const page of pages) {
        onPage(page.pageNumber);
        yield `${JSON.stringify({
            pageNumber: page.pageNumber,
            text: page.text,
        })}\n`;
    }
}

/**
 * Builds the document's index once per revision; concurrent callers share the
 * build and its progress. A build is not tied to the search that started it,
 * so a newer query reuses it. Closing the working copy or shutting down stops it.
 */
export function buildSearchIndex(
    document: ISearchIndexedDocument,
    onProgress?: (pagesScanned: number) => void,
): Promise<ISearchIndexCoverage> {
    const key = `${document.indexPath}\0${document.documentRevision}`;
    let build = builds.get(key);
    if (!build) {
        const controller = new AbortController();
        const operation = registerMainOperation({
            kind: 'abortable-work',
            workingCopyPath: document.workingCopyPath,
            cancel: reason => controller.abort(new Error(reason)),
        });
        const signal = AbortSignal.any([
            controller.signal,
            operation.signal,
        ]);
        const listeners = new Set<(pagesScanned: number) => void>();
        const promise = runNativeToolCommand(resolvePdfSearchBinary(), [
            'index',
            '--out',
            document.indexPath,
            '--document-revision',
            indexRevision(document),
        ], {
            commandLabel: 'evb-pdf-search(index)',
            signal,
            stdin: toJsonLines(document.readPages(signal), (pageNumber) => {
                for (const listener of listeners) {
                    listener(pageNumber);
                }
            }),
        }).then((result) => {
            const coverage = parseOutput(result.stdout);
            if (!isCoverage(coverage)) {
                throw new Error('evb-pdf-search index returned an invalid coverage report');
            }
            return coverage;
        }).finally(() => {
            operation.complete();
            builds.delete(key);
        });
        build = {
            promise,
            listeners,
            cancel: () => controller.abort(new Error('Search index build canceled')),
        };
        builds.set(key, build);
    }
    if (onProgress) {
        const listeners = build.listeners;
        listeners.add(onProgress);
        void build.promise.finally(() => listeners.delete(onProgress)).catch(() => undefined);
    }
    return build.promise;
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

function searchArgs(document: ISearchIndexedDocument, query: string, options: ISearchQueryOptions) {
    return [
        '--index',
        document.indexPath,
        '--document-revision',
        indexRevision(document),
        '--query',
        query,
        '--limit',
        String(options.limit ?? SEARCH_RESULT_LIMIT),
        '--context',
        String(SEARCH_EXCERPT_CONTEXT_CHARS),
        ...(options.matchCase ? ['--match-case'] : []),
        ...(options.wholeWord ? ['--whole-word'] : []),
        ...(options.useRegex ? ['--regex'] : []),
        ...(options.pages && options.pages.length > 0 ? [
            '--pages',
            options.pages.join(','),
        ] : []),
    ];
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
    } = {},
): Promise<ISearchIndexResponse> {
    const args = searchArgs(document, query, options);
    let response = await runIndexQuery('search', args, context.signal);
    if (response === null) {
        await awaitWithSignal(buildSearchIndex(document, context.onIndexProgress), context.signal);
        response = await runIndexQuery('search', args, context.signal);
    }
    const results = isRecord(response) && Array.isArray(response.results)
        ? response.results.map(result => SEARCH_WIRE_CODEC.decodeResult(result))
        : null;
    if (
        !isRecord(response)
        || results === null
        || results.some(result => result === null)
        || typeof response.truncated !== 'boolean'
        || !isCoverage(response.coverage)
    ) {
        throw new Error('evb-pdf-search returned an invalid search response');
    }
    return {
        results: results.filter(result => result !== null),
        truncated: response.truncated,
        pageCount: response.coverage.pageCount,
        coverage: response.coverage,
    };
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
    if (isCoverage(coverage)) {
        return coverage;
    }
    return awaitWithSignal(buildSearchIndex(document, context.onIndexProgress), context.signal);
}
