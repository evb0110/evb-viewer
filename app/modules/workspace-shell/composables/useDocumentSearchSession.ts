import { getErrorMessage } from '@app/utils/error';
import type { MaybeRefOrGetter } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type {
    IResolvedSearchMatchOptions, TSearchResultOffset,
} from '@contracts/search';
import {
    DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH, SEARCH_RESULT_LIMIT,
} from '@contracts/search';
import {
    DEFAULT_DOCUMENT_SEARCH_OPTIONS,
    getDocumentSearchQueryError,
    resolveDocumentSearchQuery,
} from '@app/modules/document-viewer/public';
import type {
    IDocumentSearchBackend,
    IDocumentSearchMatch,
    IDocumentSearchProgress,
    IDocumentSearchSession,
    TDocumentSearchDirection,
} from '@app/modules/document-viewer/public';

interface IUseDocumentSearchSessionOptions {
    backend: MaybeRefOrGetter<IDocumentSearchBackend | null>;
    documentRevision?: MaybeRefOrGetter<string | null | undefined>;
    onNavigate?: ((match: IDocumentSearchMatch, index: number) => void) | undefined;
    normalizeError?: ((error: unknown) => string) | undefined;
}

function isAbortError(error: unknown) {
    return typeof error === 'object'
        && error !== null
        && 'name' in error
        && error.name === 'AbortError';
}

function defaultSearchError(error: unknown) {
    return getErrorMessage(error);
}

