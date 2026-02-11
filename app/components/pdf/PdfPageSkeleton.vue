<template>
    <div class="pdf-page-skeleton" :style="paddingStyle">
        <div class="pdf-page-skeleton__inner">
            <div class="pdf-page-skeleton__header">
                <USkeleton class="pdf-page-skeleton__title" />
                <USkeleton class="pdf-page-skeleton__subtitle" />
            </div>

            <div class="pdf-page-skeleton__paragraph">
                <USkeleton class="pdf-page-skeleton__line" />
                <USkeleton class="pdf-page-skeleton__line" />
                <USkeleton class="pdf-page-skeleton__line pdf-page-skeleton__line--short" />
            </div>

            <div class="pdf-page-skeleton__paragraph">
                <USkeleton class="pdf-page-skeleton__line" />
                <USkeleton class="pdf-page-skeleton__line" />
                <USkeleton class="pdf-page-skeleton__line pdf-page-skeleton__line--short" />
            </div>

            <div class="pdf-page-skeleton__formula-block">
                <USkeleton class="pdf-page-skeleton__formula" />
                <div class="pdf-page-skeleton__formula-inline-row">
                    <USkeleton class="pdf-page-skeleton__formula-inline" />
                    <USkeleton class="pdf-page-skeleton__formula-inline" />
                </div>
            </div>

            <div
                v-for="i in repeatParagraphs"
                :key="`pdf-page-skeleton-paragraph-${i}`"
                class="pdf-page-skeleton__paragraph"
            >
                <USkeleton class="pdf-page-skeleton__line" />
                <USkeleton class="pdf-page-skeleton__line" />
                <USkeleton class="pdf-page-skeleton__line pdf-page-skeleton__line--short" />
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface IPadding {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

interface IProps {
    padding: IPadding | null;
    contentHeight: number | null;
}

const {
    padding,
    contentHeight,
} = defineProps<IProps>();

const resolvedPadding = computed<IPadding>(() => ({
    top: padding?.top ?? 0,
    right: padding?.right ?? 0,
    bottom: padding?.bottom ?? 0,
    left: padding?.left ?? 0,
}));

const paddingStyle = computed(() => ({padding: `${resolvedPadding.value.top}px ${resolvedPadding.value.right}px ${resolvedPadding.value.bottom}px ${resolvedPadding.value.left}px`}));

const repeatParagraphs = computed(() => {
    const height = contentHeight ?? 0;
    const REM = 16;

    const gapInner = 0.9;

    const headerHeight = 1.2 + 0.5 + 0.95;
    const headerMarginBottom = 0.5;

    const paragraphHeight = 1.05 + 0.65 + 0.95 + 0.65 + 0.85;

    const formulaBlockMarginTop = 0.55;
    const formulaBlockHeight = 1.3 + 0.45 + 0.95;

    const fixedReservedRem =
        headerHeight +
        headerMarginBottom +
        gapInner +
        paragraphHeight +
        gapInner +
        paragraphHeight +
        gapInner +
        formulaBlockMarginTop +
        formulaBlockHeight;

    const strideRem = gapInner + paragraphHeight;

    const paddingY = (padding?.top ?? 0) + (padding?.bottom ?? 0);
    const availableHeight = Math.max(
        height - paddingY - fixedReservedRem * REM,
        0,
    );
    const count = Math.floor(availableHeight / (strideRem * REM));

    return Math.max(0, count);
});
</script>

<style scoped>
.pdf-page-skeleton {
    position: absolute;
    inset: 0;
    border-radius: 2px;
    box-shadow: var(--shadow-sm);
    background: var(--ui-bg);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    overflow: hidden;
    pointer-events: none;
    animation: pdf-page-skeleton-pulse 0.9s ease-in-out infinite;
    box-sizing: border-box;
}

.pdf-page-skeleton__inner {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    width: 100%;
    max-width: 100%;
    height: 100%;
    padding: 0;
    box-sizing: border-box;
}

.pdf-page-skeleton__inner > * {
    position: relative;
    z-index: 1;
}

.pdf-page-skeleton__header {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
}

.pdf-page-skeleton__title,
.pdf-page-skeleton__subtitle,
.pdf-page-skeleton__line,
.pdf-page-skeleton__formula,
.pdf-page-skeleton__formula-inline {
    border-radius: 999px;
}

.pdf-page-skeleton__title {
    width: 60%;
    height: 1.2rem;
}

.pdf-page-skeleton__subtitle {
    width: 42%;
    height: 0.95rem;
    opacity: 0.8;
}

.pdf-page-skeleton__paragraph {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
}

.pdf-page-skeleton__line {
    width: 100%;
    height: 0.95rem;
}

.pdf-page-skeleton__paragraph .pdf-page-skeleton__line:nth-child(1) {
    height: 1.05rem;
}

.pdf-page-skeleton__paragraph .pdf-page-skeleton__line:nth-child(2) {
    height: 0.95rem;
}

.pdf-page-skeleton__paragraph .pdf-page-skeleton__line:nth-child(3) {
    height: 0.85rem;
}

.pdf-page-skeleton__line--short {
    width: 78%;
}

.pdf-page-skeleton__formula-block {
    margin-top: 0.55rem;
}

.pdf-page-skeleton__formula {
    width: 100%;
    height: 1.3rem;
}

.pdf-page-skeleton__formula-inline-row {
    display: flex;
    gap: 0.55rem;
    margin-top: 0.45rem;
}

.pdf-page-skeleton__formula-inline {
    flex: 1;
    height: 0.95rem;
}

@keyframes pdf-page-skeleton-pulse {
    0%,
    100% {
        opacity: 0.45;
    }

    50% {
        opacity: 1;
    }
}
</style>
