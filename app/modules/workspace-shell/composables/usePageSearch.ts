import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IResolvedSearchMatchOptions,
    ISearchMatchOptions,
} from '@contracts/search';
import type { TPdfSidebarTab } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import { reconcileDocumentSidebarTab } from '@app/modules/document-viewer/public';

interface IPageSearchDeps {
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    dragMode: Ref<boolean>;
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    totalPages: Ref<number>;
    searchQuery: Ref<string>;
    searchOptions: Ref<IResolvedSearchMatchOptions>;
    search: (
        query: string,
        path: TDocumentRef,
        totalPages?: number,
        options?: ISearchMatchOptions,
        documentRevisionToken?: TDocumentRevisionToken | null,
    ) => Promise<boolean>;
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
        documentRevisionToken,
        totalPages,
        searchQuery,
        searchOptions,
        search,
        goToResult,
        setResultIndex,
        clearSearch,
    } = deps;

    const searchFocusRequest = ref(0);
    const availableSidebarTabs = ref<readonly TPdfSidebarTab[]>([]);
    const hasReportedAvailableSidebarTabs = ref(false);

    /**
     * The rendered sidebar owns which tabs a format actually has. Before its
     * first report, shared callers keep the historical PDF fallback; afterward,
     * an empty list means the active format has no sidebar capability.
     */
    function setAvailableSidebarTabs(tabs: readonly TPdfSidebarTab[]) {
        availableSidebarTabs.value = [...tabs];
        hasReportedAvailableSidebarTabs.value = true;
    }

    function isSidebarTabAvailable(tab: TPdfSidebarTab) {
        return !hasReportedAvailableSidebarTabs.value || availableSidebarTabs.value.includes(tab);
    }

    function openSearch() {
        if (!isSidebarTabAvailable('search')) {
            return;
        }
        showSidebar.value = true;
        sidebarTab.value = 'search';
        searchFocusRequest.value += 1;
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
        if (!hasReportedAvailableSidebarTabs.value) {
            sidebarTab.value = 'thumbnails';
            return;
        }

        const nonSearchTabs = availableSidebarTabs.value.filter(tab => tab !== 'search');
        const fallback = reconcileDocumentSidebarTab('thumbnails', nonSearchTabs);
        if (fallback) {
            sidebarTab.value = fallback;
            return;
        }

        showSidebar.value = false;
    }

    watch([
        workingCopyPath,
        documentRevisionToken,
    ], () => {
        clearSearch();
    });

    async function handleSearch() {
        if (workingCopyPath.value) {
            showSidebar.value = true;
            sidebarTab.value = 'search';
            await search(
                searchQuery.value,
                workingCopyPath.value,
                totalPages.value > 0 ? totalPages.value : undefined,
                searchOptions.value,
                documentRevisionToken.value,
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
        searchFocusRequest,
        setAvailableSidebarTabs,
        openAnnotations,
        closeSearch,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,
    };
};
