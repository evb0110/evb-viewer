import { parsePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type { TPdfViewMode } from '@contracts/shared';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import type { TDocumentViewportVisualOwner } from '@app/modules/document-viewer/public';

export function shouldShowPdfViewportPageSkeleton(options: {
    fallbackVisible: boolean;
    isEmptyToDocumentTransition: boolean;
    isViewportTransitionActive: boolean;
    pageNumber: TPageNumber;
    totalPages: number;
    viewMode: TPdfViewMode;
    visual: TDocumentViewportVisualOwner;
}) {
    if (!options.isViewportTransitionActive) {
        // A settled open-surface canvas does not own future rows reached by
        // free scrolling. Those rows must use the normal render-demand
        // skeleton while their own canvas is pending.
        return options.fallbackVisible;
    }

    const visual = options.visual;
    const visualPageNumber = visual.kind === 'page'
        ? parsePageNumber(visual.pageNumber, options.totalPages)
        : null;
    const visualRow = visualPageNumber !== null
        ? getPageRowBoundsForViewMode({
            pageNumber: visualPageNumber,
            totalPages: options.totalPages,
            viewMode: options.viewMode,
        })
        : null;
    const visualOwnsPage = visual.kind === 'page' && (
        visualRow === null
            ? visual.pageNumber === options.pageNumber
            : options.pageNumber >= visualRow.start && options.pageNumber <= visualRow.end
    );
    if (visual.kind === 'page' && !visualOwnsPage) {
        // A viewport generation owns one target row. Neighbouring virtualized
        // pages may stay mounted for layout continuity, but they must not keep
        // stale skeleton visuals after another row becomes authoritative.
        return false;
    }
    if (visual.kind === 'page' && visualOwnsPage) {
        if (visual.presentation === 'skeleton') {
            // During empty-to-document opening, the exact chassis frame is
            // already the shared viewport session's physical skeleton owner.
            // This is true while its geometry is provisional as well as after
            // the renderer has committed exact metrics. Mounting the page-track
            // skeleton in either phase creates two concurrent page frames.
            return !options.isEmptyToDocumentTransition;
        }
        return false;
    }
    if (options.isEmptyToDocumentTransition) {
        // The viewport session is the sole presentation owner while opening.
        // Non-target page fallbacks must never mount beside its exact frame.
        return false;
    }
    return options.fallbackVisible;
}
