<template>
    <AppSidebarShell
        class="document-source-sidebar"
        data-testid="document-sidebar"
        :aria-label="t('documentSourceSidebar.navLabel')"
        :model-value="effectiveTab ?? ''"
        :tabs="availableShellTabs"
        @update:model-value="handleShellTabUpdate"
    >
        <DocumentSidebarPagesPanel
            v-if="source?.thumbnailProvider"
            v-show="effectiveTab === 'thumbnails'"
        >
            <DocumentThumbnailList
                :source="source"
                :current-page="currentPage"
                :is-active="isActive && effectiveTab === 'thumbnails'"
                :is-resizing="isResizing"
                @go-to-page="forwardThumbnailActivation"
            />
        </DocumentSidebarPagesPanel>

        <div v-show="effectiveTab === 'bookmarks'" class="document-source-sidebar__bookmarks">
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
            v-show="effectiveTab === 'search'"
            :session="searchSession"
            :is-active="effectiveTab === 'search'"
            :focus-request="searchFocusRequest ?? 0"
        />
    </AppSidebarShell>
</template>

<script setup lang="ts">
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';
import { useDocumentBookmarkSession } from '@app/utils/document-viewer/bookmarks/useDocumentBookmarkSession';
import type { IDocumentSearchSession } from '@app/utils/document-viewer/search/documentSearch';
import type {TDocumentSidebarTab} from '@app/utils/document-viewer/sidebar/documentSidebarTabs';
import {useDocumentSidebarCapabilitySession} from '@app/utils/document-viewer/sidebar/useDocumentSidebarCapabilitySession';
import AppSidebarShell from '@app/components/sidebar/AppSidebarShell.vue';
import DocumentPanelEmptyState from '@app/components/document-viewer/DocumentPanelEmptyState.vue';
import DocumentBookmarkToolbar from '@app/components/document-viewer/DocumentBookmarkToolbar.vue';
import DocumentBookmarkTree from '@app/components/document-viewer/DocumentBookmarkTree.vue';
import DocumentSearchPanel from '@app/components/document-viewer/DocumentSearchPanel.vue';
import DocumentThumbnailList from '@app/components/document-viewer/DocumentThumbnailList.vue';
import DocumentSidebarPagesPanel from '@app/components/document-viewer/DocumentSidebarPagesPanel.vue';

const { t } = useTypedI18n();
const props = defineProps<{
    source: IDocumentPageSource | null;
    currentPage: number;
    isActive?: boolean;
    searchSession: IDocumentSearchSession;
    isResizing?: boolean;
    searchFocusRequest?: number;
}>();
const emit = defineEmits<{
    // Optional because bookmark rows navigate without a selection event; see
    // IDocumentThumbnailListEmits for what the thumbnail rail hands over.
    'go-to-page': [pageNumber: number, event?: MouseEvent];
    'update:availableTabs': [value: TDocumentSidebarTab[]];
}>();

const activeTab = defineModel<TDocumentSidebarTab>('activeTab', {required: true});
const sidebarCapabilities = computed(() => ({
    annotations: false,
    bookmarks: Boolean(props.source?.outlineProvider),
    pages: Boolean(props.source?.thumbnailProvider),
    search: Boolean(props.source?.searchProvider ?? props.source?.textProvider),
}));
const {
    availableTabs,
    effectiveTab,
    select: selectTab,
} = useDocumentSidebarCapabilitySession({
    capabilities: sidebarCapabilities,
    capabilitiesReady: computed(() => props.source !== null),
    preferredTab: activeTab,
});
const isActive = computed(() => props.isActive);
watch(
    availableTabs,
    tabs => emit('update:availableTabs', [...tabs]),
    {immediate: true},
);
const bookmarkSession = useDocumentBookmarkSession({
    source: computed(() => props.source),
    currentPage: computed(() => props.currentPage),
    isActive: computed(() => effectiveTab.value === 'bookmarks'),
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

const availableShellTabs = computed(() => availableTabs.value.map(tab => ({
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
        ? availableTabs.value[Number(value)]
        : value as TDocumentSidebarTab;
    if (!tab || !availableTabs.value.includes(tab)) {
        return;
    }
    selectTab(tab);
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
