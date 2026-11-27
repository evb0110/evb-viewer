<template>
    <AppSidebarShell
        class="document-source-sidebar"
        data-testid="document-sidebar"
        :aria-label="t('documentSourceSidebar.navLabel')"
        :model-value="activeTab ?? ''"
        :tabs="availableShellTabs"
        @update:model-value="handleShellTabUpdate"
    >
        <DocumentSidebarPagesPanel
            v-if="source?.thumbnailProvider"
            v-show="activeTab === 'thumbnails'"
        >
            <DocumentThumbnailList
                :source="source"
                :current-page="currentPage"
                :is-active="isActive && activeTab === 'thumbnails'"
                :is-resizing="isResizing"
                @go-to-page="forwardThumbnailActivation"
            />
        </DocumentSidebarPagesPanel>

        <div v-show="activeTab === 'bookmarks'" class="document-source-sidebar__bookmarks">
            <DocumentBookmarkToolbar
                v-if="isBookmarkToolbarVisible"
                :display-mode="bookmarkDisplayMode"
                @set-display-mode="setBookmarkDisplayMode"
            />
            <p v-if="outlineStatus === 'loading'" class="document-source-sidebar__status">{{ t('documentSourceSidebar.loadingOutline') }}</p>
            <DocumentPanelEmptyState
                v-else-if="outlineStatus === 'error'"
                icon="i-ph-warning"
                :title="t('bookmarks.unavailable')"
                :description="outlineError ?? ''"
            />
            <DocumentPanelEmptyState
                v-else-if="outlineStatus === 'empty'"
                icon="i-ph-bookmark"
                :title="t('documentSourceSidebar.noOutline')"
            />
            <DocumentBookmarkTree
                v-else
                :items="outlineItems"
                :active-id="activeBookmarkId"
                :active-path-ids="activeBookmarkPathIds"
                :display-mode="bookmarkDisplayMode"
                :expanded-ids="expandedBookmarkIds"
                @activate="activateBookmark"
                @toggle-expand="toggleBookmarkExpanded"
            />
        </div>

        <DocumentSearchPanel
            v-show="activeTab === 'search'"
            :session="searchSession"
            :is-active="activeTab === 'search'"
            :focus-request="searchFocusRequest ?? 0"
        />
    </AppSidebarShell>
</template>

<script setup lang="ts">
import type {
    IDocumentPageSource, IDocumentSearchSession ,TDocumentSidebarTab, 
} from '@app/modules/document-viewer/public';
import { useDocumentBookmarkSession } from '@app/modules/document-viewer/public';
import AppSidebarShell from '@app/components/sidebar/AppSidebarShell.vue';
import DocumentPanelEmptyState from '@app/components/document-viewer/DocumentPanelEmptyState.vue';
import DocumentBookmarkToolbar from '@app/components/document-viewer/DocumentBookmarkToolbar.vue';
import DocumentBookmarkTree from '@app/components/document-viewer/DocumentBookmarkTree.vue';
import DocumentSearchPanel from '@app/components/document-viewer/DocumentSearchPanel.vue';
import DocumentThumbnailList from '@app/components/document-viewer/DocumentThumbnailList.vue';
import DocumentSidebarPagesPanel from '@app/components/document-viewer/DocumentSidebarPagesPanel.vue';

const { t } = useTypedI18n();
const {
    source,
    currentPage,
    isActive,
    searchSession,
    isResizing,
    searchFocusRequest,
    activeTab,
    availableTabs,
} = defineProps<{
    source: IDocumentPageSource | null;
    currentPage: number;
    isActive?: boolean;
    searchSession: IDocumentSearchSession;
    isResizing?: boolean;
    searchFocusRequest?: number;
    /** The tab shown: the preference clamped to `availableTabs`, or none. */
    activeTab: TDocumentSidebarTab | null;
    availableTabs: readonly TDocumentSidebarTab[];
}>();
const emit = defineEmits<{
    // Optional because bookmark rows navigate without a selection event; see
    // IDocumentThumbnailListEmits for what the thumbnail rail hands over.
    'go-to-page': [pageNumber: number, event?: MouseEvent];
    'update:activeTab': [value: TDocumentSidebarTab];
}>();

const bookmarkSession = useDocumentBookmarkSession({
    source: computed(() => source),
    currentPage: computed(() => currentPage),
    isActive: computed(() => activeTab === 'bookmarks'),
});
const {
    activeId: activeBookmarkId,
    activePathIds: activeBookmarkPathIds,
    displayMode: bookmarkDisplayMode,
    error: outlineError,
    expandedIds: expandedBookmarkIds,
    getPageNumber: getBookmarkPageNumber,
    items: outlineItems,
    setDisplayMode: setBookmarkDisplayMode,
    status: outlineStatus,
    toggleExpanded: toggleBookmarkExpanded,
} = bookmarkSession;

/** Display modes are meaningless until there is a settled outline to arrange. */
const isBookmarkToolbarVisible = computed(() => (
    outlineStatus.value === 'ready' || outlineStatus.value === 'empty'
));

const availableShellTabs = computed(() => availableTabs.map(tab => ({
    value: tab,
    label: getTabLabel(tab),
    title: getTabLabel(tab),
    icon: {
        annotations: 'i-ph-chat',
        thumbnails: 'i-ph-file',
        bookmarks: 'i-ph-bookmark',
        search: 'i-ph-magnifying-glass',
    }[tab],
})));

function getTabLabel(tab: TDocumentSidebarTab) {
    return t(`sidebar.${tab === 'thumbnails' ? 'pages' : tab}`);
}

function handleShellTabUpdate(value: string) {
    const tab = /^\d+$/u.test(value)
        ? availableTabs[Number(value)]
        : value as TDocumentSidebarTab;
    if (!tab || !availableTabs.includes(tab)) {
        return;
    }
    emit('update:activeTab', tab);
}

/**
 * Thumbnail rows hand over the click they were activated with, so a consumer
 * can act on its modifier keys; bookmark rows navigate without one.
 */
function forwardThumbnailActivation(pageNumber: number, event: MouseEvent) {
    emit('go-to-page', pageNumber, event);
}

function activateBookmark(id: string) {
    const pageNumber = getBookmarkPageNumber(id);
    if (pageNumber !== null) emit('go-to-page', pageNumber);
}

</script>

<style scoped>
.document-source-sidebar {
    width: 100%;
    height: 100%;
    min-width: 0;
}

.document-source-sidebar__bookmarks {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
}

.document-source-sidebar__row {
    padding: var(--app-sidebar-row-padding-block) var(--app-sidebar-row-padding-inline);
    text-align: left;
    border-radius: var(--app-radius-md);
}

.document-source-sidebar__status {
    flex: 1;
    display: grid;
    place-items: center;
    margin: 0;
    color: var(--ui-text-muted);
    font-size: var(--app-sidebar-caption-font-size);
}

</style>
