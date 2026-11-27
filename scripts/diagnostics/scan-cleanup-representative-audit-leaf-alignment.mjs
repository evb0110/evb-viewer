const DEFAULT_TOLERANCE_MM = 3;
const DEFAULT_SCALE_TOLERANCE = 0.02;
const DEFAULT_ABSOLUTE_POSITION_TOLERANCE_FRACTION = 0.15;
const CONTENT_BELOW_PAPER = 245;
const SCALE_CONTENT_BELOW_PAPER = 64;
const MINIMUM_ROW_PIXELS = 3;
const SCALE_MINIMUM_ROW_PIXELS = 3;

function round(value) {
    return Math.round(value * 10_000) / 10_000;
}

export function contentBboxHeightFraction(grid, horizontalMargin = 0) {
    let minRow = -1;
    let maxRow = -1;
    const margin = Math.min(horizontalMargin, Math.floor(grid.cols / 2));
    for (let row = 0; row < grid.rows; row += 1) {
        const rowOffset = row * grid.cols;
        const rowHasInk = grid.dark.subarray(rowOffset + margin, rowOffset + grid.cols - margin).some((cell) => cell === 1);
        if (rowHasInk) {
            minRow = minRow === -1 ? row : minRow;
            maxRow = row;
        }
    }
    return minRow === -1 ? 0 : (maxRow - minRow + 1) / grid.rows;
}

export function buildExpectationInfos({expectSingles, inferredLayouts}) {
    const mismatches = inferredLayouts.flatMap((layout, index) => {
        const sourcePage = index + 1;
        const expectedLayout = expectSingles.has(sourcePage) ? 'single' : 'spread';
        return layout === expectedLayout
            ? []
            : [
                  {
                      actual: layout,
                      expected: expectedLayout,
                      sourcePage,
                  },
              ];
    });
    if (mismatches.length === 0) {
        return [];
    }
    return [
        {
            code: 'expectation-mismatch',
            details: mismatches,
            message:
                'Rendered output/source evidence inferred a different layout than the legacy manifest hint; this is INFO only and does not count as a violation.',
        },
    ];
}

function contentVerticalBounds(bitmap, threshold = CONTENT_BELOW_PAPER, minimumPixels = MINIMUM_ROW_PIXELS) {
    // Keep the oracle's vertical anchor in the same pixel space as the native
    // matched-canvas planner. A dark-ink grid misses pale photo skies and can
    // report different tops for otherwise aligned leaves. The row guard
    // rejects isolated dust while retaining genuine low-contrast content.
    let top = null;
    let bottom = null;
    for (let y = 0; y < bitmap.height; y += 1) {
        let contentPixels = 0;
        const rowOffset = y * bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            if (bitmap.data[rowOffset + x] < threshold) {
                contentPixels += 1;
                if (contentPixels >= minimumPixels) {
                    top ??= y;
                    bottom = y + 1;
                    break;
                }
            }
        }
    }
    return top === null
        ? null
        : {
              bottom,
              span: bottom - top,
              top,
          };
}

function contentTopPixels(bitmap) {
    return contentVerticalBounds(bitmap)?.top ?? null;
}