/** Workspace-owned search state with latest-run and latest-backend authority. */
export const useDocumentSearchSession = (
    options: IUseDocumentSearchSessionOptions,
): IDocumentSearchSession => {
    const { t } = useTypedI18n();
    const query = ref('');
    const submittedQuery = ref('');
    const searchOptions = ref<IResolvedSearchMatchOptions>({...DEFAULT_DOCUMENT_SEARCH_OPTIONS});
    const results = ref<IDocumentSearchMatch[]>([]);
    const currentResultIndex = ref(-1);
    const currentResultNavigationId = ref(0);
    const isSearching = ref(false);
    const error = ref<string | null>(null);
    const progress = ref<IDocumentSearchProgress>();
    const isTruncated = ref(false);
    const minQueryLength = computed(() => (
        toValue(options.backend)?.minQueryLength ?? DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH
    ));
    let activeController: AbortController | null = null;
    let searchCommand: {
        resultOffset?: TSearchResultOffset;
        backend: IDocumentSearchBackend;
        query: string;
        matchOptions: IResolvedSearchMatchOptions
    } | null = null;
    let sourceGeneration = 0;
    let runGeneration = 0;

    function cancel() {
        runGeneration += 1;
        activeController?.abort();
        activeController = null;
        isSearching.value = false;
    }

    function resetResults() {
        results.value = [];
        currentResultIndex.value = -1;
        currentResultNavigationId.value = 0;
        progress.value = undefined;
        error.value = null;
        isTruncated.value = false;
    }

    function clear() {
        searchCommand = null;
        cancel();
        query.value = '';
        submittedQuery.value = '';
        resetResults();
    }

    function select(index: number) {
        const match = results.value[index];
        if (!match) {
            return false;
        }
        currentResultIndex.value = index;
        currentResultNavigationId.value += 1;
        options.onNavigate?.(match, index);
        return true;
    }

    function navigate(direction: TDocumentSearchDirection) {
        const resultCount = results.value.length;
        if (resultCount === 0) {
            return false;
        }
        if (currentResultIndex.value < 0) {
            return select(direction === 'next' ? 0 : resultCount - 1);
        }
        if (isSearching.value || !searchCommand) return false;
        const nextIndex = currentResultIndex.value + (direction === 'next' ? 1 : -1);
        if (nextIndex >= 0 && nextIndex < resultCount) return select(nextIndex);
        const firstOrdinal = results.value[0]!.matchIndex;
        if (!isTruncated.value && (searchCommand.resultOffset ?? 0) === 0) return select(direction === 'next' ? 0 : resultCount - 1);
        const resultOffset = direction === 'next'
            ? isTruncated.value ? results.value.at(-1)!.matchIndex + 1 : 0
            : firstOrdinal > 0 ? Math.max(0, firstOrdinal - SEARCH_RESULT_LIMIT) : 'last';
        void run(resultOffset, direction, direction === 'previous' && firstOrdinal > 0 ? firstOrdinal - 1 : undefined);
        return true;
    }

    async function run(resultOffset?: TSearchResultOffset, direction?: TDocumentSearchDirection, targetMatchIndex?: number) {
        cancel();
        const backend = direction ? searchCommand?.backend : toValue(options.backend);
        const normalizedQuery = direction ? searchCommand?.query ?? '' : resolveDocumentSearchQuery(query.value);
        const matchOptions = direction ? searchCommand!.matchOptions : {...searchOptions.value};
        submittedQuery.value = normalizedQuery;
        if (!direction) resetResults();
        if (!backend || normalizedQuery.length < minQueryLength.value) {
            return false;
        }

        const queryError = getDocumentSearchQueryError(normalizedQuery, matchOptions);
        if (queryError) {
            error.value = t(queryError.key, {count: queryError.count});
            return false;
        }

        const controller = new AbortController();
        const currentSourceGeneration = sourceGeneration;
        const currentRunGeneration = runGeneration;
        const currentDocumentRevision = toValue(options.documentRevision);
        activeController = controller;
        isSearching.value = true;
        if (!direction) progress.value = {
            processed: 0,
            total: 0,
        };
        try {
            const response = await backend.search({
                query: normalizedQuery,
                matchOptions,
                ...(resultOffset === undefined ? {} : {resultOffset}),
                signal: controller.signal,
                onProgress: nextProgress => {
                    if (
                        !controller.signal.aborted
                        && currentRunGeneration === runGeneration
                        && currentSourceGeneration === sourceGeneration
                    ) progress.value = {
                        ...(direction ? progress.value : {}),
                        ...nextProgress,
                    };
                },
            });
            if (
                controller.signal.aborted
                || currentRunGeneration !== runGeneration
                || currentSourceGeneration !== sourceGeneration
                || currentDocumentRevision !== toValue(options.documentRevision)
                || backend !== toValue(options.backend)
            ) {
                return false;
            }
            searchCommand = {
                backend,
                query: normalizedQuery,
                matchOptions,
                ...(resultOffset === undefined ? {} : {resultOffset}),
            };
            results.value = [...response.results];
            isTruncated.value = response.truncated;
            if (response.coverage) progress.value = {
                processed: response.coverage.pagesScanned,
                total: response.coverage.pageCount,
                coverage: response.coverage,
            };
            if (results.value.length > 0) select(targetMatchIndex === undefined
                ? direction === 'previous' ? results.value.length - 1 : 0
                : results.value.findIndex(match => match.matchIndex === targetMatchIndex));
            return true;
        } catch (caught) {
            if (
                !controller.signal.aborted
                && !isAbortError(caught)
                && currentRunGeneration === runGeneration
                && currentSourceGeneration === sourceGeneration
                && currentDocumentRevision === toValue(options.documentRevision)
            ) error.value = (options.normalizeError ?? defaultSearchError)(caught);
            return false;
        } finally {
            if (activeController === controller) {
                activeController = null;
                isSearching.value = false;
            }
        }
    }

    watch(
        [
            () => toValue(options.backend),
            () => toValue(options.documentRevision),
        ],
        () => {
            sourceGeneration += 1;
            clear();
        },
        {flush: 'sync'},
    );
    tryOnScopeDispose(cancel);

    function setQuery(nextQuery: string) {
        query.value = nextQuery;
    }

    function setOptions(nextOptions: IResolvedSearchMatchOptions) {
        searchOptions.value = nextOptions;
    }

    return {
        query,
        submittedQuery,
        options: searchOptions,
        results,
        currentResultIndex,
        currentResultNavigationId,
        isSearching,
        error,
        progress,
        isTruncated,
        minQueryLength,
        setQuery,
        setOptions,
        run,
        clear,
        cancel,
        select,
        navigate,
    };
};
