<template>
    <DocumentThumbnailRail
        :set-root="setScrollRoot"
        class="document-thumbnail-list"
        data-testid="document-thumbnail-list"
        @scroll.passive="handleScroll"
        @wheel.passive="handleWheel"
        @pointerdown="handlePointerDown"
    >
        <div
            class="document-thumbnail-list__content"
            :data-thumbnail-scroll-segment="activeScrollSegmentIndex"
            :style="{height: contentHeight}"
        >
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
                    v-if="typeof states.get(item.pageNumber)?.surface === 'string'"
                    :src="states.get(item.pageNumber)?.surface as string"
                    alt=""
                    draggable="false"
                >
                <span
                    v-else-if="states.get(item.pageNumber)?.surface"
                    :ref="element => setCanvasHost(item.pageNumber, element)"
                    class="document-thumbnail-list__canvas-host"
                />
                <span
                    v-else-if="showsRenderError(item.pageNumber)"
                    class="document-thumbnail-list__error"
                    aria-hidden="true"
                >
                    <UIcon name="i-ph-warning-circle" class="size-5" />
                    <span class="document-thumbnail-list__error-text">{{ t('common.pageRenderFailed') }}</span>
                </span>
                <span v-else class="document-thumbnail-list__placeholder" />
                <template #label>
                    <slot name="label" :page-number="item.pageNumber">{{ item.pageNumber }}</slot>
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
    const surface = states.get(pageNumber)?.surface;
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
    return renderErrors.has(pageNumber) && !states.get(pageNumber)?.surface;
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

.document-thumbnail-list__error {
    display: flex;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    flex-direction: column;
    gap: var(--app-space-3xs);
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: var(--app-space-2xs);
    color: var(--ui-text-muted);
    text-align: center;
}

.document-thumbnail-list__error-text {
    font-size: var(--app-sidebar-caption-font-size);
    line-height: 1.2;
}

.document-thumbnail-list__placeholder {
    width: 100%;
    height: 100%;
    background: var(--ui-bg-elevated);
    animation:
        document-thumbnail-pulse
        var(--app-animation-duration-skeleton)
        ease-in-out infinite alternate;
}

:global(html.app-low-graphics) .document-thumbnail-list__placeholder {
    animation: none;
}

@keyframes document-thumbnail-pulse {
    from { opacity: 0.52; }
    to { opacity: 0.86; }
}

@media (prefers-reduced-motion: reduce) {
    .document-thumbnail-list__placeholder {
        animation: none;
    }
}
</style>
