import type {INativeScanCleanupOutputMetadataV3} from '@contracts/electronApiScanCleanup';
import {resolveScanCleanupMatchedCanvasPlacement} from '@evb/scan-cleanup/core/policy/documentCanvas';
import type {IPdfMrcLayers} from '@evb/scan-cleanup/core/types';

/**
 * Maps a trusted source-MRC foreground from source pixels into PDF user space.
 * Callers validate that the metadata describes an affine, usable transform;
 * this helper owns only the shared geometry calculation.
 */
export function buildScanCleanupSourceMrcForegroundPdfMatrix(
    metadata: INativeScanCleanupOutputMetadataV3,
    layers: IPdfMrcLayers,
    pageWidthPoints: number,
    pageHeightPoints: number,
) {
    const matrix = metadata.forwardTransform!.matrix;
    const inputScaleX = metadata.inputWidthPx! / layers.foregroundWidth;
    const inputScaleY = metadata.inputHeightPx! / layers.foregroundHeight;
    const {
        matchScaleX,
        matchScaleY,
        effectivePlacementOffsetXPx,
        effectivePlacementOffsetYPx,
    } = resolveScanCleanupMatchedCanvasPlacement(metadata);
    const sourceToCanvas = {
        a: matrix[0]![0]! * inputScaleX * matchScaleX,
        b: matrix[0]![1]! * inputScaleY * matchScaleX,
        c: matrix[0]![2]! * matchScaleX + effectivePlacementOffsetXPx,
        d: matrix[1]![0]! * inputScaleX * matchScaleY,
        e: matrix[1]![1]! * inputScaleY * matchScaleY,
        f: matrix[1]![2]! * matchScaleY + effectivePlacementOffsetYPx,
    };
    const pointScaleX = pageWidthPoints / metadata.canvasWidthPx;
    const pointScaleY = pageHeightPoints / metadata.canvasHeightPx;
    const sourceWidth = layers.foregroundWidth;
    const sourceHeight = layers.foregroundHeight;
    return [
        pointScaleX * sourceToCanvas.a * sourceWidth,
        -pointScaleY * sourceToCanvas.d * sourceWidth,
        -pointScaleX * sourceToCanvas.b * sourceHeight,
        pointScaleY * sourceToCanvas.e * sourceHeight,
        pointScaleX * (sourceToCanvas.b * sourceHeight + sourceToCanvas.c),
        pageHeightPoints
        - pointScaleY * (sourceToCanvas.e * sourceHeight + sourceToCanvas.f),
    ];
}
