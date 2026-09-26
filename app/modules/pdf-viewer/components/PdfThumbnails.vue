<template>
  <DocumentThumbnailList
    ref="list"
    :source="source"
    :current-page="currentPage"
    :focus-page="rovingFocusPage"
    :is-active="isActive"
    :is-resizing="isResizing"
    :selected-pages="selectedPageLookup"
    :page-revision="pageRevision"
    item-tag="div"
    tabindex="-1"
    role="listbox"
    aria-multiselectable="true"
    :aria-label="t('sidebar.pages')"
    class="pdf-thumbnails"
    :class="{
      'is-reorder-dragging': isDragging,
      'is-external-drag': isExternalDragOver,
    }"
    @go-to-page="(page, event) => handleThumbnailClick(event, page)"
    @mousedown="handleRowMouseDown"
    @contextmenu="handleRowContextMenu"
    @pointercancel="handleDragPointerCancel"
    @lostpointercapture="handleDragPointerCancel"
    @dragenter="handleExternalDragEnter"
    @dragover="handleExternalDragOver"
    @dragleave="handleExternalDragLeave"
    @drop="handleExternalDrop"
    @focusin="handleContainerFocusIn"
    @keydown="handleContainerKeyDown"
  >
    <template #overlay="{pageNumber}">
      <span
        v-if="dropInsertIndex === pageNumber - 1"
        class="pdf-thumbnail-drop pdf-thumbnail-drop--before"
      />
      <span
        v-if="pageNumber === totalPages && dropInsertIndex === totalPages"
        class="pdf-thumbnail-drop pdf-thumbnail-drop--after"
      />
      <span v-if="isDragging && draggedPages.includes(pageNumber)" class="pdf-thumbnail-dragged" hidden />
      <AppTooltip :text="getThumbnailSelectionLabel(pageNumber)" :delay-duration="400">
        <button
          type="button"
          :aria-pressed="isSelected(pageNumber)"
          :aria-label="getThumbnailSelectionLabel(pageNumber)"
          class="pdf-thumbnail-selection-toggle"
          :class="{ 'is-selected': isSelected(pageNumber) }"
          @mousedown.stop
          @click.stop="toggleSinglePageSelection(pageNumber)"
        >
          <UIcon
            v-if="isSelected(pageNumber)"
            name="i-ph-check"
            class="pdf-thumbnail-selection-icon"
          />
        </button>
      </AppTooltip>
    </template>
    <template #label="{pageNumber}">{{ formatPageIndicatorWithOptions(pageNumber, pageLabels ?? null) }}</template>
  </DocumentThumbnailList>
</template>

