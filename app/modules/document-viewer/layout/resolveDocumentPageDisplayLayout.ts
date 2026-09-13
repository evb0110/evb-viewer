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
}

interface IDocumentPageDisplayLayoutsInput extends Omit<IDocumentPageDisplayScaleInput, 'pageSize'> {pageSizes: readonly IDocumentPageDisplaySize[];}

export function resolveDocumentPageDisplayScale(input: IDocumentPageDisplayScaleInput) {
    const manualZoom = clampDocumentManualZoom(input.manualZoom);
    if (!input.pageSize) {
        return manualZoom;
    }
    if (input.zoomMode === 'fit-width' && input.pageSize.width > 0) {
        return clampDocumentFitScale(input.availableWidth / input.pageSize.width);
    }
    if (input.zoomMode === 'fit-height' && input.pageSize.height > 0) {
        return clampDocumentFitScale(input.availableHeight / input.pageSize.height);
    }
    return manualZoom;
}

export function resolveDocumentPageDisplayLayouts(
    input: IDocumentPageDisplayLayoutsInput,
): IDocumentPageDisplayLayout[] {
    return input.pageSizes.map((pageSize) => {
        const scale = resolveDocumentPageDisplayScale({
            availableHeight: input.availableHeight,
            availableWidth: input.availableWidth,
            manualZoom: input.manualZoom,
            pageSize,
            zoomMode: input.zoomMode,
        });
        return {
            height: Math.max(1, Math.round(pageSize.height * scale)),
            scale,
            width: Math.max(1, Math.round(pageSize.width * scale)),
        };
    });
}
