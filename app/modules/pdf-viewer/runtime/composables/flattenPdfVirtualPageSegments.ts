import { requirePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';
import type { IPdfVirtualPageSegment } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';

export type TPdfVirtualPageItem = {
    key: `page:${number}`;
    kind: 'page';
    page: TPageNumber;
} | {
    key: `spacer:${number}`;
    kind: 'spacer';
    style: Record<string, string>;
};

export interface IPdfVirtualPageRowItem {
    key: `row:${number}`;
    kind: 'row';
    pages: Array<Extract<TPdfVirtualPageItem, {kind: 'page'}>>;
}

/**
 * Keeps pages as globally keyed siblings so a virtual-window boundary change
 * cannot remount an overlapping page and discard its freshly rendered canvas.
 */
export function flattenPdfVirtualPageSegments(
    segments: readonly IPdfVirtualPageSegment[],
    options: {
        initialPageShell?: boolean;
        initialPageShellPage?: TPageNumber;
    } = {},
): TPdfVirtualPageItem[] {
    const items: TPdfVirtualPageItem[] = [];
    // The call-local ordinal keeps each structural spacer stable across
    // projections with the same segment order. It is not a global counter.
    let spacerIndex = 0;
    for (const segment of segments) {
        const pages: TPdfVirtualPageItem[] = segment.pages.map(page => {
            const pageNumber = requirePageNumber(page);
            return {
                key: `page:${pageNumber}`,
                kind: 'page',
                page: pageNumber,
            };
        });
        if (!segment.spacerBeforeStyle) {
            items.push(...pages);
            continue;
        }
        items.push(
            {
                // Keep the structural spacer node stable while its height and
                // page window move. Replacing it lets the browser observe a
                // transiently shortened scroll tree and clamp scrollTop before
                // the new far-window spacer is inserted.
                key: `spacer:${spacerIndex++}`,
                kind: 'spacer',
                style: segment.spacerBeforeStyle,
            },
            ...pages,
        );
    }
    if (items.length > 0 || options.initialPageShell !== true) {
        return items;
    }
    const page = requirePageNumber(Math.max(1, Math.trunc(options.initialPageShellPage ?? 1)));
    return [{
        key: `page:${page}`,
        kind: 'page',
        page,
    }];
}

export function groupPdfVirtualPageItems(
    items: readonly TPdfVirtualPageItem[],
    options: {
        isFacingMode: boolean;
        isSpreadSingle: (page: TPageNumber) => boolean;
    },
): Array<TPdfVirtualPageItem | IPdfVirtualPageRowItem> {
    if (!options.isFacingMode) {
        return [...items];
    }
    const grouped: Array<TPdfVirtualPageItem | IPdfVirtualPageRowItem> = [];
    let rowPages: IPdfVirtualPageRowItem['pages'] = [];
    const flushRow = () => {
        if (rowPages.length === 0) {
            return;
        }
        const firstPage = rowPages[0]?.page;
        if (firstPage !== undefined) {
            grouped.push({
                key: `row:${firstPage}`,
                kind: 'row',
                pages: rowPages,
            });
        }
        rowPages = [];
    };
    for (const item of items) {
        if (item.kind === 'spacer') {
            flushRow();
            grouped.push(item);
            continue;
        }
        if (
            rowPages.length === 0
            || (
                rowPages.length < 2
                && !options.isSpreadSingle(rowPages[0]!.page)
                && !options.isSpreadSingle(item.page)
            )
        ) {
            rowPages.push(item);
            continue;
        }
        flushRow();
        rowPages.push(item);
    }
    flushRow();
    return grouped;
}
