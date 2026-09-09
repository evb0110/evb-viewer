import type {
    INativeScanCleanupOptionsV3,
    IScanCleanupManualZones,
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    IScanCleanupPageOverride,
    TScanCleanupDespeckleLevel,
    TScanCleanupLayoutClassification,
    TScanCleanupLayoutByPage,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeSetting,
} from '@contracts/electronApiScanCleanup';
import {resolveScanCleanupEffectiveOutputMode} from '@contracts/electronApiScanCleanup';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
    resolveScanCleanupPageLayout,
} from '@contracts/scanCleanupPageOverrides';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {IPdfPageSize} from '@evb/scan-cleanup/core/types';

export function resolveReusablePagePlan(
    options: IScanCleanupOptions,
    layoutByPage: TScanCleanupLayoutByPage | undefined,
    evidenceByPage: Partial<Record<string, IScanCleanupPagePlanEvidence>> | undefined,
    pageNumber: number,
) {
    return resolveReusablePagePlanResult(
        options,
        layoutByPage,
        evidenceByPage,
        pageNumber,
    ).plan;
}

export type TReusablePagePlanStatus =
    | 'matched'
    | 'absent'
    | 'page-number-mismatch'
    | 'rotation-mismatch'
    | 'layout-mismatch';

export function resolveReusablePagePlanResult(
    options: IScanCleanupOptions,
    layoutByPage: TScanCleanupLayoutByPage | undefined,
    evidenceByPage: Partial<Record<string, IScanCleanupPagePlanEvidence>> | undefined,
    pageNumber: number,
): {
    plan: ReturnType<typeof reusablePlanFromEvidence>;
    status: TReusablePagePlanStatus
} {
    const evidence = evidenceByPage?.[String(pageNumber)];
    const pageOverride = getScanCleanupPageOverride(
        options.pageOverrides,
        requirePageNumber(pageNumber),
    );
    const observedLayout = layoutByPage?.[String(pageNumber)];
    if (evidence === undefined) {
        return {
            plan: {},
            status: 'absent',
        };
    }
    if (evidence.pageNumber !== pageNumber) {
        return {
            plan: {},
            status: 'page-number-mismatch',
        };
    }
    if (evidence.rotationDegrees !== pageOverride.rotationDegrees) {
        return {
            plan: {},
            status: 'rotation-mismatch',
        };
    }
    if (evidence.layoutClassification !== observedLayout) {
        return {
            plan: {},
            status: 'layout-mismatch',
        };
    }
    return {
        plan: reusablePlanFromEvidence(evidence),
        status: 'matched',
    };
}

function reusablePlanFromEvidence(evidence: IScanCleanupPagePlanEvidence) {
    const automaticContentBoxes = Object.fromEntries(Object.entries(evidence.outputs).flatMap(([
        half,
        output,
    ]) => output.contentBox === undefined ? [] : [[
        half,
        output.contentBox,
    ]]));
    const automaticSkewDegrees = Object.fromEntries(Object.entries(evidence.outputs).flatMap(([
        half,
        output,
    ]) => output.detectedSkewDegrees === undefined ? [] : [[
        half,
        output.detectedSkewDegrees,
    ]]));
    const resolvedTextToneDiagnostics = Object.fromEntries(Object.entries(evidence.outputs).flatMap(([
        half,
        output,
    ]) => output.textToneDiagnostics === undefined ? [] : [[
        half,
        output.textToneDiagnostics,
    ]]));
    return {
        ...(evidence.automaticSplit === undefined ? {} : {automaticSplit: evidence.automaticSplit}),
        ...(Object.keys(automaticContentBoxes).length === 0 ? {} : {automaticContentBoxes}),
        ...(Object.keys(automaticSkewDegrees).length === 0 ? {} : {automaticSkewDegrees}),
        ...(Object.keys(resolvedTextToneDiagnostics).length === 0
            ? {}
            : {resolvedTextToneDiagnostics}),
    };
}

export interface IScanCleanupExperimentalOptions {
    autoDewarp: boolean;
    autoDewarpDepth?: number;
}

const DEFAULT_SCAN_CLEANUP_EXPERIMENTAL_OPTIONS: Readonly<IScanCleanupExperimentalOptions> = Object.freeze({autoDewarp: false});

export type TScanCleanupQualityPath = 'raster' | 'lossless';

