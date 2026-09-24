<template>
    <main class="flex h-dvh min-h-0 flex-col bg-[var(--ui-bg)] text-[var(--ui-text)]">
        <PdfToolbar
            :has-pdf="Boolean(pdfSrc)"
            :can-save="false"
            :can-undo="false"
            :can-redo="false"
            :can-export-docx="false"
            :is-saving="false"
            :is-saving-as="false"
            :is-any-saving="false"
            :is-history-busy="false"
            :is-exporting-docx="false"
            :is-opening-document="isOpening"
            :is-preparing-print="false"
            :is-fit-width-active="zoomMode === 'fit-width'"
            :is-fit-height-active="zoomMode === 'fit-height'"
            :show-sidebar="false"
            :can-toggle-sidebar="false"
            :drag-mode="dragMode"
            :continuous-scroll="continuousScroll"
            :is-djvu-mode="false"
            :surface="toolbarSurface"
            variant="reader"
            :is-capturing-region="false"
            :is-crop-selecting="false"
            :is-placing-page-note="false"
            @open-file="handleOpen"
            @open-settings="openSettings"
            @fit-width="handleFitWidth"
            @fit-height="handleFitHeight"
            @toggle-continuous-scroll="toggleContinuousScroll"
            @enable-drag="enableDragMode"
            @disable-drag="disableDragMode"
        >
            <template v-if="pdfSrc" #app-menu>
                <ToolbarButton
                    icon="ph:x"
                    :tooltip="t('annotationProperties.close', undefined)"
                    @click="handleClose"
                />
            </template>
            <template #overflow-menu="{ collapseTier }">
                <ToolbarButton
                    v-if="pdfSrc"
                    icon="ph:magnifying-glass"
                    :active="isSearchOpen"
                    :tooltip="t('sidebar.search', undefined)"
                    @click="toggleSearch"
                />
                <ToolbarOverflowMenu
                    :open="overflowMenuOpen"
                    :collapse-tier="Math.max(collapseTier, 3)"
                    :can-toggle-sidebar="false"
                    :can-capture-region="false"
                    :can-crop="false"
                    :can-quick-note="false"
                    :has-pdf="Boolean(pdfSrc)"
                    :can-use-ocr="false"
                    :show-sidebar="false"
                    :drag-mode="dragMode"
                    :continuous-scroll="continuousScroll"
                    :view-mode="viewMode"
                    :is-djvu-mode="false"
                    :is-fit-width-active="zoomMode === 'fit-width'"
                    :is-fit-height-active="zoomMode === 'fit-height'"
                    :is-capturing-region="false"
                    :is-crop-selecting="false"
                    :is-placing-page-note="false"
                    :surface="toolbarSurface"
                    trigger-icon="i-ph-list"
                    @update:open="overflowMenuOpen = $event"
                    @capture-region="noopToolbarAction"
                    @crop="noopToolbarAction"
                    @toggle-sidebar="noopToolbarAction"
                    @fit-width="handleFitWidth"
                    @fit-height="handleFitHeight"
                    @enable-drag="enableDragMode"
                    @disable-drag="disableDragMode"
                    @set-view-mode="setViewMode"
                    @toggle-continuous-scroll="toggleContinuousScroll"
                    @quick-note="noopToolbarAction"
                    @open-settings="openSettings"
                />
            </template>
            <template v-if="pdfSrc" #page-dropdown>
                <PdfPageDropdown
                    v-model="currentPage"
                    :open="pageDropdownOpen"
                    :total-pages="totalPages"
                    :view-mode="viewMode"
                    :disabled="!pdfSrc"
                    :compact-level="3"
                    @go-to-page="handleGoToPage"
                    @update:open="pageDropdownOpen = $event"
                />
            </template>
            <template v-if="pdfSrc" #zoom-dropdown>
                <PdfZoomDropdown
                    v-model:zoom="zoom"
                    v-model:zoom-mode="zoomMode"
                    v-model:fit-mode="fitMode"
                    v-model:view-mode="viewMode"
                    :effective-zoom="effectiveZoom"
                    :open="zoomDropdownOpen"
                    :disabled="!pdfSrc"
                    :compact-level="2"
                    @update:effective-zoom="effectiveZoom = $event"
                    @update:open="zoomDropdownOpen = $event"
                    @fit-width="handleFitWidth"
                    @fit-height="handleFitHeight"
                />
            </template>
        </PdfToolbar>

        <form
            v-if="isSearchOpen"
            class="flex shrink-0 items-center gap-2 border-b border-[var(--ui-border)] bg-[var(--app-chrome)] px-3 py-2"
            @submit.prevent="handleSearch"
        >
            <AppSearchInput
                v-model="searchDraft"
                class="min-w-0 flex-1"
                size="sm"
                icon="i-ph-magnifying-glass"
                :placeholder="t('searchResults.enterSearchTerm')"
                :disabled="!workingCopyPath"
            />
            <UButton
                type="submit"
                icon="i-ph-magnifying-glass"
                size="sm"
                color="neutral"
                variant="ghost"
                :loading="isSearching"
                :disabled="!workingCopyPath"
                :aria-label="t('sidebar.search', undefined)"
            />
        </form>

        <UAlert
            v-if="openError"
            color="warning"
            variant="soft"
            class="mx-3 mt-2 shrink-0"
            :description="openError"
            :ui="{ title: 'sr-only' }"
        />
        <UAlert
            v-if="isSearchOpen && searchError"
            color="warning"
            variant="soft"
            class="mx-3 mt-2 shrink-0"
            :description="searchError"
            :ui="{ title: 'sr-only' }"
        />

        <section
            v-if="!pdfSrc"
            class="min-h-0 flex-1"
        >
            <PdfEmptyState
                :recent-files="recentFiles"
                :recent-files-resolved="recentFilesResolved"
                :open-batch-progress="null"
                :open-in-progress="isOpening"
                @open-file="handleOpen"
                @open-recent="openRecent"
                @remove-recent="removeRecent"
                @clear-recent="clearRecent"
            />
        </section>

        <section v-else class="min-h-0 flex-1">
            <ClientOnly>
                <PdfViewer
                    ref="pdfViewerRef"
                    :src="pdfSrc"
                    :source-pdf-data="pdfData"
                    :zoom-state="zoomState"
                    :view-mode="viewMode"
                    :continuous-scroll="continuousScroll"
                    :drag-mode="dragMode"
                    show-annotations
                    :annotation-tool="'none'"
                    :search-page-matches="pageMatches"
                    :current-search-match="currentResult"
                    :current-search-match-navigation-id="currentResultNavigationId"
                    :working-copy-path="workingCopyPath"
                    @update:zoom-state="applyZoomState"
                    @update:effective-zoom="effectiveZoom = $event"
                    @update:current-page="currentPage = $event"
                    @update:total-pages="totalPages = $event"
                    @loading="isViewerLoading = $event"
                />
            </ClientOnly>
        </section>

        <footer
            v-if="pdfSrc"
            class="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--ui-border)] px-3 py-2 text-xs text-[var(--ui-text-muted)]"
        >
            <span>{{ t('annotations.page', undefined) }} {{ currentPage }} / {{ totalPages }}</span>
            <span v-if="isViewerLoading">{{ t('common.loading', undefined) }}</span>
            <span v-else-if="totalMatches > 0">{{ currentMatch }} / {{ totalMatches }}</span>
        </footer>

        <SettingsDialog v-if="showSettings" v-model:open="showSettings" />
    </main>
