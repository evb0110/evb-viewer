import {assertNever} from '@contracts/assertNever';
import type {TScanCleanupWarningEvent} from '@contracts/scan-cleanup/nativeProtocolV3';

const REPORTED_PAGE_NUMBER_LIMIT = 20;

export function describePageNumbers(pageNumbers: readonly number[]) {
    return pageNumbers.length <= REPORTED_PAGE_NUMBER_LIMIT
        ? pageNumbers.join(', ')
        : `${pageNumbers.slice(0, REPORTED_PAGE_NUMBER_LIMIT).join(', ')} and ${String(pageNumbers.length - REPORTED_PAGE_NUMBER_LIMIT)} more`;
}

// Canvas pixels are whole by construction; PDF points are the physical decimals
// the lossless path measures in, and both paths have always reported them this
// way.
const extent = (value: number, unit: 'px' | 'pt') => unit === 'px'
    ? String(value)
    : value.toFixed(1);

/**
 * Places the decimal point in a value its producer already quantized. Rounding
 * a raw float here would make the digits depend on the language doing the
 * rounding — Rust resolves an exact half to the even digit, JavaScript's
 * `toFixed` resolves it upward — so the transport carries fixed-point units and
 * this does nothing but split them.
 */
const fixedPoint = (units: number, decimals: number) => {
    const scale = 10 ** decimals;
    return `${String(Math.trunc(units / scale))}.${String(units % scale).padStart(decimals, '0')}`;
};

/**
 * The producer-side counterpart for a percentage the sentence shows with one
 * decimal. Deriving the digit from `toFixed` is what keeps a JavaScript
 * producer's wording byte-identical to the text it emitted before the
 * transport became structured.
 */
export function toScanCleanupPercentTenths(percent: number) {
    return Math.round(Number(percent.toFixed(1)) * 10);
}

/**
 * The same counterpart for a DPI the sentence shows with three decimals. A
 * planned render DPI is usually whole, but a source resolution measured from a
 * raster and its page rectangle is not, and handing that float to the formatter
 * would print JavaScript's full decimal expansion of it in a user-facing
 * sentence.
 */
export function toScanCleanupDpiThousandths(dpi: number) {
    return Math.round(Number(dpi.toFixed(3)) * 1_000);
}

/**
 * The one place a scan-cleanup warning condition becomes English. Every
 * producer — native, lossless, preview — reports the condition as an event, so
 * a wording change here cannot alter which conditions the run aggregates, and
 * aggregation cannot alter what the user reads.
 *
 * `pageNumber` reproduces the per-page prefix the raster and lossless summaries
 * have always carried; a document-wide condition passes none.
 */
export function formatScanCleanupWarningEvent(
    event: TScanCleanupWarningEvent,
    pageNumber?: number,
) {
    const prefix = pageNumber === undefined ? '' : `Page ${String(pageNumber)}: `;
    return prefix + describeScanCleanupWarningEvent(event);
}

