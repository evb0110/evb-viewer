#!/usr/bin/env node
/*
 * Scan-cleanup preview raster oracle.
 *
 * Usage:
 *   node scripts/diagnostics/scan-cleanup-preview-harness.mjs \
 *     --source .devkit/tmp/source.pdf --pages 1,2,99 --out .devkit/tmp/preview-oracle
 *   node scripts/diagnostics/scan-cleanup-preview-harness.mjs \
 *     --source .devkit/tmp/source.pdf --pages 1,2,99 --out .devkit/tmp/preview-oracle --check
 *
 * By default the harness runs scripts/scan-cleanup-convert.ts for the selected
 * source sheets, renders that final PDF back to PREVIEW_DPI, and compares it
 * with native `renderMode: preview` / `canvasScope: page` outputs. Pass
 * --final-pdf and --detection-cache to reuse a previously generated reference.
 * --check exits nonzero when preview/final weight agreement differs by more
 * than 15% of the measured stroke width, any normalized ink margin differs by
 * more than 3 percentage points, or either provisional/settled content-box
 * overlay excludes more than 1% of ink (with no robust ink edge overrun above
 * 3%), or preview/final materialized placement differs. --preview-render-dpi
 * is a diagnostic-only override for isolating
 * resolution-sensitive native stages; omit it for the app-exact preview path.
 */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    mkdir,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    createCanvas,
    loadImage,
} from '@napi-rs/canvas';
import {tsImport} from 'tsx/esm/api';
import {createScanCleanupDiagnosticsManifestScope} from './scan-cleanup-diagnostics-manifest.mjs';
import {loadGrayscaleImage} from './load-grayscale-image.mjs';
import {
    composePreviewTransition,
    createForcedPostSettleMovementProbeLeaves,
    measurePreviewPresentationStability,
} from './scan-cleanup-preview-presentation.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsconfig = join(projectRoot, 'tsconfig.scripts.json');
const importTs = specifier => tsImport(specifier, {
    parentURL: import.meta.url,
    tsconfig,
});

const [
    {
        PREVIEW_DPI,
        resolvePreviewProcessingDpi,
        resolvePreviewRasterPlan,
    },
    {
        resolveScanCleanupDocumentCanvasDpi,
        resolveScanCleanupProvisionalDocumentCanvas,
    },
    {buildRunnableNativeScanCleanupManifest},
    {resolveReusablePagePlan},
    {createScanCleanupRenderers},
    {
        runCliNativeToolCommand,
        resolveCliNativeToolPath,
    },
    {detectSourceDpiDetails},
    {createScanCleanupDetectionCacheKey},
    {
        resolvePreviewMetadataPlacement,
        toPreviewStyleRect,
    },
    {
        measurePreviewContentBoxContainment,
        transformPreviewContentBox,
    },
    {
        commitScanCleanupPreviewPresentationSettle,
        resolveScanCleanupPreviewPresentationCommit,
    },
] = await Promise.all([
    importTs('../../scan-cleanup-core/detection.ts'),
    importTs('../../scan-cleanup-core/policy/documentCanvas.ts'),
    importTs('../../scan-cleanup-core/policy/buildNativeScanCleanupManifest.ts'),
    importTs('../../scan-cleanup-core/policy/effectiveOptions.ts'),
    importTs('../../scan-cleanup-adapters/createScanCleanupRenderers.ts'),
    importTs('../scanCleanupCliAdapters.ts'),
    importTs('../../scan-cleanup-core/sourceDpiDetection.ts'),
    importTs('../scanCleanupDetectionCache.ts'),
    importTs('../../app/modules/scan-cleanup/geometry/placement.ts'),
    importTs('../../app/modules/scan-cleanup/geometry/coordinates.ts'),
    importTs('../../app/modules/scan-cleanup/runtime/scanCleanupPreviewPresentationPin.ts'),
]);

const WEIGHT_DEVIATION_LIMIT = 0.15;
const INK_MARGIN_LIMIT = 0.03;
const METRIC_INK_THRESHOLD = 160;
const MARGIN_INK_THRESHOLD = 220;
const OVERLAY_EDGE_LIMIT = 0.03;
const OVERLAY_INK_TOLERANCE = 0.01;
const PLACEMENT_PIXEL_TOLERANCE = 1.5;
const FORCED_PLACEMENT_DIVERGENCE_PX = 8;

function printUsage() {
    process.stderr.write([
        'Usage: node scripts/diagnostics/scan-cleanup-preview-harness.mjs --source <pdf> --pages <list> --out <dir> [flags]',
        '',
        'Flags:',
        '  --check                       Enforce the 15% weight-agreement / 3% ink-margin guard',
        '  --final-pdf <pdf>             Reuse this final conversion reference',
        '  --detection-cache <path>      Cache directory used by conversion/detection',
        '  --force-placement-offset-divergence  Diagnostic negative probe for placement identity',
        '  --preview-render-dpi <number> Diagnostic native render-DPI override',
        '  --overlay-edge-tolerance <n>  Maximum normalized box/ink edge delta (default: 0.03)',
        '  --overlay-ink-tolerance <n>   Allowed ink fraction outside the box (default: 0.01)',
        '  --help',
    ].join('\n') + '\n');
}

function parsePageList(value) {
    const pages = value.split(',').flatMap(part => {
        const range = /^(\d+)-(\d+)$/u.exec(part.trim());
        if (range) {
            const from = Number(range[1]);
            const to = Number(range[2]);
            if (from < 1 || to < from) throw new Error(`Invalid page range: ${part}`);
            return Array.from({length: to - from + 1}, (_, index) => from + index);
        }
        const page = Number(part);
        if (!Number.isSafeInteger(page) || page < 1) throw new Error(`Invalid page: ${part}`);
        return [page];
    });
    if (new Set(pages).size !== pages.length) throw new Error('Page selection contains duplicates');
    return pages.sort((left, right) => left - right);
}

