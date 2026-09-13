import { getErrorMessage } from '@app/utils/error';
import type { MaybeRefOrGetter } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type { IResolvedSearchMatchOptions } from '@contracts/search';
import { DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH } from '@contracts/search';
import { DEFAULT_DOCUMENT_SEARCH_OPTIONS } from '@app/utils/document-viewer/providers/documentSearch';
import type {
    IDocumentSearchBackend,
    IDocumentSearchMatch,
    IDocumentSearchProgress,
    IDocumentSearchSession,
    TDocumentSearchDirection,
} from '@app/utils/document-viewer/search/documentSearch';

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
        const delta = direction === 'next' ? 1 : -1;
        return select((currentResultIndex.value + delta + resultCount) % resultCount);
    }

    async function run() {
        cancel();
        const backend = toValue(options.backend);
        const normalizedQuery = query.value.trim();
        submittedQuery.value = normalizedQuery;
        resetResults();
        if (!backend || normalizedQuery.length < minQueryLength.value) {
            return false;
        }

        const controller = new AbortController();
        const currentSourceGeneration = sourceGeneration;
        const currentRunGeneration = runGeneration;
        const currentDocumentRevision = toValue(options.documentRevision);
        activeController = controller;
        isSearching.value = true;
        progress.value = {
            processed: 0,
            total: 0,
        };
        try {
            const response = await backend.search({
                query: normalizedQuery,
                matchOptions: searchOptions.value,
                signal: controller.signal,
                onProgress: nextProgress => {
                    if (
                        !controller.signal.aborted
                        && currentRunGeneration === runGeneration
                        && currentSourceGeneration === sourceGeneration
                    ) progress.value = nextProgress;
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
            results.value = [...response.results];
            isTruncated.value = response.truncated;
            if (results.value.length > 0) select(0);
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
