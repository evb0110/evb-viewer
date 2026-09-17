import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPixelRect,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {CSSProperties} from 'vue';

export interface IScanCleanupPreviewPlacement {
    canvasWidthPx: number;
    canvasHeightPx: number;
    /** Size the intrinsic raster takes on the canvas, after normalization. */
    contentWidthPx: number;
    contentHeightPx: number;
    left: number;
    top: number;
    /**
     * Intrinsic raster pixels to canvas pixels, per axis. The two are the same
     * ratio — the content box keeps the raster's aspect — but the main process
     * rounds each side of that box to a whole canvas pixel independently, so a
     * single number cannot land on both. Measuring each axis from the side it
     * belongs to keeps a rect drawn over the page on the pixels it names,
     * instead of a pixel of drift down the page; nothing is distorted, because
     * the difference between the two is that rounding alone.
     */
    scaleX: number;
    scaleY: number;
}

/**
 * Where a cleaned raster sits on the page it was normalized onto. A matched
 * document scales every page to one visual size, and a preview keeps the raster
 * it rendered, so the placement carries the scale the presentation applies —
 * one number that every rect drawn over the page goes through.
 */
export function resolvePreviewMetadataPlacement(
    metadata: IScanCleanupPreviewMetadata,
): IScanCleanupPreviewPlacement {
    const contentWidthPx = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    const contentHeightPx = metadata.matchedCanvasContentHeightPx ?? metadata.outputHeightPx;
    const intrinsicRasterWidthPx = metadata.intrinsicRasterWidthPx ?? metadata.outputWidthPx;
    const intrinsicRasterHeightPx = metadata.intrinsicRasterHeightPx ?? metadata.outputHeightPx;
    return {
        canvasWidthPx: metadata.canvasWidthPx,
        canvasHeightPx: metadata.canvasHeightPx,
        contentWidthPx,
        contentHeightPx,
        left: metadata.placementOffsetXPx
            - (metadata.matchedCanvasIntrinsicOverflowLeftPx ?? 0),
        top: metadata.placementOffsetYPx
            - (metadata.matchedCanvasIntrinsicOverflowTopPx ?? 0),
        scaleX: contentWidthPx / Math.max(1, intrinsicRasterWidthPx),
        scaleY: contentHeightPx / Math.max(1, intrinsicRasterHeightPx),
    };
}

export function toPreviewSourceCropStyle(
    metadata: IScanCleanupPreviewMetadata,
): CSSProperties {
    const leftPx = metadata.foldClipLeftPx ?? 0;
    const rightPx = metadata.foldClipRightPx ?? 0;
    if (leftPx === 0 && rightPx === 0) {
        return {};
    }
    const contentWidthPx = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    return {clipPath: `inset(0 ${rightPx / contentWidthPx * 100}% 0 ${leftPx / contentWidthPx * 100}%)`};
}

export function toPreviewStyleRect(
    rect: IScanCleanupPixelRect,
    placement: IScanCleanupPreviewPlacement,
): CSSProperties {
    return {
        left: `${(rect.xPx * placement.scaleX + placement.left) / placement.canvasWidthPx * 100}%`,
        top: `${(rect.yPx * placement.scaleY + placement.top) / placement.canvasHeightPx * 100}%`,
        width: `${rect.widthPx * placement.scaleX / placement.canvasWidthPx * 100}%`,
        height: `${rect.heightPx * placement.scaleY / placement.canvasHeightPx * 100}%`,
    };
}
