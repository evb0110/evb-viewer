import {
    ref,
    computed,
    toValue,
    provide,
    inject,
    type MaybeRefOrGetter,
    type InjectionKey,
    type ComputedRef,
} from 'vue';
import { BrowserLogger } from '@app/utils/browser-logger';
import type {
    IContentInsets,
    PDFPageProxy,
} from '@app/types/pdf';
import { clamp } from 'es-toolkit/math';

interface IPdfSkeletonContext {
    scaledSkeletonPadding: ComputedRef<IContentInsets | null>;
    scaledPageHeight: ComputedRef<number | null>;
}

const PDF_SKELETON_CONTEXT_KEY: InjectionKey<IPdfSkeletonContext> = Symbol('PdfSkeletonContext');

export const usePdfSkeletonContext = () => {
    const context = inject<IPdfSkeletonContext>(PDF_SKELETON_CONTEXT_KEY);
    if (!context) {
        throw new Error('usePdfSkeletonContext must be used within a component that calls usePdfSkeletonInsets');
    }
    return context;
};

export const usePdfSkeletonInsets = (
    basePageWidth: MaybeRefOrGetter<number | null>,
    basePageHeight: MaybeRefOrGetter<number | null>,
    effectiveScale: MaybeRefOrGetter<number>,
) => {
    const skeletonContentInsets = ref<IContentInsets | null>(null);

    const scaledSkeletonPadding = computed<IContentInsets | null>(() => {
        const width = toValue(basePageWidth);
        const height = toValue(basePageHeight);
        if (!width || !height) {
            return null;
        }

        const insets = skeletonContentInsets.value ?? buildFallbackInsets(width, height);
        const scale = toValue(effectiveScale);

        return {
            top: insets.top * scale,
            right: insets.right * scale,
            bottom: insets.bottom * scale,
            left: insets.left * scale,
        };
    });

    const scaledPageHeight = computed(() => {
        const height = toValue(basePageHeight);
        if (!height) {
            return null;
        }
        return Math.floor(height * toValue(effectiveScale));
    });

    provide(PDF_SKELETON_CONTEXT_KEY, {
        scaledSkeletonPadding,
        scaledPageHeight,
    });

    function buildFallbackInsets(width: number, height: number): IContentInsets {
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
    ): IContentInsets | null {
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
        const width = toValue(basePageWidth);
        const height = toValue(basePageHeight);
        if (!width || !height) {
            skeletonContentInsets.value = null;
            return;
        }

        const fallback = buildFallbackInsets(width, height);

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
            BrowserLogger.warn('pdf-skeleton', 'Failed to derive PDF content bounds, using fallback', error);
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
