import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {
    requirePageIndex,
    type TPageIndex,
} from '@contracts/pageNumbers';
import {
    DJVU_OUTLINE_MAX_DEPTH,
    DJVU_OUTLINE_MAX_NODES,
    DJVU_OUTLINE_MAX_TITLE_CHARS,
} from '@contracts/djvuResourceLimits';
import type {
    IDjvuDocFileEntry,
    IDjvuOutlineRawItem,
} from '@djvu-core/djvuLibreTypes';

/** Maximum serialized outline byte size accepted before refusing oversized NAVM metadata. */
export const DJVU_OUTLINE_MAX_BYTES = 262_144;

/** Maps DIRM component IDs and names to 0-based page indices. */
export function buildDjvuPageComponentMap(files: readonly IDjvuDocFileEntry[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const file of files) {
        if (file.type !== 'page' || file.pageNumber === null || file.pageNumber < 1) {
            continue;
        }
        const pageIndex = file.pageNumber - 1;
        if (file.id) {
            map.set(file.id, pageIndex);
        }
        if (file.name && !map.has(file.name)) {
            map.set(file.name, pageIndex);
        }
    }
    return map;
}

/** Resolves a DjVu outline URL (`#<component-id>` or `#<1-based-page>`) to a 0-based page index. */
export function resolveDjvuOutlineUrlToPageIndex(
    url: string,
    pageComponents?: ReadonlyMap<string, number>,
    pageCount?: number,
): TPageIndex | null {
    if (!url || !url.startsWith('#')) {
        return null;
    }
    const target = url.slice(1);
    if (!target) {
        return null;
    }
    const componentIndex = pageComponents?.get(target);
    if (componentIndex !== undefined && Number.isSafeInteger(componentIndex) && componentIndex >= 0) {
        if (pageCount === undefined || componentIndex < pageCount) {
            return requirePageIndex(componentIndex);
        }
        return null;
    }
    if (/^\d+$/u.test(target)) {
        const pageNum = Number.parseInt(target, 10);
        if (Number.isSafeInteger(pageNum) && pageNum >= 1 && (pageCount === undefined || pageNum <= pageCount)) {
            return requirePageIndex(pageNum - 1);
        }
    }
    return null;
}

/** Normalizes a DjVuLibre WASM outline tree into bounded `IPdfBookmarkEntry[]`. */
export function normalizeDjvuOutlineTree(
    items: readonly IDjvuOutlineRawItem[],
    pageComponents?: ReadonlyMap<string, number>,
    pageCount?: number,
): IPdfBookmarkEntry[] {
    let nodeCount = 0;
    let totalTitleChars = 0;

    const visit = (nodes: readonly IDjvuOutlineRawItem[], depth: number): IPdfBookmarkEntry[] => {
        if (depth > DJVU_OUTLINE_MAX_DEPTH) {
            throw new Error(`DjVu outline nesting is capped at ${DJVU_OUTLINE_MAX_DEPTH}`);
        }
        const result: IPdfBookmarkEntry[] = [];
        for (const node of nodes) {
            nodeCount += 1;
            if (nodeCount > DJVU_OUTLINE_MAX_NODES) {
                throw new Error('DjVu outline node count exceeds the supported limit');
            }
            const title = typeof node.title === 'string' ? node.title : '';
            totalTitleChars += title.length;
            if (totalTitleChars > DJVU_OUTLINE_MAX_TITLE_CHARS) {
                throw new Error('DjVu outline text exceeds the supported limit');
            }
            const children = Array.isArray(node.children) && node.children.length > 0
                ? visit(node.children, depth + 1)
                : [];
            result.push({
                title: title.slice(0, DJVU_OUTLINE_MAX_TITLE_CHARS),
                pageIndex: resolveDjvuOutlineUrlToPageIndex(node.url, pageComponents, pageCount),
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: children,
            });
        }
        return result;
    };

    return visit(items, 1);
}
