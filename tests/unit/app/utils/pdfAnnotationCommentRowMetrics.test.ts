import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    ANNOTATION_COMMENT_ROW_GAP_REM,
    ANNOTATION_COMMENT_ROW_HEIGHT_REM,
    ANNOTATION_COMMENT_REPLY_BLOCK_REM,
    ANNOTATION_COMMENT_REPLY_CHARS_PER_LINE,
    ANNOTATION_COMMENT_REPLY_TEXT_LINE_HEIGHT_REM,
    ANNOTATION_COMMENT_ROW_STRIDE_REM,
    resolveAnnotationCommentRowMetrics,
} from '@app/utils/pdfAnnotationCommentRowMetrics';
import { BASE_ROOT_FONT_SIZE_PX } from '@app/utils/rootFontSize';

// The four first-class UI-scale presets (`useUiScale.ts`) plus the extremes of
// the Windows auto-compensation band, which clamps to [0.85, 1].
const UI_SCALE_MATRIX = [
    0.85,
    0.9,
    0.95,
    1,
    1.1,
    1.25,
];

function rootFontSizeFor(scale: number) {
    return BASE_ROOT_FONT_SIZE_PX * scale;
}

describe('annotation comment row metrics', () => {
    it('keeps the rem geometry additive', () => {
        expect(ANNOTATION_COMMENT_ROW_STRIDE_REM)
            .toBe(ANNOTATION_COMMENT_ROW_HEIGHT_REM + ANNOTATION_COMMENT_ROW_GAP_REM);
    });

    it.each(UI_SCALE_MATRIX)('makes the row box and the stride agree at scale %s', (scale) => {
        const metrics = resolveAnnotationCommentRowMetrics(rootFontSizeFor(scale));

        // The virtual stride is what the list scrolls by; the row box is what the
        // user sees. Any difference is exactly the overlap or gap of issue #99.
        expect(metrics.rowHeightPx + metrics.rowGapPx).toBe(metrics.rowStridePx);
    });

    it.each(UI_SCALE_MATRIX)('resolves whole pixels at scale %s', (scale) => {
        const metrics = resolveAnnotationCommentRowMetrics(rootFontSizeFor(scale));

        // Chromium snaps layout to 1/64 px. Whole-pixel metrics keep the rendered
        // stride byte-identical to the virtual stride instead of drifting by a
        // fraction of a pixel per row.
        expect(Number.isInteger(metrics.rowHeightPx)).toBe(true);
        expect(Number.isInteger(metrics.rowGapPx)).toBe(true);
        expect(Number.isInteger(metrics.rowStridePx)).toBe(true);
    });

    it.each(UI_SCALE_MATRIX)('tracks the scaled rem stride at scale %s', (scale) => {
        const rootFontSizePx = rootFontSizeFor(scale);
        const metrics = resolveAnnotationCommentRowMetrics(rootFontSizePx);

        expect(metrics.rowStridePx)
            .toBeCloseTo(ANNOTATION_COMMENT_ROW_STRIDE_REM * rootFontSizePx, 0);
        expect(metrics.rowGapPx)
            .toBeCloseTo(ANNOTATION_COMMENT_ROW_GAP_REM * rootFontSizePx, 0);
    });

    it('reproduces the historical default-scale stride', () => {
        // 112 px was the hardcoded stride before #99; at scale 1 the derived
        // metrics must land on exactly that value, so default-scale users see no
        // layout change from this fix.
        expect(resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX).rowStridePx).toBe(112);
    });

    it('reserves a full reply block in the virtual row stride', () => {
        const base = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX);
        const withReply = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX, [{contents: 'reply'}]);

        expect(withReply.rowStridePx - base.rowStridePx)
            .toBe(Math.round(ANNOTATION_COMMENT_REPLY_BLOCK_REM * BASE_ROOT_FONT_SIZE_PX));
        expect(withReply.rowHeightPx + withReply.rowGapPx).toBe(withReply.rowStridePx);
    });

    it('reserves additional lines for wrapped and multiline replies', () => {
        const oneLine = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX, [{contents: 'reply'}]);
        const longReply = 'x'.repeat(ANNOTATION_COMMENT_REPLY_CHARS_PER_LINE + 1);
        const wrapped = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX, [{contents: longReply}]);
        const multiline = resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX, [{contents: 'first\nsecond'}]);
        const extraLinePx = Math.round(ANNOTATION_COMMENT_REPLY_TEXT_LINE_HEIGHT_REM * BASE_ROOT_FONT_SIZE_PX);

        expect(wrapped.rowStridePx).toBe(oneLine.rowStridePx + extraLinePx);
        expect(multiline.rowStridePx).toBe(oneLine.rowStridePx + extraLinePx);
        expect(wrapped.rowHeightPx + wrapped.rowGapPx).toBe(wrapped.rowStridePx);
    });

    it('diverges from the historical stride at every non-default preset', () => {
        const strides = [
            0.9,
            1.1,
            1.25,
        ].map(scale => resolveAnnotationCommentRowMetrics(rootFontSizeFor(scale)).rowStridePx);

        expect(strides).toStrictEqual([
            101,
            123,
            140,
        ]);
    });

    it('grows monotonically with the root font size', () => {
        const strides = UI_SCALE_MATRIX
            .map(scale => resolveAnnotationCommentRowMetrics(rootFontSizeFor(scale)).rowStridePx);

        expect(strides).toStrictEqual([...strides].sort((left, right) => left - right));
    });

    it.each([
        Number.NaN,
        0,
        -12,
        Number.POSITIVE_INFINITY,
    ])('falls back to the base root font size for %s', (rootFontSizePx) => {
        expect(resolveAnnotationCommentRowMetrics(rootFontSizePx))
            .toStrictEqual(resolveAnnotationCommentRowMetrics(BASE_ROOT_FONT_SIZE_PX));
    });

    it('keeps a usable row box at absurdly small root font sizes', () => {
        const metrics = resolveAnnotationCommentRowMetrics(0.05);

        expect(metrics.rowHeightPx).toBeGreaterThan(0);
        expect(metrics.rowGapPx).toBeGreaterThan(0);
        expect(metrics.rowHeightPx + metrics.rowGapPx).toBe(metrics.rowStridePx);
    });
});