export interface IResolveEffectiveScanCleanupOptionsInput {
    options: IScanCleanupOptions;
    pageOverride: IScanCleanupPageOverride;
    dpi: number;
    sourceDpi?: number;
    sourceHasBilevelLayer?: boolean;
    sourceBackgroundDpi?: number;
    requestedRenderDpi?: number;
    renderCrop?: INativeScanCleanupOptionsV3['renderCrop'];
    resolvedOutputMode?: TScanCleanupOutputMode;
    preferSoftAlphaForeground?: boolean;
    resolvedTextToneDiagnostics?: INativeScanCleanupOptionsV3['resolvedTextToneDiagnostics'];
    observedLayout?: TScanCleanupLayoutClassification;
    automaticSplit?: INativeScanCleanupOptionsV3['automaticSplit'];
    automaticContentBoxes?: INativeScanCleanupOptionsV3['automaticContentBoxes'];
    automaticSkewDegrees?: INativeScanCleanupOptionsV3['automaticSkewDegrees'];
    placementAnchors?: INativeScanCleanupOptionsV3['placementAnchors'];
    qualityPath: TScanCleanupQualityPath;
    experimental?: IScanCleanupExperimentalOptions;
}

export interface IEffectiveNativeScanCleanupOptionsV3 extends INativeScanCleanupOptionsV3 {
    despeckleLevel: TScanCleanupDespeckleLevel;
    manualZones: IScanCleanupManualZones;
}

export const SCAN_CLEANUP_MAX_BILEVEL_PIXELS = 160_000_000;
export const SCAN_CLEANUP_MAX_CONTINUOUS_TONE_PIXELS = 80_000_000;
export const SCAN_CLEANUP_MAX_DIMENSION_PX = 40_000;

/**
 * One canvas is shared by every output of the document, so it has to fit the
 * tightest budget any of them can be rendered under — but only the budgets the
 * document's own settings can actually produce. A document that is bilevel
 * throughout is normalized onto the bilevel grid, which is twice the pixels a
 * continuous-tone page is allowed; enabling colour output is what lowers it,
 * rather than the mere possibility of colour somewhere.
 *
 * `auto` counts as continuous-tone: the engine resolves it per page from the
 * pixels, so a canvas sized for a binary layer could be a grid a page resolved
 * to colour is not allowed to be rendered on.
 */
export function resolveScanCleanupMatchedCanvasMaxPixels(
    configuredModes: Iterable<TScanCleanupOutputModeSetting>,
) {
    for (const mode of configuredModes) {
        if (mode !== 'bw') {
            return SCAN_CLEANUP_MAX_CONTINUOUS_TONE_PIXELS;
        }
    }
    return SCAN_CLEANUP_MAX_BILEVEL_PIXELS;
}

// An unresolved (absent) mode gets the bilevel budget because the native
// engine may still resolve the page to a binary layer.
export function resolveScanCleanupPipelineMaxPixels(
    outputMode?: TScanCleanupOutputMode,
) {
    return outputMode === undefined || outputMode === 'bw'
        ? SCAN_CLEANUP_MAX_BILEVEL_PIXELS
        : SCAN_CLEANUP_MAX_CONTINUOUS_TONE_PIXELS;
}

// Tonal layers do not own crisp text on mixed pages; the high-resolution
// bilevel mask does. Raising every background/full-page JPEG into the
// near-lossless range bloats compact scans without creating source detail.
export const SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY = 85;
export const SCAN_CLEANUP_COLOR_JPEG_QUALITY = 87;

export function resolveTonalJpegQuality(mode: TScanCleanupOutputMode) {
    if (mode === 'color') {
        return SCAN_CLEANUP_COLOR_JPEG_QUALITY;
    }
    if (mode === 'grayscale' || mode === 'mixed') {
        return SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY;
    }
    return undefined;
}

// What a page is measured at when nothing has measured it yet: one page view in
// points, which is the cheapest render Poppler can be asked for.
export const SCAN_CLEANUP_SIZE_PROBE_DPI = 72;

/**
 * The resolution a page may actually be rendered at: what was asked for, held
 * inside the pixel budget its output mode allows and the largest dimension the
 * engine accepts, measured from a raster of that page at a known resolution.
 */
function resolveSafeRenderDpi(
    requestedRenderDpi: number,
    maxPixels: number,
    probe: {
        dpi: number;
        width: number;
        height: number
    },
) {
    return Math.max(1, Math.floor(Math.min(
        requestedRenderDpi,
        probe.dpi * Math.min(SCAN_CLEANUP_MAX_DIMENSION_PX / probe.width, SCAN_CLEANUP_MAX_DIMENSION_PX / probe.height),
        probe.dpi * Math.sqrt(maxPixels / (probe.width * probe.height)),
    )));
}

/**
 * The pixel guardrail a page can be planned against without rendering it: the
 * raster row pdfimages reported, or the page's own paper turned the way it is
 * displayed, which is what a size probe would have measured. A page outside a
 * run's scope is planned from this, so the document's pixel grid is the same
 * whether or not that page was one of the pages cleaned.
 */
