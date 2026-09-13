import type { IDocumentOpenSurfacePageGeometry } from '@app/modules/document-viewer/chassis/documentOpenSurfaceSession';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/layout/documentPageGutterPx';
import {
    clampDocumentFitScale,
    clampDocumentManualZoom,
} from '@app/modules/document-viewer/zoomPolicy';

export interface IDocumentPageSourceOpeningFrameInput {
    readonly geometry: IDocumentOpenSurfacePageGeometry;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly zoom: number;
    readonly zoomMode: 'custom' | 'fit-width' | 'fit-height';
}

export interface IDocumentPageSourceOpeningFrame {
    readonly width: number;
    readonly height: number;
    readonly style: Readonly<{
        width: string;
        height: string;
    }>;
}

export function resolveDocumentPageSourceOpeningFrame(
    input: IDocumentPageSourceOpeningFrameInput,
): IDocumentPageSourceOpeningFrame | null {
    if (
        !Number.isFinite(input.viewportWidth)
        || !Number.isFinite(input.viewportHeight)
        || input.viewportWidth <= DOCUMENT_PAGE_GUTTER_PX * 2
        || input.viewportHeight <= DOCUMENT_PAGE_GUTTER_PX * 2
        || !Number.isFinite(input.geometry.width)
        || !Number.isFinite(input.geometry.height)
        || input.geometry.width <= 0
        || input.geometry.height <= 0
    ) {
        return null;
    }

    const scale = input.zoomMode === 'custom'
        ? clampDocumentManualZoom(input.zoom)
        : input.zoomMode === 'fit-height'
            ? clampDocumentFitScale(
                (input.viewportHeight - DOCUMENT_PAGE_GUTTER_PX * 2) / input.geometry.height,
            )
            : clampDocumentFitScale(
                (input.viewportWidth - DOCUMENT_PAGE_GUTTER_PX * 2) / input.geometry.width,
            );
    const width = input.geometry.width * scale;
    const height = input.geometry.height * scale;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }

    return Object.freeze({
        width,
        height,
        style: Object.freeze({
            width: `${String(width)}px`,
            height: `${String(height)}px`,
        }),
    });
}
