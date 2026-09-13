import type { Ref } from 'vue';
import type { IResolvedSearchMatchOptions } from '@contracts/search';
import type { IPdfSearchMatch } from '@app/types/pdfUi';
import type {
    IDocumentSearchProgress,
    IDocumentSearchSession,
    TDocumentSearchDirection,
} from '@app/modules/document-viewer/public';

interface ICreatePdfDocumentSearchSessionOptions {
    query: Readonly<Ref<string>>;
    submittedQuery: Readonly<Ref<string>>;
    options: Readonly<Ref<IResolvedSearchMatchOptions>>;
    results: Readonly<Ref<IPdfSearchMatch[]>>;
    currentResultIndex: Readonly<Ref<number>>;
    currentResultNavigationId: Readonly<Ref<number>>;
    isSearching: Readonly<Ref<boolean>>;
    error: Readonly<Ref<string | null>>;
    progress: Readonly<Ref<IDocumentSearchProgress | undefined>>;
    isTruncated: Readonly<Ref<boolean>>;
    minQueryLength: Readonly<Ref<number>>;
    setQuery: (query: string) => void;
    setOptions: (options: IResolvedSearchMatchOptions) => void;
    run: () => void;
    clear: () => void;
    cancel: () => void;
    select: (index: number) => void;
    navigate: (direction: TDocumentSearchDirection) => void;
}

/** Projects the indexed PDF engine through the shared document-search contract. */
export function createPdfDocumentSearchSession(
    options: ICreatePdfDocumentSearchSessionOptions,
): IDocumentSearchSession {
    return {
        query: options.query,
        submittedQuery: options.submittedQuery,
        options: options.options,
        results: options.results,
        currentResultIndex: options.currentResultIndex,
        currentResultNavigationId: options.currentResultNavigationId,
        isSearching: options.isSearching,
        error: options.error,
        progress: options.progress,
        isTruncated: options.isTruncated,
        minQueryLength: options.minQueryLength,
        setQuery: options.setQuery,
        setOptions: options.setOptions,
        run() {
            options.run();
            return Promise.resolve(true);
        },
        clear: options.clear,
        cancel: options.cancel,
        select(index) {
            if (!options.results.value[index]) {
                return false;
            }
            options.select(index);
            return true;
        },
        navigate(direction) {
            if (options.results.value.length === 0) {
                return false;
            }
            options.navigate(direction);
            return true;
        },
    };
}
