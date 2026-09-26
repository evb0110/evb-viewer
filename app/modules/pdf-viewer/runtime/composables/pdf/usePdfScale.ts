import type { MaybeRefOrGetter } from 'vue';
import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import type {
    TFitMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import type {
    TPdfViewMode,
    TPdfViewRotation,
} from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import { normalizePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import { resolveCurrentSpreadBaseWidth } from '@app/modules/pdf-viewer/engine/pdf-page-layout/resolveCurrentSpreadBaseWidth';
import { resolveDocumentBaseMetric } from '@app/modules/pdf-viewer/engine/pdf-page-layout/resolveDocumentBaseMetric';
import {
    resolvePdfFitWidthDimensions as resolveSharedPdfFitWidthDimensions,
    resolvePdfFitWidthRowWidths,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/resolvePdfFitWidthDimensions';
import {
    clampPdfFitScale,
    resolvePdfZoomScale,
} from '@app/modules/pdf-viewer/runtime/zoom/resolvePdfZoomScale';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/public';

interface IFitScalePageOptions {page?: number | null | undefined;}

export const usePdfScale = (
    zoom: MaybeRefOrGetter<number>,
    zoomMode: MaybeRefOrGetter<TZoomMode>,
    fitMode: MaybeRefOrGetter<TFitMode>,
    viewMode: MaybeRefOrGetter<TPdfViewMode>,
    viewRotation: MaybeRefOrGetter<TPdfViewRotation>,
    numPages: MaybeRefOrGetter<number>,
    pageMetrics: MaybeRefOrGetter<IPdfPageMetric[]>,
    pageMetricsVersion: MaybeRefOrGetter<number>,
    basePageWidth: MaybeRefOrGetter<number | null>,
    basePageHeight: MaybeRefOrGetter<number | null>,
    currentPage: MaybeRefOrGetter<number>,
    continuousScroll: MaybeRefOrGetter<boolean> = false,
) => {
    const fitWidthScale = ref(1);
    const lastFitScaleSignature = ref<string | null>(null);

    const effectiveScale = computed(() => resolvePdfZoomScale({
        zoomMode: toValue(zoomMode),
        fitMode: toValue(fitMode),
        manualZoom: toValue(zoom),
        fitScale: fitWidthScale.value,
    }).effectiveScale);

    const containerStyle = computed(() => {
        return {
            padding: `${DOCUMENT_PAGE_GUTTER_PX}px`,
            gap: `${DOCUMENT_PAGE_GUTTER_PX}px`,
        };
    });

    const scaledMargin = computed(() => DOCUMENT_PAGE_GUTTER_PX);

    let normalizedMetricsCacheKey = '';
    let normalizedMetricsCacheValue: IPdfPageMetric[] = [];

    function getNormalizedPageMetrics() {
        const totalPages = toValue(numPages);
        const fallbackWidth = toValue(basePageWidth);
        const fallbackHeight = toValue(basePageHeight);
        const cacheKey = [
            toValue(pageMetricsVersion),
            totalPages,
            fallbackWidth ?? 'null',
            fallbackHeight ?? 'null',
            toValue(viewRotation),
        ].join('|');

        if (cacheKey === normalizedMetricsCacheKey) {
            return normalizedMetricsCacheValue;
        }

        normalizedMetricsCacheKey = cacheKey;
        normalizedMetricsCacheValue = normalizePageMetrics({
            pageMetrics: toValue(pageMetrics),
            totalPages,
            fallbackWidth,
            fallbackHeight,
            viewRotation: toValue(viewRotation),
        });
        return normalizedMetricsCacheValue;
    }

    function resolveFitScalePage(options?: IFitScalePageOptions) {
        const page = options?.page ?? toValue(currentPage);
        if (!Number.isFinite(page)) {
            return requirePageNumber(Math.max(1, toValue(currentPage)));
        }

        return requirePageNumber(Math.max(1, Math.trunc(page)));
    }

    function resolveFitHeightBaseDimension(
        normalizedPageMetrics: IPdfPageMetric[],
        documentBaseHeight: number,
        page: TPageNumber,
    ) {
        // Fit-height is anchored to the visible page row. In facing modes the
        // row is the unit the user is paging through, so the taller page in
        // the active spread must define the scale.
        const totalPages = toValue(numPages);
        const rowBounds = getPageRowBoundsForViewMode({
            pageNumber: page,
            viewMode: toValue(viewMode),
            totalPages,
        });
        let rowHeight = 0;

        for (let rowPage = Number(rowBounds.start); rowPage <= rowBounds.end; rowPage += 1) {
            rowHeight = Math.max(rowHeight, normalizedPageMetrics[rowPage - 1]?.height ?? 0);
        }

        return rowHeight > 0 ? rowHeight : documentBaseHeight;
    }

    function getFitRawSize(container: HTMLElement, mode: TFitMode) {
        // clientHeight rounds fractional CSS pixels up at some UI zoom
        // levels. Fit inside the physical box or Chromium still exposes
        // a subpixel scroll range and paints a vertical scrollbar.
        return mode === 'height'
            ? Math.min(container.clientHeight, Math.floor(container.getBoundingClientRect().height))
            : container.clientWidth;
    }

    function getFitAvailableSize(rawSize: number, mode: TFitMode, page: TPageNumber) {
        if (mode === 'height') {
            return rawSize - DOCUMENT_PAGE_GUTTER_PX * 2;
        }

        const row = getPageRowBoundsForViewMode({
            pageNumber: page,
            viewMode: toValue(viewMode),
            totalPages: toValue(numPages),
        });
        const columns = row.end - row.start + 1;
        return rawSize - DOCUMENT_PAGE_GUTTER_PX * (columns + 1);
    }

    function doesFitHeightSpreadFitWidth(container: HTMLElement, page: TPageNumber) {
        const metrics = getNormalizedPageMetrics();
        const height = resolveDocumentBaseMetric(metrics, 'height');
        const width = resolveCurrentSpreadBaseWidth(
            metrics, toValue(viewMode), toValue(numPages), page,
        );
        if (!height || !width) return false;

        // Decide scrollbar admission from the unobstructed viewport, never
        // from the scale already reduced by that scrollbar. Otherwise hiding
        // the bar enlarges the spread and immediately admits the bar again.
        const availableHeight = getFitAvailableSize(
            Math.floor(container.getBoundingClientRect().height), 'height', page,
        );
        const scale = clampFitScale(availableHeight
            / resolveFitHeightBaseDimension(metrics, height, page));
        return width * scale <= getFitAvailableSize(container.clientWidth, 'width', page);
    }

    let widthRowsCacheKey = '';
    let widthRows = new Map<number, number>();

    function resolveFitWidthDimensions(
        metrics: IPdfPageMetric[],
        rawSize: number,
        page: TPageNumber,
        currentWidth: number,
    ) {
        if (!toValue(continuousScroll)) {
            return {
                availableSize: getFitAvailableSize(rawSize, 'width', page),
                baseDimension: currentWidth,
            };
        }
        const cacheKey = `${normalizedMetricsCacheKey}|${toValue(viewMode)}`;
        if (widthRowsCacheKey !== cacheKey) {
            widthRowsCacheKey = cacheKey;
            widthRows = resolvePdfFitWidthRowWidths({
                metrics,
                viewMode: toValue(viewMode),
                totalPages: toValue(numPages),
            });
        }
        return resolveSharedPdfFitWidthDimensions({
            metrics,
            rawSize,
            page,
            currentWidth,
            viewMode: toValue(viewMode),
            totalPages: toValue(numPages),
            continuousScroll: true,
            widthRows,
        });
    }

    function buildFitScaleSignature(options: {
        mode: TFitMode;
        rawSize: number;
        availableSize: number;
        baseDimension: number;
        scalePage: number;
        totalPages: number;
    }) {
        return [
            options.mode,
            toValue(viewMode),
            toValue(viewRotation),
            options.totalPages,
            options.scalePage,
            Math.round(options.rawSize),
            Math.round(options.availableSize),
            options.baseDimension.toFixed(3),
        ].join('|');
    }

    function clampFitScale(scale: number) {
        return clampPdfFitScale(scale);
    }

    function logMissingFitDimensions(
        container: HTMLElement | null,
        normalizedPageMetrics: IPdfPageMetric[],
        currentSpreadBaseWidth: number | null,
        documentBaseHeight: number | null,
    ) {
        BrowserLogger.diagnostic('pdf-nav', '[scale] skipped computeFitWidthScale: missing container/base dimensions', {
            hasContainer: Boolean(container),
            basePageWidth: toValue(basePageWidth),
            basePageHeight: toValue(basePageHeight),
            normalizedPageMetricsCount: normalizedPageMetrics.length,
            currentSpreadBaseWidth,
            documentBaseHeight,
        });
    }

    function computeFitWidthScale(container: HTMLElement | null, options?: IFitScalePageOptions) {
        const totalPages = toValue(numPages);
        const normalizedPageMetrics = getNormalizedPageMetrics();
        const scalePage = resolveFitScalePage(options);
        const height = resolveDocumentBaseMetric(normalizedPageMetrics, 'height');
        const width = resolveCurrentSpreadBaseWidth(
            normalizedPageMetrics,
            toValue(viewMode),
            totalPages,
            scalePage,
        );

        if (!container || !width || !height) {
            logMissingFitDimensions(container, normalizedPageMetrics, width, height);
            return false;
        }

        const mode = toValue(fitMode);
        const rawSize = getFitRawSize(container, mode);

        if (rawSize <= 0) {
            BrowserLogger.diagnostic('pdf-nav', `[scale] skipped computeFitWidthScale: rawSize<=0 mode=${mode}`, {
                rawSize,
                clientWidth: container.clientWidth,
                clientHeight: container.clientHeight,
            });
            return false;
        }

        const dimensions = mode === 'height'
            ? {
                availableSize: getFitAvailableSize(rawSize, mode, scalePage),
                baseDimension: resolveFitHeightBaseDimension(normalizedPageMetrics, height, scalePage),
            }
            : resolveFitWidthDimensions(normalizedPageMetrics, rawSize, scalePage, width);
        const {
            availableSize,
            baseDimension,
        } = dimensions;
        if (availableSize <= 0) {
            BrowserLogger.diagnostic('pdf-nav', `[scale] skipped computeFitWidthScale: availableSize<=0 mode=${mode}`, {
                rawSize,
                baseMargin: DOCUMENT_PAGE_GUTTER_PX,
                availableSize,
            });
            return false;
        }
        const fitScaleSignature = buildFitScaleSignature({
            mode,
            rawSize,
            availableSize,
            baseDimension,
            scalePage: mode === 'width' && toValue(continuousScroll) ? 0 : scalePage,
            totalPages,
        });

        if (lastFitScaleSignature.value === fitScaleSignature) {
            BrowserLogger.diagnostic('pdf-nav', `[scale] skipped computeFitWidthScale: dimensions unchanged mode=${mode}`, {
                rawSize,
                availableSize,
                baseDimension,
                fitScaleSignature,
            });
            return false;
        }

        lastFitScaleSignature.value = fitScaleSignature;

        const newScale = clampFitScale(availableSize / baseDimension);

        const currentScale = fitWidthScale.value;
        if (newScale === currentScale) {
            BrowserLogger.diagnostic('pdf-nav', `[scale] skipped computeFitWidthScale: scale unchanged mode=${mode}`, {
                currentScale,
                newScale,
                availableSize,
                baseDimension,
                epsilon: 0,
            });
            return false;
        }

        BrowserLogger.diagnostic('pdf-nav', `[scale] computeFitWidthScale mode=${mode} ${fitWidthScale.value.toFixed(4)}->${newScale.toFixed(4)}`, {
            rawSize,
            availableSize,
            baseDimension,
            basePageWidth: toValue(basePageWidth),
            basePageHeight: toValue(basePageHeight),
            currentSpreadBaseWidth: width,
            documentBaseHeight: height,
            zoom: toValue(zoom),
            viewMode: toValue(viewMode),
            numPages: totalPages,
            currentPage: toValue(currentPage),
            scalePage,
            fitScaleSignature,
            previousScale: fitWidthScale.value,
            nextScale: newScale,
        });
        fitWidthScale.value = newScale;
        return true;
    }

    function isFitWidthScaleCurrent(container: HTMLElement | null, options?: IFitScalePageOptions) {
        const totalPages = toValue(numPages);
        const normalizedPageMetrics = getNormalizedPageMetrics();
        const scalePage = resolveFitScalePage(options);
        const height = resolveDocumentBaseMetric(normalizedPageMetrics, 'height');
        const width = resolveCurrentSpreadBaseWidth(
            normalizedPageMetrics,
            toValue(viewMode),
            totalPages,
            scalePage,
        );

        if (!container || !width || !height) {
            return true;
        }

        const mode = toValue(fitMode);
        const rawSize = getFitRawSize(container, mode);
        if (rawSize <= 0) {
            return true;
        }

        const dimensions = mode === 'height'
            ? {
                availableSize: getFitAvailableSize(rawSize, mode, scalePage),
                baseDimension: resolveFitHeightBaseDimension(normalizedPageMetrics, height, scalePage),
            }
            : resolveFitWidthDimensions(normalizedPageMetrics, rawSize, scalePage, width);
        const {
            availableSize,
            baseDimension,
        } = dimensions;
        if (availableSize <= 0) {
            return true;
        }

        const expectedScale = clampFitScale(availableSize / baseDimension);

        return expectedScale === fitWidthScale.value;
    }

    function invalidateScaleCache() {
        lastFitScaleSignature.value = null;
    }

    function seedOpeningFitScale(scale: number) {
        if (!Number.isFinite(scale) || scale <= 0) {
            return false;
        }
        const nextScale = clampFitScale(scale);
        invalidateScaleCache();
        if (Math.abs(nextScale - fitWidthScale.value) < 0.001) {
            return false;
        }
        fitWidthScale.value = nextScale;
        return true;
    }

    function resetScale() {
        fitWidthScale.value = 1;
        invalidateScaleCache();
    }

    return {
        fitWidthScale,
        effectiveScale,
        containerStyle,
        scaledMargin,
        computeFitWidthScale,
        doesFitHeightSpreadFitWidth,
        isFitWidthScaleCurrent,
        invalidateScaleCache,
        seedOpeningFitScale,
        resetScale,
    };
};
