export interface IDocumentRasterResidencyPlanOptions {
    mountedPages: readonly number[];
    visiblePages: readonly number[];
    bufferRadius: number;
    maxBufferPixels: number;
    maximumResidentPages?: number;
    minimumBufferPages?: number;
    preferredDirection?: -1 | 0 | 1;
    estimatePagePixels: (pageNumber: number) => number;
}

export interface IDocumentRasterResidencyPlan {
    visiblePages: number[];
    bufferPages: number[];
    residentPages: number[];
    maxPixelsPerBufferSurface: number;
    estimatedBufferPixels: number;
}

function normalizePixels(value: number) {
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.ceil(value)) : 1;
}

function normalizePages(pages: readonly number[]) {
    return [...new Set(pages)]
        .filter(pageNumber => Number.isInteger(pageNumber) && pageNumber > 0);
}

function getDistanceFromVisiblePages(pageNumber: number, visiblePages: readonly number[]) {
    return visiblePages.reduce(
        (nearest, visiblePage) => Math.min(nearest, Math.abs(pageNumber - visiblePage)),
        Number.POSITIVE_INFINITY,
    );
}

/**
 * Renderer-neutral raster admission policy. Geometry virtualization decides
 * which page slots exist; this planner decides which mounted slots may retain
 * decoded raster surfaces. Visible pages are unconditional, while nearby
 * surfaces share one aggregate pixel budget and are admitted nearest-first.
 */
export function resolveDocumentRasterResidencyPlan(
    options: IDocumentRasterResidencyPlanOptions,
): IDocumentRasterResidencyPlan {
    const mountedPages = normalizePages(options.mountedPages);
    const visiblePages = normalizePages(options.visiblePages)
        .sort((left, right) => left - right);
    const visiblePageSet = new Set(visiblePages);
    const firstVisiblePage = visiblePages.at(0) ?? null;
    const lastVisiblePage = visiblePages.at(-1) ?? null;
    const preferredDirection = options.preferredDirection ?? 0;
    const bufferRadius = Math.max(0, Math.trunc(options.bufferRadius));
    const candidates = mountedPages
        .filter((pageNumber) => {
            if (visiblePageSet.has(pageNumber)) {
                return false;
            }
            const distance = getDistanceFromVisiblePages(pageNumber, visiblePages);
            return distance > 0 && distance <= bufferRadius;
        })
        .sort((left, right) => {
            const directionRank = (pageNumber: number) => {
                if (preferredDirection > 0) {
                    return lastVisiblePage !== null && pageNumber > lastVisiblePage ? 0 : 1;
                }
                if (preferredDirection < 0) {
                    return firstVisiblePage !== null && pageNumber < firstVisiblePage ? 0 : 1;
                }
                return 0;
            };
            return directionRank(left) - directionRank(right)
                || getDistanceFromVisiblePages(left, visiblePages)
                - getDistanceFromVisiblePages(right, visiblePages)
                || (preferredDirection < 0 ? left - right : right - left);
        });
    const maxBufferPixels = Number.isFinite(options.maxBufferPixels)
        ? Math.max(0, Math.trunc(options.maxBufferPixels))
        : Number.MAX_SAFE_INTEGER;
    const maximumResidentPages = options.maximumResidentPages === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, Math.trunc(options.maximumResidentPages));
    const maximumBufferPages = Math.max(0, maximumResidentPages - visiblePages.length);
    const guaranteedNeighborCount = Math.min(
        Math.max(0, Math.trunc(options.minimumBufferPages ?? 2)),
        candidates.length,
        maximumBufferPages,
    );
    const maxPixelsPerBufferSurface = guaranteedNeighborCount > 0
        ? Math.max(1, Math.floor(maxBufferPixels / guaranteedNeighborCount))
        : 0;
    const bufferPages: number[] = [];
    let estimatedBufferPixels = 0;

    for (const pageNumber of candidates) {
        if (bufferPages.length >= maximumBufferPages) {
            break;
        }
        const estimatedPixels = Math.min(
            normalizePixels(options.estimatePagePixels(pageNumber)),
            maxPixelsPerBufferSurface,
        );
        if (estimatedBufferPixels + estimatedPixels > maxBufferPixels) {
            break;
        }
        bufferPages.push(pageNumber);
        estimatedBufferPixels += estimatedPixels;
    }

    return {
        visiblePages,
        bufferPages,
        residentPages: [
            ...visiblePages,
            ...bufferPages,
        ],
        maxPixelsPerBufferSurface,
        estimatedBufferPixels,
    };
}
