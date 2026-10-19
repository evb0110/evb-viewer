const OCR_DEFAULT_RENDER_DPI = 300;
const OCR_MIN_RENDER_DPI = 72;
const OCR_MAX_RENDER_DPI = 1200;

/**
 * The resolution an OCR job renders at: the document's source resolution
 * (its finest page image) or the one the caller asked for, else 300 DPI,
 * kept within 72 to 1200.
 */
export function resolveOcrExtractionDpi(dpi: number | null | undefined) {
    if (dpi === null || dpi === undefined || !Number.isFinite(dpi)) return OCR_DEFAULT_RENDER_DPI;
    return Math.min(Math.max(Math.round(dpi), OCR_MIN_RENDER_DPI), OCR_MAX_RENDER_DPI);
}

/** A page renders no finer than its own image, so recognition never reads an upscaled scan. */
export function resolveOcrPageDpi(extractionDpi: number, pageSourceDpi: number | undefined) {
    return Math.min(extractionDpi, pageSourceDpi ?? extractionDpi);
}