export function measureSpreadLeafVerticalAlignment({
    absolutePositionToleranceFraction = DEFAULT_ABSOLUTE_POSITION_TOLERANCE_FRACTION,
    cleanedLeft,
    cleanedRight,
    dpi,
    sourceLeft,
    sourceRight,
    toleranceMm = DEFAULT_TOLERANCE_MM,
}) {
    const sourceLeftTop = contentTopPixels(sourceLeft);
    const sourceRightTop = contentTopPixels(sourceRight);
    const cleanedLeftTop = cleanedLeft ? contentTopPixels(cleanedLeft) : null;
    const cleanedRightTop = cleanedRight ? contentTopPixels(cleanedRight) : null;
    /** @type {any} */
    const result = {
        cleaned: {
            leftTopPx: cleanedLeftTop === null ? null : round(cleanedLeftTop),
            rightTopPx: cleanedRightTop === null ? null : round(cleanedRightTop),
        },
        dpi,
        absolutePosition: {
            shiftFraction: null,
            shiftPx: null,
            toleranceFraction: absolutePositionToleranceFraction,
            tolerancePx: null,
        },
        source: {
            leftTopPx: sourceLeftTop === null ? null : round(sourceLeftTop),
            rightTopPx: sourceRightTop === null ? null : round(sourceRightTop),
        },
        status: 'unmeasured',
        toleranceMm,
        violations: [],
    };
    if (sourceLeftTop === null || sourceRightTop === null || cleanedLeftTop === null || cleanedRightTop === null) {
        result.reason = 'content-top-not-measurable';
        return result;
    }

    const sourceDeltaPx = sourceRightTop - sourceLeftTop;
    const outputDeltaPx = cleanedRightTop - cleanedLeftTop;
    const tolerancePx = (dpi * toleranceMm) / 25.4;
    const deltaDifferencePx = outputDeltaPx - sourceDeltaPx;
    // Retain the existing allowance for cleanup to reduce a source skew, but
    // compare signed deltas whenever both directions are material. Without
    // this branch a complete reversal (+100 px to -100 px) looks unchanged.
    const directionReversed =
        sourceDeltaPx * outputDeltaPx < 0 && Math.abs(sourceDeltaPx) > tolerancePx && Math.abs(outputDeltaPx) > tolerancePx;
    const deltaExcessPx = directionReversed ? Math.abs(deltaDifferencePx) : Math.max(0, Math.abs(outputDeltaPx) - Math.abs(sourceDeltaPx));
    const sourcePairTopFraction = (sourceLeftTop / sourceLeft.height + sourceRightTop / sourceRight.height) / 2;
    const cleanedPairTopFraction = (cleanedLeftTop / cleanedLeft.height + cleanedRightTop / cleanedRight.height) / 2;
    const cleanedPairHeight = (cleanedLeft.height + cleanedRight.height) / 2;
    const absoluteShiftFraction = cleanedPairTopFraction - sourcePairTopFraction;
    const absoluteShiftPx = absoluteShiftFraction * cleanedPairHeight;
    const absolutePositionTolerancePx = absolutePositionToleranceFraction * cleanedPairHeight;
    result.source.deltaPx = round(sourceDeltaPx);
    result.source.deltaMm = round((sourceDeltaPx * 25.4) / dpi);
    result.cleaned.deltaPx = round(outputDeltaPx);
    result.cleaned.deltaMm = round((outputDeltaPx * 25.4) / dpi);
    result.deltaDifferencePx = round(deltaDifferencePx);
    result.deltaDifferenceMm = round((deltaDifferencePx * 25.4) / dpi);
    result.deltaExcessPx = round(deltaExcessPx);
    result.deltaExcessMm = round((deltaExcessPx * 25.4) / dpi);
    result.directionReversed = directionReversed;
    result.tolerancePx = round(tolerancePx);
    result.absolutePosition = {
        cleanedPairTopFraction: round(cleanedPairTopFraction),
        expectedPairTopFraction: round(sourcePairTopFraction),
        shiftFraction: round(absoluteShiftFraction),
        shiftPx: round(absoluteShiftPx),
        toleranceFraction: absolutePositionToleranceFraction,
        tolerancePx: round(absolutePositionTolerancePx),
    };
    const relativeMisalignment = deltaExcessPx > tolerancePx;
    const grossAbsoluteTranslation = Math.abs(absoluteShiftFraction) > absolutePositionToleranceFraction;
    result.status = relativeMisalignment || grossAbsoluteTranslation ? 'violation' : 'pass';
    if (result.status === 'violation') {
        result.violations.push('leaf-misalignment');
    }
    return result;
}

