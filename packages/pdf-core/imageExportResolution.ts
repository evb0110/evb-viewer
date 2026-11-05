import {uniq} from 'es-toolkit/array';
import {range} from 'es-toolkit/math';

const POINTS_PER_INCH = 72;
const DEFAULT_EXPORT_RENDER_DPI = 300;
const PDF_EXPORT_DPI_PROBE_SAMPLE_PAGES = 8;
const PPM_HEADER_AND_ROUNDING_RESERVE_BYTES = 64 * 1024;
export const IMAGE_EXPORT_MAX_NETPBM_READ_BYTES = 192 * 1024 * 1024;
const IMAGE_EXPORT_MAX_RENDER_DIMENSION = Math.floor(
    Math.sqrt((IMAGE_EXPORT_MAX_NETPBM_READ_BYTES - PPM_HEADER_AND_ROUNDING_RESERVE_BYTES) / 3),
);

export interface IExportPageSize {
    widthPts: number;
    heightPts: number;
}

export function selectDpiProbePages(pageCount: number) {
    const sampleCount = Math.min(pageCount, PDF_EXPORT_DPI_PROBE_SAMPLE_PAGES);
    if (sampleCount < 2) {
        return [1];
    }

    return uniq(range(0, sampleCount).map(index => 1 + Math.round(
        (index / (sampleCount - 1)) * (pageCount - 1),
    )));
}

export function resolveExportRenderDpi(detectedDpi: number | null, pageSizes: readonly IExportPageSize[]) {
    const sourceDpi = detectedDpi ?? DEFAULT_EXPORT_RENDER_DPI;
    const requestedDpi = Number.isFinite(sourceDpi)
        ? Math.min(Math.max(Math.round(sourceDpi), 72), 1200)
        : DEFAULT_EXPORT_RENDER_DPI;
    let longestSidePts = 0;
    for (const pageSize of pageSizes) {
        longestSidePts = Math.max(longestSidePts, pageSize.widthPts, pageSize.heightPts);
    }

    if (longestSidePts <= 0) {
        return requestedDpi;
    }

    const dimensionLimitedDpi = Math.floor((IMAGE_EXPORT_MAX_RENDER_DIMENSION * POINTS_PER_INCH) / longestSidePts);
    return Math.max(1, Math.min(requestedDpi, dimensionLimitedDpi));
}
