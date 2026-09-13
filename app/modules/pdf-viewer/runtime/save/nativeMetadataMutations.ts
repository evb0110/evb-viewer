import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import { normalizePageLabelRanges } from '@app/modules/document-viewer/public';

export function buildNativePageLabelsMutationForSave(opts: {
    pageLabelsDirty: boolean;
    totalPageCount: number;
    pageLabelRanges: IPdfPageLabelRange[] | null;
}) {
    if (!opts.pageLabelsDirty) {
        return null;
    }
    if (!opts.pageLabelRanges || opts.totalPageCount <= 0) {
        return null;
    }
    return {
        totalPages: opts.totalPageCount,
        ranges: normalizePageLabelRanges(opts.pageLabelRanges, opts.totalPageCount),
    };
}

export function buildNativeBookmarksMutationForSave(opts: {
    bookmarksDirty: boolean;
    totalPageCount: number;
    bookmarkItems: IPdfBookmarkEntry[] | null;
    untitledBookmarkLabel: string;
}) {
    if (!opts.bookmarksDirty) {
        return null;
    }
    if (!opts.bookmarkItems || opts.totalPageCount <= 0) {
        return null;
    }
    return {
        totalPages: opts.totalPageCount,
        untitledLabel: opts.untitledBookmarkLabel,
        items: opts.bookmarkItems,
    };
}
