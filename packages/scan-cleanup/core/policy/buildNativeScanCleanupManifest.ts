import type {
    INativeScanCleanupManifestV3,
    INativeScanCleanupOutputV3,
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupDocumentPrior,
    IScanCleanupOptions,
    TNativeScanCleanupOperation,
    TNativeScanCleanupRenderMode,
    TScanCleanupCanvasScope,
    TScanCleanupLayoutClassification,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';
import {SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION} from '@contracts/electronApiScanCleanup';
import {
    SCAN_CLEANUP_MAX_STAGED_INPUT_PEAK_PIXELS,
    SCAN_CLEANUP_MAX_STAGED_INPUT_WINDOW,
} from '@contracts/scan-cleanup/stagedInputWindow';
import {getScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import { requirePageNumber } from '@contracts/pageNumbers';
import {SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {
    resolveEffectiveScanCleanupOptions,
    resolveScanCleanupPipelineMaxPixels,
    SCAN_CLEANUP_MAX_DIMENSION_PX,
    type IEffectiveNativeScanCleanupOptionsV3,
    type IScanCleanupExperimentalOptions,
    type TScanCleanupQualityPath,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';
import {
    assertScanCleanupPathWithinCanonicalRoot,
    canonicalizeScanCleanupAllowedRoot,
    type IScanCleanupAllowedRoot,
} from '@evb/scan-cleanup/core/assertScanCleanupPathWithinRoot';

export interface IScanCleanupManifestPageInput {
    inputPath: string;
    analysisInputPath?: string;
    analysisDpi?: number;
    trustedForegroundMaskPath?: string;
    trustedMrcBackgroundPath?: string;
    pageNumber: number;
    dpi: number;
    sourceDpi?: number;
    sourceHasBilevelLayer?: boolean;
    sourceBackgroundDpi?: number;
    requestedRenderDpi?: number;
    renderCrop?: INativeScanCleanupManifestV3['pages'][number]['options']['renderCrop'];
    resolvedOutputMode?: TScanCleanupOutputMode;
    preferSoftAlphaForeground?: boolean;
    resolvedTextToneDiagnostics?: INativeScanCleanupManifestV3['pages'][number]['options']['resolvedTextToneDiagnostics'];
    observedLayout?: TScanCleanupLayoutClassification;
    automaticSplit?: INativeScanCleanupManifestV3['pages'][number]['options']['automaticSplit'];
    automaticContentBoxes?: INativeScanCleanupManifestV3['pages'][number]['options']['automaticContentBoxes'];
    automaticSkewDegrees?: INativeScanCleanupManifestV3['pages'][number]['options']['automaticSkewDegrees'];
    placementAnchors?: INativeScanCleanupManifestV3['pages'][number]['options']['placementAnchors'];
    /** Trusted replay values supplied by a core consumer such as the corpus harness. */
    resolvedOptions?: Partial<IEffectiveNativeScanCleanupOptionsV3>;
    pageMetadataPath: string;
    outputs?: INativeScanCleanupOutputV3[];
    documentPrior?: IScanCleanupDocumentPrior;
    detailRenderPlan?: INativeScanCleanupManifestV3['pages'][number]['detailRenderPlan'];
}

export interface IBuildNativeScanCleanupManifestInput {
    operation: TNativeScanCleanupOperation;
    analysisPurpose?: INativeScanCleanupManifestV3['analysisPurpose'];
    renderMode: TNativeScanCleanupRenderMode;
    canvasScope: TScanCleanupCanvasScope;
    qualityPath: TScanCleanupQualityPath;
    options: IScanCleanupOptions;
    pages: IScanCleanupManifestPageInput[];
    documentCanvas?: IScanCleanupDocumentCanvasPlan;
    experimental?: IScanCleanupExperimentalOptions;
    hostMemoryBytes?: number;
    rasterWindow?: number;
    /**
     * Bounded number of replayable Analyze page rasters this process keeps
     * staged at once. Declaring it moves the sidecar onto the staged-input
     * lease protocol, so an input that is absent at admission is expected.
     */
    stagedInputWindow?: number;
    /**
     * Pixels in the largest raster that window will stage. The sidecar sizes
     * its page pool from it while most inputs are still unrendered.
     */
    stagedInputPeakPixels?: number;
}

/**
 * `allowedPathRoot` is the process-owned directory every path in this manifest
 * must resolve inside. A runnable manifest is launched against a native binary,
 * so the root is required rather than optional.
 */
export interface IBuildRunnableNativeScanCleanupManifestInput extends IBuildNativeScanCleanupManifestInput {allowedPathRoot: string;}

function clampNativeLimit(value: unknown, maximum: number, label: string) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new ScanCleanupContractError(`${label} must be a number`);
    }
    return Math.min(maximum, Math.max(1, Math.floor(value)));
}

type TManifestPage = INativeScanCleanupManifestV3['pages'][number];

type TManifestDetailRenderPlan = NonNullable<TManifestPage['detailRenderPlan']>;

type TPathFieldKey<T> = {[K in keyof T]-?: K extends `${string}Path` ? K : never}[keyof T];

interface IManifestPathField<T> {
    field: TPathFieldKey<T>;
    /** Trailing part of the containment error label for this field. */
    label: string;
}

/**
 * Accept a descriptor list only when it names every path field of the shape it
 * validates. A new path slot in the protocol or in the builder input therefore
 * fails to compile until it is given a label here, instead of silently
 * shipping unchecked.
 */
function defineManifestPathFields<T>() {
    return <TFields extends ReadonlyArray<IManifestPathField<T>>>(
        fields: TFields
            & (Exclude<TPathFieldKey<T>, TFields[number]['field']> extends never
                ? unknown
                : {unlabelledManifestPathField: Exclude<TPathFieldKey<T>, TFields[number]['field']>}),
    ): TFields => fields;
}

/**
 * Every path-bearing manifest slot, in the order the builder judges it. The
 * page list is defined over both the emitted page and the builder input, so
 * neither side can grow a path the other does not know about.
 */
const MANIFEST_PAGE_PATH_FIELDS = defineManifestPathFields<TManifestPage & IScanCleanupManifestPageInput>()([
    {
        field: 'inputPath',
        label: 'input path',
    },
    {
        field: 'analysisInputPath',
        label: 'analysis input path',
    },
    {
        field: 'pageMetadataPath',
        label: 'metadata path',
    },
    {
        field: 'trustedForegroundMaskPath',
        label: 'trusted foreground mask path',
    },
    {
        field: 'trustedMrcBackgroundPath',
        label: 'trusted MRC background path',
    },
]);

const MANIFEST_OUTPUT_PATH_FIELDS = defineManifestPathFields<INativeScanCleanupOutputV3>()([
    {
        field: 'outputPath',
        label: 'output path',
    },
    {
        field: 'metadataPath',
        label: 'metadata path',
    },
    {
        field: 'bilevelOutputPath',
        label: 'bilevel output path',
    },
    {
        field: 'backgroundOutputPath',
        label: 'background output path',
    },
    {
        field: 'foregroundMaskOutputPath',
        label: 'foreground mask output path',
    },
    {
        field: 'foregroundAlphaOutputPath',
        label: 'foreground alpha output path',
    },
    {
        field: 'pictureMaskOutputPath',
        label: 'picture mask output path',
    },
    {
        field: 'tonePreservationAlphaOutputPath',
        label: 'tone-preservation alpha output path',
    },
]);

const MANIFEST_DETAIL_RENDER_PLAN_PATH_FIELDS = defineManifestPathFields<TManifestDetailRenderPlan>()([
    {
        field: 'baseMetadataPath',
        label: 'detail base metadata path',
    },
    {
        field: 'baseRasterPath',
        label: 'detail base raster path',
    },
    {
        field: 'baseCleanedRasterPath',
        label: 'detail base cleaned raster path',
    },
]);

function assertManifestPagePaths(
    page: IScanCleanupManifestPageInput,
    pageIndex: number,
    allowedRoot: IScanCleanupAllowedRoot,
    checkedPathTrails: Map<string, string>,
) {
    const pageLabel = `page ${String(pageIndex + 1)}`;
    const pageTrail = `pages.${String(pageIndex)}`;
    const check = (path: string | undefined, trail: string, label: string) => {
        if (path === undefined) {
            return;
        }
        assertScanCleanupPathWithinCanonicalRoot(path, allowedRoot, label);
        // Keyed by the field trail the manifest emits, not by the path value: a
        // slot this list never judged cannot borrow the verdict of a checked
        // slot that happens to carry the same string.
        checkedPathTrails.set(trail, path);
    };
    for (const {
        field,
        label,
    } of MANIFEST_PAGE_PATH_FIELDS) check(page[field], `${pageTrail}.${field}`, `${pageLabel} ${label}`);
    for (const [
        outputIndex,
        output,
    ] of (page.outputs ?? []).entries()) {
        for (const {
            field,
            label,
        } of MANIFEST_OUTPUT_PATH_FIELDS) {
            check(
                output[field],
                `${pageTrail}.outputs.${String(outputIndex)}.${field}`,
                `${pageLabel} output ${String(outputIndex)} ${label}`,
            );
        }
    }
    const detailRenderPlan = page.detailRenderPlan;
    if (detailRenderPlan === undefined) {
        return;
    }
    for (const {
        field,
        label,
    } of MANIFEST_DETAIL_RENDER_PLAN_PATH_FIELDS) {
        check(
            detailRenderPlan[field],
            `${pageTrail}.detailRenderPlan.${field}`,
            `${pageLabel} ${label}`,
        );
    }
}

/**
 * Last word on coverage: a runnable manifest may not carry a path string that
 * containment never judged. Descriptor lists say what is checked; this says
 * that nothing else reached the wire, including a slot copied verbatim from
 * caller input.
 *
 * Coverage is matched per emitted field trail, so an unlabelled path slot fails
 * even when it repeats a string some other slot was cleared for.
 */
function assertNoUncheckedManifestPaths(
    manifest: INativeScanCleanupManifestV3,
    checkedPathTrails: ReadonlyMap<string, string>,
) {
    const visit = (value: unknown, trail: string) => {
        if (Array.isArray(value)) {
            for (const [
                index,
                entry,
            ] of value.entries()) visit(entry, `${trail}.${String(index)}`);
            return;
        }
        if (value === null || typeof value !== 'object') {
            return;
        }
        for (const [
            key,
            entry,
        ] of Object.entries(value)) {
            const fieldTrail = trail === '' ? key : `${trail}.${key}`;
            if (key.endsWith('Path') && typeof entry === 'string' && checkedPathTrails.get(fieldTrail) !== entry) {
                throw new ScanCleanupContractError(
                    `manifest field ${fieldTrail} was not checked against the allowed root`,
                );
            }
            visit(entry, fieldTrail);
        }
    };
    visit(manifest, '');
}

function assertManifestOutputContract(
    page: IScanCleanupManifestPageInput,
    pageIndex: number,
) {
    for (const [
        outputIndex,
        output,
    ] of (page.outputs ?? []).entries()) {
        const foregroundPlane = output.foregroundAlphaOutputPath !== undefined
            ? 'soft-alpha'
            : output.foregroundMaskOutputPath !== undefined
                ? 'soft-mask'
                : undefined;
        if (foregroundPlane !== undefined && output.backgroundOutputPath === undefined) {
            throw new ScanCleanupContractError(
                `page ${String(pageIndex + 1)} output ${String(outputIndex)} declares a ${foregroundPlane} plane without a base background image`,
            );
        }
    }
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

function assembleNativeScanCleanupManifest({
    operation,
    analysisPurpose,
    renderMode,
    canvasScope,
    qualityPath,
    options,
    pages,
    documentCanvas,
    experimental,
    hostMemoryBytes,
    rasterWindow,
    stagedInputWindow,
    stagedInputPeakPixels,
}: IBuildNativeScanCleanupManifestInput, allowedPathRoot: string | null): INativeScanCleanupManifestV3 {
    if (pages.length > SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES) {
        throw new ScanCleanupContractError(
            `One native scan-cleanup manifest may contain at most ${String(SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES)} page records; replay bounded batches for longer documents`,
        );
    }
    // One canonical root per manifest: every field is judged against the same
    // resolved directory instead of re-resolving the root for each path.
    const allowedRoot = allowedPathRoot === null ? null : canonicalizeScanCleanupAllowedRoot(allowedPathRoot);
    const checkedPathTrails = new Map<string, string>();
    const manifest: INativeScanCleanupManifestV3 = {
        version: SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
        operation,
        ...(analysisPurpose === undefined ? {} : {analysisPurpose}),
        renderMode,
        canvasScope,
        ...(documentCanvas === undefined ? {} : {documentCanvas}),
        ...(hostMemoryBytes !== undefined && hostMemoryBytes > 0 ? {hostMemoryBytes} : {}),
        ...(rasterWindow === undefined
            ? {}
            : {rasterWindow: clampNativeLimit(rasterWindow, 16, 'rasterWindow')}),
        ...(stagedInputWindow === undefined
            ? {}
            : {stagedInputWindow: clampNativeLimit(
                stagedInputWindow,
                SCAN_CLEANUP_MAX_STAGED_INPUT_WINDOW,
                'stagedInputWindow',
            )}),
        ...(stagedInputWindow === undefined || stagedInputPeakPixels === undefined
            ? {}
            : {stagedInputPeakPixels: clampNativeLimit(
                stagedInputPeakPixels,
                SCAN_CLEANUP_MAX_STAGED_INPUT_PEAK_PIXELS,
                'stagedInputPeakPixels',
            )}),
        pages: pages.map((page, pageIndex) => {
            assertManifestOutputContract(page, pageIndex);
            if (
                (page.analysisInputPath === undefined) !== (page.analysisDpi === undefined)
                || (page.analysisDpi !== undefined
                    && (!Number.isFinite(page.analysisDpi) || page.analysisDpi <= 0))
            ) {
                throw new ScanCleanupContractError(
                    `page ${String(pageIndex + 1)} fixed analysis input requires a positive analysisDpi`,
                );
            }
            if (allowedRoot !== null) assertManifestPagePaths(page, pageIndex, allowedRoot, checkedPathTrails);
            const resolvedOptions = {
                ...resolveEffectiveScanCleanupOptions({
                    options,
                    pageOverride: getScanCleanupPageOverride(
                        options.pageOverrides,
                        requirePageNumber(page.pageNumber),
                    ),
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
                    ...(page.resolvedOutputMode === undefined
                        ? {}
                        : {resolvedOutputMode: page.resolvedOutputMode}),
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
                // be echoed back as the newly detected automatic content box.
                ...(analysisPurpose === 'page-plan' ? {manualContentBoxes: {}} : {}),
            };
            const maxPixels = resolveScanCleanupPipelineMaxPixels(
                resolvedOptions.outputMode === 'auto' ? undefined : resolvedOptions.outputMode,
            );
            return {
                inputPath: page.inputPath,
                ...(page.analysisInputPath === undefined
                    ? {}
                    : {
                        analysisInputPath: page.analysisInputPath,
                        analysisDpi: page.analysisDpi,
                    }),
                ...(page.trustedForegroundMaskPath === undefined
                    ? {}
                    : {trustedForegroundMaskPath: page.trustedForegroundMaskPath}),
                ...(page.trustedMrcBackgroundPath === undefined
                    ? {}
                    : {trustedMrcBackgroundPath: page.trustedMrcBackgroundPath}),
                sourcePageIndex: page.pageNumber - 1,
                pageMetadataPath: page.pageMetadataPath,
                options: serializeNativeScanCleanupOptions({
                    ...resolvedOptions,
                    maxPixels: clampNativeLimit(resolvedOptions.maxPixels, maxPixels, 'maxPixels'),
                    maxDimensionPx: clampNativeLimit(
                        resolvedOptions.maxDimensionPx,
                        SCAN_CLEANUP_MAX_DIMENSION_PX,
                        'maxDimensionPx',
                    ),
                }),
                outputs: page.outputs ?? [],
                ...(page.documentPrior === undefined ? {} : {documentPrior: page.documentPrior}),
                ...(page.detailRenderPlan === undefined ? {} : {detailRenderPlan: page.detailRenderPlan}),
            };
        }),
    };
    if (allowedRoot !== null) assertNoUncheckedManifestPaths(manifest, checkedPathTrails);
    return manifest;
}

/**
 * Build a manifest that will be handed to the native binary. Every path is
 * checked against the caller's process-owned root before the manifest exists.
 */
export function buildRunnableNativeScanCleanupManifest(
    input: IBuildRunnableNativeScanCleanupManifestInput,
): INativeScanCleanupManifestV3 {
    return assembleNativeScanCleanupManifest(input, input.allowedPathRoot);
}

/**
 * Build a manifest only to validate shape and geometry. Callers use placeholder
 * paths here, so path containment neither applies nor can be checked. Never
 * hand the result to the native binary.
 */
export function buildGeometryOnlyNativeScanCleanupManifest(
    input: IBuildNativeScanCleanupManifestInput,
): INativeScanCleanupManifestV3 {
    return assembleNativeScanCleanupManifest(input, null);
}
