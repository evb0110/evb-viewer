import type { TZoomMode } from '@contracts/shared';
import {
    clampDocumentFitScale,
    clampDocumentManualZoom,
} from '@app/modules/document-viewer/zoomPolicy';

export interface IDocumentPageDisplaySize {
    readonly height: number;
    readonly width: number;
}

export interface IDocumentPageDisplayLayout extends IDocumentPageDisplaySize {readonly scale: number;}

interface IDocumentPageDisplayScaleInput {
    availableHeight: number;
    availableWidth: number;
    manualZoom: number;
    pageSize: IDocumentPageDisplaySize | null | undefined;
    zoomMode: TZoomMode;
    /**
     * In continuous scroll, the width fit-width fits: the document's widest
     * page, so one scale holds for every page (ADR 0006). Absent in paged
     * mode, where the page itself fits.
     */
    fitWidthPageWidth?: number | undefined;
}

interface IDocumentPageDisplayLayoutsInput extends Omit<IDocumentPageDisplayScaleInput, 'pageSize' | 'fitWidthPageWidth'> {
    pageSizes: readonly IDocumentPageDisplaySize[];
    continuousScroll: boolean;
}

export function resolveDocumentPageDisplayScale(input: IDocumentPageDisplayScaleInput) {
    const manualZoom = clampDocumentManualZoom(input.manualZoom);
    if (!input.pageSize) {
        return manualZoom;
    }
    const fitWidth = input.fitWidthPageWidth ?? input.pageSize.width;
    if (input.zoomMode === 'fit-width' && fitWidth > 0) {
        return clampDocumentFitScale(input.availableWidth / fitWidth);
    }
    if (input.zoomMode === 'fit-height' && input.pageSize.height > 0) {
        return clampDocumentFitScale(input.availableHeight / input.pageSize.height);
    }
    return manualZoom;
}

export function resolveDocumentPageDisplayLayouts(
    input: IDocumentPageDisplayLayoutsInput,
): IDocumentPageDisplayLayout[] {
    const fitWidthPageWidth = input.continuousScroll
        ? input.pageSizes.reduce((widest, pageSize) => Math.max(widest, pageSize.width), 0)
        : undefined;
    return input.pageSizes.map((pageSize) => {
        const scale = resolveDocumentPageDisplayScale({
            availableHeight: input.availableHeight,
            availableWidth: input.availableWidth,
            manualZoom: input.manualZoom,
            pageSize,
            zoomMode: input.zoomMode,
            fitWidthPageWidth,
        });
        return {
            height: Math.max(1, Math.round(pageSize.height * scale)),
            scale,
            width: Math.max(1, Math.round(pageSize.width * scale)),
        };
    });
}
