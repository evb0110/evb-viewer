import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type {
    IDocumentNavigationRequest,
    IDocumentTextAnchorNavigationOptions,
} from '@app/modules/document-viewer/public';

export interface IScrollToPageOptions {
    searchNavigationId?: number | undefined;
    navigationRequest?: IDocumentNavigationRequest | undefined;
    navigationSource?: 'bookmark' | 'toolbar' | 'search' | 'annotation' | 'thumbnail' | 'activation' | 'restore' | 'wheel' | undefined;
    preferExactDom?: boolean;
    /**
     * Align a normalized page y coordinate to the top of the viewport. This is
     * used for PDF outline destinations such as /XYZ and /FitH, where the
     * destination describes a page coordinate rather than an annotation box.
     */
    pageYRatio?: number | null | undefined;
    /**
     * Snap to an already mounted page without queueing another paged render.
     *
     * Fit-height current-page rerenders already start a force render before
     * snapping back to the same page. Queueing the usual post-snap render there
     * can cancel the in-flight canvas render repeatedly on large PDFs, leaving
     * the page skeleton visible. Normal navigation leaves this unset.
     */
    suppressRenderAfterSnap?: boolean;
    markerRect?: IAnnotationMarkerRect | null | undefined;
    /** Resolve a text-layer range after the target page is visually ready. */
    textAnchor?: IDocumentTextAnchorNavigationOptions | null | undefined;
}
