import type { IDocumentPageSlotRegistry } from '@app/modules/document-viewer/page-slots/createDocumentPageSlotRegistry';

/**
 * One render of a page. It carries its identity from the renderer to the
 * open surface; only the page's latest attempt in a live session commits.
 */
export interface IDocumentPageRenderAttempt {
    readonly pageNumber: number;
    readonly requestId: number;
}

export interface IDocumentViewerRenderSession {
    readonly ownerId: string;
    readonly pageSlots: ReturnType<IDocumentPageSlotRegistry['createOwner']>;
    runPageRender<T>(
        pageNumber: number,
        render: (attempt: IDocumentPageRenderAttempt) => Promise<T>,
    ): Promise<{
        committed: boolean;
        attempt: IDocumentPageRenderAttempt;
        value: T
    }>;
    releasePage(pageNumber: number): void;
    resolveMountedPages(options: {
        currentPage: number;
        destinationPage?: number | undefined;
        maxPages?: number | undefined;
        pageCount: number;
        radius?: number | undefined;
        viewportPages?: readonly number[] | undefined;
    }): number[];
    dispose(): void;
}

export function createDocumentViewerRenderCoordinator(pageSlots: IDocumentPageSlotRegistry) {
    function createSession(ownerId: string): IDocumentViewerRenderSession {
        const ownedSlots = pageSlots.createOwner(ownerId);
        const latestAttempts = new Map<number, IDocumentPageRenderAttempt>();
        let nextRequestId = 0;
        let disposed = false;

        return {
            ownerId,
            pageSlots: ownedSlots,
            async runPageRender(pageNumber, render) {
                const attempt: IDocumentPageRenderAttempt = Object.freeze({
                    pageNumber,
                    requestId: ++nextRequestId,
                });
                if (!disposed) {
                    latestAttempts.set(pageNumber, attempt);
                }
                const value = await render(attempt);
                return {
                    committed: !disposed && latestAttempts.get(pageNumber) === attempt,
                    attempt,
                    value,
                };
            },
            releasePage(pageNumber) {
                latestAttempts.delete(pageNumber);
            },
            resolveMountedPages({
                currentPage,
                destinationPage,
                maxPages,
                pageCount,
                radius = 3,
                viewportPages = [],
            }) {
                const normalizePage = (pageNumber: number) => Math.max(
                    1,
                    Math.min(pageCount, Math.trunc(pageNumber)),
                );
                const normalizedViewportPages = [...new Set(viewportPages
                    .filter(Number.isFinite)
                    .map(normalizePage))]
                    .sort((left, right) => left - right);
                const semanticPages = new Set<number>();
                for (const anchor of [
                    currentPage,
                    destinationPage,
                ]) {
                    if (anchor === undefined) continue;
                    for (
                        let page = Math.max(1, anchor - radius);
                        page <= Math.min(pageCount, anchor + radius);
                        page += 1
                    ) semanticPages.add(page);
                }
                const candidates = new Set([
                    ...normalizedViewportPages,
                    ...semanticPages,
                ]);
                const normalizedMaxPages = maxPages === undefined
                    ? Number.POSITIVE_INFINITY
                    : Math.max(1, Math.trunc(maxPages));
                if (candidates.size <= normalizedMaxPages) {
                    return [...candidates].sort((left, right) => left - right);
                }

                const viewportStart = normalizedViewportPages[0];
                const viewportEnd = normalizedViewportPages.at(-1);
                const viewportCenter = viewportStart !== undefined && viewportEnd !== undefined
                    ? (viewportStart + viewportEnd) / 2
                    : normalizePage(destinationPage ?? currentPage);
                const destination = destinationPage === undefined
                    ? null
                    : normalizePage(destinationPage);
                const requiredPages = new Set<number>(normalizedViewportPages);
                if (destination !== null) requiredPages.add(destination);
                requiredPages.add(normalizePage(currentPage));
                const ranked = [...candidates].sort((left, right) => {
                    const leftRequired = requiredPages.has(left) ? 0 : 1;
                    const rightRequired = requiredPages.has(right) ? 0 : 1;
                    if (leftRequired !== rightRequired) {
                        return leftRequired - rightRequired;
                    }
                    const leftDistance = Math.min(
                        Math.abs(left - viewportCenter),
                        destination === null ? Number.POSITIVE_INFINITY : Math.abs(left - destination),
                    );
                    const rightDistance = Math.min(
                        Math.abs(right - viewportCenter),
                        destination === null ? Number.POSITIVE_INFINITY : Math.abs(right - destination),
                    );
                    return leftDistance - rightDistance || left - right;
                });
                return ranked
                    .slice(0, normalizedMaxPages)
                    .sort((left, right) => left - right);
            },
            dispose() {
                if (disposed) {
                    return;
                }
                disposed = true;
                latestAttempts.clear();
                ownedSlots.dispose();
            },
        };
    }

    return {createSession};
}
