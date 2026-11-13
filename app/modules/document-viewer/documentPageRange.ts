export interface IDocumentPageRange {
    start: number;
    end: number;
}

export function normalizeDocumentPageNumber(pageNumber: number, totalPages: number) {
    if (!Number.isFinite(pageNumber)) {
        return totalPages > 0 ? 1 : 0;
    }
    if (totalPages <= 0) {
        return Math.max(0, Math.trunc(pageNumber));
    }
    return Math.min(Math.max(Math.trunc(pageNumber), 1), totalPages);
}