export function resolveScanCleanupDocumentGuardrail(
    detected: {
        width: number;
        height: number
    } | undefined,
    sourceDpi: number | undefined,
    pageSize: IPdfPageSize | undefined,
) {
    if (detected !== undefined && sourceDpi !== undefined) {
        return {
            dpi: sourceDpi,
            width: detected.width,
            height: detected.height,
        };
    }
    if (pageSize === undefined) {
        return undefined;
    }
    const swapsAxes = Math.abs(Math.round(pageSize.rotation / 90)) % 2 === 1;
    return {
        dpi: SCAN_CLEANUP_SIZE_PROBE_DPI,
        width: (swapsAxes ? pageSize.heightPoints : pageSize.widthPoints) / 72 * SCAN_CLEANUP_SIZE_PROBE_DPI,
        height: (swapsAxes ? pageSize.widthPoints : pageSize.heightPoints) / 72 * SCAN_CLEANUP_SIZE_PROBE_DPI,
    };
}

// A page with no measurable source raster may still contain vector text that
// cleanup must synthesize into a binary layer. Give only that synthesized
// raster a 600-DPI floor. Re-rendering an existing scan above its measured
// sample grid cannot recover detail, but it multiplies Poppler, FIFO, native,
// and output work quadratically.
const SCAN_CLEANUP_SYNTHETIC_BINARY_RENDER_DPI_FLOOR = 600;

export function resolveScanCleanupRequestedRenderDpi(
    {
        sourceDpi,
        outputCarriesBinaryLayer,
        sourceRasterDetected,
    }: {
        sourceDpi: number;
        outputCarriesBinaryLayer: boolean;
        sourceRasterDetected: boolean;
    },
) {
    return outputCarriesBinaryLayer && !sourceRasterDetected
        ? Math.max(sourceDpi, SCAN_CLEANUP_SYNTHETIC_BINARY_RENDER_DPI_FLOOR)
        : sourceDpi;
}

export interface IResolveScanCleanupPlannedDpiInput {
    sourceDpi: number;
    outputCarriesBinaryLayer: boolean;
    sourceRasterDetected: boolean;
    maxPixels: number;
    guardrail: {
        dpi: number;
        width: number;
        height: number
    } | undefined;
}

/**
 * The resolution a page is planned at: existing rasters keep their measured
 * source grid, while a page synthesizing a binary layer without a source
 * raster gets the floor above. All paths remain inside the pixel budget their
 * guardrail allows.
 */
export function resolveScanCleanupPlannedDpi({
    sourceDpi,
    outputCarriesBinaryLayer,
    sourceRasterDetected,
    maxPixels,
    guardrail,
}: IResolveScanCleanupPlannedDpiInput) {
    const requestedRenderDpi = resolveScanCleanupRequestedRenderDpi({
        sourceDpi,
        outputCarriesBinaryLayer,
        sourceRasterDetected,
    });
    return {
        sourceDpi,
        requestedRenderDpi,
        dpi: guardrail === undefined
            ? requestedRenderDpi
            : resolveSafeRenderDpi(requestedRenderDpi, maxPixels, guardrail),
    };
}

/**
 * The resolution one page contributes to the document's shared canvas.
 *
 * It reads the output mode the page is *configured* with — its override, or the
 * document's setting — rather than the mode a run resolved for it: a canvas
 * that moved when detection recommended a mode, or when a selection resolved
 * fewer pages than a full run, would make the same page a different size
 * depending on when it was cleaned. `auto` therefore takes the binary synthesis
 * floor only when the page has no measured source raster.
 */
export function resolveScanCleanupCanvasPageDpi(
    input: Omit<IResolveScanCleanupPlannedDpiInput, 'outputCarriesBinaryLayer' | 'maxPixels'>
        & {configuredMode: TScanCleanupOutputModeSetting},
) {
    return resolveScanCleanupPlannedDpi({
        ...input,
        outputCarriesBinaryLayer: input.configuredMode !== 'grayscale' && input.configuredMode !== 'color',
        maxPixels: resolveScanCleanupMatchedCanvasMaxPixels([input.configuredMode]),
    }).dpi;
}

function resolveScanCleanupDespeckleLevel(
    options: IScanCleanupOptions,
): TScanCleanupDespeckleLevel {
    const legacyEnabled = options.despeckle ?? true;
    return options.despeckleLevel ?? (legacyEnabled ? 'normal' : 'off');
}

