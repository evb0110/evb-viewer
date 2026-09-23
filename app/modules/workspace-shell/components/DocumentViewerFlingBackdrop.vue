<template>
    <div class="document-viewer-fling-backdrop" aria-hidden="true">
        <div
            v-if="strip"
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
                    v-for="(shell, index) in backdrop.pages"
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
</template>

<script setup lang="ts">
import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import {
    resolveDocumentWheelInteraction,
    type IDocumentViewportFlingBackdrop,
} from '@app/modules/document-viewer/public';

interface IScrollTimelineOptions {
    source: Element;
    axis: 'block';
}

interface IScrollTimelineConstructor {new (options: IScrollTimelineOptions): AnimationTimeline}

const {
    backdrop,
    viewport,
} = defineProps<{
    backdrop: IDocumentViewportFlingBackdrop;
    viewport: HTMLElement | null;
}>();

// A fling moves more than a viewport between consecutive scroll events. So can
// a page jump or a zoom, which is why a step shows the strip only while wheel
// scrolling is under way. The strip hides once the scroll slows down.
const USER_WHEEL_WINDOW_MS = 200;
const FLING_HOLD_MS = 400;

const active = ref(false);
const viewportWidth = ref(0);
const viewportHeight = ref(0);
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
const pitch = computed(() => backdrop.pitch);
const columnGap = computed(() => backdrop.columnGap);
const phase = computed(() => ((backdrop.rowTop % backdrop.pitch) + backdrop.pitch) % backdrop.pitch);
const rowCount = computed(() => (
    viewportHeight.value > 0 && backdrop.pitch > 0
        ? Math.ceil(viewportHeight.value / backdrop.pitch) + 2
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
    if (!viewport) {
        return;
    }
    const scrollRange = viewport.scrollHeight - viewport.clientHeight;
    if (scrollRange > 0 && scrollRange !== binding.scrollRange) {
        binding.scrollRange = scrollRange;
        binding.animation.effect?.updateTiming({iterations: scrollRange / binding.rowPitch});
    }
}

function showStrip() {
    syncScrollRange();
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

watch(() => viewport, (element, _previous, onCleanup) => {
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
    const observer = new ResizeObserver(() => {
        viewportWidth.value = element.clientWidth;
        viewportHeight.value = element.clientHeight;
    });
    observer.observe(element);
    onCleanup(() => {
        element.removeEventListener('scroll', handleScroll);
        element.removeEventListener('wheel', handleWheel);
        observer.disconnect();
    });
}, {immediate: true});

// The compositor drives the strip from the viewport's scroll offset: each
// iteration moves it up by one row, and one iteration spans one row of scroll,
// so the rows stay in phase with the page track without new raster. It stays
// bound while the strip is transparent: a fling can outrun raster in its first
// frame, before the main thread shows the strip, and binding it then would
// cost more frames. Showing the strip refreshes the iterations when the scroll
// range has changed since.
watchEffect((onCleanup) => {
    const element = stripElement.value;
    const source = viewport;
    const rowPitch = pitch.value;
    void bindRevision.value;
    if (!element || !source || !(rowPitch > 0)) {
        return;
    }
    const ScrollTimelineConstructor = getScrollTimelineConstructor();
    const scrollRange = source.scrollHeight - source.clientHeight;
    if (!ScrollTimelineConstructor || scrollRange <= 0) {
        return;
    }
    const animation = element.animate([
        {transform: 'translateY(0)'},
        {transform: `translateY(${-rowPitch}px)`},
    ], {
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
