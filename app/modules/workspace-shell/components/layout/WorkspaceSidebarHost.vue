<template>
    <main ref="workspaceMainRef" class="workspace-main">
        <div
            ref="sidebarWrapperRef"
            class="sidebar-wrapper"
            :class="{
                'is-closed': !showSidebar,
                'is-resizing': isResizingSidebar,
            }"
            :style="sidebarPresentationStyle"
            :aria-hidden="showSidebar ? undefined : 'true'"
            :inert="showSidebar ? undefined : true"
            @transitionend="handleWrapperTransitionEnd"
        >
            <div class="sidebar-wrapper__content" :style="sidebarContentStyle">
                <slot name="sidebar" />
            </div>
            <div
                v-show="showSidebar || isSliding"
                class="sidebar-resizer"
                :class="{ 'is-active': isResizingSidebar }"
                role="separator"
                aria-orientation="vertical"
                :aria-label="resizeAriaLabel"
                @pointerdown.prevent="handleResizeStart"
            />
        </div>
        <div class="workspace-main__viewer">
            <slot />
        </div>
    </main>
</template>

<script setup lang="ts">
import type { CSSProperties } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';

const {
    isResizingSidebar,
    showSidebar,
    sidebarContentWidth,
    sidebarWrapperStyle = undefined,
} = defineProps<{
    showSidebar: boolean;
    sidebarContentWidth: number;
    sidebarWrapperStyle?: CSSProperties | null;
    isResizingSidebar: boolean;
    resizeAriaLabel: string;
}>();

const emit = defineEmits<{
    'resize-start': [event: PointerEvent];
    'container-resize': [width: number];
    'slide-start': [];
    'slide-end': [];
}>();
const workspaceMainRef = useTemplateRef<HTMLElement>('workspaceMainRef');
const sidebarWrapperRef = useTemplateRef<HTMLElement>('sidebarWrapperRef');
const sidebarPresentationStyle = computed<CSSProperties>(() => ({
    ...(sidebarWrapperStyle ?? {}),
    width: showSidebar ? sidebarWrapperStyle?.width : '0px',
}));
/**
 * The wrapper animates its width and clips the panel, so the panel is revealed
 * and covered like a curtain. The panel itself takes its open width at once and
 * only collapses after the closing slide, so the tab bar and thumbnail rail lay
 * out once per toggle instead of on every frame, and a closed panel cannot
 * measure as visible.
 */
const sidebarContentStyle = computed<CSSProperties>(() => (
    {width: showSidebar ? `${String(sidebarContentWidth)}px` : '0px'}
));

/**
 * A transition that never fires `transitionend` (a hidden host, a display
 * change) must still release the viewer, so the slide also ends on a timer
 * derived from the same CSS. The margin keeps the timer from winning against a
 * late `transitionend`; settling the viewer early would fix its fit scale to a
 * width the sidebar had not finished leaving.
 */
const SLIDE_END_FALLBACK_MARGIN_MS = 150;
let slideEndFallbackTimer: ReturnType<typeof setTimeout> | null = null;
// The sash is the visible edge of the curtain. It stays through the closing
// slide so the panel is covered behind a border rather than cut off raw.
const isSliding = ref(false);

function parseCssTimeMs(value: string) {
    const trimmed = value.trim();
    if (trimmed.endsWith('ms')) {
        return Number.parseFloat(trimmed);
    }
    if (trimmed.endsWith('s')) {
        return Number.parseFloat(trimmed) * 1000;
    }
    return 0;
}

function resolveWidthTransitionMs(style: CSSStyleDeclaration) {
    const properties = style.transitionProperty.split(',').map(property => property.trim());
    const durations = style.transitionDuration.split(',').map(parseCssTimeMs);
    const delays = style.transitionDelay.split(',').map(parseCssTimeMs);
    // Shorter transition value lists repeat cyclically over the property list.
    return properties.reduce((longest, property, index) => {
        if (property !== 'width' && property !== 'all') {
            return longest;
        }
        const duration = durations[index % durations.length] ?? 0;
        const delay = delays[index % delays.length] ?? 0;
        return Math.max(longest, duration + delay);
    }, 0);
}

function finishSlide() {
    if (slideEndFallbackTimer === null) {
        return;
    }
    clearTimeout(slideEndFallbackTimer);
    slideEndFallbackTimer = null;
    isSliding.value = false;
    emit('slide-end');
}

