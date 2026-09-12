import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { usePdfSearch } from '@app/modules/pdf-viewer/public';
import { usePageSearch } from '@app/modules/workspace-shell/composables/usePageSearch';
import { useSidebarResize } from '@app/modules/workspace-shell/composables/useSidebarResize';
import type { TPdfSidebarTab } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';

interface IWorkspaceSearchSidebarOptions {
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    dragMode: Ref<boolean>;
    totalPages: Ref<number>;
    initialSidebarWidth?: number | undefined;
}

export const useWorkspaceSearchSidebar = (options: IWorkspaceSearchSidebarOptions) => {
    const {
        workingCopyPath,
        documentRevisionToken,
        showSidebar,
        sidebarTab,
        dragMode,
        totalPages,
    } = options;

    const {
        searchQuery,
        submittedSearchQuery,
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
        currentResultNavigationId,
        currentResult,
        isSearching,
        searchError,
        totalMatches,
        search,
        goToResult,
        setResultIndex,
        cancelSearch,
        clearSearch,
        searchProgress,
        resetSearchCache,
        isTruncated,
        minQueryLength,
    } = usePdfSearch({documentRevisionToken});

    const {
        openSearch,
        searchFocusRequest,
        setAvailableSidebarTabs,
        openAnnotations,
        closeSearch,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,
    } = usePageSearch({
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
    });

    const {
        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        isPointerResizingSidebar,
        isSlidingSidebar,
        startSidebarResize,
        setSidebarContainerWidth,
        cleanupSidebarResizeListeners,
    } = useSidebarResize({
        showSidebar,
        initialWidth: options.initialSidebarWidth,
    });

    return {
        searchQuery,
        submittedSearchQuery,
        searchOptions,
        results,
        pageMatches,
        currentResultIndex,
        currentResultNavigationId,
        currentResult,
        isSearching,
        searchError,
        totalMatches,
        searchProgress,
        isTruncated,
        minQueryLength,
        cancelSearch,
        openSearch,
        searchFocusRequest,
        setAvailableSidebarTabs,
        openAnnotations,
        closeSearch,
        handleSearch,
        handleSearchNext,
        handleSearchPrevious,
        handleGoToResult,
        resetSearchCache,
        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        isPointerResizingSidebar,
        isSlidingSidebar,
        startSidebarResize,
        setSidebarContainerWidth,
        cleanupSidebarResizeListeners,
    };
};
