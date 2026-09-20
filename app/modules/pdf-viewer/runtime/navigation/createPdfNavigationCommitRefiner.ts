import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import {
    resolvePdfNavigationAnchor,
    resolveTextAnchorRect,
    type IResolvedPdfNavigationTarget,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfNavigationRequestResolver';
import type {
    IPdfSemanticAnchor,
    IPdfViewportGeometry,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import type { IPdfViewportIntent } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface IPdfViewportCommit {
    anchor: IPdfSemanticAnchor;
    left: number;
    top: number;
}

interface ICreatePdfNavigationCommitRefinerOptions {
    getContainer: () => HTMLElement | null;
    refreshGeometry: () => IPdfViewportGeometry | null;
    resolvedTargets: Map<string, IResolvedPdfNavigationTarget>;
    resolveAnchorForViewport: (
        snapshot: IPdfViewportGeometry,
        pageNumber: TPageNumber,
    ) => IPdfSemanticAnchor;
    resolveNavigationScrollForViewport: (
        snapshot: IPdfViewportGeometry,
        anchor: IPdfSemanticAnchor,
    ) => {
        left: number;
        top: number
    };
}

export function createPdfNavigationCommitRefiner(
    options: ICreatePdfNavigationCommitRefinerOptions,
) {
    return function refineNavigationCommit<TCommit extends IPdfViewportCommit>(
        intent: IPdfViewportIntent,
        commit: TCommit,
    ): Promise<TCommit> {
        const container = options.getContainer();
        const snapshot = options.refreshGeometry();
        const request = intent.navigation;
        const resolved = options.resolvedTargets.get(intent.id);
        if (!container || !snapshot || !request || !resolved) {
            return Promise.resolve(commit);
        }
        const textAnchor = request.target.kind === 'text-anchor' ? request.target : null;
        if (textAnchor) {
            const rect = resolveTextAnchorRect(container, textAnchor);
            if (rect) {
                resolved.rect = rect;
            }
            logPdfRenderTrace('navigation-text-anchor-refined', () => {
                const pageElement = container.querySelector<HTMLElement>(
                    `.page_container[data-page="${textAnchor.page}"]`,
                );
                const textLayer = pageElement?.querySelector<HTMLElement>('.text-layer, .textLayer');
                return {
                    intentId: intent.id,
                    page: textAnchor.page,
                    hasPage: pageElement !== null,
                    hasTextLayer: Boolean(pageElement && textLayer),
                    textLayerReady: textLayer?.dataset.pdfTextLayerReady ?? null,
                    textLayerTextLength: textLayer?.textContent.length ?? 0,
                    textLayerSpanCount: textLayer?.querySelectorAll('span').length ?? 0,
                    hasResolvedRect: rect !== null,
                    resolvedRect: rect,
                    searchRange: textAnchor.searchRange ?? null,
                };
            });
        }
        const anchor = resolvePdfNavigationAnchor(request, resolved, snapshot);
        // Navigation layout estimates are enough to mount the target row.
        // Once that row exists, its physical position is the authority.
        // Long scanned PDFs can accumulate several pages of error between
        // estimated and measured heights, so applying the estimate here
        // can commit page N while leaving page N-6 in the viewport.
        const scroll = options.resolveNavigationScrollForViewport(snapshot, anchor);
        if (request.alignment === 'keep-visible') {
            const centerAnchor = resolvePdfNavigationAnchor({
                ...request,
                alignment: 'rect-center',
            }, resolved);
            const center = options.resolveNavigationScrollForViewport(snapshot, centerAnchor);
            const visible = Math.abs(center.left - container.scrollLeft) <= container.clientWidth / 2
                && Math.abs(center.top - container.scrollTop) <= container.clientHeight / 2;
            if (visible) {
                return Promise.resolve({
                    ...commit,
                    anchor: options.resolveAnchorForViewport(snapshot, requirePageNumber(anchor.page)),
                    left: container.scrollLeft,
                    top: container.scrollTop,
                });
            }
        }
        return Promise.resolve({
            ...commit,
            anchor,
            ...scroll,
        });
    };
}
