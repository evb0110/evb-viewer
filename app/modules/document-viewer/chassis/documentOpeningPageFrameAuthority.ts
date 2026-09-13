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
    IDocumentOpenSurfacePreparedPageFrame,
    IDocumentOpenSurfaceSession,
} from '@app/modules/document-viewer/chassis/documentOpenSurfaceSession';
import { resolveDocumentPageSourceOpeningFrame } from '@app/modules/document-viewer/layout/resolveDocumentPageSourceOpeningFrame';
import { DOCUMENT_PAGE_GUTTER_PX } from '@app/modules/document-viewer/layout/documentPageGutterPx';

export interface IDocumentOpeningPageFramePolicy {
    readonly fitMode: TFitMode;
    readonly viewMode: TDocumentViewMode;
    readonly zoom: number;
    readonly zoomMode: TZoomMode;
}

export interface IDocumentOpeningPageFrameAuthority {
    draftOpeningPageFrame(geometry: IDocumentOpenSurfacePageGeometry): IDocumentOpenSurfacePreparedPageFrame | null;
    isPreparedOpeningPageFrameCurrent(frame: IDocumentOpenSurfacePreparedPageFrame): boolean;
    prepareOpeningPageFrame(generation: number): boolean;
}

interface ICreateDocumentOpeningPageFrameAuthorityOptions {
    readonly openSurface: IDocumentOpenSurfaceSession;
    readonly readLayoutRevision?: () => number;
    readonly readPolicy: () => IDocumentOpeningPageFramePolicy;
    readonly readViewportSize: () => {
        width: number;
        height: number;
    };
}

let nextOpeningPageFrameAuthorityId = 0;

export function resolveDocumentOpeningPageShellId(chassisInstanceId: string, generation: number) {
    return `${chassisInstanceId}-opening-page-shell-${String(generation)}`;
}

function isDjvuDocument(documentId: string) {
    return /\.djvu?$/iu.test(documentId);
}

export function resolveDocumentOpeningPageMargin(
    _geometry: IDocumentOpenSurfacePageGeometry | null,
    _rendererKind?: 'pdfjs' | 'native-pdf' | 'page-source',
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
    const fitScale = policy.zoomMode === 'fit-height'
        ? (viewport.height - pageMargin * 2) / geometry.height
        : (viewport.width - pageMargin * (columns + 1)) / (geometry.width * columns);
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

function resolveSourceRevisionKey(geometry: IDocumentOpenSurfacePageGeometry) {
    const revision = geometry as IDocumentOpenSurfacePageGeometry & {
        readonly modifiedAt?: unknown;
        readonly size?: unknown;
    };
    return Number.isSafeInteger(revision.size)
        && Number.isSafeInteger(revision.modifiedAt)
        ? `${String(revision.size)}:${String(revision.modifiedAt)}`
        : null;
}

export function createDocumentOpeningPageFrameAuthority(
    options: ICreateDocumentOpeningPageFrameAuthorityOptions,
): IDocumentOpeningPageFrameAuthority {
    const ownerId = `document-viewer-chassis:${String(++nextOpeningPageFrameAuthorityId)}`;

    function readPreparationInputs(geometry: IDocumentOpenSurfacePageGeometry) {
        // Read the revision only as a reactive invalidation signal. Frame
        // identity is content-addressed by the dimensions that actually
        // affect geometry; same-size ResizeObserver churn must not stale an
        // otherwise exact prepared frame.
        options.readLayoutRevision?.();
        const policy = options.readPolicy();
        const viewport = options.readViewportSize();
        const style = resolveOpeningPageFrameStyle(geometry, viewport, policy);
        if (style === null) {
            return null;
        }
        return {
            layoutKey: `${String(viewport.width)}x${String(viewport.height)}`,
            policy,
            policyKey: [
                policy.fitMode,
                policy.viewMode,
                policy.zoomMode,
                policy.zoom,
            ].join(':'),
            style,
        } as const;
    }

    function draftOpeningPageFrame(
        geometry: IDocumentOpenSurfacePageGeometry,
    ): IDocumentOpenSurfacePreparedPageFrame | null {
        const preparation = readPreparationInputs(geometry);
        if (preparation === null) {
            return null;
        }
        return Object.freeze({
            documentId: geometry.documentId,
            ownerId,
            pageNumber: geometry.pageNumber,
            intentKey: `${preparation.policy.zoomMode}:${String(preparation.policy.zoom)}`,
            layoutKey: preparation.layoutKey,
            policyKey: preparation.policyKey,
            sourceRevisionKey: resolveSourceRevisionKey(geometry),
            style: Object.freeze({...preparation.style}),
            geometry: Object.freeze({...geometry}),
        });
    }

    return Object.freeze({
        draftOpeningPageFrame,
        isPreparedOpeningPageFrameCurrent(frame: IDocumentOpenSurfacePreparedPageFrame) {
            const current = draftOpeningPageFrame(frame.geometry);
            return current !== null
                && current.ownerId === frame.ownerId
                && current.documentId === frame.documentId
                && current.pageNumber === frame.pageNumber
                && current.layoutKey === frame.layoutKey
                && current.policyKey === frame.policyKey
                && current.sourceRevisionKey === frame.sourceRevisionKey
                && Object.entries(current.style).every(([
                    key,
                    value,
                ]) => frame.style[key] === value)
                && Object.keys(current.style).length === Object.keys(frame.style).length;
        },
        prepareOpeningPageFrame(generation: number) {
            const snapshot = options.openSurface.snapshot.value;
            const geometry = snapshot.openingPageGeometry;
            if (
                snapshot.generation !== generation
                || geometry === null
                || snapshot.openingPageFrame !== null
                    && snapshot.openingPageFrame.ownerId !== ownerId
                || snapshot.openingPageFrame?.preview !== undefined
                    && snapshot.openingPageFrame.preview.pageNumber !== geometry.pageNumber
            ) {
                return false;
            }
            const preparedFrame = draftOpeningPageFrame(geometry);
            if (preparedFrame === null) {
                return false;
            }
            return options.openSurface.commitOpeningPageFrame(generation, {
                generation,
                ownerId,
                pageNumber: geometry.pageNumber,
                intentKey: preparedFrame.intentKey,
                ...(preparedFrame.sourceRevisionKey === null
                    ? {}
                    : {sourceRevisionKey: preparedFrame.sourceRevisionKey}),
                style: preparedFrame.style,
            });
        },
    });
}