export function measureSpreadLeafScale({cleanedLeft, cleanedRight, sourceLeft, sourceRight, tolerance = DEFAULT_SCALE_TOLERANCE}) {
    const sourceLeftBounds = contentVerticalBounds(sourceLeft, SCALE_CONTENT_BELOW_PAPER, SCALE_MINIMUM_ROW_PIXELS);
    const sourceRightBounds = contentVerticalBounds(sourceRight, SCALE_CONTENT_BELOW_PAPER, SCALE_MINIMUM_ROW_PIXELS);
    const cleanedLeftBounds = cleanedLeft ? contentVerticalBounds(cleanedLeft, SCALE_CONTENT_BELOW_PAPER, SCALE_MINIMUM_ROW_PIXELS) : null;
    const cleanedRightBounds = cleanedRight
        ? contentVerticalBounds(cleanedRight, SCALE_CONTENT_BELOW_PAPER, SCALE_MINIMUM_ROW_PIXELS)
        : null;
    const result = {
        cleaned: {
            leftSpanPx: cleanedLeftBounds?.span ?? null,
            rightSpanPx: cleanedRightBounds?.span ?? null,
        },
        scales: {
            left: null,
            right: null,
        },
        source: {
            leftSpanPx: sourceLeftBounds?.span ?? null,
            rightSpanPx: sourceRightBounds?.span ?? null,
        },
        status: 'unmeasured',
        reason: null,
        scaleDifferenceRatio: null,
        sourceSpanDifferenceRatio: null,
        tolerance,
        violations: [],
    };
    if (sourceLeftBounds === null || sourceRightBounds === null || cleanedLeftBounds === null || cleanedRightBounds === null) {
        result.reason = 'content-span-not-measurable';
        return result;
    }

    const sourceSpanDifferenceRatio =
        Math.abs(sourceLeftBounds.span - sourceRightBounds.span) / Math.max(sourceLeftBounds.span, sourceRightBounds.span);
    result.sourceSpanDifferenceRatio = round(sourceSpanDifferenceRatio);
    // A single bounding span is not a reliable scale marker when the two
    // source leaves contain materially different vertical extents. Keep that
    // pair visible as unmeasured instead of mistaking genuine page-layout
    // differences for a raster-scale defect.
    if (sourceSpanDifferenceRatio > tolerance) {
        result.reason = 'source-content-spans-not-comparable';
        return result;
    }

    const leftScale = cleanedLeftBounds.span / sourceLeftBounds.span;
    const rightScale = cleanedRightBounds.span / sourceRightBounds.span;
    const scaleDifferenceRatio = Math.abs(leftScale - rightScale) / Math.max(leftScale, rightScale);
    result.scales.left = round(leftScale);
    result.scales.right = round(rightScale);
    result.scaleDifferenceRatio = round(scaleDifferenceRatio);
    result.status = scaleDifferenceRatio > tolerance ? 'violation' : 'pass';
    if (result.status === 'violation') {
        result.violations.push('leaf-scale-mismatch');
    }
    return result;
}

function mapSpreadLeafPairs({entries, sourcePages, splitHalves}, mapPair) {
    const pairs = [];
    for (let index = 0; index < entries.length; index += 2) {
        const leftEntry = entries[index];
        const rightEntry = entries[index + 1];
        if (
            !leftEntry ||
            !rightEntry ||
            leftEntry.side !== 'left' ||
            rightEntry.side !== 'right' ||
            leftEntry.sourceLayout !== 'spread' ||
            rightEntry.sourceLayout !== 'spread' ||
            leftEntry.sourcePage !== rightEntry.sourcePage
        ) {
            continue;
        }
        pairs.push(
            mapPair({
                leftEntry,
                rightEntry,
                sourceHalves: splitHalves(sourcePages.get(leftEntry.sourcePage)),
            }),
        );
    }
    return pairs;
}

export function buildSpreadLeafAlignment({cleanedPages, dpi, entries, sourcePages, splitHalves}) {
    return mapSpreadLeafPairs(
        {
            entries,
            sourcePages,
            splitHalves,
        },
        ({leftEntry, rightEntry, sourceHalves}) => {
            const measurement = measureSpreadLeafVerticalAlignment({
                cleanedLeft: cleanedPages.get(leftEntry.cleanedPage) ?? null,
                cleanedRight: cleanedPages.get(rightEntry.cleanedPage) ?? null,
                dpi,
                sourceLeft: sourceHalves.left,
                sourceRight: sourceHalves.right,
            });
            return {
                leftCleanedPage: leftEntry.cleanedPage,
                rightCleanedPage: rightEntry.cleanedPage,
                sourcePage: leftEntry.sourcePage,
                ...measurement,
            };
        },
    );
}

export function buildSpreadLeafScale({cleanedPages, entries, sourcePages, splitHalves}) {
    return mapSpreadLeafPairs(
        {
            entries,
            sourcePages,
            splitHalves,
        },
        ({leftEntry, rightEntry, sourceHalves}) => {
            const measurement = measureSpreadLeafScale({
                cleanedLeft: cleanedPages.get(leftEntry.cleanedPage) ?? null,
                cleanedRight: cleanedPages.get(rightEntry.cleanedPage) ?? null,
                sourceLeft: sourceHalves.left,
                sourceRight: sourceHalves.right,
            });
            return {
                leftCleanedPage: leftEntry.cleanedPage,
                rightCleanedPage: rightEntry.cleanedPage,
                sourcePage: leftEntry.sourcePage,
                ...measurement,
            };
        },
    );
}
