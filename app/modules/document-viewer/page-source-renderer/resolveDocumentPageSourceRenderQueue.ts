export interface IDocumentPageSourceRenderQueueInput {
    bufferPages: readonly number[];
    concurrency: number;
    currentPage: number;
    guardRadius: number;
    inFlightPages: readonly number[];
    mountedPages: readonly number[];
    needsRender: (pageNumber: number) => boolean;
    preferredDirection: -1 | 0 | 1;
    residentPages: readonly number[];
    visiblePages: readonly number[];
}

export interface IDocumentPageSourceRenderQueue {
    pagesToAbort: number[];
    pagesToRender: number[];
}

export function resolveDocumentPageSourceRenderQueue(
    input: IDocumentPageSourceRenderQueueInput,
): IDocumentPageSourceRenderQueue {
    const mountedPageSet = new Set(input.mountedPages);
    const inFlightPageSet = new Set(input.inFlightPages);
    const visiblePageSet = new Set(input.visiblePages);
    const bufferPageSet = new Set(input.bufferPages);
    const nonCurrentVisiblePages = input.visiblePages.filter(pageNumber => pageNumber !== input.currentPage);
    const currentPageIsOutsideVisibleBand = input.preferredDirection > 0
        ? (nonCurrentVisiblePages.at(0) ?? input.currentPage) > input.currentPage + 1
        : input.preferredDirection < 0
            ? (nonCurrentVisiblePages.at(-1) ?? input.currentPage) < input.currentPage - 1
            : false;
    const leadingEdge = input.preferredDirection < 0
        ? input.visiblePages.at(0) ?? input.currentPage
        : input.visiblePages.at(-1) ?? input.currentPage;
    const rankPage = (pageNumber: number) => {
        if (pageNumber === input.currentPage && !currentPageIsOutsideVisibleBand) {
            return 0;
        }
        const isLeadingBuffer = input.preferredDirection !== 0
            && bufferPageSet.has(pageNumber)
            && Math.sign(pageNumber - leadingEdge) === input.preferredDirection;
        if (isLeadingBuffer) {
            return 1 + input.guardRadius - Math.abs(pageNumber - leadingEdge);
        }
        if (visiblePageSet.has(pageNumber)) {
            if (pageNumber === input.currentPage && currentPageIsOutsideVisibleBand) {
                return 150;
            }
            return 100 + Math.abs(pageNumber - input.currentPage);
        }
        return 200 + Math.abs(pageNumber - input.currentPage);
    };
    const availableRenderSlots = Math.max(0, input.concurrency - inFlightPageSet.size);
    const pagesToRender = input.residentPages
        .filter(pageNumber => mountedPageSet.has(pageNumber))
        .sort((left, right) => rankPage(left) - rankPage(right))
        .filter(pageNumber => !inFlightPageSet.has(pageNumber) && input.needsRender(pageNumber))
        .slice(0, availableRenderSlots);
    const pagesToAbort = input.preferredDirection === 0
        ? []
        : input.inFlightPages.filter(pageNumber => (
            (pageNumber - input.currentPage) * input.preferredDirection < 0
        ));
    return {
        pagesToAbort,
        pagesToRender,
    };
}
