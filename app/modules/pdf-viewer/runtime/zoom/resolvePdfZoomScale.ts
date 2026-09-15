import {
    clampDocumentFitScale,
    clampDocumentManualZoom,
    type IDocumentZoomLimits,
} from '@app/modules/document-viewer/public';
import type {
    TFitMode,
    TZoomMode,
} from '@app/types/pdfContracts';

type IZoomLimits = IDocumentZoomLimits;

interface IResolvePdfZoomScaleInput {
    zoomMode: TZoomMode;
    fitMode: TFitMode;
    manualZoom: number;
    fitScale: number;
    limits?: Partial<IZoomLimits>;
}

function normalizeFitIntent(zoomMode: TZoomMode, fitMode: TFitMode) {
    if (zoomMode === 'fit-height') {
        return 'height';
    }
    if (zoomMode === 'fit-width') {
        return 'width';
    }
    return fitMode;
}

export function clampPdfManualZoom(level: number, limits?: Partial<IZoomLimits>) {
    return clampDocumentManualZoom(level, limits);
}

export function clampPdfFitScale(level: number, limits?: Partial<IZoomLimits>) {
    return clampDocumentFitScale(level, limits);
}

export function resolvePdfZoomScale(input: IResolvePdfZoomScaleInput) {
    if (input.zoomMode === 'custom') {
        return {
            mode: 'custom' as const,
            fitMode: normalizeFitIntent(input.zoomMode, input.fitMode),
            effectiveScale: clampPdfManualZoom(input.manualZoom, input.limits),
        };
    }

    return {
        mode: input.zoomMode,
        fitMode: normalizeFitIntent(input.zoomMode, input.fitMode),
        effectiveScale: clampPdfFitScale(input.fitScale, input.limits),
    };
}