</template>

<script setup lang="ts">
import {
    createZoomState,
    getZoomMode,
    type IRecentFile,
    type TPdfZoomState,
} from '@contracts/shared';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import ToolbarButton from '@app/components/ToolbarButton.vue';
import { PdfEmptyState } from '@app/modules/pdf-viewer/public/component-exports/pdfEmptyState';
import { PdfPageDropdown } from '@app/modules/pdf-viewer/public/component-exports/pdfPageDropdown';
import { PdfToolbar } from '@app/modules/pdf-viewer/public/component-exports/pdfToolbar';
import { PdfZoomDropdown } from '@app/modules/pdf-viewer/public/component-exports/pdfZoomDropdown';
import { usePdfSearch } from '@app/modules/pdf-viewer/public';
import { usePdfFile } from '@app/modules/workspace-shell/public';
import SettingsDialog from '@app/components/SettingsDialog.vue';
import ToolbarOverflowMenu from '@app/components/toolbar/ToolbarOverflowMenu.vue';
import { MOBILE_READER_COMMAND_SURFACE } from '@app/utils/readerCommandSurface';
import AppSearchInput from '@app/components/AppSearchInput.vue';

const PdfViewer = defineAsyncComponent(() =>
    import('@app/modules/pdf-viewer/public/component-exports/pdfViewer').then(module => module.PdfViewer));

