import {
    createAllPageSelection,
    createExplicitPageSelection,
    createPredicatePageSelection,
    createRangePageSelection,
    iteratePageSelectionBatches,
    materializePageSelection,
    normalizeSelectedPageNumbers,
    pageSelectionCount,
} from '@app/utils/pdfPageSelection';
import type { TPageSelection } from '@app/utils/pdfPageSelection';

export type TPdfPageScope = 'all' | 'current' | 'selected' | 'range' | 'even' | 'odd';

interface IPdfPageScopeSelectionOptions {
    totalPages: () => number;
    currentPage: () => number;
    selectedPages?: () => number[];
    selectedPageSelection?: () => TPageSelection | null;
    resolveRangePages?: () => number[] | null;
    resolveRangeSelection?: () => TPageSelection | null;
}

interface IResolveScopedPageNumbersOptions { includeAllPages?: boolean; }

export const usePdfPageScopeSelection = (options: IPdfPageScopeSelectionOptions) => {
    const scope = ref<TPdfPageScope>('all');
    const rangeInput = ref('');
    const rangeTouched = ref(false);

    const normalizedSelectedPages = computed(() => normalizeSelectedPageNumbers(
        options.selectedPages?.() ?? [],
        options.totalPages(),
    ));

    const normalizedSelectedPageSelection = computed<TPageSelection>(() => {
        const pageCount = options.totalPages();
        const provided = options.selectedPageSelection?.();
        if (provided && provided.pageCount === pageCount) {
            return provided;
        }
        return createExplicitPageSelection(pageCount, normalizedSelectedPages.value);
    });

    function resetScopeForOpen(defaultScope?: TPdfPageScope) {
        scope.value = defaultScope ?? (
            pageSelectionCount(normalizedSelectedPageSelection.value) > 0 ? 'selected' : 'all'
        );
        rangeInput.value = '';
        rangeTouched.value = false;
    }

    function resolveScopedPageNumbers(
        resolveOptions: IResolveScopedPageNumbersOptions = {},
    ): number[] | undefined | null {
        if (scope.value === 'all') {
            return resolveOptions.includeAllPages
                ? materializePageSelection(createAllPageSelection(options.totalPages()))
                : undefined;
        }
        if (scope.value === 'current') {
            const page = options.currentPage();
            return page >= 1 && page <= options.totalPages() ? [page] : null;
        }
        if (scope.value === 'even') {
            return materializePageSelection(createPredicatePageSelection(options.totalPages(), 'even'));
        }
        if (scope.value === 'odd') {
            return materializePageSelection(createPredicatePageSelection(options.totalPages(), 'odd'));
        }
        if (scope.value === 'selected') {
            return normalizedSelectedPages.value.length > 0 ? normalizedSelectedPages.value : null;
        }
        const selection = resolveRangeSelection();
        return selection ? materializePageSelection(selection) : null;
    }

    function resolveRangeSelection(): TPageSelection | null {
        const provided = options.resolveRangeSelection?.();
        if (provided) {
            return provided;
        }
        const pages = options.resolveRangePages?.();
        if (!pages || pages.length === 0) {
            return null;
        }
        const normalized = normalizeSelectedPageNumbers(pages, options.totalPages());
        if (normalized.length === 0) {
            return null;
        }
        const first = normalized[0];
        const last = normalized.at(-1);
        if (first === undefined || last === undefined) {
            return null;
        }
        const isContiguous = normalized.every((page, index) => page === first + index);
        return isContiguous
            ? createRangePageSelection(options.totalPages(), first, last)
            : createExplicitPageSelection(options.totalPages(), normalized);
    }

    function resolveScopedPageSelection(): TPageSelection | null | undefined {
        const pageCount = options.totalPages();
        switch (scope.value) {
            case 'all':
                return createAllPageSelection(pageCount);
            case 'current': {
                const page = options.currentPage();
                return page >= 1 && page <= pageCount
                    ? createExplicitPageSelection(pageCount, [page])
                    : null;
            }
            case 'even':
                return createPredicatePageSelection(pageCount, 'even');
            case 'odd':
                return createPredicatePageSelection(pageCount, 'odd');
            case 'selected':
                return pageSelectionCount(normalizedSelectedPageSelection.value) > 0
                    ? normalizedSelectedPageSelection.value
                    : null;
            case 'range':
                return resolveRangeSelection();
        }
    }

    function resolveScopedPageBatches(batchSize = 1_024): Generator<number[]> | null {
        const selection = resolveScopedPageSelection();
        return selection ? iteratePageSelectionBatches(selection, {batchSize}) : null;
    }

    watch(normalizedSelectedPageSelection, (selection) => {
        if (scope.value === 'selected' && pageSelectionCount(selection) === 0) {
            scope.value = 'all';
        }
    });

    watch(scope, () => {
        rangeTouched.value = false;
    });

    return {
        scope,
        rangeInput,
        rangeTouched,
        normalizedSelectedPages,
        normalizedSelectedPageSelection,
        resetScopeForOpen,
        resolveScopedPageNumbers,
        resolveScopedPageSelection,
        resolveScopedPageBatches,
    };
};