function parseArgs(argv) {
    const parsed = {
        check: false,
        detectionCache: null,
        finalPdf: null,
        forcePlacementOffsetDivergence: false,
        out: null,
        overlayEdgeTolerance: OVERLAY_EDGE_LIMIT,
        overlayInkTolerance: OVERLAY_INK_TOLERANCE,
        pages: null,
        previewRenderDpi: null,
        source: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') {
            return {
                ...parsed,
                help: true,
            };
        }
        if (argument === '--check') {
            parsed.check = true;
            continue;
        }
        if (argument === '--force-placement-offset-divergence') {
            parsed.forcePlacementOffsetDivergence = true;
            continue;
        }
        if (![
            '--detection-cache',
            '--final-pdf',
            '--out',
            '--overlay-edge-tolerance',
            '--overlay-ink-tolerance',
            '--pages',
            '--preview-render-dpi',
            '--source',
        ].includes(argument)) {
            throw new Error(`Unknown argument: ${argument}`);
        }
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
        index += 1;
        if (argument === '--pages') parsed.pages = parsePageList(value);
        else if (argument === '--overlay-edge-tolerance' || argument === '--overlay-ink-tolerance') {
            const tolerance = Number(value);
            if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance >= 0.5) {
                throw new Error(`${argument} must be a number from 0 (inclusive) to 0.5 (exclusive)`);
            }
            parsed[argument === '--overlay-edge-tolerance'
                ? 'overlayEdgeTolerance'
                : 'overlayInkTolerance'] = tolerance;
        }
        else if (argument === '--preview-render-dpi') {
            parsed.previewRenderDpi = Number(value);
            if (!Number.isSafeInteger(parsed.previewRenderDpi) || parsed.previewRenderDpi < 1) {
                throw new Error('--preview-render-dpi must be a positive integer');
            }
        }
        else parsed[argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = resolve(value);
    }
    if (!parsed.source || !parsed.out || !parsed.pages) {
        throw new Error('--source, --pages, and --out are required');
    }
    parsed.detectionCache ??= join(parsed.out, 'detection-cache');
    parsed.finalPdf ??= join(parsed.out, 'final-reference.pdf');
    return parsed;
}

const defaultOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    binarization: 'auto',
    normalizeIllumination: true,
    readingOrder: 'ltr',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckleLevel: 'normal',
    autoDewarp: false,
    autoDewarpDepth: undefined,
    skipBlankPages: false,
    pageOverrides: {},
};

function resolveTool(binaryName, crateName, environmentName) {
    const path = resolveCliNativeToolPath(
        binaryName,
        crateName,
        projectRoot,
        environmentName === undefined ? undefined : process.env[environmentName],
    );
    if (!path) throw new Error(`Required tool is unavailable: ${binaryName}`);
    return path;
}

function runStreaming(command, args, options = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            env: options.env ?? process.env,
            stdio: [
                'ignore',
                'inherit',
                'inherit',
            ],
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) resolvePromise();
            else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown'}`));
        });
    });
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function round(value, places = 4) {
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
}

function quantile(values, fraction) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) {
        return sorted[lower];
    }
    return sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
}

function mean(values) {
    return values.reduce((total, value) => total + value, 0) / values.length;
}

async function readGray(path) {
    return loadGrayscaleImage(path);
}

function inkBounds(bitmap, threshold) {
    let left = bitmap.width;
    let top = bitmap.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < bitmap.height; y += 1) {
        const rowOffset = y * bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            if (bitmap.data[rowOffset + x] >= threshold) continue;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
        }
    }
    if (right < left || bottom < top) {
        return null;
    }
    return {
        bottom: bottom + 1,
        left,
        right: right + 1,
        top,
    };
}

function normalizedMargins(bitmap) {
    const bounds = inkBounds(bitmap, MARGIN_INK_THRESHOLD);
    if (!bounds) {
        return null;
    }
    return {
        left: bounds.left / bitmap.width,
        top: bounds.top / bitmap.height,
        right: (bitmap.width - bounds.right) / bitmap.width,
        bottom: (bitmap.height - bounds.bottom) / bitmap.height,
    };
}

async function measureMargins(path) {
    return normalizedMargins(await readGray(path));
}

function lineBands(bitmap, bounds) {
    const minimumRowInk = Math.max(3, Math.round((bounds.right - bounds.left) * 0.0015));
    const activeRows = [];
    for (let y = bounds.top; y < bounds.bottom; y += 1) {
        let ink = 0;
        const rowOffset = y * bitmap.width;
        for (let x = bounds.left; x < bounds.right; x += 1) {
            if (bitmap.data[rowOffset + x] < METRIC_INK_THRESHOLD) ink += 1;
        }
        if (ink >= minimumRowInk) activeRows.push(y);
    }
    const bands = [];
    for (const y of activeRows) {
        const current = bands.at(-1);
        if (!current || y - current.bottom > 2) bands.push({
            top: y,
            bottom: y + 1,
        });
        else current.bottom = y + 1;
    }
    return bands.filter(band => band.bottom - band.top >= 2);
}

function horizontalRuns(bitmap, rect, maximumRun) {
    const runs = [];
    for (let y = rect.top; y < rect.bottom; y += 1) {
        const rowOffset = y * bitmap.width;
        let run = 0;
        for (let x = rect.left; x <= rect.right; x += 1) {
            const ink = x < rect.right && bitmap.data[rowOffset + x] < METRIC_INK_THRESHOLD;
            if (ink) {
                run += 1;
            } else if (run > 0) {
                if (run <= maximumRun) runs.push(run);
                run = 0;
            }
        }
    }
    return runs;
}

function wordWeights(bitmap, bounds, bands) {
    const weights = [];
    for (const band of bands) {
        const height = band.bottom - band.top;
        const occupied = [];
        for (let x = bounds.left; x < bounds.right; x += 1) {
            let ink = false;
            for (let y = band.top; y < band.bottom; y += 1) {
                if (bitmap.data[y * bitmap.width + x] < METRIC_INK_THRESHOLD) {
                    ink = true;
                    break;
                }
            }
            occupied.push(ink);
        }
        const minimumGap = Math.max(2, Math.round(height * 0.28));
        let start = null;
        let lastInk = null;
        const flush = () => {
            if (start === null || lastInk === null || lastInk - start + 1 < 2) {
                return;
            }
            const runs = horizontalRuns(bitmap, {
                left: bounds.left + start,
                right: bounds.left + lastInk + 1,
                top: band.top,
                bottom: band.bottom,
            }, Math.max(3, Math.round(height * 1.5)));
            if (runs.length >= 3) weights.push(mean(runs));
        };
        let gap = 0;
        for (let index = 0; index <= occupied.length; index += 1) {
            if (occupied[index] === true) {
                if (start === null) start = index;
                lastInk = index;
                gap = 0;
            } else if (start !== null) {
                gap += 1;
                if (gap >= minimumGap || index === occupied.length) {
                    flush();
                    start = null;
                    lastInk = null;
                    gap = 0;
                }
            }
        }
    }
    return weights;
}

