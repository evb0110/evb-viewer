<template>
    <DocumentThumbnailRail
        :set-root="setScrollRoot"
        :scroll-suppressed="userScrollSuppressed"
        class="document-thumbnail-list"
        data-testid="document-thumbnail-list"
        @scroll.passive="handleScroll"
        @wheel="handleWheel"
        @pointerdown="handlePointerDown"
    >
        <div
            class="document-thumbnail-list__content"
            :data-thumbnail-scroll-segment="activeScrollSegmentIndex"
            :style="{height: contentHeight, ...slotPatternStyle}"
        >
            <span v-if="slotPatternStyle" class="document-thumbnail-list__slots" aria-hidden="true" />
            <span
                v-for="row in mountedRows"
                :key="row.pageNumber"
                class="document-thumbnail-list__underlay"
                :style="row.placementStyle"
                aria-hidden="true"
            />
            <DocumentThumbnailItem
                v-for="row in mountedRows"
                :key="row.pageNumber"
                class="document-thumbnail-list__item"
                :current="row.current"
                :aria-disabled="disabled || undefined"
                :selected="row.selected"
                :tag="itemTag"
                :role="row.role"
                :aria-selected="row.ariaSelected"
                :tabindex="row.tabindex"
                :aspect-ratio="row.aspectRatio"
                :style="row.placementStyle"
                :aria-label="row.ariaLabel"
                :data-thumbnail-page="row.pageNumber"
                :data-thumbnail-render-error="row.renderErrorAttr"
                :data-thumbnail-request-width="row.requestWidthAttr"
                :disabled="disabled"
                @click="handleItemClick(row.pageNumber, $event)"
            >
                <template #overlay>
                    <slot name="overlay" :page-number="row.pageNumber" />
                </template>
                <img
                    v-if="row.imageSrc !== undefined"
                    class="document-thumbnail-list__image"
                    :src="row.imageSrc"
                    :style="row.surfaceStyle"
                    alt=""
                    draggable="false"
                >
                <span
                    v-else-if="row.hasCanvasSurface"
                    :ref="element => setCanvasHost(row.pageNumber, element)"
                    class="document-thumbnail-list__canvas-host"
                    :style="row.surfaceStyle"
                />
                <span v-else class="document-thumbnail-list__placeholder" />
                <template #label>
                    <slot name="label" :page-number="row.pageNumber">{{ row.pageNumber }}</slot>
                    <span v-if="row.showsRenderError" class="document-thumbnail-list__error" aria-hidden="true">
                        <UIcon name="i-ph-warning-circle" />
                        <span class="sr-only document-thumbnail-list__error-text">{{ t('common.pageRenderFailed') }}</span>
                    </span>
                </template>
            </DocumentThumbnailItem>
        </div>
    </DocumentThumbnailRail>
</template>

<script setup lang="ts">
import type {ComponentPublicInstance} from 'vue';
import type {
    IDocumentPageSource,IDocumentThumbnailListEmits,
} from '@app/modules/document-viewer/public';
import {useDocumentThumbnailController} from '@app/modules/document-viewer/public';
import DocumentThumbnailItem from '@app/components/document-viewer/DocumentThumbnailItem.vue';
import DocumentThumbnailRail from '@app/components/document-viewer/DocumentThumbnailRail.vue';

const props = defineProps<{
    source: IDocumentPageSource | null;
    currentPage: number;
    isActive?: boolean;
    isResizing?: boolean;
    itemMetricsKey?: unknown;
    itemTag?: 'button' | 'div';
    selectedPages?: Pick<ReadonlySet<number>, 'has'>;
    /** The row that holds the tab stop; the current page by default. */
    focusPage?: number | null;
    pageRevision?: (pageNumber: number) => string;
    /** The document page a row names, when rows are not in page order. */
    documentPage?: (pageNumber: number) => number;
    disabled?: boolean;
}>();
const labelPage = (pageNumber: number) => props.documentPage?.(pageNumber) ?? pageNumber;
const emit = defineEmits<IDocumentThumbnailListEmits>();
const {t} = useTypedI18n();
const scrollRoot = ref<HTMLElement | null>(null);
function setScrollRoot(element: HTMLElement | null) {
    scrollRoot.value = element;
}
const {
    activeScrollSegmentIndex = ref(0),
    contentHeight,
    handlePointerDown,
    handleScroll,
    handleWheel,
    slotPatternStyle,
    userScrollSuppressed,
    outputScale,
    rasterWidth,
    renderErrors,
    retryRender,
    revealPage,
    scrollToRequestedOffset,
    states,
    virtualItems,
} = useDocumentThumbnailController({
    currentPage: toRef(props, 'currentPage'),
    isActive: computed(() => props.isActive),
    isResizing: computed(() => props.isResizing),
    itemMetricsKey: toRef(props, 'itemMetricsKey'),
    pageRevision: toRef(props, 'pageRevision'),
    scrollRoot,
    source: toRef(props, 'source'),
});
// One tab stop among the mounted rows, so the rail stays reachable by Tab
// after the focused row scrolls out of the virtual window.
const resolvedVirtualItems = computed(() => unref(virtualItems) ?? []);
const tabStopPage = computed(() => {
    const items = resolvedVirtualItems.value;
    const first = items[0]?.pageNumber ?? 0;
    const last = items.at(-1)?.pageNumber ?? 0;
    return Math.min(Math.max(props.focusPage ?? props.currentPage, first), last);
});
defineExpose({
    revealPage,
    scrollRoot,
    scrollToRequestedOffset,
});

// A resize never stretches an old, smaller raster. Capped source images are
// contained at their native density, while the slot stays unchanged.
function surfaceState(pageNumber: number) {
    const state = states.get(pageNumber);
    return state && state.requestWidthPx >= (unref(rasterWidth) ?? 0) ? state : undefined;
}

