import type {IScanCleanupTextLayerInstruction} from '@evb/scan-cleanup/core/compactManifest';
import type {IRenderedCleanupOutputPage} from '@evb/scan-cleanup/core/assembleCompactScanCleanupPages';
import {
    assertCanonicalPdfPageSizes,
    type IPdfPageSize,
} from '@evb/scan-cleanup/core/types';
import {resolveScanCleanupMatchedCanvasPlacement} from '@evb/scan-cleanup/core/policy/documentCanvas';

export interface IScanCleanupTextLayerPlan {
    pages: IScanCleanupTextLayerInstruction[];
    skippedNonAffine: number[];
    alreadyPreserved: number[];
}

function finitePositive(value: number | null | undefined): value is number {
    return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function canonicalNumber(value: number) {
    return value === 0 ? 0 : value;
}

function normalizeQuarterTurn(value: number) {
    return ((Math.round(value / 90) % 4) + 4) % 4;
}

function sourcePdfPointToCleanupRaster(
    x: number,
    y: number,
    page: IPdfPageSize,
    inputWidthPx: number,
    inputHeightPx: number,
    cleanupRotation: number,
) {
    const pageX = (x - page.xPoints) / page.widthPoints;
    const pageY = (y - page.yPoints) / page.heightPoints;
    const displayRotation = normalizeQuarterTurn(page.rotation);
    const display = displayRotation === 1
        ? {
            x: pageY * inputWidthPx,
            y: pageX * inputHeightPx,
        }
        : displayRotation === 2
            ? {
                x: (1 - pageX) * inputWidthPx,
                y: pageY * inputHeightPx,
            }
            : displayRotation === 3
                ? {
                    x: (1 - pageY) * inputWidthPx,
                    y: (1 - pageX) * inputHeightPx,
                }
                : {
                    x: pageX * inputWidthPx,
                    y: (1 - pageY) * inputHeightPx,
                };
    const rotation = normalizeQuarterTurn(cleanupRotation);
    if (rotation === 1) {
        return {
            x: inputHeightPx - display.y,
            y: display.x,
        };
    }
    if (rotation === 2) {
        return {
            x: inputWidthPx - display.x,
            y: inputHeightPx - display.y,
        };
    }
    if (rotation === 3) {
        return {
            x: display.y,
            y: inputWidthPx - display.x,
        };
    }
    return display;
}

/**
 * Maps source PDF user space (bottom-left origin) through native's source-raster
 * affine (top-left origin), matched-canvas placement, and back into the cleaned
 * PDF's user space. A dewarp has no affine equivalent and is intentionally
 * omitted; the raster page remains valid but cannot safely inherit positioned
 * source text.
 */
export function resolveScanCleanupTextLayerInstruction(
    output: IRenderedCleanupOutputPage,
    outputPageIndex: number,
    pageSize: IPdfPageSize | undefined,
): IScanCleanupTextLayerInstruction | null {
    const metadata = output.metadata;
    const forward = metadata.forwardTransform?.matrix;
    if (
        output.preservedSource !== undefined
        || pageSize === undefined
        || metadata.dewarpMapping != null
        || forward === undefined
        || forward.length !== 3
        || forward.some(row => row.length !== 3 || row.some(value => !Number.isFinite(value)))
        || !finitePositive(metadata.inputWidthPx)
        || !finitePositive(metadata.inputHeightPx)
        || !finitePositive(metadata.outputWidthPx)
        || !finitePositive(metadata.outputHeightPx)
        || (metadata.intrinsicRasterWidthPx !== undefined && !finitePositive(metadata.intrinsicRasterWidthPx))
        || (metadata.intrinsicRasterHeightPx !== undefined && !finitePositive(metadata.intrinsicRasterHeightPx))
        || !finitePositive(metadata.canvasWidthPx)
        || !finitePositive(metadata.canvasHeightPx)
        || !finitePositive(pageSize.widthPoints)
        || !finitePositive(pageSize.heightPoints)
    ) {
        return null;
    }
    const pageWidthPoints = metadata.matchedCanvasTargetWidthPoints
        ?? metadata.canvasWidthPx / output.dpi * 72;
    const pageHeightPoints = metadata.matchedCanvasTargetHeightPoints
        ?? metadata.canvasHeightPx / output.dpi * 72;
    const {
        contentWidthPx,
        contentHeightPx,
        intrinsicRasterWidthPx,
        intrinsicRasterHeightPx,
        matchScaleX,
        matchScaleY,
        effectivePlacementOffsetXPx,
        effectivePlacementOffsetYPx,
    } = resolveScanCleanupMatchedCanvasPlacement(metadata);
    if (
        !finitePositive(pageWidthPoints)
        || !finitePositive(pageHeightPoints)
        || !finitePositive(contentWidthPx)
        || !finitePositive(contentHeightPx)
        || !finitePositive(intrinsicRasterWidthPx)
        || !finitePositive(intrinsicRasterHeightPx)
    ) {
        return null;
    }

    // source PDF -> displayed source raster -> cleanup quarter-turn. Deriving
    // the affine from three points keeps page /Rotate and user-requested
    // rotation in the same coordinate model as lossless crop placement.
    const sourceOrigin = sourcePdfPointToCleanupRaster(
        0,
        0,
        pageSize,
        metadata.inputWidthPx,
        metadata.inputHeightPx,
        metadata.rotationDegrees,
    );
    const sourceX = sourcePdfPointToCleanupRaster(
        1,
        0,
        pageSize,
        metadata.inputWidthPx,
        metadata.inputHeightPx,
        metadata.rotationDegrees,
    );
    const sourceY = sourcePdfPointToCleanupRaster(
        0,
        1,
        pageSize,
        metadata.inputWidthPx,
        metadata.inputHeightPx,
        metadata.rotationDegrees,
    );
    const pixelXFromPdfX = sourceX.x - sourceOrigin.x;
    const pixelYFromPdfX = sourceX.y - sourceOrigin.y;
    const pixelXFromPdfY = sourceY.x - sourceOrigin.x;
    const pixelYFromPdfY = sourceY.y - sourceOrigin.y;

    // intrinsic output -> matched canvas -> output PDF
    const pdfXFromCanvas = pageWidthPoints / metadata.canvasWidthPx;
    const pdfYFromCanvas = -pageHeightPoints / metadata.canvasHeightPx;
    const f00 = forward[0]![0]!;
    const f01 = forward[0]![1]!;
    const f02 = forward[0]![2]!;
    const f10 = forward[1]![0]!;
    const f11 = forward[1]![1]!;
    const f12 = forward[1]![2]!;

    const xFromPdfX = pdfXFromCanvas * matchScaleX * (
        f00 * pixelXFromPdfX + f01 * pixelYFromPdfX
    );
    const xFromPdfY = pdfXFromCanvas * matchScaleX * (
        f00 * pixelXFromPdfY + f01 * pixelYFromPdfY
    );
    const xOffset = pdfXFromCanvas * (
        matchScaleX * (f00 * sourceOrigin.x + f01 * sourceOrigin.y + f02)
        + effectivePlacementOffsetXPx
    );
    const yFromPdfX = pdfYFromCanvas * matchScaleY * (
        f10 * pixelXFromPdfX + f11 * pixelYFromPdfX
    );
    const yFromPdfY = pdfYFromCanvas * matchScaleY * (
        f10 * pixelXFromPdfY + f11 * pixelYFromPdfY
    );
    const yOffset = pageHeightPoints + pdfYFromCanvas * (
        matchScaleY * (f10 * sourceOrigin.x + f11 * sourceOrigin.y + f12)
        + effectivePlacementOffsetYPx
    );
    const matrix = [
        canonicalNumber(xFromPdfX),
        canonicalNumber(yFromPdfX),
        canonicalNumber(xFromPdfY),
        canonicalNumber(yFromPdfY),
        canonicalNumber(xOffset),
        canonicalNumber(yOffset),
    ] satisfies IScanCleanupTextLayerInstruction['matrix'];
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    if (!matrix.every(Number.isFinite) || Math.abs(determinant) <= Number.EPSILON) {
        return null;
    }
    return {
        sourcePageIndex: output.sourcePageNumber - 1,
        outputPageIndex,
        matrix,
        ...(metadata.half !== undefined && metadata.half !== 'full'
            ? {filterToOutputPage: true}
            : {}),
    };
}

function buildScanCleanupTextLayerPlanFromPageSizeResolver(
    outputs: readonly IRenderedCleanupOutputPage[],
    resolvePageSize: (pageNumber: number) => IPdfPageSize | undefined,
): IScanCleanupTextLayerPlan {
    const pages: IScanCleanupTextLayerInstruction[] = [];
    const skippedNonAffine = new Set<number>();
    const alreadyPreserved = new Set<number>();
    outputs.forEach((output, outputPageIndex) => {
        if (output.preservedSource !== undefined) {
            alreadyPreserved.add(output.sourcePageNumber);
            return;
        }
        const instruction = resolveScanCleanupTextLayerInstruction(
            output,
            outputPageIndex,
            resolvePageSize(output.sourcePageNumber),
        );
        if (instruction === null) {
            skippedNonAffine.add(output.sourcePageNumber);
        } else {
            pages.push(instruction);
        }
    });
    return {
        pages,
        skippedNonAffine: [...skippedNonAffine].sort((left, right) => left - right),
        alreadyPreserved: [...alreadyPreserved].sort((left, right) => left - right),
    };
}

export function buildScanCleanupTextLayerPlan(
    outputs: readonly IRenderedCleanupOutputPage[],
    pageSizes: readonly IPdfPageSize[],
): IScanCleanupTextLayerPlan {
    // Each instruction maps a source page's text into an output page through
    // `pageSizes[sourcePageNumber - 1]`, so out-of-order geometry silently
    // stamps one page's words onto another.
    assertCanonicalPdfPageSizes(pageSizes, 'Scan cleanup text layer planning');
    return buildScanCleanupTextLayerPlanFromPageSizeResolver(
        outputs,
        pageNumber => pageSizes[pageNumber - 1],
    );
}

/**
 * Build text-layer instructions from geometry already read by a bounded
 * conversion child. Reusing that materialized geometry keeps the shared
 * sidecar cursor monotone across native batches.
 */
export function buildScanCleanupTextLayerPlanFromPageSizeMap(
    outputs: readonly IRenderedCleanupOutputPage[],
    pageSizes: ReadonlyMap<number, IPdfPageSize>,
): IScanCleanupTextLayerPlan {
    return buildScanCleanupTextLayerPlanFromPageSizeResolver(
        outputs,
        pageNumber => {
            const pageSize = pageSizes.get(pageNumber);
            if (pageSize === undefined) {
                throw new Error(`Scan cleanup text layer planning has no geometry for page ${String(pageNumber)}`);
            }
            return pageSize;
        },
    );
}
