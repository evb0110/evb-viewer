export function groupContiguousPages(pages: readonly number[]) {
    const ranges: Array<{
        firstPage: number;
        lastPage: number
    }> = [];
    for (const page of pages) {
        const lastRange = ranges.at(-1);
        if (lastRange && page === lastRange.lastPage + 1) {
            lastRange.lastPage = page;
            continue;
        }

        ranges.push({
            firstPage: page,
            lastPage: page,
        });
    }
    return ranges;
}

export function splitPdfTextOutput(output: string, expectedCount?: number) {
    let pages = output.split('\f');
    if (typeof expectedCount === 'number' && expectedCount > 0) {
        if (pages.length < expectedCount) {
            pages = pages.concat(Array.from({ length: expectedCount - pages.length }, () => ''));
        } else if (pages.length > expectedCount) {
            pages = pages.slice(0, expectedCount);
        }
    } else if (pages.length > 1 && pages.at(-1)?.trim() === '') {
        pages = pages.slice(0, -1);
    }
    return pages;
}

export function normalizeRequestedPdfPages(pages: readonly number[] | undefined, pageCount?: number) {
    if (!pages || pages.length === 0) {
        return [];
    }

    return Array.from(new Set(
        pages
            .map(page => Math.trunc(page))
            .filter(page => page >= 1 && (pageCount === undefined || page <= pageCount)),
    )).sort((left, right) => left - right);
}

export function splitPdfPageRange(firstPage: number, lastPage: number, windowPages: number) {
    const ranges: Array<{
        firstPage: number;
        lastPage: number;
    }> = [];
    for (
        let rangeFirstPage = firstPage;
        rangeFirstPage <= lastPage;
        rangeFirstPage += windowPages
    ) {
        ranges.push({
            firstPage: rangeFirstPage,
            lastPage: Math.min(lastPage, rangeFirstPage + windowPages - 1),
        });
    }
    return ranges;
}
