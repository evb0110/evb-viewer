import {requirePageIndex} from '@contracts/pageNumbers';
import type {TPageIndex} from '@contracts/pageNumbers';

import type {IBookmarkIdentityInput, TCreateBookmarkId} from '@app/types/pdfOutline';

/**
 * `untitledLabel` is what persistence writes in place of a blank title.
 * Identity has to make the same substitution, or a bookmark with no label would
 * be handed one id when it is resolved from the PDF and a different one after a
 * round trip through persisted entries, taking its whole subtree with it.
 */
export interface IBookmarkIdentityOptions {
    untitledLabel?: string;
}

export interface IBookmarkIdentityFactory {
    createBookmarkId: TCreateBookmarkId;
    createDraftBookmarkId: () => string;
}

const BOOKMARK_ID_PREFIX = 'bookmark-';
const DRAFT_ID_PREFIX = `${BOOKMARK_ID_PREFIX}draft-`;
const COLLISION_SUFFIX = '~';

/**
 * Length-prefixed encoding keeps the joined path unambiguous, so a title that
 * happens to contain the separator cannot impersonate a different field.
 */
function encodeField(value: string | number | null) {
    if (value === null) {
        return 'n|';
    }

    const text = String(value);
    return `${text.length}|${text}`;
}

function resolveIdentityTitle(title: string | null | undefined, untitledLabel: string) {
    const trimmed = typeof title === 'string' ? title.trim() : '';
    return trimmed.length > 0 ? trimmed : untitledLabel;
}

function resolveIdentityPageIndex(pageIndex: TPageIndex | null) {
    return typeof pageIndex === 'number' && Number.isFinite(pageIndex) ? Math.max(0, Math.trunc(pageIndex)) : null;
}

/**
 * Only a string destination survives the persistence round trip as
 * `namedDest`; array destinations are dropped there, so they must not take
 * part in identity or a reloaded outline would hand every such bookmark a new
 * id.
 */
function resolveIdentityNamedDest(dest: string | unknown[] | null) {
    return typeof dest === 'string' && dest.trim().length > 0 ? dest : null;
}

/**
 * cyrb53: two independent 32-bit rounds folded into one 53-bit value. Integer
 * arithmetic only, so the same content path yields the same id on every
 * platform and after every reload, and a 10k-item outline stays far away from
 * the birthday bound.
 */
function hashContentPath(value: string) {
    let first = 0xdeadbeef;
    let second = 0x41c6ce57;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 2654435761);
        second = Math.imul(second ^ code, 1597334677);
    }
    first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
    second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
    return (4294967296 * (2097151 & second) + (first >>> 0)).toString(36);
}

/**
 * Derives bookmark ids from where a bookmark sits in the outline's content,
 * not from its position in traversal order. The id of a node is a hash of its
 * parent's id plus its own label and destination, so inserting, removing, or
 * reordering unrelated siblings leaves every other id untouched, and an
 * outline rebuilt from persisted entries reproduces the ids that selection,
 * expansion, and row keys are held under.
 *
 * Siblings that share a label and a destination are told apart by their
 * occurrence among identical siblings, which is stable as long as the
 * duplicates themselves do not change. Draft bookmarks get a counter id
 * instead: their content is about to be typed, so it cannot identify them.
 */
export function createBookmarkIdentityFactory(options: IBookmarkIdentityOptions = {}): IBookmarkIdentityFactory {
    const untitledLabel = options.untitledLabel ?? '';
    const occurrencesByContentPath = new Map<string, number>();
    const usedIds = new Set<string>();
    let draftCount = 0;

    function reserveUniqueId(candidate: string) {
        if (!usedIds.has(candidate)) {
            usedIds.add(candidate);
            return candidate;
        }

        let attempt = 1;
        while (usedIds.has(`${candidate}${COLLISION_SUFFIX}${attempt}`)) {
            attempt += 1;
        }
        const unique = `${candidate}${COLLISION_SUFFIX}${attempt}`;
        usedIds.add(unique);
        return unique;
    }

    function createBookmarkId(input: IBookmarkIdentityInput) {
        const contentPath = [
            encodeField(input.parentId),
            encodeField(resolveIdentityTitle(input.title, untitledLabel)),
            encodeField(resolveIdentityPageIndex(input.pageIndex === null ? null : requirePageIndex(input.pageIndex))),
            encodeField(resolveIdentityNamedDest(input.dest)),
        ].join('');
        const occurrence = occurrencesByContentPath.get(contentPath) ?? 0;
        occurrencesByContentPath.set(contentPath, occurrence + 1);

        return reserveUniqueId(`${BOOKMARK_ID_PREFIX}${hashContentPath(`${contentPath}${encodeField(occurrence)}`)}`);
    }

    function createDraftBookmarkId() {
        draftCount += 1;
        return reserveUniqueId(`${DRAFT_ID_PREFIX}${draftCount}`);
    }

    return {
        createBookmarkId,
        createDraftBookmarkId,
    };
}
