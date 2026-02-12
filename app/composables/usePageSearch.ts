import type { Ref } from 'vue';

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';

export interface IPageSearchDeps {
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    dragMode: Ref<boolean>;
    workingCopyPath: Ref<string | null>;
    totalPages: Ref<number>;
    searchQuery: Ref<string>;
    search: (query: string, path: string, totalPages?: number) => Promise<boolean>;
    goToResult: (direction: 'next' | 'previous') => void;
    setResultIndex: (index: number) => void;
    clearSearch: () => void;
}

export const usePageSearch = (deps: IPageSearchDeps) => {
    const {
        showSidebar,
        sidebarTab,
        dragMode,
        workingCopyPath,
        totalPages,
        searchQuery,
        search,
        goToResult,
        setResultIndex,
        clearSearch,
    } = deps;

    function openSearch() {
        showSidebar.value = true;
        sidebarTab.value = 'search';
    }

    function openAnnotations() {
        if (showSidebar.value && sidebarTab.value === 'annotations') {
            showSidebar.value = false;
            return;
        }
        showSidebar.value = true;
        sidebarTab.value = 'annotations';
        dragMode.value = false;
    }

    function closeSearch() {
        clearSearch();
        sidebarTab.value = 'thumbnails';
    }

    async function handleSearch() {
        if (workingCopyPath.value) {
            showSidebar.value = true;
            sidebarTab.value = 'search';
            await search(
                searchQuery.value,
                workingCopyPath.value,
                totalPages.value > 0 ? totalPages.value : undefined,
            );
        }
    }

    function handleSearchNext() {
        goToResult('next');
    }

    function handleSearchPrevious() {
        goToResult('previous');
    }

    function handleGoToResult(index: number) {
        setResultIndex(index);
    }

    return {
        openSearch,
        openAnnotations,
        closeSearch,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,
    };
};