export function weightUniformity(bitmap) {
    const bounds = inkBounds(bitmap, METRIC_INK_THRESHOLD);
    if (!bounds) {
        return null;
    }
    const bands = lineBands(bitmap, bounds);
    const bandWeights = bands.flatMap(band => {
        const height = band.bottom - band.top;
        const runs = horizontalRuns(bitmap, {
            left: bounds.left,
            right: bounds.right,
            top: band.top,
            bottom: band.bottom,
        }, Math.max(3, Math.round(height * 1.5)));
        return runs.length >= 12 ? [mean(runs)] : [];
    });
    const words = wordWeights(bitmap, bounds, bands);
    if (bandWeights.length < 2 || words.length < 2) {
        return null;
    }
    const observedMinimumLineWeight = Math.min(...bandWeights);
    const observedMaximumLineWeight = Math.max(...bandWeights);
    // Isolated headings, page numbers, and hairline rules are not body-text
    // weight samples. Use the central line population for the guard while
    // retaining the literal observed extrema in the report for diagnosis.
    const minimumLineWeight = quantile(bandWeights, 0.1);
    const maximumLineWeight = quantile(bandWeights, 0.9);
    const wordMedian = quantile(words, 0.5);
    const wordAbsoluteDeviations = words.map(value => Math.abs(value - wordMedian));
    const wordVariancePx = quantile(wordAbsoluteDeviations, 0.5);
    return {
        lineCount: bandWeights.length,
        lineMeanRunMinPx: round(minimumLineWeight),
        lineMeanRunMaxPx: round(maximumLineWeight),
        lineMaxMinRatio: round(maximumLineWeight / Math.max(0.01, minimumLineWeight)),
        lineObservedMaxMinRatio: round(
            observedMaximumLineWeight / Math.max(0.01, observedMinimumLineWeight),
        ),
        wordCount: words.length,
        wordRunMedianPx: round(wordMedian),
        wordVariancePx: round(wordVariancePx),
        wordVarianceProxy: round(wordVariancePx / Math.max(0.01, wordMedian)),
    };
}

function relativeDifference(left, right) {
    return Math.abs(left - right) / Math.max(Math.abs(right), 1e-6);
}

export function compareMetrics(preview, final) {
    if (!preview || !final) {
        return {
            measurable: false,
            weightDeviation: null,
        };
    }
    // The proxy is a normalized spread, so comparing two near-zero proxies
    // relatively turns subpixel rasterization noise into a large percentage.
    // Compare the underlying absolute spread in pixels and normalize it by a
    // representative measured stroke width instead. One-pixel quantization
    // remains visible in the report without making a 0.03 proxy residual red.
    const previewWordVariancePx = Number.isFinite(preview.wordVariancePx)
        ? preview.wordVariancePx
        : preview.wordVarianceProxy * preview.wordRunMedianPx;
    const finalWordVariancePx = Number.isFinite(final.wordVariancePx)
        ? final.wordVariancePx
        : final.wordVarianceProxy * final.wordRunMedianPx;
    const wordVarianceResidualPx = Math.abs(previewWordVariancePx - finalWordVariancePx);
    const representativeWordRunPx = Math.max(
        preview.wordRunMedianPx,
        final.wordRunMedianPx,
        1,
    );
    const lineRatioDeviation = relativeDifference(preview.lineMaxMinRatio, final.lineMaxMinRatio);
    const wordVarianceDeviation = wordVarianceResidualPx / representativeWordRunPx;
    return {
        measurable: true,
        lineRatioDeviation: round(lineRatioDeviation),
        wordVarianceResidualPx: round(wordVarianceResidualPx),
        wordVarianceDeviation: round(wordVarianceDeviation),
        weightDeviation: round(Math.max(
            lineRatioDeviation,
            wordVarianceDeviation,
        )),
    };
}

export function weightAgreementViolations(weightComparison) {
    if (!weightComparison.measurable) {
        return ['weight-unmeasurable'];
    }
    return weightComparison.weightDeviation > WEIGHT_DEVIATION_LIMIT
        ? ['preview-final-weight-agreement']
        : [];
}

function compareMargins(preview, final) {
    if (!preview || !final) {
        return null;
    }
    const deltas = Object.fromEntries([
        'left',
        'top',
        'right',
        'bottom',
    ].map(side => [
        side,
        round(Math.abs(preview[side] - final[side])),
    ]));
    return {
        ...deltas,
        maximum: Math.max(...Object.values(deltas)),
    };
}

function pixelRectFromStyle(style, width, height) {
    const percent = value => Number.parseFloat(value) / 100;
    const left = percent(style.left) * width;
    const top = percent(style.top) * height;
    return {
        left,
        top,
        right: left + percent(style.width) * width,
        bottom: top + percent(style.height) * height,
    };
}

