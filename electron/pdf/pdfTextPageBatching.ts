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
