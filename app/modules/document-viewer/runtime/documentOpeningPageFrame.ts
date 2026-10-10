import type { ComputedRef } from 'vue';
import { clamp } from 'es-toolkit/math';
import type { IPdfSemanticAnchor } from '@contracts/recentReadingView';
import type {
    TFitMode,
    TDocumentViewMode,
    TPdfViewRotation,
    TPdfZoomState,
    TZoomMode,
} from '@contracts/shared';
import { requirePageNumber } from '@contracts/pageNumbers';
import { buildPageLayoutMetrics } from '@app/modules/document-viewer/layout/buildPageLayoutMetrics';
import {
    normalizePageMetrics,
    projectPdfPageMetricForView,
} from '@app/modules/document-viewer/layout/normalizePageMetrics';
import { getPageRowBoundsForViewMode } from '@app/modules/document-viewer/layout/getPageRowBoundsForViewMode';
import { resolveCurrentSpreadBaseWidth } from '@app/modules/document-viewer/layout/resolveCurrentSpreadBaseWidth';
import { resolvePdfFitWidthDimensions } from '@app/modules/document-viewer/layout/resolvePdfFitWidthDimensions';
import { getLayoutPhysicalScrollOrigin } from '@app/modules/document-viewer/layout/pdfPageLayoutMetrics';
import {
    createPdfViewportGeometryFromLayout,
    getViewportGeometryRowForPage,
    resolveScrollForPageRect,
} from '@app/modules/document-viewer/layout/pdfViewportGeometry';
import {
    createDocumentWheelZoomHandler,
    type IDocumentWheelInteraction,
} from '@app/modules/document-viewer/input/documentWheelInteraction';
import { createPageNavigationRequest } from '@app/modules/document-viewer/navigation/documentNavigationRequest';
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
    readonly viewRotation?: TPdfViewRotation | undefined;
    readonly fitMode: TFitMode;
    readonly viewMode: TDocumentViewMode;
    readonly zoom: number;
    readonly zoomMode: TZoomMode;
    readonly continuousScroll: boolean;
}

/** The opening skeleton as the viewport draws it: the page the open presents, at its size and place. */
export interface IDocumentOpeningPageShell {
    readonly generation: number;
    readonly height: number;
    readonly id: string;
    readonly ownerId: string;
    readonly pageNumber: number;
    readonly style: Readonly<Record<string, string>>;
}

export interface IDocumentOpeningPageFrame {
    /** Null until the open knows its page's shape, and again once the open is done. */
    readonly shell: ComputedRef<IDocumentOpeningPageShell | null>;
    prepareOpeningPageFrame(generation: number): boolean;
    /** The reader's wheel zoom of the opening view, before any page is shown. */
    zoomOpeningShell(interaction: IDocumentWheelInteraction): void;
}

interface ICreateDocumentOpeningPageFrameOptions {
    /** The viewer runtime's instance, which keeps shell ids unique across panes. */
    readonly instanceId: string;
    readonly openSurface: IDocumentOpenSurfaceSession;
    readonly readRendererKind: () => 'pdfjs' | 'page-source';
    readonly readLayoutRevision?: () => number;
    readonly readPolicy: () => IDocumentOpeningPageFramePolicy;
    readonly readViewportSize: () => {
        width: number;
        height: number;
    };
    readonly readViewport?: () => HTMLElement | null;
    readonly emitZoomState?: (state: TPdfZoomState) => void;
}

// The viewport keeps a stable scrollbar gutter: a page wider than the
// viewport adds a horizontal bar of that thickness, which the viewer's
// viewport height excludes.
function readScrollbar(viewport: HTMLElement | null | undefined) {
    return viewport ? viewport.offsetWidth - viewport.clientWidth : 0;
}