const { t } = useTypedI18n();
const {
    pdfSrc,
    pdfData,
    workingCopyPath,
    error: openError,
    closeFile,
    openFile,
    openFileDirect,
} = usePdfFile();
const {
    recentFiles,
    isResolved: recentFilesResolved,
    loadRecentFiles,
    removeRecentFile,
    clearRecentFiles,
} = useRecentFiles();
const {
    search,
    pageMatches,
    currentResult,
    currentResultNavigationId,
    currentMatch,
    totalMatches,
    isSearching,
    searchError,
} = usePdfSearch();

const isOpening = ref(false);
const isViewerLoading = ref(false);
const currentPage = ref(1);
const totalPages = ref(0);
const searchDraft = ref('');
const zoom = ref(1);
const effectiveZoom = ref(1);
const zoomMode = ref<TZoomMode>('fit-width');
const fitMode = ref<TFitMode>('width');
const zoomState = computed(() => createZoomState(zoomMode.value, zoom.value));
function applyZoomState(state: TPdfZoomState) {
    zoom.value = state.kind === 'custom' ? state.scale : zoom.value;
    fitMode.value = state.kind === 'fit' ? state.axis : fitMode.value;
    zoomMode.value = getZoomMode(state);
}
const viewMode = ref<TPdfViewMode>('single');
const continuousScroll = ref(true);
const dragMode = ref(false);
const isSearchOpen = ref(false);
const showSettings = ref(false);
const pageDropdownOpen = ref(false);
const zoomDropdownOpen = ref(false);
const overflowMenuOpen = ref(false);
const pdfViewerRef = ref<{ scrollToPage: (pageNumber: number) => void } | null>(null);
const toolbarSurface = MOBILE_READER_COMMAND_SURFACE;

definePageMeta({ preloadWorkspaceShell: false });
if (import.meta.server) useSeoMeta({ robots: 'noindex, nofollow' });
useHead(() => ({ title: t('app.title', undefined) }));
onMounted(() => {
    void loadRecentFiles();
});

async function handleOpen() {
    isOpening.value = true;
    try {
        await openFile();
        await loadRecentFiles();
    } finally {
        isOpening.value = false;
    }
}

async function openRecent(file: IRecentFile) {
    isOpening.value = true;
    try {
        await openFileDirect(file.originalPath);
        await loadRecentFiles();
    } finally {
        isOpening.value = false;
    }
}

async function removeRecent(file: IRecentFile) {
    await removeRecentFile(file);
}

async function clearRecent() {
    await clearRecentFiles();
}

async function handleClose() {
    closeFile();
    searchDraft.value = '';
    isSearchOpen.value = false;
    currentPage.value = 1;
    totalPages.value = 0;
    await loadRecentFiles();
}

async function handleSearch() {
    if (!workingCopyPath.value) {
        return;
    }

    await search(searchDraft.value, workingCopyPath.value, totalPages.value);
}

function handleGoToPage(pageNumber: number) {
    currentPage.value = pageNumber;
    pdfViewerRef.value?.scrollToPage(pageNumber);
}

function handleFitWidth() {
    fitMode.value = 'width';
    zoomMode.value = 'fit-width';
}

function handleFitHeight() {
    fitMode.value = 'height';
    zoomMode.value = 'fit-height';
}

function openSettings() {
    showSettings.value = true;
}

function toggleContinuousScroll() {
    continuousScroll.value = !continuousScroll.value;
}

function enableDragMode() {
    dragMode.value = true;
}

function disableDragMode() {
    dragMode.value = false;
}

function toggleSearch() {
    isSearchOpen.value = !isSearchOpen.value;
}

function setViewMode(mode: TPdfViewMode) {
    viewMode.value = mode;
}

function noopToolbarAction() {}
</script>
