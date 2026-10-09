<template>
    <div class="document-viewer-fling-backdrop" aria-hidden="true">
        <div
            v-if="strip"
            class="document-viewer-fling-backdrop__client"
            :style="strip.clientStyle"
        >
            <div
                ref="stripElement"
                class="document-viewer-fling-backdrop__strip"
                :class="{'document-viewer-fling-backdrop__strip--visible': active}"
                :style="strip.style"
            >
                <div
                    v-for="row in strip.rows"
                    :key="row"
                    class="document-viewer-fling-backdrop__row"
                    :style="strip.rowStyle"
                >
                    <div
                        v-for="(shell, index) in backdrop?.pages ?? []"
                        :key="index"
                        class="document-viewer-fling-backdrop__page"
                        :style="{
                            width: `${shell.width}px`,
                            height: `${shell.height}px`,
                        }"
                    >
                        <DocumentPageSkeleton :content-height="shell.height" />
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import {
    injectDocumentViewerRuntime,
    resolveDocumentWheelInteraction,
} from '@app/modules/document-viewer/public';

interface IScrollTimelineOptions {
    source: Element;
    axis: 'block';
}

interface IScrollTimelineConstructor {new (options: IScrollTimelineOptions): AnimationTimeline}

// The backdrop and the viewport are read from the chassis runtime that owns
// them, so the chassis does not re-render when the row geometry changes.
const runtime = injectDocumentViewerRuntime();
if (!runtime) {
    throw new Error('DocumentViewerFlingBackdrop renders inside a document viewer chassis');
}
const backdrop = runtime.viewportFlingBackdrop;
const viewport = runtime.viewportElement;

// A fling moves more than a viewport between consecutive scroll events. So can
// a page jump or a zoom, which is why a step shows the strip only while wheel
// scrolling is under way. The strip hides once the scroll slows down.
const USER_WHEEL_WINDOW_MS = 200;
const FLING_HOLD_MS = 400;

const active = ref(false);
const viewportWidth = ref(0);
const viewportHeight = ref(0);
const viewportClientLeft = ref(0);
const viewportClientTop = ref(0);
const stripElement = shallowRef<HTMLElement | null>(null);
let lastScrollTop: number | null = null;
let lastUserWheelAt = Number.NEGATIVE_INFINITY;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let binding: {
    animation: Animation;
    rowPitch: number;
    scrollRange: number;
} | null = null;
// Rebinds the scroll animation when no binding exists yet, for example while
// the scroll range was still empty.
const bindRevision = ref(0);

// Primitive projections: a renderer republishes the descriptor as the current
// page changes, and an unchanged row must not restart the scroll animation.
const pitch = computed(() => backdrop.value?.pitch ?? 0);
const columnGap = computed(() => backdrop.value?.columnGap ?? 0);
const phase = computed(() => (pitch.value > 0
    ? (((backdrop.value?.rowTop ?? 0) % pitch.value) + pitch.value) % pitch.value
    : 0));
const rowCount = computed(() => (
    viewportHeight.value > 0 && pitch.value > 0
        ? Math.ceil(viewportHeight.value / pitch.value) + 2
        : 0
));

// The strip stays mounted, transparent while idle, so that showing it does not
// wait for raster.
const strip = computed(() => {
    if (rowCount.value <= 0 || viewportWidth.value <= 0) {
        return null;
    }
    return {
        rows: rowCount.value,
        // The strip stays inside the client area: the scroll bar tracks are
        // transparent, and wide pages would otherwise show through them.
        clientStyle: {
            left: `${viewportClientLeft.value}px`,
            top: `${viewportClientTop.value}px`,
            width: `${viewportWidth.value}px`,
            height: `${viewportHeight.value}px`,
        },
        style: {
            width: `${viewportWidth.value}px`,
            top: `${phase.value - pitch.value}px`,
        },
        rowStyle: {
            height: `${pitch.value}px`,
            columnGap: `${columnGap.value}px`,
        },
    };
});

function getScrollTimelineConstructor() {
    const candidate: unknown = Reflect.get(window, 'ScrollTimeline');
    return typeof candidate === 'function' ? candidate as IScrollTimelineConstructor : null;
}

function releaseHold() {
    if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
    }
}

function syncScrollRange() {
    if (!binding) {
        bindRevision.value += 1;
        return;
    }
    const element = viewport.value;
    if (!element || !element.isConnected) {
        return;
    }
    const scrollRange = element.scrollHeight - element.clientHeight;
    if (scrollRange > 0 && scrollRange !== binding.scrollRange) {
        binding.scrollRange = scrollRange;
        binding.animation.effect?.updateTiming({iterations: scrollRange / binding.rowPitch});
    }
}

function showStrip() {
    active.value = true;
    releaseHold();
    holdTimer = setTimeout(() => {
        holdTimer = null;
        active.value = false;
    }, FLING_HOLD_MS);
}

