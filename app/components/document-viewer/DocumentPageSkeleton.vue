<template>
    <!-- Plain elements, not USkeleton, and one pulse on .inner rather than one
    per line: a fast scroll mounts a dozen pages per frame, and a component and
    an animation for each of their hundreds of lines made every such frame a
    long task. -->
    <div
        class="document-page-skeleton"
        :class="{'is-deferred': isDeferred}"
        :style="paddingStyle"
        aria-hidden="true"
    >
        <div class="inner flex flex-col">
            <div class="header flex flex-col gap-2">
                <div class="title-line"></div>
                <div class="subtitle-line"></div>
            </div>

            <div class="paragraph flex flex-col">
                <div class="line"></div>
                <div class="line"></div>
                <div class="line is-short"></div>
            </div>

            <div class="paragraph flex flex-col">
                <div class="line"></div>
                <div class="line"></div>
                <div class="line is-short"></div>
            </div>

            <div class="formula-block">
                <div class="formula"></div>
                <div class="formula-inline-row">
                    <div class="formula-inline"></div>
                    <div class="formula-inline"></div>
                </div>
            </div>

            <div
                v-for="i in repeatParagraphs"
                :key="`document-page-skeleton-paragraph-${i}`"
                class="paragraph flex flex-col"
            >
                <div class="line"></div>
                <div class="line"></div>
                <div class="line is-short"></div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
