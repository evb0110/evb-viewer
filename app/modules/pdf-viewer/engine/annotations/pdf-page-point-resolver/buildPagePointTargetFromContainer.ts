import type { IPagePointTarget } from '@app/modules/pdf-viewer/engine/annotations/pagePointTarget';
import { clamp01 } from '@app/modules/pdf-viewer/engine/annotation-geometry/clamp01';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { INotePlacementDiagnosticsContext } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/notePlacementDiagnosticsContext';

const NOTE_PLACEMENT_LOG_SECTION = 'note-placement';

function roundForLog(value: number, digits = 3) {
    if (!Number.isFinite(value)) {
        return value;
    }
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function toRectLog(rect: DOMRect | {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}) {
    return {
        left: roundForLog(rect.left),
        top: roundForLog(rect.top),
        right: roundForLog(rect.right),
        bottom: roundForLog(rect.bottom),
        width: roundForLog(rect.width),
        height: roundForLog(rect.height),
    };
}

export function buildPagePointTargetFromContainer(
    pageContainer: HTMLElement,
    clientX: number,
    clientY: number,
    selectedSource: string,
    currentPage: number,
    diagnostics?: INotePlacementDiagnosticsContext,
): IPagePointTarget | null {
    const rect = pageContainer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        if (diagnostics) {
            BrowserLogger.diagnostic(NOTE_PLACEMENT_LOG_SECTION, 'Resolved quick-note page container has invalid rect', {
                attemptId: diagnostics.attemptId ?? null,
                selectedSource,
                pageNumberFromDataset: pageContainer.dataset.page ?? null,
                rect: toRectLog(rect),
            });
        }
        return null;
    }
    const parsedPageNumber = pageContainer.dataset.page ? Number(pageContainer.dataset.page) : currentPage;
    const pageNumber = Number.isFinite(parsedPageNumber) && parsedPageNumber > 0 ? parsedPageNumber : null;
    if (pageNumber === null) {
        if (diagnostics) {
            BrowserLogger.diagnostic(NOTE_PLACEMENT_LOG_SECTION, 'Resolved quick-note page container has invalid page number', {
                attemptId: diagnostics.attemptId ?? null,
                selectedSource,
                datasetPage: pageContainer.dataset.page ?? null,
                fallbackCurrentPage: currentPage,
            });
        }
        return null;
    }
    return {
        pageContainer,
        pageNumber,
        pageX: clamp01((clientX - rect.left) / rect.width),
        pageY: clamp01((clientY - rect.top) / rect.height),
    };
}