function handleScroll(event: Event) {
    const source = event.currentTarget;
    if (!(source instanceof HTMLElement)) {
        return;
    }
    const scrollTop = source.scrollTop;
    const previousScrollTop = lastScrollTop;
    lastScrollTop = scrollTop;
    if (previousScrollTop === null || viewportHeight.value <= 0) {
        return;
    }
    if (Math.abs(scrollTop - previousScrollTop) <= viewportHeight.value) {
        return;
    }
    if (!active.value && performance.now() - lastUserWheelAt > USER_WHEEL_WINDOW_MS) {
        return;
    }
    showStrip();
}

watch(viewport, (element, _previous, onCleanup) => {
    lastScrollTop = null;
    if (!element) {
        return;
    }
    const handleWheel = (event: WheelEvent) => {
        const interaction = resolveDocumentWheelInteraction(event, element);
        if (interaction.intent === 'zoom') {
            return;
        }
        lastUserWheelAt = performance.now();
        // A packet that alone scrolls past the viewport shows the strip before
        // the compositor applies it.
        if (viewportHeight.value > 0 && Math.abs(interaction.deltaPx) > viewportHeight.value) {
            showStrip();
        }
    };
    element.addEventListener('scroll', handleScroll, {passive: true});
    element.addEventListener('wheel', handleWheel, {passive: true});
    // The content resizes without the viewport when pages are added or
    // removed. Resize callbacks run before paint, so the iterations never lag
    // the scroll range by a visible frame.
    const observer = new ResizeObserver(() => {
        viewportWidth.value = element.clientWidth;
        viewportHeight.value = element.clientHeight;
        viewportClientLeft.value = element.clientLeft;
        viewportClientTop.value = element.clientTop;
        syncScrollRange();
    });
    observer.observe(element);
    for (const child of element.children) {
        observer.observe(child);
    }
    const contentObserver = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.removedNodes) {
                if (node instanceof Element) {
                    observer.unobserve(node);
                }
            }
            for (const node of record.addedNodes) {
                if (node instanceof Element && node.parentElement === element) {
                    observer.observe(node);
                }
            }
        }
    });
    contentObserver.observe(element, {childList: true});
    onCleanup(() => {
        element.removeEventListener('scroll', handleScroll);
        element.removeEventListener('wheel', handleWheel);
        observer.disconnect();
        contentObserver.disconnect();
    });
}, {immediate: true});

function rowKeyframes(rowPitch: number) {
    return [
        {transform: 'translateY(0)'},
        {transform: `translateY(${-rowPitch}px)`},
    ];
}

// The compositor drives the strip from the viewport's scroll offset: each
// iteration moves it up by one row, and one iteration spans one row of scroll,
// so the rows stay in phase with the page track without new raster. It stays
// bound while the strip is transparent: a fling can outrun raster in its first
// frame, before the main thread shows the strip, and binding it then would
// cost more frames. The iterations follow the scroll range as it changes.
watch([
    stripElement,
    viewport,
    bindRevision,
], ([
    element,
    source,
], _previous, onCleanup) => {
    const rowPitch = pitch.value;
    if (!element || !source || !(rowPitch > 0)) {
        return;
    }
    const ScrollTimelineConstructor = getScrollTimelineConstructor();
    const scrollRange = source.scrollHeight - source.clientHeight;
    if (!ScrollTimelineConstructor || scrollRange <= 0) {
        return;
    }
    const animation = element.animate(rowKeyframes(rowPitch), {
        timeline: new ScrollTimelineConstructor({
            source,
            axis: 'block',
        }),
        iterations: scrollRange / rowPitch,
        easing: 'linear',
        fill: 'both',
    });
    binding = {
        animation,
        rowPitch,
        scrollRange,
    };
    onCleanup(() => {
        animation.cancel();
        binding = null;
    });
}, {immediate: true});

// A zoom or a pane resize changes the row pitch, during a divider drag on
// every frame. The bound animation takes the new pitch in place: rebinding
// read the scroll range, forcing a layout in the middle of the update, and
// replaced the scroll timeline. The resize observer above corrects the
// iterations once the new scroll range is laid out, before paint.
watch(pitch, (rowPitch) => {
    const effect = binding?.animation.effect;
    if (!binding || !(rowPitch > 0) || !(effect instanceof KeyframeEffect)) {
        bindRevision.value += 1;
        return;
    }
    effect.setKeyframes(rowKeyframes(rowPitch));
    effect.updateTiming({iterations: binding.scrollRange / rowPitch});
    binding.rowPitch = rowPitch;
});

onBeforeUnmount(releaseHold);
</script>

<style scoped>
.document-viewer-fling-backdrop {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    background: var(--app-document-viewer-bg);
}

.document-viewer-fling-backdrop__client {
    position: absolute;
    overflow: hidden;
}

.document-viewer-fling-backdrop__strip {
    position: absolute;
    left: 0;
    opacity: 0;
    will-change: transform, opacity;
}

.document-viewer-fling-backdrop__strip--visible {
    opacity: 1;
}

.document-viewer-fling-backdrop__row {
    display: flex;
    box-sizing: border-box;
    align-items: flex-start;
    justify-content: center;
}

.document-viewer-fling-backdrop__page {
    position: relative;
    flex: none;
    overflow: hidden;
    background: var(--app-document-page-bg);
    border-radius: var(--app-document-page-radius);
    box-shadow: var(--app-document-page-shadow);
}
</style>
