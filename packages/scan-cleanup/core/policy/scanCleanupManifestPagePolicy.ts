import type {
    INativeScanCleanupManifestV3,
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputMode,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {getScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    resolveEffectiveScanCleanupOptions,
    resolveScanCleanupPipelineMaxPixels,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
    type IEffectiveNativeScanCleanupOptionsV3,
    type IScanCleanupExperimentalOptions,
    type TScanCleanupQualityPath,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';

type TManifestPage = INativeScanCleanupManifestV3['pages'][number];
type TManifestPageOptions = TManifestPage['options'];

/**
 * What one manifest page says about its page, apart from the files it names:
 * the facts its options are resolved from. A desktop manifest page adds its
 * paths; a browser engine request carries the same options beside bytes.
 */
export interface IScanCleanupManifestPageFacts {
    pageNumber: number;
    dpi: number;
    sourceDpi?: number;
    sourceHasBilevelLayer?: boolean;
    sourceBackgroundDpi?: number;
    requestedRenderDpi?: number;
    renderCrop?: TManifestPageOptions['renderCrop'];
    resolvedOutputMode?: TScanCleanupOutputMode;
    preferSoftAlphaForeground?: boolean;
    resolvedTextToneDiagnostics?: TManifestPageOptions['resolvedTextToneDiagnostics'];
    observedLayout?: TScanCleanupLayoutClassification;
    automaticSplit?: TManifestPageOptions['automaticSplit'];
    automaticContentBoxes?: TManifestPageOptions['automaticContentBoxes'];
    automaticSkewDegrees?: TManifestPageOptions['automaticSkewDegrees'];
    placementAnchors?: TManifestPageOptions['placementAnchors'];
    /** Trusted replay values supplied by a core consumer such as the corpus harness. */
    resolvedOptions?: Partial<IEffectiveNativeScanCleanupOptionsV3>;
    documentPrior?: IScanCleanupDocumentPrior;
    pdfPage?: TManifestPage['pdfPage'];
}

export interface IResolveScanCleanupManifestPageOptionsInput {
    options: IScanCleanupOptions;
    analysisPurpose?: INativeScanCleanupManifestV3['analysisPurpose'];
    qualityPath: TScanCleanupQualityPath;
    experimental?: IScanCleanupExperimentalOptions;
    /** Optional host-admission cap that must also bound native page rasters. */
    rasterMaxPixels?: number;
    page: IScanCleanupManifestPageFacts;
}

export function clampNativeLimit(value: unknown, maximum: number, label: string) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new ScanCleanupContractError(`${label} must be a number`);
    }
    return Math.min(maximum, Math.max(1, Math.floor(value)));
}

export function serializeNativeScanCleanupOptions(
    options: IEffectiveNativeScanCleanupOptionsV3,
): INativeScanCleanupManifestV3['pages'][number]['options'] {
    const {
        despeckleLevel,
        manualZones,
        ...baselineOptions
    } = options;
    const derivedDespeckleLevel = options.despeckle ? 'normal' : 'off';
    const hasManualZones = manualZones.picture.length > 0 || manualZones.fill.length > 0;
    return {
        ...baselineOptions,
        ...(despeckleLevel === derivedDespeckleLevel ? {} : {despeckleLevel}),
        ...(hasManualZones ? {manualZones} : {}),
    };
}

