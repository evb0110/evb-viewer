import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPixelRect,
    TScanCleanupPageAlignment,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {CSSProperties} from 'vue';
import type {IScanCleanupDragRect} from '@app/modules/scan-cleanup/composables/useScanCleanupDragTransaction';
import type {IScanCleanupPreviewImageSwap} from '@app/modules/scan-cleanup/composables/useScanCleanupPreviewImages';
import type {IScanCleanupPreviewPlacement} from '@app/modules/scan-cleanup/geometry/placement';

export type TScanCleanupContentHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export interface IRenderedScanCleanupOutput {
    canvasStyle: CSSProperties;
    contentRect: IScanCleanupPixelRect | null;
    contentStyle: CSSProperties | null;
    imageStyle: CSSProperties;
    marginBoundaryStyle: CSSProperties;
    metadata: IScanCleanupPreviewMetadata;
    pixelSwap: IScanCleanupPreviewImageSwap;
    placement: IScanCleanupPreviewPlacement;
    sourceCropStyle: CSSProperties;
}

export interface IScanCleanupContentOverlayOutput extends IRenderedScanCleanupOutput {
    canvasClientRect: IScanCleanupDragRect;
    style: CSSProperties;
}

export interface IScanCleanupPlacementOverlayOutput extends IRenderedScanCleanupOutput {
    active: boolean;
    alignment: TScanCleanupPageAlignment;
    canvasClientRect: IScanCleanupDragRect;
}
