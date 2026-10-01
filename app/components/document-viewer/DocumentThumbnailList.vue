<template>
    <DocumentThumbnailRail
        :set-root="setScrollRoot"
        class="document-thumbnail-list"
        data-testid="document-thumbnail-list"
        :style="{overflow: userScrollSuppressed ? 'hidden' : undefined}"
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
                v-for="item in virtualItems"
                :key="item.pageNumber"
                class="document-thumbnail-list__underlay"
                :style="{height: `${String(item.height)}px`, transform: `translateY(${String(item.top)}px)`}"
                aria-hidden="true"
            />
            <DocumentThumbnailItem
                v-for="item in virtualItems"
                :key="item.pageNumber"
                class="document-thumbnail-list__item"
                :current="item.pageNumber === currentPage"
                :aria-disabled="disabled || undefined"
                :selected="selectedPages?.has(item.pageNumber)"
                :tag="itemTag"
                :role="selectedPages ? 'option' : undefined"
                :aria-selected="selectedPages ? selectedPages.has(item.pageNumber) : undefined"
                :tabindex="itemTag === 'div'
                    ? (disabled ? -1 : item.pageNumber === tabStopPage ? 0 : -1)
                    : undefined"
                frame-class="document-thumbnail-list__frame"
                :frame-style="{aspectRatio: item.aspectRatio}"
                :style="{height: `${String(item.height)}px`, transform: `translateY(${String(item.top)}px)`}"
                :aria-label="showsRenderError(item.pageNumber)
                    ? t('documentSourceSidebar.goToPageRenderFailed', {page: item.pageNumber})
                    : t('documentSourceSidebar.goToPage', {page: item.pageNumber})"
                :data-thumbnail-page="item.pageNumber"
                :data-thumbnail-render-error="showsRenderError(item.pageNumber) ? '' : undefined"
                :data-thumbnail-request-width="states.get(item.pageNumber)?.widthPx ?? ''"
                :disabled="disabled"
                data-pane-relocation-scroll-item
                @click="handleItemClick(item.pageNumber, $event)"
            >
                <template #overlay>
                    <slot name="overlay" :page-number="item.pageNumber" />
                </template>
                <img
                    v-if="typeof surfaceState(item.pageNumber)?.surface === 'string'"
                    :src="surfaceState(item.pageNumber)?.surface as string"
                    :style="surfaceStyle(item.pageNumber)"
                    alt=""
                    draggable="false"
                >
                <span
                    v-else-if="surfaceState(item.pageNumber)?.surface"
                    :ref="element => setCanvasHost(item.pageNumber, element)"
                    class="document-thumbnail-list__canvas-host"
                    :style="surfaceStyle(item.pageNumber)"
                />
                <span v-else class="document-thumbnail-list__placeholder" />
                <template #label>
                    <slot name="label" :page-number="item.pageNumber">{{ item.pageNumber }}</slot>
                    <span v-if="showsRenderError(item.pageNumber)" class="document-thumbnail-list__error" aria-hidden="true">
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
    disabled?: boolean;
}>();
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
const tabStopPage = computed(() => {
    const first = virtualItems.value[0]?.pageNumber ?? 0;
    const last = virtualItems.value.at(-1)?.pageNumber ?? 0;
    return Math.min(Math.max(props.focusPage ?? props.currentPage, first), last);
});
defineExpose({
    revealPage,
    scrollRoot,
});

// A resize never stretches an old, smaller raster. Capped source images are
// contained at their native density, while the portrait slot stays unchanged.
function surfaceState(pageNumber: number) {
    const state = states.get(pageNumber);
    return state && state.requestWidthPx >= rasterWidth.value ? state : undefined;
}

function surfaceStyle(pageNumber: number) {
    const state = surfaceState(pageNumber);
    return state ? {
        maxWidth: `min(100%, ${String(state.widthPx / outputScale.value)}px)`,
        maxHeight: `min(100%, ${String(state.heightPx / outputScale.value)}px)`,
    } : undefined;
}

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

/**
 * A committed surface wins over a render error everywhere in the row: the
 * failure semantics belong to a row that has nothing to show, so a page still
 * holding an older thumbnail keeps its plain name and no failure marker.
 */
function showsRenderError(pageNumber: number) {
    return renderErrors.has(pageNumber) && !surfaceState(pageNumber)?.surface;
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