function describeScanCleanupWarningEvent(event: TScanCleanupWarningEvent) {
    switch (event.code) {
        case 'matched-canvas-content-fitted': {
            const size = `${extent(event.contentWidth, event.unit)}x${extent(event.contentHeight, event.unit)} ${event.unit}`;
            const inner = `${extent(event.innerWidth, event.unit)}x${extent(event.innerHeight, event.unit)} ${event.unit}`;
            const canvas = event.documentCanvasWidth === undefined
                || event.documentCanvasHeight === undefined
                ? 'margin box'
                : `requested margin box on the ${extent(event.documentCanvasWidth, event.unit)}`
                    + `x${extent(event.documentCanvasHeight, event.unit)} ${event.unit} document canvas`;
            return `Matched page size fitted this page to ${size} inside the ${inner} ${canvas}, `
                + 'below the document\'s scale';
        }
        case 'matched-canvas-content-fitted-pages':
            return `Matched page size fitted ${String(event.pages.length)} page(s) inside their `
                + `requested margin boxes, below the document's scale: ${describePageNumbers(event.pages)}`;
        case 'matched-canvas-margins-reduced':
            return 'Matched page size reduced requested margins because they leave no drawable canvas';
        case 'matched-canvas-margins-unavailable':
            return 'Requested margins were not applied because content detection or cropping is unavailable';
        case 'matched-canvas-paper-downscaled': {
            const paper = event.paperWidth === undefined || event.paperHeight === undefined
                ? 'paper'
                : `${extent(event.paperWidth, event.unit)}x${extent(event.paperHeight, event.unit)} ${event.unit} paper`;
            return `Matched page size placed this page at ${fixedPoint(event.scalePercentTenths, 1)}% of the `
                + `document's scale because its ${paper} is larger than the `
                + `${extent(event.documentCanvasWidth, event.unit)}x${extent(event.documentCanvasHeight, event.unit)} `
                + `${event.unit} document canvas, which was measured from a different layout for this page`;
        }
        case 'matched-canvas-optical-centering-fallback':
            return 'Optical centering was requested but the optical bounds could not fit inside '
                + 'the canvas margins; raster alignment was retained';
        case 'matched-canvas-intrinsic-overflow':
            return `Matched page raster extends beyond the canvas by ${String(event.leftPx)} px on the left `
                + `and ${String(event.rightPx)} px on the right; optical content remains bounded`;
        case 'matched-canvas-spread-headroom-trimmed':
            return `Matched spread placement trimmed ${String(event.topPx)} px of source headroom `
                + 'above the shared content anchor';
        case 'matched-canvas-fold-columns-discarded':
            return `Matched spread discarded ${String(event.leftColumns)} provably-paper fold-side columns `
                + `on the left and ${String(event.rightColumns)} on the right (all samples met the `
                + 'leaf-specific paper bound) before overflow fitting';
        case 'matched-canvas-dropped':
            return 'Matched page size was dropped: this document carries no readable page geometry';
        case 'matched-canvas-geometry-unmeasured':
            return 'Matched page size is off for this document: its page geometry could not be measured '
                + `(${event.detail}). Pages are previewed and cleaned at their own size.`;
        case 'matched-canvas-pages-resampled':
            return `Matched page size re-rendered ${String(event.pages.length)} page(s) that do not share `
                + `the document's pixel grid: ${describePageNumbers(event.pages)}`;
        case 'matched-canvas-pages-scaled-in-place':
            return `Matched page size scaled ${String(event.pages.length)} page(s) that carry their own raster `
                + `without re-rendering them: ${describePageNumbers(event.pages)}`;
        case 'matched-canvas-document-dpi-normalized':
            return `Matched page size normalized this document at ${String(Math.round(event.canvasDpi))} DPI `
                + `instead of the ${String(Math.round(event.finestPageDpi))} DPI its finest page was rendered at, `
                + 'to keep one shared page inside the output pixel budget';
        case 'matched-canvas-page-dpi-capped':
            return `Matched page size capped page ${String(event.pageNumber)} at `
                + `${fixedPoint(event.appliedDpiThousandths, 3)} DPI from `
                + `${fixedPoint(event.requestedDpiThousandths, 3)} DPI to keep its uniform canvas `
                + 'inside cleanup guardrails';
        case 'render-dpi-limited':
            return `Requested render DPI ${fixedPoint(event.requestedDpiThousandths, 3)} was limited to `
                + `${fixedPoint(event.appliedDpiThousandths, 3)} by native raster safety limits`;
    }
    // A new event variant reaches the user as a sentence or not at all, so it
    // has to fail here at compile time rather than silently decode into a
    // warning nobody displays.
    return assertNever(event, 'Unhandled scan-cleanup warning event');
}

/**
 * Everything one native output has to say: its structured conditions, then the
 * unstructured diagnostics that carry no program logic.
 *
 * The string channel is permanent for those unstructured diagnostics. It is
 * also where an artifact written before scan-cleanup runtime revision 10 left
 * its *conditions*, as sentences — such an artifact decodes and displays
 * unchanged here and nowhere decides aggregation. That legacy case ends when no
 * pre-revision-10 artifact is read: those artifacts live only in a run's
 * scratch directory and in preserved JSON evidence, never in shipped state.
 */
export function describeScanCleanupNativeWarnings(
    metadata: {
        warnings?: readonly string[];
        warningEvents?: readonly TScanCleanupWarningEvent[]
    },
    pageNumber?: number,
) {
    const prefix = pageNumber === undefined ? '' : `Page ${String(pageNumber)}: `;
    return [
        ...(metadata.warningEvents ?? []).map(event => formatScanCleanupWarningEvent(event, pageNumber)),
        ...(metadata.warnings ?? []).map(warning => prefix + warning),
    ];
}
