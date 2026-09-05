import { clamp } from 'es-toolkit/math';
import type { IPdfBookmarkEntry } from '@app/types/pdfContracts';
import { normalizeBookmarkColor } from '@app/utils/pdfOutlineHelpers';

function normalizeTitle(title: string | null | undefined) {
    return typeof title === 'string' ? title.trim() : '';
}

function normalizePageIndex(pageIndex: number | null) {
    return typeof pageIndex === 'number' && Number.isFinite(pageIndex) ? pageIndex : null;
}

function normalizePageYRatio(pageYRatio: number | null | undefined) {
    return typeof pageYRatio === 'number' && Number.isFinite(pageYRatio)
        ? clamp(pageYRatio, 0, 1)
        : null;
}

function normalizeNamedDest(namedDest: string | null) {
    return typeof namedDest === 'string' && namedDest.trim().length > 0 ? namedDest : null;
}

/**
 * Compares exactly the fields persistence writes, after the same normalization
 * persistence applies. Anything else about the objects (key order, an absent
 * versus explicitly null `pageYRatio`, color spelling, extra properties a
 * caller carried along) cannot change the saved document, so it must not read
 * as an edit.
 */
function areEntryFieldsEqual(left: IPdfBookmarkEntry, right: IPdfBookmarkEntry) {
    return normalizeTitle(left.title) === normalizeTitle(right.title)
        && normalizePageIndex(left.pageIndex) === normalizePageIndex(right.pageIndex)
        && normalizePageYRatio(left.pageYRatio) === normalizePageYRatio(right.pageYRatio)
        && normalizeNamedDest(left.namedDest) === normalizeNamedDest(right.namedDest)
        && (left.bold === true) === (right.bold === true)
        && (left.italic === true) === (right.italic === true)
        && normalizeBookmarkColor(left.color) === normalizeBookmarkColor(right.color);
}

/**
 * Semantic equality for persisted PDF bookmark outlines. Sibling order is
 * meaningful and is compared position by position; the walk visits each node
 * once, so a large outline costs one linear pass rather than a full
 * serialization of both trees.
 */
export function areBookmarkEntriesEqual(
    left: readonly IPdfBookmarkEntry[] | null | undefined,
    right: readonly IPdfBookmarkEntry[] | null | undefined,
): boolean {
    const pendingLeft: Array<readonly IPdfBookmarkEntry[]> = [left ?? []];
    const pendingRight: Array<readonly IPdfBookmarkEntry[]> = [right ?? []];

    while (pendingLeft.length > 0) {
        const leftList = pendingLeft.pop() ?? [];
        const rightList = pendingRight.pop() ?? [];
        if (leftList.length !== rightList.length) {
            return false;
        }

        for (const [
            index,
            leftEntry,
        ] of leftList.entries()) {
            const rightEntry = rightList[index];
            if (!rightEntry || !areEntryFieldsEqual(leftEntry, rightEntry)) {
                return false;
            }

            pendingLeft.push(leftEntry.items);
            pendingRight.push(rightEntry.items);
        }
    }

    return true;
}
