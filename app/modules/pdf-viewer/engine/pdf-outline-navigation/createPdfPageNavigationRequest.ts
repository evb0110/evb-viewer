import type {
    IDocumentNavigationRequest,
    TDocumentNavigationTarget,
} from '@app/modules/document-viewer/public';
import type {IScrollToPageOptions} from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';

function clampRatio(value: number) {
    return Math.min(1, Math.max(0, value));
}

/**
 * Translate PDF-facing scroll options into the shared navigation request.
 * Callers may provide a fully formed request for named destinations or other
 * semantic targets that have already been resolved.
 */
export function createPdfPageNavigationRequest(
    page: number,
    options: IScrollToPageOptions = {},
): IDocumentNavigationRequest {
    if (options.navigationRequest) {
        return options.navigationRequest;
    }

    const source = options.navigationSource ?? (options.markerRect ? 'annotation' : 'toolbar');
    let target: TDocumentNavigationTarget = {
        kind: 'page',
        page,
    };
    let alignment: IDocumentNavigationRequest['alignment'] = 'page-top';
    const readiness: IDocumentNavigationRequest['readiness'] = source === 'search'
        ? 'text-layer'
        : source === 'annotation'
            ? 'annotation-editor'
            : 'page-canvas';

    if (options.markerRect) {
        target = {
            kind: 'rect',
            page,
            rect: options.markerRect,
        };
        alignment = 'rect-center';
    } else if (options.textAnchor) {
        target = {
            kind: 'text-anchor',
            page,
            ...options.textAnchor,
        };
        alignment = 'rect-center';
    } else if (typeof options.pageYRatio === 'number' && Number.isFinite(options.pageYRatio)) {
        target = {
            kind: 'rect',
            page,
            rect: {
                left: 0.5,
                top: clampRatio(options.pageYRatio),
                width: 0,
                height: 0,
            },
        };
        alignment = 'page-top';
    }

    const postArrival = source === 'search'
        ? 'search-highlight'
        : source === 'annotation'
            ? 'annotation-pulse'
            : undefined;

    return {
        ...(source === 'search' && typeof options.searchNavigationId === 'number'
            ? {searchNavigationId: options.searchNavigationId}
            : {}),
        target,
        alignment,
        readiness,
        ...(postArrival ? {postArrival} : {}),
        source,
        supersession: 'latest-wins',
    };
}
