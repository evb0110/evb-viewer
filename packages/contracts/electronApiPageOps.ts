import { requirePageNumber } from '@contracts/pageNumbers';
import type {
    TPageNumber,
    IPageMoveRangeSegment,
} from '@contracts/pageNumbers';

import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';

export type TPageOpsRotationAngle = 90 | 180 | 270;

export interface IPageOpsCompactSelection {
    pageCount: number;
    ranges: IPageMoveRangeSegment[];
}

export type TPageOpsPageSelection = number[] | IPageOpsCompactSelection;

export interface IPageOpsMetadataSnapshot {
    /** Omitted until the viewer has read the document's page labels. */
    readonly pageLabels?: readonly string[] | null;
    /** Compact page-label source of truth, including when pageLabels is null. */
    readonly pageLabelRanges?: readonly IPdfPageLabelRange[];
    /** Omitted until the viewer has read the document's outline tree. */
    readonly bookmarks?: readonly IPdfBookmarkEntry[];
    readonly untitledBookmarkLabel: string;
}

export interface IPageOpsMutationOptions {
    expectedDocumentRevisionToken?: TDocumentRevisionToken | null;
    metadataSnapshot?: IPageOpsMetadataSnapshot;
}

/** A contiguous page mapping in a structural page operation. */
export interface IPageIdentityRangeMapping {
    readonly kind: 'retain' | 'move';
    /** One-based source page at the start of the range. */
    readonly fromPageNumber: number;
    /** One-based destination page at the start of the range. */
    readonly toPageNumber: number;
    /** Number of pages in the range. */
    readonly count: number;
}

/** A contiguous run of newly inserted pages. */
export interface IPageIdentityRangeInsert {
    readonly kind: 'insert';
    /** One-based destination page at the start of the run. */
    readonly toPageNumber: number;
    readonly count: number;
    /** Seed used to derive one UUID per inserted page without an array. */
    readonly identitySeed: string;
    /** Small legacy-compatible insertions may carry their concrete UUIDs. */
    readonly insertedIds?: readonly string[];
}

/** A contiguous run of source pages removed by a structural operation. */
export interface IPageIdentityRangeDelete {
    readonly kind: 'delete';
    /** One-based source page at the start of the removed run. */
    readonly fromPageNumber: number;
    readonly count: number;
}

/** A contiguous run whose bytes changed but whose page identities did not. */
export interface IPageIdentityRangeTouch {
    readonly kind: 'touch';
    /** One-based destination page at the start of the touched run. */
    readonly toPageNumber: number;
    readonly count: number;
    readonly reason: 'rotate' | 'crop' | 'remove-crop';
}

export type TPageIdentityRangeOperation =
    | IPageIdentityRangeMapping
    | IPageIdentityRangeInsert
    | IPageIdentityRangeDelete
    | IPageIdentityRangeTouch;

export type TPageIdentityDeltaPage = {readonly fromPageNumber: number} | {readonly insertedId: string};

export interface IPageIdentityDelta {
    readonly previousPageCount: number;
    /**
     * The v1 full permutation. New large-document deltas omit this field and
     * use ranges instead. Keeping it optional lets the IPC contract carry a
     * million-page operation without allocating a million objects.
     */
    readonly pages?: readonly TPageIdentityDeltaPage[];
    /** Number of pages after the operation, required when pages is omitted. */
    readonly nextPageCount?: number;
    /** Sparse range mappings and structural edits for large documents. */
    readonly ranges?: readonly TPageIdentityRangeOperation[];
}

/** Returns the page count published by either the v1 or sparse delta form. */
export function getPageIdentityDeltaNextPageCount(delta: IPageIdentityDelta) {
    return delta.nextPageCount ?? delta.pages?.length;
}

/**
 * Maps one-based source page numbers through a page-tree delta. Inserted and
 * deleted pages have no source page and therefore return null. Range deltas
 * intentionally list every surviving range, including unchanged ranges.
 */
export function mapPageNumberThroughPageIdentityDelta(
    delta: IPageIdentityDelta,
    pageNumber: TPageNumber,
) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        return null;
    }
    if (delta.pages !== undefined) {
        const nextPageIndex = delta.pages.findIndex(page => (
            'fromPageNumber' in page && page.fromPageNumber === pageNumber
        ));
        return nextPageIndex < 0 ? null : requirePageNumber(nextPageIndex + 1);
    }
    for (const range of delta.ranges ?? []) {
        if (
            (range.kind === 'retain' || range.kind === 'move')
            && pageNumber >= range.fromPageNumber
            && pageNumber < range.fromPageNumber + range.count
        ) {
            return requirePageNumber(range.toPageNumber + pageNumber - range.fromPageNumber);
        }
    }
    return null;
}

export interface IPageOpsResult {
    readonly success: boolean;
    /** The user canceled the operation and the document is unchanged. */
    readonly canceled?: boolean;
    readonly pageCount?: number;
    readonly documentRevision?: IDocumentRevisionInfo;
    readonly pageIdentityDelta?: IPageIdentityDelta;
}

export interface IPageOpsCancelActiveResult {
    /** Operations that stop and leave the document unchanged. */
    readonly canceled: number;
    /** Operations already writing their result; they finish normally. */
    readonly committing: number;
}

export interface IPageOpsExtractResult {
    readonly success: boolean;
    readonly canceled?: boolean;
    readonly destPath?: TDocumentRef;
}

export interface IPageOpsInsertResult {
    readonly success: boolean;
    readonly canceled?: boolean;
    readonly documentRevision?: IDocumentRevisionInfo;
    readonly pageIdentityDelta?: IPageIdentityDelta;
}