function previewPlacementSignature(metadata, imageRect, canvasWidthPx, canvasHeightPx) {
    const contentWidthPx = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    const scaleX = (imageRect.right - imageRect.left) / contentWidthPx;
    const foldClipLeftPx = metadata.foldClipLeftPx ?? 0;
    const foldClipRightPx = metadata.foldClipRightPx ?? 0;
    const sourceLeftPx = Math.max(foldClipLeftPx, -imageRect.left / scaleX);
    const sourceRightPx = Math.min(
        contentWidthPx - foldClipRightPx,
        (canvasWidthPx - imageRect.left) / scaleX,
    );
    const destinationX = imageRect.left + sourceLeftPx * scaleX;
    const destinationY = Math.max(0, imageRect.top);
    return {
        canvas: {
            heightPx: canvasHeightPx,
            widthPx: canvasWidthPx,
        },
        contentWidthPx,
        destinationOrigin: {
            xPx: round(destinationX),
            yPx: round(destinationY),
            xNormalized: round(destinationX / canvasWidthPx, 8),
            yNormalized: round(destinationY / canvasHeightPx, 8),
        },
        retainedSourceInterval: {
            leftPx: round(sourceLeftPx),
            rightPx: round(sourceRightPx),
            leftNormalized: round(sourceLeftPx / contentWidthPx, 8),
            rightNormalized: round(sourceRightPx / contentWidthPx, 8),
        },
    };
}

function finalPlacementSignature(metadata, materializedWidthPx, materializedHeightPx, forcedOffsetXPx = 0) {
    const contentWidthPx = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    const effectiveLeftPx = metadata.placementOffsetXPx
        - (metadata.matchedCanvasIntrinsicOverflowLeftPx ?? 0);
    const effectiveTopPx = metadata.placementOffsetYPx
        - (metadata.matchedCanvasIntrinsicOverflowTopPx ?? 0);
    const foldClipLeftPx = metadata.foldClipLeftPx ?? 0;
    const foldClipRightPx = metadata.foldClipRightPx ?? 0;
    const sourceLeftPx = Math.max(foldClipLeftPx, -effectiveLeftPx);
    const sourceRightPx = Math.min(
        contentWidthPx - foldClipRightPx,
        metadata.canvasWidthPx - effectiveLeftPx,
    );
    const scaleX = materializedWidthPx / metadata.canvasWidthPx;
    const scaleY = materializedHeightPx / metadata.canvasHeightPx;
    const destinationX = (effectiveLeftPx + sourceLeftPx) * scaleX + forcedOffsetXPx;
    const destinationY = Math.max(0, effectiveTopPx) * scaleY;
    return {
        canvas: {
            heightPx: materializedHeightPx,
            widthPx: materializedWidthPx,
        },
        contentWidthPx,
        nativeCanvasWidthPx: metadata.canvasWidthPx,
        destinationOrigin: {
            xPx: round(destinationX),
            yPx: round(destinationY),
            xNormalized: round(destinationX / materializedWidthPx, 8),
            yNormalized: round(destinationY / materializedHeightPx, 8),
        },
        retainedSourceInterval: {
            leftPx: round(sourceLeftPx),
            rightPx: round(sourceRightPx),
            leftNormalized: round(sourceLeftPx / contentWidthPx, 8),
            rightNormalized: round(sourceRightPx / contentWidthPx, 8),
        },
    };
}

function comparePlacementSignatures(preview, final) {
    const presentedFinalContentWidthPx = final.contentWidthPx
        * final.canvas.widthPx / Math.max(1, final.nativeCanvasWidthPx);
    const tolerances = {
        destinationX: PLACEMENT_PIXEL_TOLERANCE / Math.min(preview.canvas.widthPx, final.canvas.widthPx),
        destinationY: PLACEMENT_PIXEL_TOLERANCE / Math.min(preview.canvas.heightPx, final.canvas.heightPx),
        retainedSource: PLACEMENT_PIXEL_TOLERANCE / Math.min(
            preview.contentWidthPx,
            presentedFinalContentWidthPx,
        ),
    };
    const deltas = {
        destinationX: round(Math.abs(
            preview.destinationOrigin.xNormalized - final.destinationOrigin.xNormalized,
        ), 8),
        destinationY: round(Math.abs(
            preview.destinationOrigin.yNormalized - final.destinationOrigin.yNormalized,
        ), 8),
        retainedSourceLeft: round(Math.abs(
            preview.retainedSourceInterval.leftNormalized - final.retainedSourceInterval.leftNormalized,
        ), 8),
        retainedSourceRight: round(Math.abs(
            preview.retainedSourceInterval.rightNormalized - final.retainedSourceInterval.rightNormalized,
        ), 8),
    };
    return {
        deltas,
        tolerances: Object.fromEntries(Object.entries(tolerances).map(([
            key,
            value,
        ]) => [
            key,
            round(value, 8),
        ])),
        identical: deltas.destinationX <= tolerances.destinationX
            && deltas.destinationY <= tolerances.destinationY
            && deltas.retainedSourceLeft <= tolerances.retainedSource
            && deltas.retainedSourceRight <= tolerances.retainedSource,
    };
}

function grayBitmapFromContext(context, width, height) {
    const rgba = context.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let index = 0, pixel = 0; index < rgba.length; index += 4, pixel += 1) {
        data[pixel] = Math.round(
            rgba[index] * 0.2126
            + rgba[index + 1] * 0.7152
            + rgba[index + 2] * 0.0722,
        );
    }
    return {
        data,
        height,
        width,
    };
}

function histogramQuantile(histogram, target) {
    let cumulative = 0;
    for (let index = 0; index < histogram.length; index += 1) {
        cumulative += histogram[index];
        if (cumulative > target) {
            return index;
        }
    }
    return histogram.length - 1;
}