const mountedRows = computed(() => {
    const items = resolvedVirtualItems.value;
    if (!items.length) {
        return [];
    }
    const hasSelection = props.selectedPages !== undefined;
    const stopPage = props.itemTag === 'div' ? tabStopPage.value : 0;
    const minRasterWidth = unref(rasterWidth) ?? 0;
    const scale = unref(outputScale) ?? 1;
    return items.map((item) => {
        const { pageNumber } = item;
        const rawState = states.get(pageNumber);
        const qualifiedState = rawState && rawState.requestWidthPx >= minRasterWidth
            ? rawState
            : undefined;
        const surface = qualifiedState?.surface;
        // A committed surface wins over a render error everywhere in the row: the
        // failure semantics belong to a row that has nothing to show, so a page still
        // holding an older thumbnail keeps its plain name and no failure marker.
        const showsRenderError = renderErrors.has(pageNumber) && !surface;
        const selected = hasSelection ? props.selectedPages!.has(pageNumber) : undefined;
        const displayPage = labelPage(pageNumber);
        return {
            pageNumber,
            aspectRatio: item.aspectRatio,
            placementStyle: {
                height: `${String(item.height)}px`,
                transform: `translateY(${String(item.top)}px)`,
            },
            current: pageNumber === props.currentPage,
            selected,
            role: hasSelection ? 'option' : undefined,
            ariaSelected: selected,
            tabindex: props.itemTag === 'div'
                ? (props.disabled ? -1 : pageNumber === stopPage ? 0 : -1)
                : undefined,
            ariaLabel: showsRenderError
                ? t('documentSourceSidebar.goToPageRenderFailed', {page: displayPage})
                : t('documentSourceSidebar.goToPage', {page: displayPage}),
            showsRenderError,
            renderErrorAttr: showsRenderError ? '' : undefined,
            requestWidthAttr: rawState?.widthPx ?? '',
            imageSrc: typeof surface === 'string' ? surface : undefined,
            hasCanvasSurface: Boolean(surface && typeof surface !== 'string'),
            surfaceStyle: qualifiedState ? {
                maxWidth: `min(100%, ${String(qualifiedState.widthPx / scale)}px)`,
                maxHeight: `min(100%, ${String(qualifiedState.heightPx / scale)}px)`,
            } : undefined,
        };
    });
});

function setCanvasHost(
    pageNumber: number,
    value: Element | ComponentPublicInstance | null,
) {
    const host = value instanceof HTMLElement
        ? value
        : value && '$el' in value && value.$el instanceof HTMLElement ? value.$el : null;
    if (!host) {
        return;
    }
    const surface = surfaceState(pageNumber)?.surface;
    if (surface && typeof surface !== 'string' && host.firstChild !== surface) {
        host.replaceChildren(surface);
    }
}

function handleItemClick(pageNumber: number, event: MouseEvent) {
    if (props.disabled) {
        return;
    }
    // Activating a row that failed to render also asks for it again; the call is
    // a no-op for every other row.
    retryRender(pageNumber);
    emit('go-to-page', pageNumber, event);
}
</script>

<style scoped>
.document-thumbnail-list__content {
    position: relative;
    width: 100%;
}

.document-thumbnail-list__item {
    position: absolute;
    top: 0;
    left: 0;
}

.document-thumbnail-list__placeholder {
    width: 100%;
    height: 100%;
    background: var(--ui-bg-accented);
}

.document-thumbnail-list__canvas-host {
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    width: 100%;
    height: 100%;
    place-items: center;
}

/* The page itself carries the edge, so any page shape keeps a tight outline
   inside the fixed slot. box-shadow stays untransitioned: animating
   it repaints every frame. */
.document-thumbnail-list__image,
.document-thumbnail-list__canvas-host > :deep(canvas) {
    display: block;
    width: auto;
    max-width: 100%;
    height: auto;
    max-height: 100%;
    border-radius: var(--app-document-page-radius);
    box-shadow: var(--document-thumbnail-page-shadow, var(--app-document-page-shadow));
}

/* A row's surface is replaced when its raster lands. Keeping the row itself
   under the pointer lets a press that spans the swap still click the row. */
.document-thumbnail-list__item :is(img, .document-thumbnail-list__canvas-host, .document-thumbnail-list__placeholder) {
    pointer-events: none;
}

.document-thumbnail-list__slots,
.document-thumbnail-list__underlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    pointer-events: none;
}

.document-thumbnail-list__slots {
    top: calc(-1 * var(--document-thumbnail-slot-stride));
    height: var(--document-thumbnail-slot-cover);
    background:
        linear-gradient(var(--ui-bg-accented) var(--document-thumbnail-slot-height), transparent 0)
        var(--document-thumbnail-slot-x) var(--document-thumbnail-slot-y) / var(--document-thumbnail-slot-width) var(--document-thumbnail-slot-stride)
        repeat-y;
    animation: document-thumbnail-slots both steps(var(--document-thumbnail-slot-steps), end);
    animation-range: 0 calc(var(--document-thumbnail-slot-steps) * var(--document-thumbnail-slot-stride));
    animation-timeline: scroll(nearest block);
}

@keyframes document-thumbnail-slots {
    to { transform: translateY(calc(var(--document-thumbnail-slot-steps) * var(--document-thumbnail-slot-stride))); }
}

/* Each mounted row sits on the rail color, so the slots never show around a
   letterboxed page or under a row tint. One per row, not one for the whole
   range: a drawing that fills most of a layer becomes the color Chromium
   shows for its unrastered tiles, which would hide the slots again. */
.document-thumbnail-list__underlay {
    background: var(--app-document-thumbnails-background);
}
</style>
