import type {
    INativeScanCleanupManifestV3,
    INativeScanCleanupOutputV3,
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupOptions,
    TNativeScanCleanupOperation,
    TNativeScanCleanupRenderMode,
    TScanCleanupCanvasScope,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    SCAN_CLEANUP_MAX_STAGED_INPUT_PEAK_PIXELS,
    SCAN_CLEANUP_MAX_STAGED_INPUT_WINDOW,
} from '@contracts/scan-cleanup/stagedInputWindow';
import {SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES} from '@contracts/scan-cleanup/inputLimits';
import type {
    IScanCleanupExperimentalOptions,
    TScanCleanupQualityPath,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {
    clampNativeLimit,
    resolveScanCleanupManifestPageOptions,
    serializeScanCleanupManifestDocumentPrior,
    type IScanCleanupManifestPageFacts,
} from '@evb/scan-cleanup/core/policy/scanCleanupManifestPagePolicy';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';

export {serializeNativeScanCleanupOptions} from '@evb/scan-cleanup/core/policy/scanCleanupManifestPagePolicy';

export interface IScanCleanupManifestPageInput extends IScanCleanupManifestPageFacts {
    inputPath: string;
    analysisInputPath?: string;
    analysisDpi?: number;
    trustedForegroundMaskPath?: string;
    trustedMrcBackgroundPath?: string;
    pageMetadataPath: string;
    outputs?: INativeScanCleanupOutputV3[];
    detailRenderPlan?: INativeScanCleanupManifestV3['pages'][number]['detailRenderPlan'];
    /** Where the page's wider view is staged when the engine asks for it. */
    alternateInputPath?: string;
    alternateView?: IScanCleanupAlternateViewInput;
}

/** A wider view of the page (its MediaBox) and the facts its analysis is resolved from. */
export interface IScanCleanupAlternateViewInput {
    primaryWidthPoints: number;
    primaryHeightPoints: number;
    widthPoints: number;
    heightPoints: number;
    page: IScanCleanupManifestPageFacts;
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
    /** Optional host-admission cap that must also bound native page rasters. */
    rasterMaxPixels?: number;
}

/**
 * `allowedPathRoot` is the process-owned directory every path in this manifest
 * must resolve inside. A runnable manifest is launched against a native binary,
 * so the root is required rather than optional.
 */
export interface IBuildRunnableNativeScanCleanupManifestInput extends IBuildNativeScanCleanupManifestInput {allowedPathRoot: string;}

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
export const MANIFEST_PAGE_PATH_FIELDS = defineManifestPathFields<TManifestPage & IScanCleanupManifestPageInput>()([
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
    {
        field: 'alternateInputPath',
        label: 'alternate input path',
    },
]);

export const MANIFEST_OUTPUT_PATH_FIELDS = defineManifestPathFields<INativeScanCleanupOutputV3>()([
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

export const MANIFEST_DETAIL_RENDER_PLAN_PATH_FIELDS = defineManifestPathFields<TManifestDetailRenderPlan>()([
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

/**
 * Judges a runnable manifest's paths: each page's slots as it is assembled,
 * then the whole manifest. Desktop supplies one; the browser's WASM requests
 * carry planes, not paths, and build shape-only.
 */
export interface IScanCleanupManifestPathCheck {
    page: (page: IScanCleanupManifestPageInput, pageIndex: number) => void;
    manifest: (manifest: INativeScanCleanupManifestV3) => void;
}

export function assembleNativeScanCleanupManifest({
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
    stagedInputWindow,
    stagedInputPeakPixels,
    rasterMaxPixels,
}: IBuildNativeScanCleanupManifestInput, pathCheck: IScanCleanupManifestPathCheck | null): INativeScanCleanupManifestV3 {
    if (pages.length > SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES) {
        throw new ScanCleanupContractError(
            `One native scan-cleanup manifest may contain at most ${String(SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES)} page records; replay bounded batches for longer documents`,
        );
    }
    const manifest: INativeScanCleanupManifestV3 = {
        version: SCAN_CLEANUP_NATIVE_PROTOCOL_VERSION,
        operation,
        ...(analysisPurpose === undefined ? {} : {analysisPurpose}),
        renderMode,
        canvasScope,
        ...(documentCanvas === undefined ? {} : {documentCanvas}),
        ...(hostMemoryBytes !== undefined && hostMemoryBytes > 0 ? {hostMemoryBytes} : {}),
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
            if ((page.alternateInputPath === undefined) !== (page.alternateView === undefined)) {
                throw new ScanCleanupContractError(
                    `page ${String(pageIndex + 1)} alternate view requires its alternate input path`,
                );
            }
            pathCheck?.page(page, pageIndex);
            const resolvePageOptions = (facts: IScanCleanupManifestPageFacts) => resolveScanCleanupManifestPageOptions({
                options,
                ...(analysisPurpose === undefined ? {} : {analysisPurpose}),
                qualityPath,
                ...(experimental === undefined ? {} : {experimental}),
                ...(rasterMaxPixels === undefined ? {} : {rasterMaxPixels}),
                page: facts,
            });
            const pageOptions = resolvePageOptions(page);
            const alternate = page.alternateView;
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
                options: pageOptions,
                outputs: page.outputs ?? [],
                ...(page.documentPrior == null
                    ? {}
                    : {documentPrior: serializeScanCleanupManifestDocumentPrior(page.documentPrior)}),
                ...(page.detailRenderPlan === undefined ? {} : {detailRenderPlan: page.detailRenderPlan}),
                ...(page.pdfPage === undefined ? {} : {pdfPage: page.pdfPage}),
                ...(alternate === undefined
                    ? {}
                    : {
                        alternateInputPath: page.alternateInputPath,
                        alternateView: {
                            primaryWidthPoints: alternate.primaryWidthPoints,
                            primaryHeightPoints: alternate.primaryHeightPoints,
                            widthPoints: alternate.widthPoints,
                            heightPoints: alternate.heightPoints,
                            options: resolvePageOptions(alternate.page),
                        },
                    }),
            };
        }),
    };
    pathCheck?.manifest(manifest);
    return manifest;
}

/**
 * Build a shape-only manifest for geometry and protocol tests.
 *
 * This wrapper deliberately skips path validation and must never be used for a
 * manifest passed to a native sidecar; the browser uses it for WASM requests,
 * which carry no paths. Runnable callers use
 * {@link buildRunnableNativeScanCleanupManifest}, which requires its allowed
 * path root and validates every emitted path.
 */
export function buildShapeOnlyNativeScanCleanupManifest(
    input: IBuildNativeScanCleanupManifestInput,
): INativeScanCleanupManifestV3 {
    return assembleNativeScanCleanupManifest(input, null);
}
