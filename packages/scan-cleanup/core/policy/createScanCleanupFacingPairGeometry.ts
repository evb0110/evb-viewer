import type {IPdfPageSize} from '@evb/scan-cleanup/core/types';

/*
 * A PDF exported as spreads lays two facing pages side by side on one page and
 * usually keeps a lone first or last page at single-page size. A page exactly
 * as wide as two of the document's own pages and as tall as one is therefore a
 * declared facing pair. Born-digital spreads show no fold or shadow, so this
 * geometry is the only evidence of the seam their pixels cannot give; the
 * engine still confirms that no ink crosses the middle before it cuts there.
 */

/** Distinct page sizes kept: far beyond any book, bounded for any document. */
const MAX_DISTINCT_SIZES = 4_096;

export interface IScanCleanupFacingPairGeometry {
    /** Records one page as it renders: its effective box after page rotation. */
    add(page: IPdfPageSize): void;
    /** Whether the document holds a page that is exactly this page's left or right half. */
    isFacingPair(page: IPdfPageSize): boolean;
}

/** A page's rendered size in whole points: exported page boxes agree to a fraction of one. */
function displayedSize(page: IPdfPageSize) {
    const unit = page.userUnit ?? 1;
    const quarterTurn = Math.abs(Math.round(page.rotation / 90)) % 2 === 1;
    const width = (quarterTurn ? page.heightPoints : page.widthPoints) * unit;
    const height = (quarterTurn ? page.widthPoints : page.heightPoints) * unit;
    return [
        width,
        height,
    ] as const;
}

function sizeKey(width: number, height: number) {
    return `${String(Math.round(width))}x${String(Math.round(height))}`;
}

export function createScanCleanupFacingPairGeometry(): IScanCleanupFacingPairGeometry {
    const sizes = new Set<string>();
    return {
        add(page) {
            const [
                width,
                height,
            ] = displayedSize(page);
            if (sizes.size < MAX_DISTINCT_SIZES && width > 0 && height > 0) sizes.add(sizeKey(width, height));
        },
        isFacingPair(page) {
            const [
                width,
                height,
            ] = displayedSize(page);
            if (!(width > height)) return false;
            // A neighbouring point absorbs rounding on either side of a whole point.
            const steps = [
                -1,
                0,
                1,
            ];
            return steps.some(widthStep => steps.some(heightStep => (
                sizes.has(sizeKey(width / 2 + widthStep, height + heightStep))
            )));
        },
    };
}
