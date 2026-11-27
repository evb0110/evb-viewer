export function resolvePdfRasterJobPages(options: {
    start: number;
    end: number;
    totalPages: number;
    explicitPages?: readonly number[] | undefined;
}) {
    if (options.explicitPages) {
        return [...new Set(options.explicitPages)].filter(
            (pageNumber) => Number.isSafeInteger(pageNumber) && pageNumber >= 1 && pageNumber <= options.totalPages,
        );
    }
    return Array.from({length: Math.max(0, options.end - options.start + 1)}, (_, index) => options.start + index);
}