interface IPadding {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

interface IProps {
    padding?: IPadding;
    contentHeight: number | null;
    /**
     * Stay transparent for a moment after mounting, so a page that paints
     * quickly never flashes the placeholder. Only the mount can start the
     * delay and turning it off ends it for good: a skeleton on screen must
     * never vanish and fade back in, and one that a second navigation
     * claims must show at once.
     */
    deferred?: boolean;
}

// Mirrors `--app-document-page-skeleton-*` in `app/assets/css/main.css` (and `.header` `gap-2`).
const ROOT_FONT_SIZE_PX = 16;
const SKELETON_LAYOUT_REM = {
    innerGap: 0.9,
    headerGap: 0.5,
    headerMarginBottom: 0.5,
    titleHeight: 1.2,
    subtitleHeight: 0.95,
    paragraphGap: 0.65,
    lineTallHeight: 1.05,
    lineHeight: 0.95,
    lineShortHeight: 0.85,
    formulaMarginTop: 0.55,
    formulaHeight: 1.3,
    formulaInlineMarginTop: 0.45,
} as const;

const HEADER_HEIGHT_REM = SKELETON_LAYOUT_REM.titleHeight + SKELETON_LAYOUT_REM.headerGap + SKELETON_LAYOUT_REM.subtitleHeight;
const PARAGRAPH_HEIGHT_REM =
    SKELETON_LAYOUT_REM.lineTallHeight +
    SKELETON_LAYOUT_REM.paragraphGap +
    SKELETON_LAYOUT_REM.lineHeight +
    SKELETON_LAYOUT_REM.paragraphGap +
    SKELETON_LAYOUT_REM.lineShortHeight;
const FORMULA_BLOCK_HEIGHT_REM =
    SKELETON_LAYOUT_REM.formulaHeight + SKELETON_LAYOUT_REM.formulaInlineMarginTop + SKELETON_LAYOUT_REM.lineHeight;
const FIXED_RESERVED_HEIGHT_PX =
    (HEADER_HEIGHT_REM +
        SKELETON_LAYOUT_REM.headerMarginBottom +
        SKELETON_LAYOUT_REM.innerGap +
        PARAGRAPH_HEIGHT_REM +
        SKELETON_LAYOUT_REM.innerGap +
        PARAGRAPH_HEIGHT_REM +
        SKELETON_LAYOUT_REM.innerGap +
        SKELETON_LAYOUT_REM.formulaMarginTop +
        FORMULA_BLOCK_HEIGHT_REM) *
    ROOT_FONT_SIZE_PX;
const PARAGRAPH_STRIDE_PX = (SKELETON_LAYOUT_REM.innerGap + PARAGRAPH_HEIGHT_REM) * ROOT_FONT_SIZE_PX;

const {padding, contentHeight, deferred = false} = defineProps<IProps>();

const isDeferred = ref(deferred);
watch(
    () => deferred,
    (value) => {
        if (!value) {
            isDeferred.value = false;
        }
    },
);

const paddingStyle = computed(() =>
    padding ? {padding: `${padding.top}px ${padding.right}px ${padding.bottom}px ${padding.left}px`} : undefined,
);

const repeatParagraphs = computed(() => {
    const height = contentHeight ?? 0;
    const paddingY = (padding?.top ?? 0) + (padding?.bottom ?? 0);
    const availableHeight = Math.max(height - paddingY - FIXED_RESERVED_HEIGHT_PX, 0);
    return Math.max(0, Math.floor(availableHeight / PARAGRAPH_STRIDE_PX));
});
</script>

<style scoped>
.document-page-skeleton {
    --document-page-skeleton-default-padding: 56px;

    position: absolute;
    inset: 0;
    z-index: var(--app-z-document-page-skeleton);
    display: flex;
    box-sizing: border-box;
    align-items: flex-start;
    justify-content: center;
    padding: var(--document-page-skeleton-default-padding);
    overflow: hidden;
    pointer-events: none;
    background: inherit;
    border-radius: inherit;
}

.is-deferred {
    animation: document-page-skeleton-reveal var(--app-document-page-skeleton-reveal-duration) ease-out
        var(--app-document-page-skeleton-reveal-delay) both;
}

.inner {
    position: relative;
    gap: var(--app-document-page-skeleton-gap);
    width: 100%;
    max-width: 100%;
    height: 100%;
    padding: 0;
    box-sizing: border-box;
    animation: document-page-skeleton-pulse 1s ease-in-out infinite;
}

.inner > * {
    position: relative;
    z-index: var(--app-z-document-pending-image);
}

.header {
    margin-bottom: var(--app-document-page-skeleton-header-margin);
}

.title-line,
.subtitle-line,
.line,
.formula,
.formula-inline {
    border-radius: var(--app-radius-full);
    background: color-mix(in oklab, var(--ui-text-muted) 18%, var(--ui-bg-muted) 82%);
}

.title-line {
    width: 60%;
    height: var(--app-document-page-skeleton-title-height);
    background: color-mix(in oklab, var(--ui-text-muted) 24%, var(--ui-bg-muted) 76%);
}

.subtitle-line {
    width: 42%;
    height: var(--app-document-page-skeleton-subtitle-height);
    opacity: 0.8;
}

.paragraph {
    gap: var(--app-document-page-skeleton-paragraph-gap);
}

.line {
    width: 100%;
    height: var(--app-document-page-skeleton-line-height);
}

.paragraph .line:nth-child(1) {
    height: var(--app-document-page-skeleton-line-tall-height);
}

.paragraph .line:nth-child(2) {
    height: var(--app-document-page-skeleton-line-height);
}

.paragraph .line:nth-child(3) {
    height: var(--app-document-page-skeleton-line-short-height);
}

.is-short {
    width: 78%;
}

.formula-block {
    margin-top: var(--app-document-page-skeleton-formula-margin);
}

.formula {
    width: 100%;
    height: var(--app-document-page-skeleton-formula-height);
}

.formula-inline-row {
    display: flex;
    gap: var(--app-document-page-skeleton-inline-gap);
    margin-top: var(--app-document-page-skeleton-inline-margin);
}

.formula-inline {
    flex: 1;
    height: var(--app-document-page-skeleton-line-height);
}

@keyframes document-page-skeleton-reveal {
    from {
        opacity: 0;
    }

    to {
        opacity: 1;
    }
}

@keyframes document-page-skeleton-pulse {
    0%,
    100% {
        opacity: 0.72;
    }

    50% {
        opacity: 1;
    }
}

html.app-low-graphics .inner {
    animation: none;
}

@media (prefers-reduced-motion: reduce) {
    .inner {
        animation: none;
    }

    /* Keep the delay that spares a quick page the flash; drop the fade. */
    .is-deferred {
        animation-timing-function: step-start;
    }
}
</style>