function resolveAnchoredViewportHeight(
    pageWidth: number,
    viewport: {
        width: number;
        height: number;
        scrollbar?: number;
    },
) {
    return pageWidth + DOCUMENT_PAGE_GUTTER_PX * 2 > viewport.width ? viewport.height - (viewport.scrollbar ?? 0) : viewport.height;
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
        height: number;
        scrollbar?: number;
    },
    policy: IDocumentOpeningPageFramePolicy,
    anchor: IPdfSemanticAnchor | undefined,
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
    // The page as the view shows it: a quarter-turned view swaps its sides.
    const shown = projectPdfPageMetricForView(geometry, policy.viewRotation ?? 0);
    // Continuous Fit Width uses one scale for the whole document, set by its
    // widest page as the view shows it (ADR 0006), so the skeleton matches
    // PDF.js's first layout: a quarter-turned view's widest is its tallest.
    const fitWidthBase = policy.continuousScroll
        ? Math.max(shown.width, projectPdfPageMetricForView({
            width: geometry.widestPageWidth ?? geometry.width,
            height: geometry.tallestPageHeight ?? geometry.height,
        }, policy.viewRotation ?? 0).width)
        : shown.width;
    const fitScale = policy.zoomMode === 'fit-height'
        ? (viewport.height - pageMargin * 2) / shown.height
        : (viewport.width - pageMargin * (columns + 1)) / (fitWidthBase * columns);
    const scale = policy.zoomMode === 'custom'
        ? clampDocumentManualZoom(policy.zoom)
        : clampDocumentFitScale(fitScale);
    const placed = geometry.pages ? placeOnPageLayout(geometry, geometry.pages, policy, anchor, viewport) : null;
    const width = placed?.width ?? shown.width * scale;
    const height = placed?.height ?? shown.height * scale;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    return Object.freeze({
        width: `${String(width)}px`,
        height: `${String(height)}px`,
        ...(placed
            ? {
                top: `${String(placed.top)}px`,
                left: `${String(placed.left)}px`,
            }
            : {}),
    });
}

/**
 * Places the opening page where the viewer will: the document's exact pages
 * laid out as the viewer lays them out (view rotation, rows, spreads), and
 * the open's point placed in that layout. Continuous scroll lays out every
 * row; paged mode shows the page's spread alone. Without every page's shape
 * there is no exact place, and the page keeps the top-centred default.
 */
function placeOnPageLayout(
    geometry: IDocumentOpenSurfacePageGeometry,
    pages: NonNullable<IDocumentOpenSurfacePageGeometry['pages']>,
    policy: IDocumentOpeningPageFramePolicy,
    anchor: IPdfSemanticAnchor | undefined,
    viewport: {
        width: number;
        height: number;
        scrollbar?: number;
    },
) {
    if (pages.length !== geometry.pageCount) {
        return null;
    }
    const gutter = DOCUMENT_PAGE_GUTTER_PX;
    const page = requirePageNumber(geometry.pageNumber);
    const metrics = normalizePageMetrics({
        pageMetrics: pages.map((page) => {
            const turned = page.rotation === 90 || page.rotation === 270;
            return {
                width: (turned ? page.heightPoints : page.widthPoints) * page.userUnit,
                height: (turned ? page.widthPoints : page.heightPoints) * page.userUnit,
                rotation: page.rotation,
                userUnit: page.userUnit,
            };
        }),
        totalPages: geometry.pageCount,
        fallbackWidth: null,
        fallbackHeight: null,
        viewRotation: policy.viewRotation ?? 0,
    });
    // The viewer's scale: a custom zoom, or the fit of the pages as turned.
    const row = getPageRowBoundsForViewMode({
        pageNumber: page,
        viewMode: policy.viewMode,
        totalPages: geometry.pageCount,
    });
    const rowHeight = Math.max(...metrics.slice(row.start - 1, row.end).map(metric => metric.height));
    const fitWidth = resolvePdfFitWidthDimensions({
        metrics,
        rawSize: viewport.width,
        page,
        currentWidth: resolveCurrentSpreadBaseWidth(metrics, policy.viewMode, geometry.pageCount, page) ?? rowHeight,
        viewMode: policy.viewMode,
        totalPages: geometry.pageCount,
        continuousScroll: policy.continuousScroll,
    });
    const scale = policy.zoomMode === 'custom'
        ? clampDocumentManualZoom(policy.zoom)
        : clampDocumentFitScale(policy.zoomMode === 'fit-height'
            ? (viewport.height - gutter * 2) / rowHeight
            : fitWidth.availableSize / fitWidth.baseDimension);
    const layout = buildPageLayoutMetrics({
        pageMetrics: metrics,
        totalPages: geometry.pageCount,
        viewMode: policy.viewMode,
        scale,
        gap: gutter,
        paddingTop: gutter,
        paddingBottom: gutter,
    });
    if (!layout) {
        return null;
    }
    const origin = policy.continuousScroll ? getLayoutPhysicalScrollOrigin(layout, page) : 0;
    const laidOut = createPdfViewportGeometryFromLayout(layout, {
        width: viewport.width,
        height: viewport.height,
        paddingInline: gutter,
    }, 0, origin);
    const rect = laidOut.pageRects[page - 1];
    const laidOutRow = getViewportGeometryRowForPage(laidOut, page);
    if (!rect || !laidOutRow) {
        return null;
    }
    // Paged mode's content is the page's spread alone, from the top inset.
    const placedPage = policy.continuousScroll
        ? {
            ...rect,
            top: rect.top - origin,
        }
        : {
            ...rect,
            top: rect.top - laidOutRow.rect.top + gutter,
        };
    const content = policy.continuousScroll
        ? {
            width: laidOut.contentWidth,
            height: Math.max(viewport.height, laidOut.contentHeight - origin),
        }
        : {
            width: Math.max(viewport.width, laidOutRow.rect.width + gutter * 2),
            height: laidOutRow.rect.height + gutter * 2,
        };
    // A content wider than the viewport brings a horizontal scrollbar, which
    // the viewer's viewport height excludes. The browser compares whole
    // pixels: its scroll width is the content width rounded.
    const viewportHeight = Math.round(content.width) > viewport.width ? viewport.height - (viewport.scrollbar ?? 0) : viewport.height;
    const scroll = resolveScrollForPageRect(placedPage, anchor ?? {
        page: geometry.pageNumber,
        pageXFraction: 0.5,
        pageYFraction: 0,
        viewportXFraction: 0.5,
        viewportYFraction: 0,
        affinity: 'start',
    }, {
        width: viewport.width,
        height: viewportHeight,
    }, content, gutter);
    return {
        top: placedPage.top - scroll.top,
        left: placedPage.left - scroll.left,
        width: rect.width,
        height: rect.height,
    };
}