export function resolveEffectiveScanCleanupOptions({
    options,
    pageOverride,
    dpi,
    sourceDpi = dpi,
    sourceHasBilevelLayer = false,
    sourceBackgroundDpi,
    requestedRenderDpi = dpi,
    renderCrop,
    resolvedOutputMode,
    preferSoftAlphaForeground,
    resolvedTextToneDiagnostics,
    observedLayout,
    automaticSplit,
    automaticContentBoxes,
    automaticSkewDegrees,
    placementAnchors,
    qualityPath,
    experimental = DEFAULT_SCAN_CLEANUP_EXPERIMENTAL_OPTIONS,
}: IResolveEffectiveScanCleanupOptionsInput): IEffectiveNativeScanCleanupOptionsV3 {
    const lossless = qualityPath === 'lossless';
    const outputMode = lossless
        ? 'color'
        : resolvedOutputMode ?? resolveScanCleanupEffectiveOutputMode({
            options,
            pageOverride,
        }) ?? 'auto';
    const autoResolvedColor = !lossless
        && options.outputMode === 'auto'
        && pageOverride.outputModeOverride === undefined
        && resolvedOutputMode === 'color';
    const hasBinaryLayer = outputMode === 'auto' || outputMode === 'bw' || outputMode === 'mixed';
    const dewarpRequested = !lossless && experimental.autoDewarp;
    const despeckleLevel = !lossless && hasBinaryLayer
        ? resolveScanCleanupDespeckleLevel(options)
        : 'off';
    const configuredLayout = resolveScanCleanupPageLayout(options.layoutMode, pageOverride.layoutOverride);
    const layout = configuredLayout !== 'auto' || pageOverride.manualSplit !== null
        ? configuredLayout
        : observedLayout === 'single-uncut-page'
            ? 'force-single'
            : observedLayout === 'two-page-spread' && automaticSplit !== undefined
                ? 'force-two-page'
                : observedLayout === 'page-with-offcut' && automaticSplit !== undefined
                    ? 'page-with-offcut'
                    // A split label without its normalized cutter is not a render
                    // plan. Re-running only the label at another DPI can select a
                    // different gutter and delete real page content.
                    : 'auto';
    return {
        dpi,
        sourceDpi,
        ...(sourceHasBilevelLayer ? {sourceHasBilevelLayer: true} : {}),
        ...(sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi}),
        requestedRenderDpi,
        ...(renderCrop === undefined ? {} : {renderCrop}),
        binarization: options.binarization ?? 'auto',
        thickness: lossless ? 0 : options.thickness,
        // Auto Color is an abstention: detection found continuous-tone/color
        // content rather than paper plus ink. Normalizing it would make preview
        // differ from the unchanged compact source objects final assembly keeps.
        // Explicit Color remains user-controlled and may normalize.
        normalizeIllumination: !lossless
            && !autoResolvedColor
            && (options.normalizeIllumination ?? true),
        despeckle: despeckleLevel !== 'off',
        despeckleLevel,
        outputMode,
        ...(preferSoftAlphaForeground === undefined ? {} : {preferSoftAlphaForeground}),
        ...(resolvedTextToneDiagnostics === undefined ? {} : {resolvedTextToneDiagnostics}),
        ocrMode: false,
        // Detection is durable page evidence, not merely a canvas hint. Reuse
        // it when the user left layout automatic so preview/final rendering do
        // not repeat the same split classification. Explicit user choices and
        // manual cutters always win.
        layout,
        manualSplit: pageOverride.manualSplit,
        ...(automaticSplit === undefined ? {} : {automaticSplit}),
        ...(pageOverride.manualSkewDegrees === undefined
            ? {}
            : {manualSkewDegrees: pageOverride.manualSkewDegrees}),
        manualContentBoxes: pageOverride.manualContentBoxes ?? {},
        ...(automaticContentBoxes === undefined ? {} : {automaticContentBoxes}),
        ...(automaticSkewDegrees === undefined ? {} : {automaticSkewDegrees}),
        manualZones: pageOverride.manualZones ?? {
            picture: [],
            fill: [],
        },
        cropContent: options.crop,
        matchPageSize: options.matchPageSize,
        pageAlignment: options.pageAlignment,
        placementOverrides: pageOverride.placementOverrides ?? {},
        ...(placementAnchors === undefined ? {} : {placementAnchors}),
        margins: {...resolveScanCleanupMarginsMm(options.marginsMm, pageOverride)},
        experimental: {
            autoDewarp: dewarpRequested,
            ...(dewarpRequested && experimental.autoDewarpDepth !== undefined
                ? {autoDewarpDepth: experimental.autoDewarpDepth}
                : {}),
        },
        rotationDegrees: pageOverride.rotationDegrees,
        excluded: pageOverride.excluded,
        skipBlankPages: !lossless && options.skipBlankPages,
        maxPixels: resolveScanCleanupPipelineMaxPixels(outputMode === 'auto' ? undefined : outputMode),
        maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
    };
}
