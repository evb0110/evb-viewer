import { clamp } from 'es-toolkit/math';
import { normalizeRootFontSizePx } from '@app/utils/rootFontSize';

/**
 * Annotation comment rows are virtualized, so the stride the virtual list
 * scrolls by and the box the row actually paints must be the same number. The
 * rem geometry below is the single declaration of that row; both the
 * `useVirtualList` item height and the rendered row box are resolved from it
 * here, against the effective root font size, so a UI-scale change cannot move
 * one without the other.
 */
export const ANNOTATION_COMMENT_ROW_HEIGHT_REM = 6.5;
export const ANNOTATION_COMMENT_ROW_GAP_REM = 0.5;
export const ANNOTATION_COMMENT_REPLY_BLOCK_REM = 2.75;
export const ANNOTATION_COMMENT_REPLY_TEXT_LINE_HEIGHT_REM = 1.25;
export const ANNOTATION_COMMENT_REPLY_CHARS_PER_LINE = 42;
export const ANNOTATION_COMMENT_ROW_STRIDE_REM
    = ANNOTATION_COMMENT_ROW_HEIGHT_REM + ANNOTATION_COMMENT_ROW_GAP_REM;

const MIN_ROW_HEIGHT_PX = 1;
const MIN_ROW_GAP_PX = 1;
const MIN_ROW_STRIDE_PX = MIN_ROW_HEIGHT_PX + MIN_ROW_GAP_PX;

export interface IAnnotationCommentRowMetrics {
    rowGapPx: number;
    rowHeightPx: number;
    rowStridePx: number;
}

function replyTextLineCount(contents: string) {
    return contents.split(/\r?\n/u).reduce((lineCount, line) => (
        lineCount + Math.max(1, Math.ceil(Array.from(line).length / ANNOTATION_COMMENT_REPLY_CHARS_PER_LINE))
    ), 0);
}

export function resolveAnnotationCommentRowMetrics(
    rootFontSizePx: number,
    replies: ReadonlyArray<{contents: string}> = [],
): IAnnotationCommentRowMetrics {
    const remPx = normalizeRootFontSizePx(rootFontSizePx);
    const replyHeightPx = Math.round(ANNOTATION_COMMENT_REPLY_BLOCK_REM * remPx);
    const replyTextLineHeightPx = Math.round(ANNOTATION_COMMENT_REPLY_TEXT_LINE_HEIGHT_REM * remPx);
    const replyExtraTextHeightPx = replies.reduce((height, reply) => (
        height + Math.max(0, replyTextLineCount(reply.contents) - 1) * replyTextLineHeightPx
    ), 0);
    // Whole pixels only: Chromium snaps layout to 1/64 px, so a fractional
    // stride would let the painted rows creep away from the virtual offsets.
    const rowStridePx = Math.max(
        MIN_ROW_STRIDE_PX,
        Math.round((ANNOTATION_COMMENT_ROW_STRIDE_REM * remPx)
            + replies.length * replyHeightPx
            + replyExtraTextHeightPx),
    );
    const rowGapPx = clamp(
        Math.round(ANNOTATION_COMMENT_ROW_GAP_REM * remPx),
        MIN_ROW_GAP_PX,
        rowStridePx - MIN_ROW_HEIGHT_PX,
    );

    return {
        rowGapPx,
        rowHeightPx: rowStridePx - rowGapPx,
        rowStridePx,
    };
}