function handleWrapperTransitionEnd(event: TransitionEvent) {
    if (event.target === sidebarWrapperRef.value && event.propertyName === 'width') {
        finishSlide();
    }
}

// Runs before this component re-renders, so the viewer learns it is resizing
// before the first animated frame reaches its ResizeObserver. The wrapper's
// transition does not depend on the open state, so the current computed style
// already describes the slide that is about to start.
watch(() => showSidebar, () => {
    const wrapper = sidebarWrapperRef.value;
    const slideMs = wrapper ? resolveWidthTransitionMs(window.getComputedStyle(wrapper)) : 0;
    if (slideMs <= 0) {
        finishSlide();
        return;
    }
    if (slideEndFallbackTimer === null) {
        isSliding.value = true;
        emit('slide-start');
    } else {
        clearTimeout(slideEndFallbackTimer);
    }
    slideEndFallbackTimer = setTimeout(finishSlide, slideMs + SLIDE_END_FALLBACK_MARGIN_MS);
});

onBeforeUnmount(finishSlide);

useResizeObserver(workspaceMainRef, (entries) => {
    const width = entries[0]?.contentRect.width;
    if (width !== undefined) {
        emit('container-resize', width);
    }
});

function handleResizeStart(event: PointerEvent) {
    emit('resize-start', event);
}

watch(
    () => [
        showSidebar,
        sidebarWrapperStyle?.width,
        isResizingSidebar,
    ] as const,
    ([
        nextShowSidebar,
        nextWidth,
        nextResizing,
    ], previousState) => {
        const [
            prevShowSidebar,
            prevWidth,
            prevResizing,
        ] = previousState ?? [
            nextShowSidebar,
            nextWidth,
            nextResizing,
        ];
        if (
            nextShowSidebar === prevShowSidebar
            && nextWidth === prevWidth
            && nextResizing === prevResizing
        ) {
            return;
        }
        BrowserLogger.diagnostic('pdf-nav', `[sidebar-host] show=${nextShowSidebar} width=${String(nextWidth)} resizing=${nextResizing}`, {
            showSidebar: {
                previous: prevShowSidebar,
                next: nextShowSidebar, 
            },
            sidebarWidth: {
                previous: prevWidth ?? null,
                next: nextWidth ?? null, 
            },
            isResizingSidebar: {
                previous: prevResizing,
                next: nextResizing, 
            },
        });
    },
    { immediate: true },
);
</script>

<style scoped>
.workspace-main {
    flex: 1;
    overflow: hidden;
    display: flex;
    position: relative;
    min-width: 0;
    min-height: 0;
}

.workspace-main__viewer {
    flex: 1;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
}

.sidebar-wrapper {
    position: relative;
    display: flex;
    height: 100%;
    min-width: 0;
    max-width: 100%;
    flex-shrink: 0;
    overflow: hidden;
    background: var(--app-sidebar-bg);
    transition: width var(--app-transition-reorder);
}

.sidebar-wrapper__content {
    display: flex;
    height: 100%;
    flex: 0 0 auto;
    overflow: hidden;
    transition: width 0s;
}

.sidebar-wrapper.is-closed {
    pointer-events: none;
}

.sidebar-wrapper.is-closed .sidebar-wrapper__content {
    transition: width 0s var(--app-transition-reorder-duration);
}

.sidebar-wrapper.is-resizing,
.sidebar-wrapper.is-resizing .sidebar-wrapper__content {
    transition: none;
}

.sidebar-resizer {
    /* Pinned to the wrapper's clip edge so it travels with the curtain instead
       of being clipped away with the panel while the wrapper is narrower. */
    position: absolute;
    inset-block: 0;
    inset-inline-end: 0;
    width: var(--app-editor-sash-width);
    cursor: col-resize;
    user-select: none;
    touch-action: none;
    background: var(--app-editor-sash-bg);
    transition: background-color 0.12s ease;
}

.sidebar-resizer:hover,
.sidebar-resizer.is-active {
    background: var(--app-editor-sash-bg-hover);
}

@media (prefers-reduced-motion: reduce) {
    .sidebar-wrapper,
    .sidebar-wrapper.is-closed .sidebar-wrapper__content {
        transition: none;
    }
}
</style>
