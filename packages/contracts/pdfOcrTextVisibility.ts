import * as v from 'valibot';

export const PDF_OCR_TEXT_VISIBILITY_FORMAT = 'evb-pdf-ocr-text-visibility';
export const PDF_OCR_TEXT_VISIBILITY_SCHEMA_VERSION = 2;

/**
 * One page of `evb-pdf-page-ops ocr-text-visibility` stdout: the existing text
 * the OCR writer would find on the page, read with the scan it replaces text
 * through. `hiddenText` is hidden text the writer removes; `uncertain` names
 * text the inspection could not read or the writer keeps; `unsupported` names
 * why the writer refuses to replace the page. `evbOcrText` is the EVB layer's
 * text in recognition order, one line per line, when the caller asked for it.
 */
const PDF_OCR_PAGE_TEXT_VISIBILITY_SCHEMA = v.strictObject({
    pageNumber: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    evbOcrLayer: v.boolean(),
    paintedText: v.boolean(),
    hiddenText: v.boolean(),
    uncertain: v.nullable(v.string()),
    unsupported: v.nullable(v.string()),
    evbOcrText: v.nullable(v.string()),
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
