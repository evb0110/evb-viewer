import type { IPdfSemanticAnchor } from '@contracts/recentReadingView';
import type { IDocumentOpenSurfacePageGeometry } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/layout/documentPageGutterPx';
import {
    clampDocumentFitScale,
    clampDocumentManualZoom,
} from '@app/modules/document-viewer/zoomPolicy';

export interface IDocumentPageSourceOpeningFrameInput {
    /** The open's restore point; the frame places the page where that restore puts it. */
    readonly anchor?: IPdfSemanticAnchor | undefined;
    readonly geometry: IDocumentOpenSurfacePageGeometry;
    /** The viewport's scrollbar thickness, which a page wider than the viewport takes from its height. */
    readonly scrollbar?: number | undefined;
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
        top?: string;
    }>;
}

// The viewport height that holds a page of this width: a page wider than the
// viewport brings a horizontal scrollbar, which the viewer's height excludes.
export function resolveAnchoredViewportHeight(
    pageWidth: number,
    viewport: {
        width: number;
        height: number;
        scrollbar?: number | undefined;
    },
) {
    return pageWidth + DOCUMENT_PAGE_GUTTER_PX * 2 > viewport.width ? viewport.height - (viewport.scrollbar ?? 0) : viewport.height;
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

    const style: {
        width: string;
        height: string;
        top?: string
    } = {
        width: `${String(width)}px`,
        height: `${String(height)}px`,
    };
    if (input.anchor) {
        // The page-source renderer rounds its page layout to whole pixels and
        // restores this point into the final client box, scrollbar included.
        const pageWidth = Math.round(width);
        const pageHeight = Math.round(height);
        const top = resolveAnchoredViewportHeight(pageWidth, {
            width: input.viewportWidth,
            height: input.viewportHeight,
            scrollbar: input.scrollbar,
        }) * input.anchor.viewportYFraction - pageHeight * input.anchor.pageYFraction;
        // The restore clamps its scroll at the document start, so the first page
        // never rises above its gutter. Later pages' layout tops are not known here.
        style.top = `${String(input.geometry.pageNumber === 1 ? Math.min(top, DOCUMENT_PAGE_GUTTER_PX) : top)}px`;
    }
    return Object.freeze({
        width,
        height,
        style: Object.freeze(style),
    });
}
