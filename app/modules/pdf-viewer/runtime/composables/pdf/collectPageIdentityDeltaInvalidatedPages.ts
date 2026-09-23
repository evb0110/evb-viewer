import type { IPageIdentityDelta } from '@contracts/electronApiPageOps';

function addRange(pages: Set<number>, firstPage: number, count: number) {
    if (!Number.isSafeInteger(firstPage) || firstPage < 1
        || !Number.isSafeInteger(count) || count < 1) {
        return;
    }
    for (let offset = 0; offset < count; offset += 1) {
        pages.add(firstPage + offset);
    }
}

/** Destination pages whose cached pixels no longer describe the same page bytes. */
export function collectPageIdentityDeltaInvalidatedPages(
    delta: IPageIdentityDelta | undefined,
    explicitlyAffectedPages: readonly number[] = [],
) {
    const pages = new Set<number>();
    for (const pageNumber of explicitlyAffectedPages) {
        if (Number.isSafeInteger(pageNumber) && pageNumber > 0) {
            pages.add(pageNumber);
        }
    }

    if (delta?.pages !== undefined) {
        delta.pages.forEach((page, index) => {
            const destinationPage = index + 1;
            if ('insertedId' in page || page.fromPageNumber !== destinationPage) {
                pages.add(destinationPage);
            }
        });
    } else {
        for (const range of delta?.ranges ?? []) {
            if (range.kind === 'insert' || range.kind === 'touch') {
                addRange(pages, range.toPageNumber, range.count);
            } else if (
                (range.kind === 'retain' || range.kind === 'move')
                && range.fromPageNumber !== range.toPageNumber
            ) {
                addRange(pages, range.toPageNumber, range.count);
            }
        }
    }

    return [...pages].sort((left, right) => left - right);
}
