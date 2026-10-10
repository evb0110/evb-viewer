import * as v from 'valibot';

export const PDF_OCR_TEXT_VISIBILITY_FORMAT = 'evb-pdf-ocr-text-visibility';
export const PDF_OCR_TEXT_VISIBILITY_SCHEMA_VERSION = 3;
export const PDF_OCR_TEXT_VISIBILITY_REPORT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * One line of an EVB OCR layer in the layer's text space, y up: its text
 * block, the origins of its first and last glyphs, its baseline and font size.
 */
const PDF_OCR_LAYER_LINE_SCHEMA = v.strictObject({
    block: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    text: v.string(),
    left: v.pipe(v.number(), v.finite()),
    right: v.pipe(v.number(), v.finite()),
    baseline: v.pipe(v.number(), v.finite()),
    size: v.pipe(v.number(), v.finite()),
});

export type IPdfOcrLayerLine = v.InferOutput<typeof PDF_OCR_LAYER_LINE_SCHEMA>;

/**
 * One page of `evb-pdf-page-ops ocr-text-visibility` stdout: the existing text
 * the OCR writer would find on the page, read with the scan it replaces text
 * through. `hiddenText` is hidden text the writer removes; `uncertain` names
 * text the inspection could not read or the writer keeps; `unsupported` names
 * why the writer refuses to replace the page. `evbOcrLines` are the EVB
 * layer's lines in recognition order, when the caller asked for them.
 */
const PDF_OCR_PAGE_TEXT_VISIBILITY_SCHEMA = v.strictObject({
    pageNumber: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    evbOcrLayer: v.boolean(),
    paintedText: v.boolean(),
    hiddenText: v.boolean(),
    uncertain: v.nullable(v.string()),
    unsupported: v.nullable(v.string()),
    evbOcrLines: v.nullable(v.array(PDF_OCR_LAYER_LINE_SCHEMA)),
});

const PDF_OCR_TEXT_VISIBILITY_REPORT_SCHEMA = v.strictObject({
    format: v.literal(PDF_OCR_TEXT_VISIBILITY_FORMAT),
    schemaVersion: v.literal(PDF_OCR_TEXT_VISIBILITY_SCHEMA_VERSION),
    pages: v.array(PDF_OCR_PAGE_TEXT_VISIBILITY_SCHEMA),
});

export type IPdfOcrPageTextVisibility = v.InferOutput<typeof PDF_OCR_PAGE_TEXT_VISIBILITY_SCHEMA>;

export function decodePdfOcrTextVisibilityReport(value: unknown) {
    return v.parse(PDF_OCR_TEXT_VISIBILITY_REPORT_SCHEMA, value);
}