function measureOverlayContainment(bitmap, rect, inkTolerance, edgeTolerance) {
    const columns = new Uint32Array(bitmap.width);
    const rows = new Uint32Array(bitmap.height);
    let inkInside = 0;
    let inkTotal = 0;
    for (let y = 0; y < bitmap.height; y += 1) {
        const rowOffset = y * bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            if (bitmap.data[rowOffset + x] >= MARGIN_INK_THRESHOLD) continue;
            inkTotal += 1;
            columns[x] += 1;
            rows[y] += 1;
            const centerX = x + 0.5;
            const centerY = y + 0.5;
            if (
                centerX >= rect.left
                && centerX <= rect.right
                && centerY >= rect.top
                && centerY <= rect.bottom
            ) {
                inkInside += 1;
            }
        }
    }
    if (inkTotal === 0) {
        return {
            measurable: false,
            containment: null,
            edgeDeltas: null,
            maximumEdgeDelta: null,
            pass: false,
        };
    }
    // Split the allowed dust/descender population across the four tails. The
    // resulting bounds stay stable in the presence of isolated marks while
    // the independent containment ratio still accounts for every ink pixel.
    const tailInk = inkTotal * inkTolerance / 4;
    const bounds = {
        left: histogramQuantile(columns, tailInk),
        top: histogramQuantile(rows, tailInk),
        right: histogramQuantile(columns, inkTotal - tailInk - 1) + 1,
        bottom: histogramQuantile(rows, inkTotal - tailInk - 1) + 1,
    };
    const edgeDeltas = {
        left: round(Math.max(0, rect.left - bounds.left) / bitmap.width),
        top: round(Math.max(0, rect.top - bounds.top) / bitmap.height),
        right: round(Math.max(0, bounds.right - rect.right) / bitmap.width),
        bottom: round(Math.max(0, bounds.bottom - rect.bottom) / bitmap.height),
    };
    const containment = round(inkInside / inkTotal);
    const maximumEdgeDelta = Math.max(...Object.values(edgeDeltas));
    return {
        measurable: true,
        containment,
        edgeDeltas,
        maximumEdgeDelta,
        pass: containment >= 1 - inkTolerance && maximumEdgeDelta <= edgeTolerance,
    };
}

async function composeLeaf(rasterPath, metadata, outputPath, overlayOptions) {
    const raster = await loadImage(rasterPath);
    const placement = resolvePreviewMetadataPlacement(metadata);
    const imageStyle = toPreviewStyleRect(
        {
            xPx: 0,
            yPx: 0,
            widthPx: metadata.outputWidthPx,
            heightPx: metadata.outputHeightPx,
        }, placement,
    );
    const canvas = createCanvas(placement.canvasWidthPx, placement.canvasHeightPx);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const imageRect = pixelRectFromStyle(imageStyle, canvas.width, canvas.height);
    const foldClipLeft = metadata.foldClipLeftPx ?? 0;
    const foldClipRight = metadata.foldClipRightPx ?? 0;
    const imageWidth = imageRect.right - imageRect.left;
    const cropLeft = imageRect.left + foldClipLeft / placement.contentWidthPx * imageWidth;
    const cropWidth = imageWidth * (placement.contentWidthPx - foldClipLeft - foldClipRight)
        / placement.contentWidthPx;
    context.save();
    context.beginPath();
    context.rect(cropLeft, imageRect.top, cropWidth, imageRect.bottom - imageRect.top);
    context.clip();
    context.drawImage(raster, imageRect.left, imageRect.top, imageWidth, imageRect.bottom - imageRect.top);
    context.restore();
    const transformedContent = transformPreviewContentBox(metadata);
    const sourceContentContainment = measurePreviewContentBoxContainment(metadata);
    const overlayStyle = transformedContent ? toPreviewStyleRect(transformedContent, placement) : null;
    const overlayRect = overlayStyle
        ? pixelRectFromStyle(overlayStyle, canvas.width, canvas.height)
        : null;
    const overlayContainment = overlayRect
        ? measureOverlayContainment(
            grayBitmapFromContext(context, canvas.width, canvas.height),
            overlayRect,
            overlayOptions.inkTolerance,
            overlayOptions.edgeTolerance,
        )
        : {
            measurable: false,
            containment: null,
            edgeDeltas: null,
            maximumEdgeDelta: null,
            pass: false,
        };
    const metricsPath = outputPath.replace(/\.png$/u, '-raster.png');
    await writeFile(metricsPath, canvas.toBuffer('image/png'));
    if (overlayRect) {
        context.save();
        context.strokeStyle = '#0078ff';
        context.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.002));
        context.strokeRect(
            overlayRect.left,
            overlayRect.top,
            overlayRect.right - overlayRect.left,
            overlayRect.bottom - overlayRect.top,
        );
        context.restore();
    }
    await writeFile(outputPath, canvas.toBuffer('image/png'));
    return {
        height: canvas.height,
        imageStyle,
        overlayContainment,
        sourceContentContainment,
        overlayRect,
        overlayStyle,
        path: outputPath,
        placementSignature: previewPlacementSignature(
            metadata,
            imageRect,
            canvas.width,
            canvas.height,
        ),
        metricsPath,
        placement,
        width: canvas.width,
    };
}

async function composeSpread(leaves, outputPath) {
    const gap = leaves.length > 1 ? 24 : 0;
    const width = leaves.reduce((total, leaf) => total + leaf.width, 0) + gap * (leaves.length - 1);
    const height = Math.max(...leaves.map(leaf => leaf.height));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#d0d0d0';
    context.fillRect(0, 0, width, height);
    let x = 0;
    for (const leaf of leaves) {
        const image = await loadImage(leaf.path);
        context.drawImage(image, x, 0);
        x += leaf.width + gap;
    }
    await writeFile(outputPath, canvas.toBuffer('image/png'));
}

async function runFinalConversion(args) {
    await mkdir(dirname(args.finalPdf), {recursive: true});
    await runStreaming(process.execPath, [
        '--import',
        'tsx',
        'scripts/scan-cleanup-convert.ts',
        '--source',
        args.source,
        '--out',
        args.finalPdf,
        '--pages',
        args.pages.join(','),
        '--detection-cache',
        args.detectionCache,
    ], {env: {
        ...process.env,
        TSX_TSCONFIG_PATH: tsconfig,
    }});
}

