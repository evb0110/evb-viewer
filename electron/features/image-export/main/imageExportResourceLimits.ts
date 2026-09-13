import {
    stat,
    statfs,
} from 'fs/promises';
import { clampDpi } from '@electron/image/imageDpi';

const IMAGE_EXPORT_MAX_PAGE_FILE_BYTES = 512 * 1024 * 1024;
export const IMAGE_EXPORT_MAX_STAGED_BYTES = 2 * 1024 * 1024 * 1024;
const POINTS_PER_INCH = 72;
const DEFAULT_EXPORT_RENDER_DPI = 300;
const PPM_HEADER_AND_ROUNDING_RESERVE_BYTES = 64 * 1024;

export const IMAGE_EXPORT_MAX_NETPBM_READ_BYTES = 192 * 1024 * 1024;

const IMAGE_EXPORT_MAX_RENDER_DIMENSION = Math.floor(
    Math.sqrt((IMAGE_EXPORT_MAX_NETPBM_READ_BYTES - PPM_HEADER_AND_ROUNDING_RESERVE_BYTES) / 3),
);

/**
 * Maximum number of exported file paths returned through one IPC result.
 * Matches the contract collection budget so an oversized export is refused
 * instead of shipping an unbounded path array to the renderer.
 */
const IMAGE_EXPORT_MAX_OUTPUT_PATHS = 100_000;
export const IMAGE_EXPORT_OUTPUT_BUDGET_ERROR_NAME = 'ImageExportOutputBudgetError';

export class ImageExportOutputBudgetError extends RangeError {
    public constructor(pathCount: number) {
        super(`Image export produced ${pathCount} output paths, exceeding the output-path budget of ${IMAGE_EXPORT_MAX_OUTPUT_PATHS}`);
        this.name = IMAGE_EXPORT_OUTPUT_BUDGET_ERROR_NAME;
    }
}

export function assertImageExportOutputPathBudget(paths: readonly string[] | number) {
    const pathCount = typeof paths === 'number' ? paths : paths.length;
    if (pathCount > IMAGE_EXPORT_MAX_OUTPUT_PATHS) {
        throw new ImageExportOutputBudgetError(pathCount);
    }
}

export interface IExportPageSize {
    widthPts: number;
    heightPts: number;
}

export function estimateImageExportStagedBytes(
    pageCount: number,
    renderDpi: number,
    pageSizes: readonly IExportPageSize[],
) {
    const longestSidePts = pageSizes.reduce(
        (longestSide, pageSize) => Math.max(longestSide, pageSize.widthPts, pageSize.heightPts),
        0,
    );
    if (
        !Number.isSafeInteger(pageCount)
        || pageCount < 1
        || !Number.isFinite(renderDpi)
        || renderDpi <= 0
        || longestSidePts <= 0
    ) {
        return IMAGE_EXPORT_MAX_STAGED_BYTES;
    }

    const pixelsPerSide = Math.max(1, Math.ceil(longestSidePts * renderDpi / POINTS_PER_INCH));
    const pageBytes = pixelsPerSide * pixelsPerSide * 4;
    if (!Number.isSafeInteger(pageBytes)) {
        return IMAGE_EXPORT_MAX_STAGED_BYTES;
    }
    return Math.min(IMAGE_EXPORT_MAX_STAGED_BYTES, pageBytes * pageCount);
}

export async function assertImageExportFreeSpace(directory: string, projectedBytes: number) {
    let availableBytes: number;
    try {
        const filesystem = await statfs(directory);
        availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    } catch {
        return;
    }
    if (Number.isFinite(availableBytes) && availableBytes < projectedBytes) {
        throw new RangeError(
            `Image export does not have enough free space for projected staging: requires ${projectedBytes} bytes, but only ${availableBytes} bytes are available`,
        );
    }
}

export function resolveExportRenderDpi(detectedDpi: number | null, pageSizes: readonly IExportPageSize[]) {
    const requestedDpi = clampDpi(detectedDpi ?? DEFAULT_EXPORT_RENDER_DPI);
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

export async function validateRenderedImagePageFiles(pageFiles: Array<{
    page: number;
    path: string;
}>) {
    let renderedBytes = 0;
    for (const pageFile of pageFiles) {
        const fileStat = await stat(pageFile.path);
        if (fileStat.size > IMAGE_EXPORT_MAX_PAGE_FILE_BYTES) {
            throw new RangeError(`Rendered page ${pageFile.page} exceeds the 512 MiB file limit`);
        }
        renderedBytes += fileStat.size;
        if (renderedBytes > IMAGE_EXPORT_MAX_STAGED_BYTES) {
            throw new RangeError('Rendered image chunk exceeds the 2 GiB scratch limit');
        }
    }
}

/** Add one staged file to an accumulator shared by the required scope. */
export async function addStagedImageFileBytes(
    currentBytes: number,
    path: string,
    errorMessage: string,
) {
    const nextBytes = currentBytes + (await stat(path)).size;
    if (nextBytes > IMAGE_EXPORT_MAX_STAGED_BYTES) {
        throw new RangeError(errorMessage);
    }
    return nextBytes;
}
