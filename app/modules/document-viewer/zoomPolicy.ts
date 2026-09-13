import { clamp } from 'es-toolkit/math';
import { ZOOM } from '@app/constants/pdfLayout';

export interface IDocumentZoomLimits {
    manualMin: number;
    manualMax: number;
    fitMin: number;
    fitMax: number;
}

function positive(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function limits(overrides?: Partial<IDocumentZoomLimits>): IDocumentZoomLimits {
    return {
        manualMin: positive(overrides?.manualMin ?? ZOOM.MIN, ZOOM.MIN),
        manualMax: positive(overrides?.manualMax ?? ZOOM.MAX, ZOOM.MAX),
        fitMin: positive(overrides?.fitMin ?? ZOOM.FIT_MIN, ZOOM.FIT_MIN),
        fitMax: positive(overrides?.fitMax ?? ZOOM.MAX, ZOOM.MAX),
    };
}

export function clampDocumentManualZoom(value: number, overrides?: Partial<IDocumentZoomLimits>) {
    const resolved = limits(overrides);
    return clamp(Number.isFinite(value) ? value : 1, resolved.manualMin, resolved.manualMax);
}

export function clampDocumentFitScale(value: number, overrides?: Partial<IDocumentZoomLimits>) {
    const resolved = limits(overrides);
    return clamp(Number.isFinite(value) ? value : 1, resolved.fitMin, resolved.fitMax);
}