async function loadDetection(args, tools) {
    const cacheKey = await createScanCleanupDetectionCacheKey(
        args.source,
        defaultOptions,
        {
            pdftoppmBinaryPath: tools.pdftoppm,
            scanCleanupBinaryPath: tools.scanCleanup,
        },
    );
    const path = args.detectionCache.toLowerCase().endsWith('.json')
        ? args.detectionCache
        : join(args.detectionCache, `${cacheKey.key}.json`);
    const cache = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(cache.results) || cache.results.length === 0) {
        throw new Error(`Detection cache has no results: ${path}`);
    }
    return {
        cacheKey: cacheKey.key,
        path,
        results: cache.results,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printUsage();
        return;
    }
    await mkdir(args.out, {recursive: true});
    const tools = {
        pdfimages: resolveTool('pdfimages', 'poppler'),
        pdftoppm: resolveTool('pdftoppm', 'poppler'),
        scanCleanup: resolveTool('evb-scan-cleanup', 'scan-cleanup', 'EVB_SCAN_CLEANUP_PATH'),
    };
    const suppliedFinal = process.argv.includes('--final-pdf');
    if (!suppliedFinal) await runFinalConversion(args);
    const detection = await loadDetection(args, tools);
    const pageSizes = detection.results.map(result => result.sourcePageMetadata).filter(Boolean);
    if (pageSizes.length !== detection.results.length) {
        throw new Error('Detection cache does not carry source geometry for every page');
    }
    const layoutByPage = Object.fromEntries(detection.results.map(result => [
        String(result.pageNumber),
        result.classification,
    ]));
    const previewRasterPlan = resolvePreviewRasterPlan(pageSizes);
    const matchedPreviewDpis = [...previewRasterPlan.renderDpiByPageNumber.values()];
    const matchedPreviewDpi = matchedPreviewDpis.length === 0
        ? previewRasterPlan.dpi
        : Math.min(...matchedPreviewDpis);
    const documentCanvas = resolveScanCleanupProvisionalDocumentCanvas(
        pageSizes,
        matchedPreviewDpi,
        defaultOptions,
        layoutByPage,
        true,
    );
    const basePreviewDpi = documentCanvas === null
        ? previewRasterPlan.dpi
        : Math.max(1, Math.floor(resolveScanCleanupDocumentCanvasDpi(documentCanvas)));
    const runCommand = (command, commandArgs, options) => runCliNativeToolCommand(
        command,
        commandArgs,
        options,
    );
    const renderers = createScanCleanupRenderers(runCommand);
    const sourceRasterDetails = await detectSourceDpiDetails(
        args.source,
        tools.pdfimages,
        () => undefined,
        undefined,
        undefined,
        args.pages,
        undefined,
        runCommand,
    );
    const finalSummary = JSON.parse(await readFile(`${args.finalPdf}.summary.json`, 'utf8'));
    const finalMappings = new Map(finalSummary.sourcePageToOutputPages.map(mapping => [
        mapping.sourcePage,
        mapping.outputPages,
    ]));
    const finalSummaryPages = new Map(finalSummary.perPageStreamSizes.map(page => [
        page.outputPageNumber,
        page,
    ]));
    const report = {
        schemaVersion: 1,
        source: args.source,
        pages: args.pages,
        previewDpi: basePreviewDpi,
        previewRenderDpi: args.previewRenderDpi ?? 'dpi-aware',
        renderMode: 'preview',
        canvasScope: 'page',
        finalReference: args.finalPdf,
        detectionCache: detection.path,
        detectionCacheKey: detection.cacheKey,
        limits: {
            inkMargin: INK_MARGIN_LIMIT,
            overlayEdge: args.overlayEdgeTolerance,
            overlayInkOutside: args.overlayInkTolerance,
            weightDeviation: WEIGHT_DEVIATION_LIMIT,
        },
        results: [],
    };
    for (const pageNumber of args.pages) {
        const pageDirectory = join(args.out, `page-${String(pageNumber)}`);
        const manifestScope = createScanCleanupDiagnosticsManifestScope(
            pageDirectory,
            buildRunnableNativeScanCleanupManifest,
        );
        await mkdir(pageDirectory, {recursive: true});
        const detectionResult = detection.results[pageNumber - 1];
        if (!detectionResult || detectionResult.pageNumber !== pageNumber) {
            throw new Error(`Detection cache has no page ${String(pageNumber)}`);
        }
        const sourceRaster = sourceRasterDetails.pageRasterByNumber.get(pageNumber);
        const sourceDpi = sourceRaster?.dpi
            ?? detectionResult.sourcePageMetadata?.sourceDpi
            ?? previewRasterPlan.pageDpiByNumber.get(pageNumber)
            ?? previewRasterPlan.dpi;
        const requestedPreviewRenderDpi = resolvePreviewProcessingDpi({
            displayDpi: basePreviewDpi,
            outputMode: detectionResult.recommendedOutputMode,
            sourceDpi,
        });
        const processingDocumentCanvas = documentCanvas === null
            || requestedPreviewRenderDpi <= basePreviewDpi
            ? null
            : resolveScanCleanupProvisionalDocumentCanvas(
                pageSizes,
                requestedPreviewRenderDpi,
                defaultOptions,
                layoutByPage,
                true,
            );
        const previewRenderDpi = args.previewRenderDpi
            ?? (processingDocumentCanvas === null
                ? requestedPreviewRenderDpi
                : Math.max(1, Math.floor(resolveScanCleanupDocumentCanvasDpi(processingDocumentCanvas))));
        const rawPath = join(pageDirectory, `source-${String(previewRenderDpi)}dpi.png`);
        await renderers.renderPage(
            {pdftoppmBinary: tools.pdftoppm},
            () => undefined,
            pageNumber,
            args.source,
            rawPath,
            previewRenderDpi,
        );
        const nativeOutputs = [
            0,
            1,
        ].map(index => ({
            outputPath: join(pageDirectory, `preview-output-${String(index)}.png`),
            metadataPath: join(pageDirectory, `preview-output-${String(index)}.json`),
        }));
        const manifestPath = join(pageDirectory, 'preview-manifest.json');
        const pageMetadataPath = join(pageDirectory, 'preview-page.json');
        const reusablePagePlan = resolveReusablePagePlan(
            defaultOptions,
            layoutByPage,
            detectionResult.pagePlanEvidence === undefined
                ? undefined
                : {[String(pageNumber)]: detectionResult.pagePlanEvidence},
            pageNumber,
        );
        const manifest = manifestScope.buildManifest({
            operation: 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: 'raster',
            options: defaultOptions,
            experimental: {autoDewarp: false},
            ...(documentCanvas === null ? {} : {documentCanvas}),
            pages: [{
                inputPath: rawPath,
                pageNumber,
                dpi: previewRenderDpi,
                sourceDpi,
                sourceHasBilevelLayer: sourceRaster?.hasBilevelLayer ?? false,
                ...(sourceRaster?.backgroundDpi === undefined
                    ? {}
                    : {sourceBackgroundDpi: sourceRaster.backgroundDpi}),
                requestedRenderDpi: previewRenderDpi,
                ...(detectionResult.recommendedOutputMode === undefined
                    ? {}
                    : {resolvedOutputMode: detectionResult.recommendedOutputMode}),
                ...(detectionResult.softAlphaForegroundRecommendation === undefined
                    ? {}
                    : {preferSoftAlphaForeground: detectionResult.softAlphaForegroundRecommendation}),
                observedLayout: detectionResult.classification,
                ...reusablePagePlan,
                pageMetadataPath,
                outputs: nativeOutputs,
                ...(detectionResult.documentPrior === null
                    ? {}
                    : {documentPrior: detectionResult.documentPrior}),
            }],
        });
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
        await runCommand(
            tools.scanCleanup,
            manifestScope.sidecarArgv(manifestPath),
            {commandLabel: `preview-harness(page=${String(pageNumber)})`},
        );
        const outputMetadata = [];
        for (const output of nativeOutputs) {
            try {
                outputMetadata.push({
                    ...output,
                    metadata: JSON.parse(await readFile(output.metadataPath, 'utf8')),
                });
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        const previewLeaves = [];
        for (const output of outputMetadata) {
            const half = output.metadata.half;
            const path = join(pageDirectory, `preview-${half}.png`);
            previewLeaves.push({
                half,
                ...await composeLeaf(output.outputPath, output.metadata, path, {
                    edgeTolerance: args.overlayEdgeTolerance,
                    inkTolerance: args.overlayInkTolerance,
                }),
            });
        }
        // Replay only this page's verdict to expose provisional-canvas jumps without Electron.
        const provisionalDocumentCanvas = resolveScanCleanupProvisionalDocumentCanvas(
            pageSizes,
            matchedPreviewDpi,
            defaultOptions,
            {[String(pageNumber)]: detectionResult.classification},
            false,
        );
        const provisionalOutputs = nativeOutputs.map((_, index) => ({
            outputPath: join(pageDirectory, `provisional-output-${String(index)}.png`),
            metadataPath: join(pageDirectory, `provisional-output-${String(index)}.json`),
        }));
        const provisionalManifestPath = join(pageDirectory, 'provisional-preview-manifest.json');
        const provisionalPageMetadataPath = join(pageDirectory, 'provisional-preview-page.json');
        const provisionalManifest = structuredClone(manifest);
        if (provisionalDocumentCanvas === null) delete provisionalManifest.documentCanvas;
        else provisionalManifest.documentCanvas = provisionalDocumentCanvas;
        provisionalManifest.pages[0].outputs = provisionalOutputs;
        provisionalManifest.pages[0].pageMetadataPath = provisionalPageMetadataPath;
        // Progressive detection has observed layout but no pagePlanEvidence yet; do not hide
        // provisional-only crop failures by replaying the settled split/content/skew plan.
        for (const key of Object.keys(reusablePagePlan)) {
            delete provisionalManifest.pages[0].options[key];
        }
        await writeFile(provisionalManifestPath, JSON.stringify(provisionalManifest, null, 2) + '\n');
        await runCommand(
            tools.scanCleanup,
            manifestScope.sidecarArgv(provisionalManifestPath),
            {commandLabel: `preview-harness-provisional(page=${String(pageNumber)})`},
        );
        const provisionalLeaves = [];
        for (const output of provisionalOutputs) {
            try {
                const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8'));
                const half = metadata.half;
                const path = join(pageDirectory, `provisional-${half}.png`);
                provisionalLeaves.push({
                    half,
                    ...await composeLeaf(output.outputPath, metadata, path, {
                        edgeTolerance: args.overlayEdgeTolerance,
                        inkTolerance: args.overlayInkTolerance,
                    }),
                });
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        const provisionalComposite = join(pageDirectory, 'provisional-preview-composite.png');
        await composeSpread(provisionalLeaves, provisionalComposite);
        const contextLeafComparisons = [];
        for (const settledLeaf of previewLeaves) {
            const provisionalLeaf = provisionalLeaves.find(leaf => leaf.half === settledLeaf.half);
            if (!provisionalLeaf) continue;
            const settledBytes = await readFile(settledLeaf.metricsPath);
            const provisionalBytes = await readFile(provisionalLeaf.metricsPath);
            contextLeafComparisons.push({
                half: settledLeaf.half,
                rasterIdentical: sha256(settledBytes) === sha256(provisionalBytes),
                inkMarginShift: compareMargins(
                    normalizedMargins(await readGray(settledLeaf.metricsPath)),
                    normalizedMargins(await readGray(provisionalLeaf.metricsPath)),
                ),
                overlayContainment: provisionalLeaf.overlayContainment,
                sourceContentContainment: provisionalLeaf.sourceContentContainment,
                violations: [
                    ...(provisionalLeaf.overlayContainment.pass ? [] : ['overlay-containment']),
                    ...(provisionalLeaf.sourceContentContainment?.contained === false
                        ? ['source-content-containment']
                        : []),
                ],
            });
        }
        const finalOutputPages = finalMappings.get(pageNumber) ?? [];
        if (finalOutputPages.length !== previewLeaves.length) {
            throw new Error(
                `Page ${String(pageNumber)} preview/final leaf mismatch: `
                + `${String(previewLeaves.length)} vs ${String(finalOutputPages.length)}`,
            );
        }
        const finalLeaves = [];
        for (let index = 0; index < finalOutputPages.length; index += 1) {
            const half = previewLeaves[index].half;
            const outputPageNumber = finalOutputPages[index];
            const finalSummaryPage = finalSummaryPages.get(outputPageNumber);
            if (!finalSummaryPage || finalSummaryPage.half !== half) {
                throw new Error(
                    `Page ${String(pageNumber)} ${half} has no matching final materialization summary`,
                );
            }
            const path = join(pageDirectory, `final-${half}.png`);
            await renderers.renderPage(
                {pdftoppmBinary: tools.pdftoppm},
                () => undefined,
                outputPageNumber,
                args.finalPdf,
                path,
                PREVIEW_DPI,
            );
            const image = await loadImage(path);
            finalLeaves.push({
                half,
                height: image.height,
                path,
                renderGeometry: finalSummaryPage.renderGeometry,
                width: image.width,
            });
        }
        const previewComposite = join(pageDirectory, 'preview-composite.png');
        const finalComposite = join(pageDirectory, 'final-composite.png');
        await composeSpread(previewLeaves, previewComposite);
        await composeSpread(finalLeaves, finalComposite);
        const eyeballComposite = join(pageDirectory, 'provisional-vs-settled-composite.png');
        await composePreviewTransition(provisionalComposite, previewComposite, eyeballComposite);
        const forcedProbeDirectory = join(pageDirectory, 'forced-post-settle-movement-probe');
        const forcedProbeLeaves = await createForcedPostSettleMovementProbeLeaves(previewLeaves, forcedProbeDirectory);
        const presentationStability = await measurePreviewPresentationStability({
            commitSettle: commitScanCleanupPreviewPresentationSettle,
            compareMargins,
            forcedProbeLeaves,
            measureMargins,
            previewLeaves,
            provisionalLeaves,
            resolveCommit: resolveScanCleanupPreviewPresentationCommit,
            transitionKey: `preview-session:page-${String(pageNumber)}:user-0`,
        });
        const placementSignatures = previewLeaves.map((leaf, index) => {
            const finalLeaf = finalLeaves[index];
            const forcedOffsetXPx = args.forcePlacementOffsetDivergence
                && pageNumber === args.pages[0]
                && index === 0
                ? FORCED_PLACEMENT_DIVERGENCE_PX
                : 0;
            const final = finalPlacementSignature(
                finalLeaf.renderGeometry,
                finalLeaf.width,
                finalLeaf.height,
                forcedOffsetXPx,
            );
            return {
                half: leaf.half,
                preview: leaf.placementSignature,
                final,
                ...comparePlacementSignatures(leaf.placementSignature, final),
            };
        });
        const leafResults = [];
        for (let index = 0; index < previewLeaves.length; index += 1) {
            const previewBitmap = await readGray(previewLeaves[index].metricsPath);
            const finalBitmap = await readGray(finalLeaves[index].path);
            const previewWeight = weightUniformity(previewBitmap);
            const finalWeight = weightUniformity(finalBitmap);
            const previewMargins = normalizedMargins(previewBitmap);
            const finalMargins = normalizedMargins(finalBitmap);
            const weightComparison = compareMetrics(previewWeight, finalWeight);
            const marginComparison = compareMargins(previewMargins, finalMargins);
            const violations = weightAgreementViolations(weightComparison);
            if (marginComparison === null) violations.push('ink-margin-unmeasurable');
            else if (marginComparison.maximum > INK_MARGIN_LIMIT) violations.push('ink-margin');
            if (!previewLeaves[index].overlayContainment.pass) {
                violations.push('overlay-containment');
            }
            if (previewLeaves[index].sourceContentContainment?.contained === false) {
                violations.push('source-content-containment');
            }
            leafResults.push({
                half: previewLeaves[index].half,
                previewRaster: previewLeaves[index].path,
                finalRaster: finalLeaves[index].path,
                previewWeight,
                finalWeight,
                weightComparison,
                previewMargins,
                finalMargins,
                marginComparison,
                overlayContainment: previewLeaves[index].overlayContainment,
                sourceContentContainment: previewLeaves[index].sourceContentContainment,
                violations,
            });
        }
        report.results.push({
            pageNumber,
            classification: detectionResult.classification,
            outputMode: detectionResult.recommendedOutputMode ?? null,
            previewRenderDpi,
            previewComposite,
            finalComposite,
            contextStability: {
                provisionalComposite,
                provisionalManifest: provisionalManifestPath,
                settledManifest: manifestPath,
                leaves: contextLeafComparisons,
                maximumInkMarginShift: Math.max(
                    0,
                    ...contextLeafComparisons.map(comparison => comparison.inkMarginShift?.maximum ?? 1),
                ),
            },
            presentationStability,
            eyeballComposite,
            manifest: manifestPath,
            previewPageMetadata: pageMetadataPath,
            placementSignatures,
            leaves: leafResults,
        });
    }
    const violations = report.results.flatMap(page => [
        ...page.leaves.flatMap(leaf => leaf.violations.map(code => ({
            code,
            half: leaf.half,
            mode: 'settled',
            pageNumber: page.pageNumber,
        }))),
        ...page.contextStability.leaves.flatMap(leaf => leaf.violations.map(code => ({
            code,
            half: leaf.half,
            mode: 'provisional',
            pageNumber: page.pageNumber,
        }))),
        ...page.presentationStability.violations.map(code => ({
            code,
            mode: 'presentation-stability',
            pageNumber: page.pageNumber,
        })),
        ...page.placementSignatures.filter(signature => !signature.identical).map(signature => ({
            code: 'placement-identity',
            half: signature.half,
            mode: 'settled',
            pageNumber: page.pageNumber,
        })),
    ]);
    report.violations = violations;
    report.status = violations.length === 0 ? 'pass' : 'fail';
    const reportPath = join(args.out, 'report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify({
        status: report.status,
        report: reportPath,
        results: report.results.map(page => ({
            pageNumber: page.pageNumber,
            previewComposite: page.previewComposite,
            finalComposite: page.finalComposite,
            placementIdentity: page.placementSignatures.map(signature => ({
                half: signature.half,
                identical: signature.identical,
                deltas: signature.deltas,
                tolerances: signature.tolerances,
            })),
            leaves: page.leaves.map(leaf => ({
                half: leaf.half,
                preview: leaf.previewWeight,
                final: leaf.finalWeight,
                comparison: leaf.weightComparison,
                marginMaximum: leaf.marginComparison?.maximum ?? null,
                violations: leaf.violations,
            })),
        })),
    }, null, 2) + '\n');
    if (args.check && violations.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main().catch(error => {
        printUsage();
        process.stderr.write(`preview harness failed: ${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 2;
    });
}