/** One manifest page's native options: the run's options under that page's overrides and facts. */
export function resolveScanCleanupManifestPageOptions({
    options,
    analysisPurpose,
    qualityPath,
    experimental,
    rasterMaxPixels,
    page,
}: IResolveScanCleanupManifestPageOptionsInput): TManifestPageOptions {
    const pageOverride = getScanCleanupPageOverride(
        options.pageOverrides,
        requirePageNumber(page.pageNumber),
        options.pageOverrideDefaults,
        options.marginsMm,
    );
    // A page plan describes the page, not one output mode: it is
    // analyzed as for automatic mode, so switching the output mode never
    // leaves a run with plans measured under another.
    const pagePlan = analysisPurpose === 'page-plan';
    const {
        outputModeOverride: _outputModeOverride,
        ...automaticPageOverride
    } = pageOverride;
    const resolvedOutputMode = pagePlan ? undefined : page.resolvedOutputMode;
    const resolvedOptions = {
        ...resolveEffectiveScanCleanupOptions({
            options: pagePlan ? {
                ...options,
                outputMode: 'auto',
            } : options,
            pageOverride: pagePlan ? automaticPageOverride : pageOverride,
            dpi: page.dpi,
            ...(page.sourceDpi === undefined ? {} : {sourceDpi: page.sourceDpi}),
            ...(page.sourceHasBilevelLayer === undefined
                ? {}
                : {sourceHasBilevelLayer: page.sourceHasBilevelLayer}),
            ...(page.sourceBackgroundDpi === undefined
                ? {}
                : {sourceBackgroundDpi: page.sourceBackgroundDpi}),
            ...(page.requestedRenderDpi === undefined
                ? {}
                : {requestedRenderDpi: page.requestedRenderDpi}),
            ...(page.renderCrop === undefined ? {} : {renderCrop: page.renderCrop}),
            ...(resolvedOutputMode === undefined ? {} : {resolvedOutputMode}),
            ...(page.preferSoftAlphaForeground === undefined
                ? {}
                : {preferSoftAlphaForeground: page.preferSoftAlphaForeground}),
            ...(page.resolvedTextToneDiagnostics === undefined
                ? {}
                : {resolvedTextToneDiagnostics: page.resolvedTextToneDiagnostics}),
            ...(page.observedLayout === undefined
                ? {}
                : {observedLayout: page.observedLayout}),
            ...(page.automaticSplit === undefined
                ? {}
                : {automaticSplit: page.automaticSplit}),
            ...(page.automaticContentBoxes === undefined
                ? {}
                : {automaticContentBoxes: page.automaticContentBoxes}),
            ...(page.automaticSkewDegrees === undefined
                ? {}
                : {automaticSkewDegrees: page.automaticSkewDegrees}),
            ...(page.placementAnchors === undefined
                ? {}
                : {placementAnchors: page.placementAnchors}),
            qualityPath,
            ...(experimental === undefined ? {} : {experimental}),
        }),
        ...(page.resolvedOptions ?? {}),
        // Page-plan analysis owns automatic evidence. A manual crop is
        // a render override and must neither trigger detection again nor
        // be echoed back as the newly detected automatic content box. An
        // exclusion only decides whether the page reaches the output, so
        // an excluded page is still analyzed: its evidence stays current
        // when it is included again.
        ...(analysisPurpose === 'page-plan' ? {
            manualContentBoxes: {},
            excluded: false,
        } : {}),
    };
    const maxPixels = resolveScanCleanupPipelineMaxPixels(
        resolvedOptions.outputMode === 'auto' ? undefined : resolvedOptions.outputMode,
        rasterMaxPixels,
    );
    return serializeNativeScanCleanupOptions({
        ...resolvedOptions,
        maxPixels: clampNativeLimit(resolvedOptions.maxPixels, maxPixels, 'maxPixels'),
        maxDimensionPx: clampNativeLimit(
            resolvedOptions.maxDimensionPx,
            SCAN_CLEANUP_MAX_DIMENSION_PX,
            'maxDimensionPx',
        ),
    });
}

/** A page's document prior as the native manifest carries it. */
export function serializeScanCleanupManifestDocumentPrior(
    prior: IScanCleanupDocumentPrior,
): NonNullable<TManifestPage['documentPrior']> {
    return {
        dominantLayout: prior.dominantLayout,
        ...(prior.cutterRatioMedian === undefined
            ? {}
            : {cutterRatioMedian: prior.cutterRatioMedian}),
        clusterDims: prior.clusterDims,
        agreementStrength: prior.agreementStrength,
        ...(prior.strokeWidthMedianPx === undefined
            ? {}
            : {strokeWidthMedianPx: prior.strokeWidthMedianPx}),
        ...(prior.xHeightMedianPx === undefined
            ? {}
            : {xHeightMedianPx: prior.xHeightMedianPx}),
    };
}
