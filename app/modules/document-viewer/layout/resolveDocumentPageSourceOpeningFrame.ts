import { clamp } from 'es-toolkit/math';
import type { IPdfSemanticAnchor } from '@contracts/recentReadingView';
import type { IDocumentOpenSurfacePageGeometry } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/layout/documentPageGutterPx';
import {
    clampDocumentFitScale,
    clampDocumentManualZoom,
} from '@app/modules/document-viewer/zoomPolicy';
import {
    resolveDocumentPageLeft,
    resolveDocumentZoomAnchorScroll,
} from '@app/modules/document-viewer/zoomAnchor';

export interface IDocumentPageSourceOpeningFrameInput {
    /** The open's restore point; the frame places the page where that restore puts it. */
    readonly anchor?: IPdfSemanticAnchor | undefined;
    /** Continuous scroll stacks every page, so a page starts below the pages before it. */
    readonly continuousScroll?: boolean | undefined;
    readonly geometry: IDocumentOpenSurfacePageGeometry;
    readonly viewport: {
        readonly width: number;
        readonly height: number;
        /** The viewport's scrollbar thickness, which a page wider than the viewport takes from its height. */
        readonly scrollbar?: number | undefined;
    };
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
        left?: string;
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
    const {viewport} = input;
    if (
        !Number.isFinite(viewport.width)
        || !Number.isFinite(viewport.height)
        || viewport.width <= DOCUMENT_PAGE_GUTTER_PX * 2
        || viewport.height <= DOCUMENT_PAGE_GUTTER_PX * 2
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
                (viewport.height - DOCUMENT_PAGE_GUTTER_PX * 2) / input.geometry.height,
            )
            : clampDocumentFitScale(
                (viewport.width - DOCUMENT_PAGE_GUTTER_PX * 2) / input.geometry.width,
            );
    const width = input.geometry.width * scale;
    const height = input.geometry.height * scale;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }

    const style: {
        width: string;
        height: string;
        top?: string;
        left?: string;
    } = {
        width: `${String(width)}px`,
        height: `${String(height)}px`,
    };
    if (input.anchor) {
        // The page-source renderer rounds its page layout to whole pixels, lays
        // the page out at its own left and top, and restores the anchor through
        // one projection. The skeleton takes that projection on both axes, so
        // the page keeps its place when the renderer replaces the skeleton.
        // The page's left is the renderer's measured client width. Its restore
        // projects and clamps while the open hides overflow, so those use the
        // outer width, before a vertical scrollbar that appears later is taken.
        const gutter = DOCUMENT_PAGE_GUTTER_PX;
        const pageWidth = Math.round(width);
        const pageHeight = Math.round(height);
        const outerWidth = viewport.width + (viewport.scrollbar ?? 0);
        const layout = {
            left: resolveDocumentPageLeft(viewport.width, pageWidth),
            top: input.continuousScroll
                ? gutter + (input.geometry.pageNumber - 1) * (pageHeight + gutter)
                : gutter,
            width: pageWidth,
            height: pageHeight,
        };
        const clientHeight = resolveAnchoredViewportHeight(pageWidth, viewport);
        const scroll = resolveDocumentZoomAnchorScroll({
            clientWidth: outerWidth,
            clientHeight,
            scrollLeft: 0,
            scrollTop: 0,
        }, [layout], {
            pageIndex: 0,
            xRatio: input.anchor.pageXFraction,
            yRatio: input.anchor.pageYFraction,
            viewportXRatio: input.anchor.viewportXFraction,
            viewportYRatio: input.anchor.viewportYFraction,
        });
        if (!scroll) {
            return null;
        }
        // The browser keeps a restored scroll within the content it lays out,
        // so the page cannot move past that content's far edge either.
        const contentHeight = input.continuousScroll
            ? gutter + input.geometry.pageCount * (pageHeight + gutter)
            : layout.top + layout.height;
        const left = clamp(scroll.left, 0, Math.max(0, layout.left + layout.width - outerWidth));
        const top = clamp(scroll.top, 0, Math.max(0, contentHeight - clientHeight));
        style.left = `${String(layout.left - left)}px`;
        style.top = `${String(layout.top - top)}px`;
    }
    return Object.freeze({
        width,
        height,
        style: Object.freeze(style),
    });
}
