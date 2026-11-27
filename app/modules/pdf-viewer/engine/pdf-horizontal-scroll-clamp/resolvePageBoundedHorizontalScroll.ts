import {isFinitePositive} from '@contracts/runtimeGuards';
import {clamp} from 'es-toolkit/math';
import type {IPageBoundedHorizontalScrollInput} from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/pdfHorizontalScrollClampTypes';

export const HORIZONTAL_SCROLL_CLAMP_EPSILON_PX = 1.5;

function normalizeNonNegative(value: number) {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function resolvePageBoundedHorizontalScroll(input: IPageBoundedHorizontalScrollInput) {
    const viewportWidth = input.viewportWidth;
    const pageWidth = input.pageWidth;
    if (!isFinitePositive(viewportWidth) || !isFinitePositive(pageWidth)) {
        return null;
    }

    const pageLeft = normalizeNonNegative(input.pageLeft);
    const margin = normalizeNonNegative(input.margin);
    const epsilon = normalizeNonNegative(input.epsilon ?? HORIZONTAL_SCROLL_CLAMP_EPSILON_PX);
    const contentViewportWidth = Math.max(0, viewportWidth - margin * 2);

    if (pageWidth <= contentViewportWidth + epsilon) {
        const centeredScrollLeft = pageLeft - Math.max(0, (viewportWidth - pageWidth) / 2);
        const targetScrollLeft = Math.max(0, centeredScrollLeft);
        return {
            minScrollLeft: targetScrollLeft,
            maxScrollLeft: targetScrollLeft,
            scrollLeft: targetScrollLeft,
            shouldLock: true,
        };
    }

    const pageRight = pageLeft + pageWidth;
    const minScrollLeft = Math.max(0, pageLeft - margin);
    const maxScrollLeft = Math.max(minScrollLeft, pageRight + margin - viewportWidth);

    return {
        minScrollLeft,
        maxScrollLeft,
        scrollLeft: clamp(input.scrollLeft, minScrollLeft, maxScrollLeft),
        shouldLock: false,
    };
}