<script setup lang="ts">
import { groupBy } from 'es-toolkit/array';
import {formatPageIndicatorWithOptions} from '@app/modules/document-viewer/public';
import DocumentThumbnailList from '@app/components/document-viewer/DocumentThumbnailList.vue';
import { usePageDragDrop } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePageDragDrop';
import { usePdfThumbnailSelection } from '@app/modules/pdf-viewer/thumbnails/usePdfThumbnailSelection';
import {
    createEditedTextMarkupThumbnailVisualSignature,
    createHiddenAnnotationIdsSignature,
    getEditedTextMarkupThumbnailComments,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailTextMarkupVisuals';
import type {
    IPdfThumbnailsEmits,
    IPdfThumbnailsProps,
} from '@app/modules/pdf-viewer/thumbnails/pdfThumbnailComponentContract';
import type {
    TPageMoveOperation,
    TPageSelection,
} from '@contracts/pageNumbers';

const {
    annotationComments = undefined,
    annotationSettings = undefined,
    currentPage,
    hiddenAnnotationIds = undefined,
    invalidationRequest = undefined,
    isActive = true,
    isResizing = false,
    pageGeometry = undefined,
    pageLabels = undefined,
    selectedPages = undefined,
    selectedPageSelection = undefined,
    source,
    totalPages,
} = defineProps<IPdfThumbnailsProps>();
const emit = defineEmits<IPdfThumbnailsEmits>();
const { t } = useTypedI18n();
const hasPageSelectionModel = selectedPageSelection !== undefined;
const list = useTemplateRef<InstanceType<typeof DocumentThumbnailList>>('list');
const containerRef = computed<HTMLElement | null>(() => list.value?.scrollRoot ?? null);

// A page re-renders when its key changes and keeps its thumbnail until the
// new one lands: edited markup and deleted annotations, the presented
// rotation, and page contents a page operation rewrote.
const pageEpochs = new Map<number, number>();
const pageEpochVersion = ref(0);
let pendingRewrittenPages: number[] = [];
const hiddenAnnotationSignature = computed(() => createHiddenAnnotationIdsSignature(new Set(hiddenAnnotationIds ?? [])));
const editedMarkupsByPage = computed(() => groupBy(
    getEditedTextMarkupThumbnailComments(annotationComments ?? []),
    comment => Math.floor(comment.pageNumber),
));
const pageRevision = computed(() => {
    void pageEpochVersion.value;
    void pageGeometry?.version;
    const hidden = hiddenAnnotationSignature.value;
    const markups = editedMarkupsByPage.value;
    const settings = annotationSettings;
    const metrics = pageGeometry?.metrics;
    return (page: number) => [
        pageEpochs.get(page) ?? 0,
        metrics?.[page - 1]?.rotation ?? 0,
        hidden,
        createEditedTextMarkupThumbnailVisualSignature(markups[page] ?? [], settings),
    ].join('\u0002');
});

function bumpPages(pages: readonly number[]) {
    for (const page of pages) {
        pageEpochs.set(page, (pageEpochs.get(page) ?? 0) + 1);
    }
    pageEpochVersion.value += 1;
}

// Rotation is part of the key already. Rewritten pages wait for the source
// of the revision that carries them; until then they keep their thumbnail.
watch(() => invalidationRequest?.id, () => {
    const request = invalidationRequest;
    if (!request?.pages.length || request.rotationOnly) {
        return;
    }
    if (request.expectedDocumentRevision) {
        pendingRewrittenPages.push(...request.pages);
    } else {
        bumpPages(request.pages);
    }
}, {flush: 'sync'});
watch(() => source, () => {
    if (pendingRewrittenPages.length > 0) {
        bumpPages(pendingRewrittenPages);
        pendingRewrittenPages = [];
    }
});

function resolveRowPage(target: EventTarget | null) {
    const page = Number((target as Element | null)?.closest?.<HTMLElement>('[data-thumbnail-page]')?.dataset.thumbnailPage);
    return Number.isInteger(page) && page >= 1 ? page : null;
}

const {
    isDragging,
    isExternalDragOver,
    draggedPages,
    dropInsertIndex,
    handleMouseDown: handleDragMouseDown,
    handlePointerCancel: handleDragPointerCancel,
    consumeClickSkip,
    handleDragEnter: handleExternalDragEnter,
    handleDragOver: handleExternalDragOver,
    handleDragLeave: handleExternalDragLeave,
    handleExternalDrop,
} = usePageDragDrop({
    containerRef,
    totalPages: computed(() => totalPages),
    selectedPages: computed(() => selectedPages ?? []),
    selectedPageSelection: computed(() => selectedPageSelection ?? null),
    onReorder: newOrder => emit('reorder', newOrder),
    onMove: hasPageSelectionModel ? (move: TPageMoveOperation) => emit('move', move) : undefined,
    onExternalFileDrop: (afterPage, filePaths) => emit('file-drop', {
        afterPage,
        filePaths,
    }),
});

function revealPage(page: number) {
    list.value?.revealPage(page);
    return nextTick();
}

const {
    handleContainerFocusIn,
    handleContainerKeyDown,
    handleThumbnailClick,
    handleThumbnailContextMenu,
    isSelected,
    rovingFocusPage,
    toggleSinglePageSelection,
} = usePdfThumbnailSelection({
    consumeClickSkip,
    currentPage: computed(() => currentPage),
    focusPageElement: page => containerRef.value
        ?.querySelector<HTMLElement>(`[data-thumbnail-page="${String(page)}"]`)
        ?.focus({preventScroll: true}),
    isDragging,
    isExternalDragOver,
    markUserInteraction: () => {},
    onContextMenu: payload => emit('page-context-menu', payload),
    onGoToPage: page => emit('go-to-page', page, {navigationSource: 'thumbnail'}),
    onMove: hasPageSelectionModel ? (move: TPageMoveOperation) => emit('move', move) : undefined,
    onReorder: newOrder => emit('reorder', newOrder),
    onSelectedPagesChange: pages => emit('update:selected-pages', pages),
    onPageSelectionChange: hasPageSelectionModel ? (selection: TPageSelection) => emit('update:selected-page-selection', selection) : undefined,
    scrollPageIntoKeyboardView: revealPage,
    selectedPages: computed(() => selectedPages ?? []),
    selectedPageSelection: hasPageSelectionModel ? computed<TPageSelection | null>(() => selectedPageSelection ?? null) : undefined,
    totalPages: computed(() => totalPages),
});
const selectedPageLookup = {has: isSelected};

function handleRowMouseDown(event: MouseEvent) {
    const page = resolveRowPage(event.target);
    if (page !== null) {
        handleDragMouseDown(event, page);
    }
}

function handleRowContextMenu(event: MouseEvent) {
    const page = resolveRowPage(event.target);
    if (page !== null) {
        event.preventDefault();
        handleThumbnailContextMenu(event, page);
    }
}

function getThumbnailSelectionLabel(page: number) {
    const label = formatPageIndicatorWithOptions(page, pageLabels ?? null);
    return isSelected(page)
        ? t('pageOps.deselectPage', {page: label})
        : t('pageOps.selectPage', {page: label});
}
</script>
<style src="./PdfThumbnails.css"></style>
