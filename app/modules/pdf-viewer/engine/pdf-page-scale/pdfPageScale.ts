export const PDF_PAGE_SCALE_CSS_VARS = Object.freeze({
    scaleFactor: '--scale-factor',
    userUnit: '--user-unit',
    totalScaleFactor: '--total-scale-factor',
});

export interface IPdfPageScale {
    scaleFactor: number;
    userUnit: number;
    totalScaleFactor: number;
}

function normalizePositiveScale(value: number | null | undefined) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

function normalizeFiniteCssNumber(value: number) {
    if (!Number.isFinite(value)) {
        throw new TypeError('PDF CSS length must be finite');
    }
    return Object.is(value, -0) ? 0 : value;
}

export function createPdfPageScale(scaleFactor: number | null | undefined, userUnit: number | null | undefined): IPdfPageScale {
    const normalizedScaleFactor = normalizePositiveScale(scaleFactor);
    const normalizedUserUnit = normalizePositiveScale(userUnit);
    return {
        scaleFactor: normalizedScaleFactor,
        userUnit: normalizedUserUnit,
        totalScaleFactor: normalizedScaleFactor * normalizedUserUnit,
    };
}

export function buildPdfPageScaleStyle(scale: IPdfPageScale): Record<string, string> {
    return {
        [PDF_PAGE_SCALE_CSS_VARS.scaleFactor]: String(scale.scaleFactor),
        [PDF_PAGE_SCALE_CSS_VARS.userUnit]: String(scale.userUnit),
        [PDF_PAGE_SCALE_CSS_VARS.totalScaleFactor]: `calc(var(${PDF_PAGE_SCALE_CSS_VARS.scaleFactor}, 1) * var(${PDF_PAGE_SCALE_CSS_VARS.userUnit}, 1))`,
    };
}

export function toPdfScaledCssLength(pdfUnits: number, additionalCssPixels = 0) {
    const normalizedPdfUnits = normalizeFiniteCssNumber(pdfUnits);
    const normalizedAdditionalPixels = normalizeFiniteCssNumber(additionalCssPixels);
    const scaledLength = `var(${PDF_PAGE_SCALE_CSS_VARS.totalScaleFactor}, 1) * ${String(normalizedPdfUnits)}px`;
    return normalizedAdditionalPixels === 0 ? `calc(${scaledLength})` : `calc(${scaledLength} + ${String(normalizedAdditionalPixels)}px)`;
}
