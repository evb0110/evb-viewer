import type {
    TFitMode,
    TDocumentViewMode,
    TZoomMode,
} from '@contracts/shared';
import { getViewColumnCount } from '@app/utils/pdfViewMode';
import {
    clampDocumentFitScale,
    clampDocumentManualZoom,
} from '@app/modules/document-viewer/zoomPolicy';
import type {
    IDocumentOpenSurfacePageGeometry,
    IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import { resolveDocumentPageSourceOpeningFrame } from '@app/modules/document-viewer/layout/resolveDocumentPageSourceOpeningFrame';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/layout/documentPageGutterPx';

export interface IDocumentOpeningPageFramePolicy {
    readonly fitMode: TFitMode;
    readonly viewMode: TDocumentViewMode;
    readonly zoom: number;
    readonly zoomMode: TZoomMode;
    readonly continuousScroll: boolean;
}

export interface IDocumentOpeningPageFrame {prepareOpeningPageFrame(generation: number): boolean;}

interface ICreateDocumentOpeningPageFrameOptions {
    readonly openSurface: IDocumentOpenSurfaceSession;
    readonly readLayoutRevision?: () => number;
    readonly readPolicy: () => IDocumentOpeningPageFramePolicy;
    readonly readViewportSize: () => {
        width: number;
        height: number;
    };
}

let nextOpeningPageFrameId = 0;

export function resolveDocumentOpeningPageShellId(chassisInstanceId: string, generation: number) {
    return `${chassisInstanceId}-opening-page-shell-${String(generation)}`;
}

function isDjvuDocument(documentId: string) {
    return /\.djvu?$/iu.test(documentId);
}

export function resolveDocumentOpeningPageMargin(
    _geometry: IDocumentOpenSurfacePageGeometry | null,
    _rendererKind?: 'pdfjs' | 'page-source',
) {
    return DOCUMENT_PAGE_GUTTER_PX;
}

function resolvePdfOpeningPageFrameStyle(
    geometry: IDocumentOpenSurfacePageGeometry,
    viewport: {
        width: number;
        height: number
    },
    policy: IDocumentOpeningPageFramePolicy,
) {
    const pageMargin = resolveDocumentOpeningPageMargin(geometry);
    if (
        !Number.isFinite(viewport.width)
        || !Number.isFinite(viewport.height)
        || viewport.width <= pageMargin * 2
        || viewport.height <= pageMargin * 2
    ) {
        return null;
    }
    const columns = getViewColumnCount(policy.viewMode, geometry.pageCount);
    // Continuous Fit Width uses one scale for the whole document, set by its
    // widest page (ADR 0006), so the skeleton matches PDF.js's first layout.
    const fitWidthBase = policy.continuousScroll
        ? Math.max(geometry.width, geometry.widestPageWidth ?? geometry.width)
        : geometry.width;
    const fitScale = policy.zoomMode === 'fit-height'
        ? (viewport.height - pageMargin * 2) / geometry.height
        : (viewport.width - pageMargin * (columns + 1)) / (fitWidthBase * columns);
    const scale = policy.zoomMode === 'custom'
        ? clampDocumentManualZoom(policy.zoom)
        : clampDocumentFitScale(fitScale);
    const width = geometry.width * scale;
    const height = geometry.height * scale;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    return Object.freeze({
        width: `${String(width)}px`,
        height: `${String(height)}px`,
    });
}

function resolveOpeningPageFrameStyle(
    geometry: IDocumentOpenSurfacePageGeometry,
    viewport: {
        width: number;
        height: number
    },
    policy: IDocumentOpeningPageFramePolicy,
) {
    if (!isDjvuDocument(geometry.documentId)) {
        return resolvePdfOpeningPageFrameStyle(geometry, viewport, policy);
    }
    return resolveDocumentPageSourceOpeningFrame({
        geometry,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        zoom: policy.zoom,
        zoomMode: policy.zoomMode,
    })?.style ?? null;
}

export function createDocumentOpeningPageFrame(
    options: ICreateDocumentOpeningPageFrameOptions,
): IDocumentOpeningPageFrame {
    const ownerId = `document-viewer-runtime:${String(++nextOpeningPageFrameId)}`;

    return Object.freeze({prepareOpeningPageFrame(generation: number) {
        const snapshot = options.openSurface.snapshot.value;
        const geometry = snapshot.openingPageGeometry;
        if (
            snapshot.generation !== generation
                || geometry === null
                || snapshot.openingPageFrame !== null
                    && snapshot.openingPageFrame.ownerId !== ownerId
        ) {
            return false;
        }
        // Read the revision only as a reactive invalidation signal.
        options.readLayoutRevision?.();
        const policy = options.readPolicy();
        const style = resolveOpeningPageFrameStyle(geometry, options.readViewportSize(), policy);
        if (style === null) {
            return false;
        }
        return options.openSurface.commitOpeningPageFrame(generation, {
            generation,
            ownerId,
            pageNumber: geometry.pageNumber,
            intentKey: `${policy.zoomMode}:${String(policy.zoom)}`,
            style: Object.freeze({...style}),
        });
    }});
}
