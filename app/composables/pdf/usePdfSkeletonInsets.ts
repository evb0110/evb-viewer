import {
    ref,
    computed,
    type Ref,
} from 'vue';
import type {
    TContentInsets,
    PDFPageProxy,
} from '../../types/pdf';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const usePdfSkeletonInsets = (
    basePageWidth: Ref<number | null>,
    basePageHeight: Ref<number | null>,
    effectiveScale: Ref<number>,
) => {
    const skeletonContentInsets = ref<TContentInsets | null>(null);

    const scaledSkeletonPadding = computed<TContentInsets | null>(() => {
        if (!basePageWidth.value || !basePageHeight.value) {
            return null;
        }

        const insets = skeletonContentInsets.value
            ?? buildFallbackInsets(basePageWidth.value, basePageHeight.value);
        const scale = effectiveScale.value;

        return {
            top: insets.top * scale,
            right: insets.right * scale,
            bottom: insets.bottom * scale,
            left: insets.left * scale,
        };
    });

    const scaledPageHeight = computed(() => {
        if (!basePageHeight.value) {
            return null;
        }
        return Math.floor(basePageHeight.value * effectiveScale.value);
    });

    function buildFallbackInsets(width: number, height: number): TContentInsets {
        const horizontal = clamp(width * 0.08, 24, width / 3);
        const vertical = clamp(height * 0.1, 32, height / 3);

        return {
            top: vertical,
            right: horizontal,
            bottom: vertical,
            left: horizontal,
        };
    }

    function extractInsetsFromTextContent(
        viewport: {
            width: number;
            height: number;
            convertToViewportPoint: (x: number, y: number) => number[];
        },
        textContent: { items: Array<Record<string, unknown>> },
    ): TContentInsets | null {
        if (!textContent?.items?.length) {
            return null;
        }

        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;

        for (const item of textContent.items) {
            if (!item || !Array.isArray(item.transform)) {
                continue;
            }

            const transform = item.transform as number[];
            const originX = transform[4] ?? 0;
            const originY = transform[5] ?? 0;

            const itemWidth = typeof item.width === 'number' ? (item.width as number) : 0;
            const itemHeight = typeof item.height === 'number'
                ? (item.height as number)
                : Math.abs(transform[3] ?? 0);

            const points = [
                viewport.convertToViewportPoint(originX, originY),
                viewport.convertToViewportPoint(originX + itemWidth, originY),
                viewport.convertToViewportPoint(originX, originY + itemHeight),
                viewport.convertToViewportPoint(originX + itemWidth, originY + itemHeight),
            ];

            const xs = points.map(point => point[0] ?? 0);
            const ys = points.map(point => point[1] ?? 0);

            const localMinX = Math.min(...xs);
            const localMaxX = Math.max(...xs);
            const localMinY = Math.min(...ys);
            const localMaxY = Math.max(...ys);

            if (
                !Number.isFinite(localMinX) ||
                !Number.isFinite(localMinY) ||
                !Number.isFinite(localMaxX) ||
                !Number.isFinite(localMaxY)
            ) {
                continue;
            }

            minX = Math.min(minX, localMinX);
            minY = Math.min(minY, localMinY);
            maxX = Math.max(maxX, localMaxX);
            maxY = Math.max(maxY, localMaxY);
        }

        if (
            !Number.isFinite(minX) ||
            !Number.isFinite(minY) ||
            !Number.isFinite(maxX) ||
            !Number.isFinite(maxY)
        ) {
            return null;
        }

        const paddingX = Math.min((maxX - minX) * 0.05, 32);
        const paddingY = Math.min((maxY - minY) * 0.05, 32);

        const left = clamp(minX - paddingX, 0, viewport.width);
        const right = clamp(viewport.width - (maxX + paddingX), 0, viewport.width);
        const top = clamp(minY - paddingY, 0, viewport.height);
        const bottom = clamp(viewport.height - (maxY + paddingY), 0, viewport.height);

        const contentWidth = viewport.width - left - right;
        const contentHeight = viewport.height - top - bottom;

        if (contentWidth <= 0 || contentHeight <= 0) {
            return null;
        }

        return {
            top,
            right,
            bottom,
            left, 
        };
    }

    async function computeSkeletonInsets(
        pdfPage: PDFPageProxy,
        renderVersion: number,
        getCurrentVersion: () => number,
    ) {
        if (!basePageWidth.value || !basePageHeight.value) {
            skeletonContentInsets.value = null;
            return;
        }

        const fallback = buildFallbackInsets(basePageWidth.value, basePageHeight.value);

        try {
            const viewport = pdfPage.getViewport({ scale: 1 });
            const textContent = await pdfPage.getTextContent();

            if (getCurrentVersion() !== renderVersion) {
                return;
            }

            const detectedInsets = extractInsetsFromTextContent(viewport, textContent);

            skeletonContentInsets.value = detectedInsets
                ? {
                    top: Math.max(detectedInsets.top, fallback.top),
                    right: Math.max(detectedInsets.right, fallback.right),
                    bottom: Math.max(detectedInsets.bottom, fallback.bottom),
                    left: Math.max(detectedInsets.left, fallback.left),
                }
                : fallback;
        } catch (error) {
            if (getCurrentVersion() !== renderVersion) {
                return;
            }
            console.warn('Failed to derive PDF content bounds, using fallback.', error);
            skeletonContentInsets.value = fallback;
        }
    }

    function resetInsets() {
        skeletonContentInsets.value = null;
    }

    return {
        skeletonContentInsets,
        scaledSkeletonPadding,
        scaledPageHeight,
        computeSkeletonInsets,
        resetInsets,
    };
};
