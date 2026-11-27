import {effectScope, ref} from 'vue';
import {describe, expect, it, vi} from 'vitest';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentSidebarTab} from '@app/modules/document-viewer/sidebar/documentSidebarTabs';
import {useDocumentSidebarCapabilitySession} from '@app/modules/document-viewer/sidebar/useDocumentSidebarCapabilitySession';
import {computed} from 'vue';
import {usePageSearch} from '@app/modules/workspace-shell/composables/usePageSearch';

function createPageSearch(tabs?: readonly TDocumentSidebarTab[]) {
    const state = {
        showSidebar: ref(false),
        sidebarTab: ref<TDocumentSidebarTab>('thumbnails'),
        dragMode: ref(false),
        workingCopyPath: ref<TDocumentRef | null>(null),
        documentRevisionToken: ref(null),
        totalPages: ref(0),
        searchQuery: ref(''),
        searchOptions: ref({
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        }),
    };
    const ready = ref(tabs !== undefined);
    const offeredTabs = ref<readonly TDocumentSidebarTab[]>(tabs ?? []);
    const sidebarTabs = useDocumentSidebarCapabilitySession({
        preferredTab: state.sidebarTab,
        capabilitiesReady: computed(() => ready.value),
        capabilities: computed(() => ({
            annotations: offeredTabs.value.includes('annotations'),
            bookmarks: offeredTabs.value.includes('bookmarks'),
            pages: offeredTabs.value.includes('thumbnails'),
            search: offeredTabs.value.includes('search'),
        })),
    });
    const clearSearch = vi.fn();
    const scope = effectScope();
    const pageSearch = scope.run(() =>
        usePageSearch({
            ...state,
            sidebarTabs,
            search: vi.fn(async () => true),
            goToResult: vi.fn(),
            setResultIndex: vi.fn(),
            clearSearch,
        }),
    );
    if (!pageSearch) {
        throw new Error('usePageSearch test harness failed to initialize');
    }
    return {
        ...state,
        clearSearch,
        pageSearch,
        stop: () => scope.stop(),
    };
}

describe('usePageSearch sidebar tab selection', () => {
    it('falls back to the pages tab while sidebar capabilities are still unknown', () => {
        const harness = createPageSearch();
        harness.sidebarTab.value = 'search';

        harness.pageSearch.closeSearch();

        expect(harness.clearSearch).toHaveBeenCalledTimes(1);
        expect(harness.sidebarTab.value).toBe('thumbnails');
        harness.stop();
    });

    it('leaves search for the first available tab when the format has no pages tab', () => {
        const harness = createPageSearch(['bookmarks', 'search']);
        harness.sidebarTab.value = 'search';

        harness.pageSearch.closeSearch();

        expect(harness.sidebarTab.value).toBe('bookmarks');
        harness.stop();
    });

    it('prefers the pages tab whenever the format has one', () => {
        const harness = createPageSearch(['bookmarks', 'thumbnails', 'search']);
        harness.sidebarTab.value = 'search';

        harness.pageSearch.closeSearch();

        expect(harness.sidebarTab.value).toBe('thumbnails');
        harness.stop();
    });

    it('refuses to open a search tab the active format does not have', () => {
        const harness = createPageSearch(['thumbnails']);

        harness.pageSearch.openSearch();

        expect(harness.showSidebar.value).toBe(false);
        expect(harness.sidebarTab.value).toBe('thumbnails');
        expect(harness.pageSearch.searchFocusRequest.value).toBe(0);
        harness.stop();
    });

    it('treats a settled empty tab list as no search capability', () => {
        const harness = createPageSearch([]);

        harness.pageSearch.openSearch();

        expect(harness.showSidebar.value).toBe(false);
        expect(harness.sidebarTab.value).toBe('thumbnails');
        expect(harness.pageSearch.searchFocusRequest.value).toBe(0);
        harness.stop();
    });

    it('closes the sidebar when search is the only available tab', () => {
        const harness = createPageSearch(['search']);
        harness.showSidebar.value = true;
        harness.sidebarTab.value = 'search';

        harness.pageSearch.closeSearch();

        expect(harness.clearSearch).toHaveBeenCalledTimes(1);
        expect(harness.showSidebar.value).toBe(false);
        expect(harness.sidebarTab.value).toBe('search');
        harness.stop();
    });

    it('closes the sidebar when the active format offers no tabs', () => {
        const harness = createPageSearch([]);
        harness.showSidebar.value = true;
        harness.sidebarTab.value = 'search';

        harness.pageSearch.closeSearch();

        expect(harness.clearSearch).toHaveBeenCalledTimes(1);
        expect(harness.showSidebar.value).toBe(false);
        expect(harness.sidebarTab.value).toBe('search');
        harness.stop();
    });

    it('opens and focuses the search tab when the format supports search', () => {
        const harness = createPageSearch(['thumbnails', 'search']);

        harness.pageSearch.openSearch();

        expect(harness.showSidebar.value).toBe(true);
        expect(harness.sidebarTab.value).toBe('search');
        expect(harness.pageSearch.searchFocusRequest.value).toBe(1);
        harness.stop();
    });
});
