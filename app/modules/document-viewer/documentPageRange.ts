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

export function normalizeDocumentPageRange<TRange extends IDocumentPageRange>(
    range: TRange,
    totalPages: number,
): IDocumentPageRange {
    if (totalPages <= 0) {
        return {
            start: 0,
            end: 0,
        };
    }

    const start = normalizeDocumentPageNumber(range.start, totalPages);
    const end = normalizeDocumentPageNumber(range.end, totalPages);
    return {
        start: Math.min(start, end),
        end: Math.max(start, end),
    };
}

export function createDocumentSinglePageRange(pageNumber: number, totalPages: number): IDocumentPageRange {
    const page = normalizeDocumentPageNumber(pageNumber, totalPages);
    return {
        start: page,
        end: page,
    };
}

export function doDocumentPageRangesIntersect(left: IDocumentPageRange, right: IDocumentPageRange) {
    return left.start <= right.end && right.start <= left.end;
}