function resolveOpeningPageFrameStyle(
    geometry: IDocumentOpenSurfacePageGeometry,
    viewport: {
        width: number;
        height: number;
        scrollbar?: number;
    },
    policy: IDocumentOpeningPageFramePolicy,
    anchor: IPdfSemanticAnchor | undefined,
) {
    if (!isDjvuDocument(geometry.documentId)) {
        return resolvePdfOpeningPageFrameStyle(geometry, viewport, policy, anchor);
    }
    const frame = resolveDocumentPageSourceOpeningFrame({
        geometry,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        zoom: policy.zoom,
        zoomMode: policy.zoomMode,
    });
    if (!frame || !anchor) {
        return frame?.style ?? null;
    }
    // The page-source renderer rounds its page layout to whole pixels and
    // restores this point into the final client box, scrollbar included.
    const width = Math.round(frame.width);
    const height = Math.round(frame.height);
    return {
        ...frame.style,
        top: `${String(resolveAnchoredViewportHeight(width, viewport) * anchor.viewportYFraction - height * anchor.pageYFraction)}px`,
    };
}

const PREPARABLE_PHASES: ReadonlySet<string> = new Set([
    'pending',
    'geometry-committed',
    'canvas-committed',
    'viewport-committed',
]);

export function createDocumentOpeningPageFrame(
    options: ICreateDocumentOpeningPageFrameOptions,
): IDocumentOpeningPageFrame {
    const ownerId = `document-viewer-runtime:${String(++nextOpeningPageFrameId)}`;
    // An open that starts where its reader left it shows that view.
    function readFramePolicy(geometry: IDocumentOpenSurfacePageGeometry): IDocumentOpeningPageFramePolicy {
        const reading = geometry.readingView;
        return reading
            ? {
                ...options.readPolicy(),
                zoom: reading.zoom,
                zoomMode: reading.zoomMode,
                viewMode: reading.viewMode,
                continuousScroll: reading.continuousScroll,
                viewRotation: reading.viewRotation,
            }
            : options.readPolicy();
    }
    const readViewportSize = () => ({
        ...options.readViewportSize(),
        scrollbar: readScrollbar(options.readViewport?.()),
    });
    // The opening skeleton appears only once the page's shape is known. Until
    // then the viewport shows its own background: a placeholder of a guessed
    // shape would change shape again when the geometry arrives.
    const shell = computed<IDocumentOpeningPageShell | null>(() => {
        const snapshot = options.openSurface.snapshot.value;
        const frame = snapshot.openingPageFrame;
        if (!PREPARABLE_PHASES.has(snapshot.phase) || frame?.generation !== undefined && frame.generation !== snapshot.generation) {
            return null;
        }
        // The page the open presents, which a restore or a navigation during the
        // open can set before the viewport has shown any page.
        const openingPage = options.openSurface.viewportSession.value.requestedPage;
        const style = frame?.pageNumber === openingPage ? frame.style : null;
        if (style === null) {
            return null;
        }
        // The prepared frame holds a positive, finite page size.
        const liveWidth = Number.parseFloat(style.width!);
        const liveHeight = Number.parseFloat(style.height!);
        const margin = DOCUMENT_PAGE_GUTTER_PX;
        return {
            generation: snapshot.generation,
            height: liveHeight,
            id: resolveDocumentOpeningPageShellId(options.instanceId, snapshot.generation),
            ownerId: frame?.ownerId ?? 'chassis-provisional',
            pageNumber: openingPage,
            // A frame placed at its reader's point keeps that place.
            style: {
                top: `${String(margin)}px`,
                left: `max(${String(margin)}px, calc(50% - ${String(liveWidth / 2)}px))`,
                ...style,
            },
        };
    });
    const readShell = () => document.getElementById(shell.value?.id ?? '');
    // The reader's zoom of the opening view starts from the scale shown and
    // keeps the page point under the pointer: the open's restore navigation
    // then places that point, and the frame follows both.
    const zoomOpeningShell = createDocumentWheelZoomHandler(
        {get value() {
            // The shell's scale: its width over the page's width as the view shows it.
            const geometry = options.openSurface.snapshot.value.openingPageGeometry;
            const width = readShell()?.getBoundingClientRect().width ?? 0;
            return geometry && width > 0
                ? width / projectPdfPageMetricForView(geometry, readFramePolicy(geometry).viewRotation ?? 0).width
                : 1;
        }},
        {get value() {
            return options.readPolicy().zoomMode;
        }},
        (_event, state) => options.emitZoomState?.(state),
        {beforeZoom: ({event}) => {
            const shellRect = readShell()?.getBoundingClientRect();
            const viewport = options.readViewport?.();
            const page = options.openSurface.viewportSession.value.requestedPage;
            if (!shellRect?.width || !shellRect.height || !viewport || page === null) {
                return;
            }
            const viewportRect = viewport.getBoundingClientRect();
            const size = readViewportSize();
            options.openSurface.navigate(createPageNavigationRequest(page, 'restore', {
                page,
                pageXFraction: clamp((event.clientX - shellRect.left) / shellRect.width, 0, 1),
                pageYFraction: clamp((event.clientY - shellRect.top) / shellRect.height, 0, 1),
                viewportXFraction: clamp((event.clientX - viewportRect.left - viewport.clientLeft) / size.width, 0, 1),
                viewportYFraction: clamp(
                    (event.clientY - viewportRect.top - viewport.clientTop) / resolveAnchoredViewportHeight(shellRect.width, size),
                    0,
                    1,
                ),
                affinity: 'center',
            }));
        }},
    );

    return Object.freeze({
        shell,
        zoomOpeningShell,
        prepareOpeningPageFrame(generation: number) {
            const snapshot = options.openSurface.snapshot.value;
            const geometry = snapshot.openingPageGeometry;
            // A frame is prepared for the page the open requests, once its shape is known.
            if (
                snapshot.generation !== generation
                || geometry === null
                || !PREPARABLE_PHASES.has(snapshot.phase)
                || !snapshot.identity?.documentId
                || geometry.pageNumber !== options.openSurface.viewportSession.value.requestedPage
                || snapshot.openingPageFrame !== null
                    && snapshot.openingPageFrame.ownerId !== ownerId
            ) {
                return false;
            }
            // Read the revision only as a reactive invalidation signal.
            options.readLayoutRevision?.();
            const policy = readFramePolicy(geometry);
            // The open's restore navigation carries the point its page is placed at.
            const target = options.openSurface.navigationTicket.value?.request.target;
            const anchor = target?.kind === 'page' ? target.anchor : undefined;
            const style = resolveOpeningPageFrameStyle(geometry, readViewportSize(), policy, anchor);
            if (style === null) {
                return false;
            }
            return options.openSurface.commitOpeningPageFrame(generation, {
                generation,
                ownerId,
                pageNumber: geometry.pageNumber,
                intentKey: `${policy.zoomMode}:${String(policy.zoom)}${anchor ? `:${JSON.stringify(anchor)}` : ''}`,
                style: Object.freeze({...style}),
            });
        },
    });
}
