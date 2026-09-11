 

import {randomUUID} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupDetectionResult,
    IScanCleanupPagePlanEvidence,
    TScanCleanupProgress,
} from '@contracts/electronApiScanCleanup';
import type {
    INativeScanCleanupAnalysisOutputV3,
    INativeScanCleanupPageMetadataV3,
    TNativeScanCleanupProgressV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {decodeNativeScanCleanupPageMetadataJson} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {getErrorMessage} from '@contracts/getErrorMessage';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {SCAN_CLEANUP_MAX_STAGED_INPUT_WINDOW} from '@contracts/scan-cleanup/stagedInputWindow';
import {buildRunnableNativeScanCleanupManifest} from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {
    ScanCleanupContractError,
    ScanCleanupInsufficientScratchError,
    ScanCleanupNativeToolUnavailableError,
} from '@evb/scan-cleanup/core/errors';
import {preserveScanCleanupJsonEvidence} from '@evb/scan-cleanup/core/preserveScanCleanupJsonEvidence';
import {
    assertCanonicalPdfPageSizes,
    detectPageRasterFromPageSize,
    detectSourceDpiFromPageSizes,
    type IDetectedPageRaster,
    type IPdfPageSize,
    type IScanCleanupDetectionResultStore,
    type IScanCleanupPageRasterSource,
    type IScanCleanupRasterRenderLimits,
    type TScanCleanupLog,
    type TScanCleanupRenderPage,
    type TScanCleanupRunSidecar,
} from '@evb/scan-cleanup/core/types';
import {
    createArrayBackedPdfPageSizeStore,
    type IPdfPageSizeStore,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import {
    type readAvailableScratchBytes,
    resolveStagedRasterWindow,
} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {createStagedRasterWindow} from '@evb/scan-cleanup/core/createStagedRasterWindow';
import {
    renderScanCleanupRasterToDisk as renderRasterToDisk,
    resolveScanCleanupRasterRenderLimits as resolveRasterRenderLimits,
} from '@evb/scan-cleanup/core/rasterValidation';
import {
    addScanCleanupDocumentCanvasObservedPage,
    addScanCleanupDocumentCanvasPage,
    createScanCleanupDocumentCanvasAccumulator,
    resolveScanCleanupDocumentCanvasFromAccumulator,
    scanCleanupDocumentCanvasSignature,
} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {
    isCropBoxOrientationMismatch,
    isMateriallySmallerCropBox,
    toCropBoxPageSize,
    toMediaBoxPageSize,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import {
    collectScanCleanupPageScopeBatch,
    iterateScanCleanupPageBatches,
    SCAN_CLEANUP_STREAMING_BATCH_PAGES,
} from '@evb/scan-cleanup/core/pageBatches';
import {
    resolveScanCleanupPageScopeLazy,
    type TScanCleanupPageScope,
} from '@evb/scan-cleanup/core/pageScope';
import {createFileBackedScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/fileBackedResultStore';
import {buildScanCleanupPlacementAnchorSummary} from '@evb/scan-cleanup/core/placementAnchors';
import {splitContiguousPageRuns} from '@evb/scan-cleanup/core/splitContiguousPageRuns';
import {SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES} from '@contracts/scan-cleanup/inputLimits';
import {usesScanCleanupInkAlignment} from '@contracts/scanCleanupPageOverrides';

export const DETECTION_DPI = 150;
export const PREVIEW_DPI = DETECTION_DPI;
/** Array results remain a deliberate compatibility path for small documents. */
export const SCAN_CLEANUP_RESULT_ARRAY_COMPATIBILITY_MAX_PAGES = SCAN_CLEANUP_STREAMING_BATCH_PAGES;
/** Completed pages a large document keeps in each progress event. */
const RECENT_PROGRESS_PAGES = 256;
/**
 * Large-document progress is a status update, not a page transport. Keep a
 * full second between live frames so a fast native batch cannot leave a
 * renderer restart decoding a long tail of short-lived result objects. Batch
 * ends still publish immediately, and the durable result store remains the
 * source for every page.
 */
const LARGE_PROGRESS_PUBLISH_INTERVAL_MS = 1_000;

/**
 * The progress contract accepts a page list only when it is exactly the
 * completed count or explicitly marked as a bounded prefix. Pages the native
 * detector processes without a classification count as completed but never
 * enter the list, and a document-sized list would breach the IPC entry cap,
 * so the list is capped and flagged whenever it is not the full set.
 */
export function completedPageProgress(
    reportedPageNumbers: ReadonlySet<number>,
    completedUnits: number,
): Pick<TScanCleanupProgress, 'completedPageNumbers' | 'completedPageNumbersTruncated'> {
    const completedPageNumbers = [...reportedPageNumbers].slice(0, SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES);
    return completedPageNumbers.length === completedUnits
        ? {completedPageNumbers}
        : {
            completedPageNumbers,
            completedPageNumbersTruncated: true,
        };
}
// Native mode selection, preview, and final rendering share this canonical
// analysis grid. The separate working raster remains free to follow source DPI.
const BASE_PREVIEW_MAX_PIXELS = 4_000_000;
const MAX_MEDIA_BOX_RETRY_PAGES = 16;
const MEDIA_BOX_RETRY_MIN_CONFIDENCE = 0.75;

/**
 * Binary cleanup needs the source's stroke samples even though the UI presents
 * the result on the smaller preview canvas. Thresholding the already reduced
 * 150-DPI raster loses subpixel stroke evidence and makes neighboring words
 * alternate between heavy and light. Native therefore cleans binary-capable
 * previews at up to 2x the display DPI; the renderer's ordinary placement
 * downsample is the same final step used when a 300-DPI conversion is viewed.
 * Tonal previews keep the inexpensive display grid because they do not
 * threshold those samples.
 */
export function resolvePreviewProcessingDpi({
    displayDpi,
    outputMode,
    sourceDpi,
}: {
    displayDpi: number;
    outputMode: 'bw' | 'color' | 'grayscale' | 'mixed' | undefined;
    sourceDpi: number;
}) {
    const binaryCapable = outputMode === undefined || outputMode === 'bw' || outputMode === 'mixed';
    if (!binaryCapable) {
        return displayDpi;
    }
    return Math.max(displayDpi, Math.floor(Math.min(sourceDpi, displayDpi * 2)));
}

export function resolvePagePreviewDpi(
    pageSize: IPdfPageSize,
    requestedDpi: number,
) {
    const pageAreaPoints = pageSize.widthPoints * pageSize.heightPoints;
    if (!Number.isFinite(pageAreaPoints) || pageAreaPoints <= 0) {
        return requestedDpi;
    }
    const pixelBoundDpi = 72 * Math.sqrt(BASE_PREVIEW_MAX_PIXELS / pageAreaPoints);
    return Math.max(1, Math.floor(Math.min(requestedDpi, pixelBoundDpi)));
}

/** Resolve one page's bounded preview raster DPI without a page-sized plan. */
export function resolveScanCleanupPagePreviewDpi(
    pageSize: IPdfPageSize,
    sourceDpi: number | null | undefined,
) {
    const normalizedSourceDpi = Number.isFinite(sourceDpi) && (sourceDpi ?? 0) > 0
        ? sourceDpi!
        : PREVIEW_DPI;
    return resolvePagePreviewDpi(
        pageSize,
        Math.min(PREVIEW_DPI, normalizedSourceDpi),
    );
}

export function resolvePreviewRasterPlan(
    pageSizes: readonly IPdfPageSize[] | null,
    sourceDpiByPage: ReadonlyMap<number, number> = new Map(),
) {
    const detected = pageSizes === null ? null : detectSourceDpiFromPageSizes(pageSizes);
    const pageDpiByNumber = new Map(detected?.pageDpiByNumber ?? []);
    let documentDpi = detected?.documentDpi ?? 0;
    for (const [
        pageNumber,
        sourceDpi,
    ] of sourceDpiByPage) {
        if (!Number.isFinite(sourceDpi) || sourceDpi <= 0) continue;
        pageDpiByNumber.set(pageNumber, Math.max(pageDpiByNumber.get(pageNumber) ?? 0, sourceDpi));
        documentDpi = Math.max(documentDpi, sourceDpi);
    }
    documentDpi = documentDpi > 0 ? documentDpi : PREVIEW_DPI;
    const dpi = Math.min(PREVIEW_DPI, documentDpi);
    const renderDpiByPageNumber = new Map<number, number>();
    for (const pageSize of pageSizes ?? []) {
        const sourceDpi = pageDpiByNumber.get(pageSize.pageNumber);
        const requestedDpi = Math.min(PREVIEW_DPI, sourceDpi ?? dpi);
        const renderDpi = resolvePagePreviewDpi(pageSize, requestedDpi);
        renderDpiByPageNumber.set(pageSize.pageNumber, renderDpi);
    }
    return {
        dpi,
        pageDpiByNumber,
        renderDpiByPageNumber,
    };
}

/**
 * Where the document keeps its own pixels. `detected` is false when pdfimages
 * is unavailable, which means every page has to be treated as one that carries
 * a raster: there is no evidence that it does not.
 */
export interface IScanCleanupDocumentRasterPages {
    detected: boolean;
    pages: ReadonlySet<number>;
    sourceDpiByPage?: ReadonlyMap<number, number>;
    bilevelLayerPages?: ReadonlySet<number>;
    dominantBilevelLayerPages?: ReadonlySet<number>;
    backgroundDpiByPage?: ReadonlyMap<number, number>;
}

/**
 * The old Set/Map representation is kept for focused core tests and older
 * adapters. Electron retention uses the bounded accessor from `types.ts`.
 */
export type TScanCleanupPageRasterSource =
    | IScanCleanupPageRasterSource
    | IScanCleanupDocumentRasterPages;

function isBoundedPageRasterSource(
    source: TScanCleanupPageRasterSource,
): source is IScanCleanupPageRasterSource {
    return typeof (source as Partial<IScanCleanupPageRasterSource>).getPageRaster === 'function';
}

function readLegacyPageRaster(
    source: IScanCleanupDocumentRasterPages,
    pageNumber: number,
): IDetectedPageRaster | undefined {
    if (!source.pages.has(pageNumber)) {
        return undefined;
    }
    const backgroundDpi = source.backgroundDpiByPage?.get(pageNumber);
    return {
        // The legacy shape did not retain pixel dimensions. Detection only
        // used these records for source-DPI and layer facts, so a tiny valid
        // placeholder keeps old direct tests source-compatible without
        // rebuilding a document-sized raster map in production.
        width: 1,
        height: 1,
        dpi: source.sourceDpiByPage?.get(pageNumber) ?? DETECTION_DPI,
        hasBilevelLayer: source.bilevelLayerPages?.has(pageNumber) ?? false,
        hasDominantBilevelLayer: source.dominantBilevelLayerPages?.has(pageNumber) ?? false,
        ...(backgroundDpi === undefined
            ? {}
            : {backgroundDpi}),
    };
}

function getPageRaster(
    source: TScanCleanupPageRasterSource,
    pageNumber: number,
) {
    return isBoundedPageRasterSource(source)
        ? source.getPageRaster(pageNumber)
        : readLegacyPageRaster(source, pageNumber);
}

function getLegacyPageDpi(
    source: TScanCleanupPageRasterSource,
    pageNumber: number,
) {
    return isBoundedPageRasterSource(source)
        ? undefined
        : source.sourceDpiByPage?.get(pageNumber);
}

function getRasterDocumentDpi(source: TScanCleanupPageRasterSource) {
    if (!isBoundedPageRasterSource(source)) {
        return undefined;
    }
    return Number.isFinite(source.documentDpi) && (source.documentDpi ?? 0) > 0
        ? source.documentDpi!
        : undefined;
}

function resolveRasterPageDpi(
    source: TScanCleanupPageRasterSource,
    page: IPdfPageSize,
    raster: IDetectedPageRaster | undefined,
) {
    const rasterDpi = raster?.dpi;
    if (Number.isFinite(rasterDpi) && (rasterDpi ?? 0) > 0) {
        return rasterDpi;
    }
    const legacyDpi = getLegacyPageDpi(source, page.pageNumber);
    if (Number.isFinite(legacyDpi) && (legacyDpi ?? 0) > 0) {
        return legacyDpi;
    }
    return resolvePageGeometrySourceDpi(page, undefined) ?? getRasterDocumentDpi(source);
}

export function createScanCleanupDocumentRasterPages(
    detected: boolean,
    pageRasterByNumber: ReadonlyMap<number, IDetectedPageRaster>,
): IScanCleanupDocumentRasterPages {
    return {
        detected,
        pages: new Set(pageRasterByNumber.keys()),
        sourceDpiByPage: new Map(
            [...pageRasterByNumber].map(([
                pageNumber,
                raster,
            ]) => [
                pageNumber,
                raster.dpi,
            ] as const),
        ),
        bilevelLayerPages: new Set(
            [...pageRasterByNumber]
                .filter(([
                    , raster,
                ]) => raster.hasBilevelLayer)
                .map(([pageNumber]) => pageNumber),
        ),
        dominantBilevelLayerPages: new Set(
            [...pageRasterByNumber]
                .filter(([
                    , raster,
                ]) => raster.hasDominantBilevelLayer)
                .map(([pageNumber]) => pageNumber),
        ),
        backgroundDpiByPage: new Map(
            [...pageRasterByNumber].flatMap(([
                pageNumber,
                raster,
            ]) =>
                raster.backgroundDpi === undefined
                    ? []
                    : [[
                        pageNumber,
                        raster.backgroundDpi,
                    ] as const],
            ),
        ),
    };
}

export interface IScanCleanupRetainedRaster {
    dpi: number;
    height: number;
    pageNumber: number;
    path: string;
    sizeBytes: number;
    width: number;
}

export interface IScanCleanupRetainedRasterInput<TDocument> {
    document: TDocument;
    dpi: number;
    height: number;
    pageNumber: number;
    scratchPath: string;
    sizeBytes: number;
    width: number;
}

export interface IScanCleanupDetectionRetention<TDocument> {
    openDocument: (
        request: Pick<IScanCleanupDetectionRequest, 'sourcePdfPath' | 'documentRevision'>,
    ) => Promise<TDocument>;
    pageCount: (document: TDocument, signal: AbortSignal) => Promise<number>;
    /** Production retention opens one bounded native-backed geometry store. */
    pageSizeStore?: (document: TDocument, signal: AbortSignal) => Promise<IPdfPageSizeStore>;
    /** Array compatibility is retained for small direct/core tests only. */
    pageSizes?: (document: TDocument, signal: AbortSignal) => Promise<IPdfPageSize[]>;
    rasterPages: (
        document: TDocument,
        signal: AbortSignal,
    ) => Promise<TScanCleanupPageRasterSource>;
    retainedPaths: (
        document: TDocument,
        pageNumbers: readonly number[],
        dpi: number,
    ) => Promise<Map<number, IScanCleanupRetainedRaster>>;
    claimRaster?: (
        document: TDocument,
        pageNumber: number,
        dpi: number,
    ) => boolean;
    rasterScratchPath: (
        document: TDocument,
        pageNumber: number,
        dpi: number,
    ) => Promise<string>;
    /**
     * Where `retain` will publish this page's raster, before it is rendered.
     *
     * Detection writes the Analyze manifest before it stages a single page, so
     * it has to name each input up front. The path is a function of the
     * document, the page and the DPI alone, which is also why re-rendering a
     * released page republishes exactly the same file.
     */
    stagedRasterPath: (
        document: TDocument,
        pageNumber: number,
        dpi: number,
    ) => Promise<string>;
    retain: (
        rendered: IScanCleanupRetainedRasterInput<TDocument>,
    ) => Promise<IScanCleanupRetainedRaster>;
    /**
     * Drop one staged raster and its cache entry. The bounded window calls this
     * when it needs the slot back and when a failed run rolls its staging back,
     * so a page released here must be re-renderable at the same path.
     */
    releaseRaster: (
        document: TDocument,
        pageNumber: number,
        dpi: number,
    ) => Promise<void>;
    release: (document: TDocument) => Promise<void>;
}

export interface IScanCleanupDetectionDependencies {
    fileSystem?: {
        copyFile: (source: string, destination: string) => Promise<void>;
        mkdir: (
            path: string,
            options?: {recursive?: boolean},
        ) => Promise<string | undefined>;
        mkdtemp: (prefix: string) => Promise<string>;
        open: (path: string, flags: 'r' | 'w+') => Promise<FileHandle>;
        readFile: (path: string, encoding: 'utf8') => Promise<string>;
        readdir: (path: string, options: {withFileTypes: true}) => Promise<ReadonlyArray<{
            isFile: () => boolean;
            name: string;
        }>>;
        rm: (
            path: string,
            options: {
                force: boolean;
                recursive?: boolean;
            },
        ) => Promise<void>;
        stat: (
            path: string,
        ) => Promise<{
            size: number;
            isFile: () => boolean;
        }>;
        writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
    };
    getTempDir: () => string;
    /**
     * Testable override for the filesystem-space probe used by the non-stream
     * fallback.  On Windows the complete detection manifest is retained before
     * native starts reading it, so it must fit the same scratch budget as the
     * retained-raster cache.
     */
    getAvailableScratchBytes?: typeof readAvailableScratchBytes;
    getPdftoppmBinary: () => string;
    resolveBinary: () => string | null;
    renderPage: TScanCleanupRenderPage;
    renderPagePpm: TScanCleanupRenderPage;
    renderPageBatch?: (input: {
        dpi: number;
        log: TScanCleanupLog;
        pdftoppmBinary: string;
        signal: AbortSignal;
        sourcePdfPath: string;
        targets: ReadonlyArray<{
            limits: IScanCleanupRasterRenderLimits;
            outputPath: string;
            pageNumber: number
        }>;
    }) => Promise<ReadonlyArray<{
        height: number;
        pageNumber: number;
        width: number
    }>>;
    createRasterPipes?: (
        paths: readonly string[],
        signal: AbortSignal,
        log: TScanCleanupLog,
    ) => Promise<void>;
    runSidecar: TScanCleanupRunSidecar;
}

function normalizeDetectionContentBox(
    output: INativeScanCleanupAnalysisOutputV3,
    rotationDegrees: IScanCleanupPagePlanEvidence['rotationDegrees'],
) {
    const contentBox = output.contentBox;
    if (
        contentBox === null
        || contentBox === undefined
        || output.inputWidthPx <= 0
        || output.inputHeightPx <= 0
        || output.sourceRegion.widthPx <= 0
        || output.sourceRegion.heightPx <= 0
    ) {
        return undefined;
    }
    const analysisWidth = rotationDegrees === 90 || rotationDegrees === 270
        ? output.inputHeightPx
        : output.inputWidthPx;
    const analysisHeight = rotationDegrees === 90 || rotationDegrees === 270
        ? output.inputWidthPx
        : output.inputHeightPx;
    const left = Math.max(0, Math.min(output.sourceRegion.widthPx, contentBox.xPx));
    const top = Math.max(0, Math.min(output.sourceRegion.heightPx, contentBox.yPx));
    const right = Math.max(
        left,
        Math.min(output.sourceRegion.widthPx, contentBox.xPx + contentBox.widthPx),
    );
    const bottom = Math.max(
        top,
        Math.min(output.sourceRegion.heightPx, contentBox.yPx + contentBox.heightPx),
    );
    if (right <= left || bottom <= top) {
        return undefined;
    }
    // Content coordinates are local to the output half, while their scale is
    // the complete rotated analysis page. Normalize the two edges first and
    // derive the extent from them so a box ending at the page edge serializes
    // exactly as `1 - start` for the manifest validator.
    const leftNormalized = left / analysisWidth;
    const topNormalized = top / analysisHeight;
    const rightNormalized = right === analysisWidth ? 1 : right / analysisWidth;
    const bottomNormalized = bottom === analysisHeight ? 1 : bottom / analysisHeight;
    return {
        xNormalized: leftNormalized,
        yNormalized: topNormalized,
        widthNormalized: rightNormalized - leftNormalized,
        heightNormalized: bottomNormalized - topNormalized,
        rotationDegrees,
    };
}

function createDetectionPagePlanEvidence(
    result: IScanCleanupDetectionResult,
    metadata: INativeScanCleanupPageMetadataV3,
    includeContentBoxes: boolean,
): IScanCleanupPagePlanEvidence {
    const rotationDegrees = metadata.rotationDegrees;
    const firstOutput = metadata.outputs?.[0];
    const analysisWidth = firstOutput === undefined
        ? 0
        : rotationDegrees === 90 || rotationDegrees === 270
            ? firstOutput.inputHeightPx
            : firstOutput.inputWidthPx;
    const splitXNormalized = result.cutterXPx === null || analysisWidth <= 0
        ? undefined
        : result.cutterXPx / analysisWidth;
    const automaticSplit = splitXNormalized === undefined
        || splitXNormalized <= 0
        || splitXNormalized >= 1
        ? undefined
        : {
            xNormalized: splitXNormalized,
            rotationDegrees,
        };
    const outputs: IScanCleanupPagePlanEvidence['outputs'] = {};
    for (const output of metadata.outputs ?? []) {
        const contentBox = includeContentBoxes
            ? normalizeDetectionContentBox(output, rotationDegrees)
            : undefined;
        if (contentBox === undefined && output.textToneDiagnostics === undefined) {
            continue;
        }
        outputs[output.half] = {
            ...(contentBox === undefined ? {} : {contentBox}),
            ...(output.textToneDiagnostics === undefined
                ? {}
                : {textToneDiagnostics: output.textToneDiagnostics}),
        };
    }
    return {
        pageNumber: result.pageNumber,
        rotationDegrees,
        layoutClassification: result.classification,
        ...(automaticSplit === undefined ? {} : {automaticSplit}),
        outputs,
    };
}

/**
 * MediaBox retries are deliberately content-gated. An undersized CropBox is
 * common in hand-authored PDFs, so area alone may never start another native
 * process. The portrait mismatch is the one metadata-only exception because
 * it cannot be an intentional crop of a dominant landscape document.
 */
export function shouldRetryMediaBoxPage(
    page: IPdfPageSize,
    result: IScanCleanupDetectionResult,
) {
    if (!isMateriallySmallerCropBox(page)) {
        return false;
    }
    if (isCropBoxOrientationMismatch(page)) {
        return true;
    }
    const diagnostics = result.splitDiagnostics;
    return result.tier1Verdict === 'two-page-spread'
        || (result.reconciled && result.classification === 'two-page-spread')
        || (
            diagnostics !== undefined
            && diagnostics.aspectSpreadScore >= 0.75
            && diagnostics.independentSpreadCues >= 3
        );
}

/** The second pass must prove a spread locally before its wider box is used. */
export function isStrongMediaBoxSpread(
    progress: TNativeScanCleanupProgressV3,
    metadata: INativeScanCleanupPageMetadataV3,
    rasterWidth: number,
    rasterHeight: number,
) {
    const diagnostics = metadata.splitDiagnostics;
    const verdict = progress.tier1Verdict ?? progress.classification;
    const confidence = progress.confidence ?? metadata.layoutConfidence ?? 0;
    const cutter = progress.cutterXPx ?? metadata.cutterXPx;
    const decisionX = diagnostics?.decisionX;
    if (
        verdict !== 'two-page-spread'
        || metadata.layoutClassification !== 'two-page-spread'
        || !Number.isFinite(confidence)
        || confidence < MEDIA_BOX_RETRY_MIN_CONFIDENCE
        || diagnostics === undefined
        || diagnostics.abstained
        || diagnostics.independentSpreadCues < 3
        || diagnostics.centralPositionGatePassed !== true
        || diagnostics.bilateralGatePassed !== true
        || diagnostics.aspectSupportGatePassed !== true
        || diagnostics.evidenceAgreementGatePassed !== true
        || !Number.isFinite(rasterWidth)
        || !Number.isFinite(rasterHeight)
        || rasterWidth <= 0
        || rasterHeight <= 0
        || !Number.isFinite(cutter ?? NaN)
        || (cutter ?? 0) <= rasterWidth * 0.15
        || (cutter ?? 0) >= rasterWidth * 0.85
        || !Number.isFinite(decisionX)
        || (decisionX ?? 0) <= rasterWidth * 0.15
        || (decisionX ?? 0) >= rasterWidth * 0.85
    ) {
        return false;
    }
    return true;
}

async function resolveDetectionPageSizeStore<TDocument>(
    retention: IScanCleanupDetectionRetention<TDocument>,
    document: TDocument,
    signal: AbortSignal,
) {
    if (retention.pageSizeStore !== undefined) {
        return retention.pageSizeStore(document, signal);
    }
    if (retention.pageSizes !== undefined) {
        const pageSizes = await retention.pageSizes(document, signal);
        assertCanonicalPdfPageSizes(pageSizes, 'Scan cleanup detection');
        return createArrayBackedPdfPageSizeStore(pageSizes);
    }
    throw new Error('Scan cleanup detection has no page-size store');
}

async function readDetectionPageSizeBatch(
    pageSizeStore: IPdfPageSizeStore,
    pageNumbers: readonly number[],
) {
    if (pageNumbers.length === 0) {
        return [] as Array<{
            raw: IPdfPageSize;
            page: IPdfPageSize
        }>;
    }
    // Detection advances through pages in document order. Keep the store's
    // forward cursor alive across batches instead of opening a range reader,
    // which must scan from page 1 for every window on streaming sources.
    const rawPages = await Promise.all(pageNumbers.map(pageNumber => pageSizeStore.getPage(pageNumber)));
    if (rawPages.length !== pageNumbers.length) {
        throw new Error(
            `Scan cleanup page-size store returned ${String(rawPages.length)} pages for ${String(pageNumbers.length)} requested pages`,
        );
    }
    return rawPages.map((raw, index) => {
        const expectedPageNumber = pageNumbers[index]!;
        if (raw.pageNumber !== expectedPageNumber) {
            throw new Error(
                `Scan cleanup page-size store returned page ${String(raw.pageNumber)} for requested page ${String(expectedPageNumber)}`,
            );
        }
        return {
            raw,
            page: toCropBoxPageSize(raw),
        };
    });
}

function resolvePageGeometrySourceDpi(
    page: IPdfPageSize,
    sourceDpiByPage: ReadonlyMap<number, number> | undefined,
) {
    const suppliedDpi = sourceDpiByPage?.get(page.pageNumber);
    if (Number.isFinite(suppliedDpi) && (suppliedDpi ?? 0) > 0) {
        return suppliedDpi;
    }
    return detectPageRasterFromPageSize(page)?.dpi;
}

/**
 * Analyze manifests are bounded transport units, not document units. Keep the
 * long-document path separate from the ordinary one so the latter retains its
 * existing progress cadence and cache behavior while a million-page source
 * never needs one path or manifest record per page in this function.
 */
async function runBatchedScanCleanupDetection<TDocument>(
    request: IScanCleanupDetectionRequest,
    signal: AbortSignal,
    retention: IScanCleanupDetectionRetention<TDocument>,
    pageSizeStore: IPdfPageSizeStore,
    resultStore: IScanCleanupDetectionResultStore,
    dependencies: IScanCleanupDetectionDependencies,
    policy: Pick<IScanCleanupRuntimePolicy, 'rasterConcurrency'>,
    publish: (
        results: IScanCleanupDetectionResult[],
        progress: TScanCleanupProgress,
        documentCanvasSignature: string,
    ) => void,
    log: TScanCleanupLog,
    document: TDocument,
    pageScope: TScanCleanupPageScope,
    totalPages: number,
    scratch: string,
) {
    const fileSystem = dependencies.fileSystem;
    if (!fileSystem) throw new Error('Scan cleanup detection requires injected filesystem capabilities');
    const getAvailableScratchBytes = dependencies.getAvailableScratchBytes;
    if (!getAvailableScratchBytes) throw new Error('Scan cleanup detection requires injected scratch-budget capability');
    const sourceRasterStructure = await retention.rasterPages(document, signal);
    const canvasAccumulator = createScanCleanupDocumentCanvasAccumulator();
    // Keep the provisional summary used while native reconciliation is still
    // open separate from the resolved summary. The former contains every
    // automatic page as unclassified geometry; the latter receives each page
    // only after its native classification and can therefore answer the final
    // document-canvas question without retaining a layout map.
    const resolvedCanvasAccumulator = createScanCleanupDocumentCanvasAccumulator();
    let geometryPages = 0;
    let expectedGeometryPageNumber = 1;
    let matchedPreviewDpi = Number.POSITIVE_INFINITY;
    await pageSizeStore.forEachChunk(chunk => {
        signal.throwIfAborted();
        if (chunk.pageCount !== totalPages) {
            throw new Error(
                `Scan cleanup page-size store reported ${String(chunk.pageCount)} pages for ${String(totalPages)} document pages`,
            );
        }
        for (const rawPage of chunk.pages) {
            signal.throwIfAborted();
            if (rawPage.pageNumber !== expectedGeometryPageNumber) {
                throw new Error(
                    `Scan cleanup page-size store returned page ${String(rawPage.pageNumber)} where page ${String(expectedGeometryPageNumber)} was expected`,
                );
            }
            expectedGeometryPageNumber += 1;
            geometryPages += 1;
            const page = toCropBoxPageSize(rawPage);
            addScanCleanupDocumentCanvasPage(canvasAccumulator, page, request.options);
            matchedPreviewDpi = Math.min(
                matchedPreviewDpi,
                resolveScanCleanupPagePreviewDpi(
                    page,
                    resolvePageGeometrySourceDpi(
                        page,
                        isBoundedPageRasterSource(sourceRasterStructure)
                            ? undefined
                            : sourceRasterStructure.sourceDpiByPage,
                    ) ?? getRasterDocumentDpi(sourceRasterStructure),
                ),
            );
        }
    });
    if (geometryPages !== totalPages) {
        throw new Error(
            `Scan cleanup page-size store returned ${String(geometryPages)} pages for ${String(totalPages)} document pages`,
        );
    }
    if (!Number.isFinite(matchedPreviewDpi)) matchedPreviewDpi = PREVIEW_DPI;
    const baselineCanvasSignature = scanCleanupDocumentCanvasSignature(
        request.options.matchPageSize
            ? resolveScanCleanupDocumentCanvasFromAccumulator(
                canvasAccumulator,
                matchedPreviewDpi,
                request.options,
            )
            : null,
    );
    resolvedCanvasAccumulator.producedPageCount = canvasAccumulator.producedPageCount;
    resolvedCanvasAccumulator.forced = canvasAccumulator.forced;
    const documentCanvasSignature = (layoutEvidenceComplete = false) => {
        if (!request.options.matchPageSize) {
            return '';
        }
        const signature = scanCleanupDocumentCanvasSignature(resolveScanCleanupDocumentCanvasFromAccumulator(
            layoutEvidenceComplete ? resolvedCanvasAccumulator : canvasAccumulator,
            matchedPreviewDpi,
            request.options,
            layoutEvidenceComplete,
        ));
        return signature === baselineCanvasSignature ? '' : signature;
    };
    // The bounded result store is authoritative for every document-scale run.
    // Keeping an array-shaped compatibility snapshot is safe only for the
    // explicit small-document threshold, below the production batch size.
    const compatibilityResults = totalPages <= SCAN_CLEANUP_RESULT_ARRAY_COMPATIBILITY_MAX_PAGES
        ? new Map<number, IScanCleanupDetectionResult>()
        : null;
    // Large documents publish only the results recorded since the previous
    // event. Preserve append order so a late reconciliation update remains in
    // the renderer's bounded tail even when it targets an early page. The
    // file-backed store holds the full set.
    const recentResults: IScanCleanupDetectionResult[] = [];
    let lastLargePublishAt = 0;
    const publishedResults = () => compatibilityResults === null
        ? []
        : [...compatibilityResults.values()]
            .sort((left, right) => left.pageNumber - right.pageNumber);
    const takePublishableResults = () => {
        if (compatibilityResults !== null) {
            return publishedResults();
        }
        const pending = recentResults.splice(0);
        return pending.length <= RECENT_PROGRESS_PAGES
            ? pending
            : pending.slice(-RECENT_PROGRESS_PAGES);
    };
    const shouldPublishLargeProgress = (terminal: boolean) => {
        if (compatibilityResults !== null || terminal) {
            return true;
        }
        if (recentResults.length >= RECENT_PROGRESS_PAGES) {
            return true;
        }
        const now = Date.now();
        if (now - lastLargePublishAt < LARGE_PROGRESS_PUBLISH_INTERVAL_MS) {
            return false;
        }
        lastLargePublishAt = now;
        return true;
    };
    const detectionDpiForPage = (_pageNumber: number) => DETECTION_DPI;
    const binary = dependencies.resolveBinary();
    if (!binary) throw new ScanCleanupNativeToolUnavailableError('evb-scan-cleanup');

    let rasterizedPages = 0;
    let analyzedPages = 0;
    const mediaBoxRetryCandidates: Array<{
        pageNumber: number;
        result: IScanCleanupDetectionResult;
        sourcePage: IPdfPageSize;
    }> = [];
    // The large-document path deliberately sends no document-sized completion
    // list through progress. A batch-local list still lets the UI identify the
    // pages represented by the latest native frame without retaining a million
    // page numbers in the workflow.
    const publishRasterizing = () => publish([], {
        stage: 'rasterizing',
        completedUnits: rasterizedPages,
        totalUnits: totalPages,
        percent: totalPages === 0 ? 100 : rasterizedPages / totalPages * 100,
        completedPageNumbers: [],
    }, documentCanvasSignature());
    publishRasterizing();

    for (const batch of iterateScanCleanupPageBatches(
        pageScope.length,
        SCAN_CLEANUP_STREAMING_BATCH_PAGES,
    )) {
        signal.throwIfAborted();
        const batchPageNumbers = collectScanCleanupPageScopeBatch(pageScope, batch);
        const batchPageSet = new Set(batchPageNumbers);
        const batchResults = new Map<number, IScanCleanupDetectionResult>();
        const batchPageRecords = await readDetectionPageSizeBatch(pageSizeStore, batchPageNumbers);
        const batchPageByNumber = new Map(batchPageRecords.map(record => [
            record.page.pageNumber,
            record.page,
        ]));
        const batchRasterByNumber = new Map(await Promise.all(batchPageNumbers.map(async pageNumber => [
            pageNumber,
            await getPageRaster(sourceRasterStructure, pageNumber),
        ] as const)));
        const previouslyBroadenedPages = new Set(
            batchPageRecords
                .filter(record => record.raw.renderBox === 'mediabox')
                .map(record => record.page.pageNumber),
        );
        const retained = new Map<number, IScanCleanupRetainedRaster>();
        for (const [
            pageNumber,
            raster,
        ] of await retention.retainedPaths(document, batchPageNumbers, DETECTION_DPI)) {
            // A preview opened before detection may have cached the
            // compatibility MediaBox render. It cannot be reused for the
            // CropBox-first pass.
            if (!previouslyBroadenedPages.has(pageNumber) && batchPageSet.has(pageNumber)) {
                const claimed = retention.claimRaster?.(document, pageNumber, DETECTION_DPI) ?? true;
                if (claimed) {
                    retained.set(pageNumber, raster);
                }
            }
        }
        const rasterScope = batchPageNumbers.filter(pageNumber => !retained.has(pageNumber));
        const rasterLimitsByPage = new Map(batchPageNumbers.map(pageNumber => [
            pageNumber,
            resolveRasterRenderLimits(
                batchPageByNumber.get(pageNumber),
                detectionDpiForPage(pageNumber),
            ),
        ]));
        const stagingPlans = rasterScope.map(pageNumber => {
            const limits = rasterLimitsByPage.get(pageNumber)!;
            return {
                renderDpi: DETECTION_DPI,
                renderCopies: 2,
                raster: {
                    dpi: DETECTION_DPI,
                    width: limits.expectedWidthPx,
                    height: limits.expectedHeightPx,
                },
            };
        });
        const requestedWindowPages = dependencies.renderPageBatch === undefined
            ? Math.min(
                SCAN_CLEANUP_MAX_STAGED_INPUT_WINDOW,
                Math.max(2, Math.max(1, policy.rasterConcurrency) * 2),
            )
            : SCAN_CLEANUP_MAX_STAGED_INPUT_WINDOW;
        const admission = await resolveStagedRasterWindow(
            stagingPlans,
            requestedWindowPages,
            scratch,
            getAvailableScratchBytes,
        );
        let stagedInputPeakPixels = 1;
        for (const limits of rasterLimitsByPage.values()) {
            stagedInputPeakPixels = Math.max(
                stagedInputPeakPixels,
                limits.expectedWidthPx * limits.expectedHeightPx,
            );
        }
        const boundedWindowPages = Math.max(
            1,
            Math.min(SCAN_CLEANUP_MAX_STAGED_INPUT_WINDOW, admission.windowPages),
        );
        log(
            'debug',
            'Scan cleanup detection staged raster admission '
            + JSON.stringify({
                pages: batchPageNumbers.length,
                stagedPages: rasterScope.length,
                retainedPages: retained.size,
                freeScratchBytes: admission.availableBytes,
                budgetBytes: admission.budgetBytes,
                wholeDocumentBytes: admission.wholeDocumentBytes,
                windowPages: boundedWindowPages,
                windowBytes: admission.windowBytes,
                renderConcurrency: Math.max(
                    1,
                    Math.min(policy.rasterConcurrency, boundedWindowPages),
                ),
                admitted: admission.admitted,
            }),
        );
        if (!admission.admitted) {
            throw new ScanCleanupInsufficientScratchError(
                admission.availableBytes,
                admission.requiredBytes,
            );
        }

        const stagedPathByPage = new Map(await Promise.all(batchPageNumbers.map(async pageNumber => [
            pageNumber,
            retained.get(pageNumber)?.path
                ?? await retention.stagedRasterPath(
                    document,
                    pageNumber,
                    DETECTION_DPI,
                ),
        ] as const)));
        const stagingAbort = new AbortController();
        const operationSignal = AbortSignal.any([
            signal,
            stagingAbort.signal,
        ]);
        let stagingError: unknown;
        let activeRenders = 0;
        const waitingRenders: Array<() => void> = [];
        const renderConcurrency = Math.max(
            1,
            Math.min(policy.rasterConcurrency, boundedWindowPages),
        );
        const renderSlot = async <T>(render: () => Promise<T>) => {
            if (activeRenders >= renderConcurrency) {
                await new Promise<void>(resolve => waitingRenders.push(resolve));
            } else {
                activeRenders += 1;
            }
            try {
                return await render();
            } finally {
                const next = waitingRenders.shift();
                if (next) {
                    next();
                } else {
                    activeRenders -= 1;
                }
            }
        };
        const countedRasterPages = new Set(retained.keys());
        rasterizedPages += retained.size;
        const recordRasterizedPage = (pageNumber: number) => {
            if (!countedRasterPages.has(pageNumber)) {
                countedRasterPages.add(pageNumber);
                rasterizedPages += 1;
            }
        };
        const batchRenderer = dependencies.renderPageBatch;
        // The detector's resident window is bounded by admission.windowPages.
        // Batch pre-staging is safe only when the entire requested set fits
        // inside that window. A large manifest may fit the scratch estimate
        // while still being too large for one Poppler process and one burst of
        // retained rasters, so long documents must use the staged windows.
        const canPrestageBatch = batchRenderer !== undefined
            && compatibilityResults === null
            && rasterScope.length > 0
            && rasterScope.length <= boundedWindowPages
            && admission.wholeDocumentBytes !== null
            && admission.wholeDocumentBytes <= admission.budgetBytes;
        const preStagePageNumbers = canPrestageBatch ? rasterScope : [];
        const preStagedPages = new Set<number>();
        const releasePreStaged = async (keep: ReadonlySet<number>) => {
            const pages = [...preStagedPages].filter(pageNumber => !keep.has(pageNumber));
            await Promise.all(pages.map(async pageNumber => {
                try {
                    await retention.releaseRaster(document, pageNumber, DETECTION_DPI);
                } catch (error) {
                    log(
                        'warn',
                        `Scan cleanup could not drop pre-staged detection raster for page ${String(pageNumber)}: ${getErrorMessage(error)}`,
                    );
                } finally {
                    preStagedPages.delete(pageNumber);
                }
            }));
        };
        const renderAndRetainBatch = async (pageNumbers: readonly number[]) => {
            if (batchRenderer === undefined) {
                throw new Error('Scan cleanup Poppler batch renderer is unavailable');
            }
            const scratchPathByPage = new Map(await Promise.all(pageNumbers.map(async pageNumber => [
                pageNumber,
                await retention.rasterScratchPath(document, pageNumber, DETECTION_DPI),
            ] as const)));
            try {
                const rendered = [];
                for (const run of splitContiguousPageRuns(pageNumbers)) {
                    operationSignal.throwIfAborted();
                    rendered.push(...await batchRenderer({
                        dpi: DETECTION_DPI,
                        log,
                        pdftoppmBinary: dependencies.getPdftoppmBinary(),
                        signal: operationSignal,
                        sourcePdfPath: request.sourcePdfPath,
                        targets: run.map(pageNumber => ({
                            limits: rasterLimitsByPage.get(pageNumber)!,
                            outputPath: scratchPathByPage.get(pageNumber)!,
                            pageNumber,
                        })),
                    }));
                }
                const dimensionsByPage = new Map(rendered.map(result => [
                    result.pageNumber,
                    result,
                ]));
                if (dimensionsByPage.size !== pageNumbers.length) {
                    throw new Error('Poppler raster batch returned an incomplete page window');
                }
                for (const pageNumber of pageNumbers) {
                    const dimensions = dimensionsByPage.get(pageNumber);
                    if (dimensions === undefined) {
                        throw new Error(`Poppler raster batch omitted page ${String(pageNumber)}`);
                    }
                    const scratchPath = scratchPathByPage.get(pageNumber)!;
                    const raster = await retention.retain({
                        document,
                        dpi: DETECTION_DPI,
                        height: dimensions.height,
                        pageNumber,
                        scratchPath,
                        sizeBytes: (await fileSystem.stat(scratchPath)).size,
                        width: dimensions.width,
                    });
                    if (raster.path !== stagedPathByPage.get(pageNumber)) {
                        throw new ScanCleanupContractError(
                            `page ${String(pageNumber)} was staged at ${raster.path} instead of its manifest input path`,
                        );
                    }
                }
            } catch (error) {
                await Promise.allSettled(pageNumbers.flatMap(pageNumber => [
                    fileSystem.rm(scratchPathByPage.get(pageNumber)!, {force: true}),
                    retention.releaseRaster(document, pageNumber, DETECTION_DPI),
                ]));
                throw error;
            }
        };
        const stagedWindow = createStagedRasterWindow({
            pages: rasterScope,
            alreadyStaged: [
                ...retained.keys(),
                ...preStagePageNumbers,
            ],
            window: boundedWindowPages,
            log,
            stage: pageNumber => renderSlot(async () => {
                operationSignal.throwIfAborted();
                const scratchPath = await retention.rasterScratchPath(document, pageNumber, DETECTION_DPI);
                try {
                    const dimensions = await renderRasterToDisk(
                        request.sourcePdfPath,
                        pageNumber,
                        scratchPath,
                        operationSignal,
                        {
                            ...dependencies,
                            fileSystem,
                        },
                        log,
                        DETECTION_DPI,
                        undefined,
                        undefined,
                        'png',
                        rasterLimitsByPage.get(pageNumber),
                        'detection raster',
                        'detection',
                        'cropbox',
                    );
                    const raster = await retention.retain({
                        document,
                        dpi: DETECTION_DPI,
                        height: dimensions.height,
                        pageNumber,
                        scratchPath,
                        sizeBytes: (await fileSystem.stat(scratchPath)).size,
                        width: dimensions.width,
                    });
                    if (raster.path !== stagedPathByPage.get(pageNumber)) {
                        throw new ScanCleanupContractError(
                            `page ${String(pageNumber)} was staged at ${raster.path} instead of its manifest input path`,
                        );
                    }
                } catch (error) {
                    await fileSystem.rm(scratchPath, {force: true}).catch((cleanupError: unknown) => {
                        log(
                            'warn',
                            `Scan cleanup could not drop the partial detection raster at ${scratchPath}: ${getErrorMessage(cleanupError)}`,
                        );
                    });
                    throw error;
                }
            }),
            ...(batchRenderer === undefined
                ? {}
                : {stageBatch: renderAndRetainBatch}),
            unstage: pageNumber => retention.releaseRaster(
                document,
                pageNumber,
                DETECTION_DPI,
            ),
            isStaged: async pageNumber => {
                try {
                    return (await fileSystem.stat(stagedPathByPage.get(pageNumber)!)).isFile();
                } catch {
                    return false;
                }
            },
            onStaged: pageNumber => {
                recordRasterizedPage(pageNumber);
                if ((compatibilityResults?.size ?? batchResults.size) === 0) publishRasterizing();
            },
        });
        let batchCompleted = false;
        const manifestPages = batchPageNumbers.map(pageNumber => {
            const sourcePage = batchPageByNumber.get(pageNumber);
            const sourceRaster = batchRasterByNumber.get(pageNumber);
            const sourceBackgroundDpi = sourceRaster?.backgroundDpi;
            const sourceDpi = sourcePage === undefined
                ? undefined
                : resolveRasterPageDpi(sourceRasterStructure, sourcePage, sourceRaster);
            return {
                inputPath: stagedPathByPage.get(pageNumber)!,
                pageNumber,
                dpi: DETECTION_DPI,
                sourceDpi: sourceDpi ?? DETECTION_DPI,
                sourceHasBilevelLayer: sourceRaster?.hasBilevelLayer ?? false,
                ...(sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi}),
                pageMetadataPath: join(scratch, `page-${pageNumber}.json`),
            };
        });
        const sourcePageByManifestIndex = new Map(manifestPages.map((page, index) => [
            index + 1,
            page.pageNumber,
        ]));
        const manifestPath = join(scratch, 'classify-manifest.json');
        const manifest = buildRunnableNativeScanCleanupManifest({
            operation: 'analyze',
            analysisPurpose: 'page-plan',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: request.options.preserveOriginalQuality ? 'lossless' : 'raster',
            options: request.options,
            experimental: {
                autoDewarp: request.options.autoDewarp ?? false,
                ...(request.options.autoDewarpDepth === undefined
                    ? {}
                    : {autoDewarpDepth: request.options.autoDewarpDepth}),
            },
            pages: manifestPages,
            ...(rasterScope.length === 0
                ? {}
                : {
                    stagedInputWindow: boundedWindowPages,
                    stagedInputPeakPixels,
                }),
            allowedPathRoot: dependencies.getTempDir(),
        });
        await fileSystem.writeFile(manifestPath, JSON.stringify(manifest));
        if (preStagePageNumbers.length > 0) {
            try {
                for (const run of splitContiguousPageRuns(preStagePageNumbers)) {
                    await renderAndRetainBatch(run);
                    for (const pageNumber of run) {
                        preStagedPages.add(pageNumber);
                        recordRasterizedPage(pageNumber);
                    }
                }
            } catch (error) {
                await stagedWindow.dispose();
                await releasePreStaged(new Set());
                throw error;
            }
            publishRasterizing();
            log(
                'debug',
                'Scan cleanup pre-staged Poppler batch '
                + JSON.stringify({pages: preStagePageNumbers.length}),
            );
        }
        const reportedPageNumbers = new Set<number>();
        const resolveSourcePageNumber = (
            pageNumber: number | undefined,
            preferSourcePageNumber = false,
        ) => {
            if (pageNumber === undefined) {
                return undefined;
            }
            if (preferSourcePageNumber && batchPageSet.has(pageNumber)) {
                return pageNumber;
            }
            return sourcePageByManifestIndex.get(pageNumber) ?? (
                batchPageSet.has(pageNumber) ? pageNumber : undefined
            );
        };
        const recordResult = (
            nativeProgress: TNativeScanCleanupProgressV3,
            sourcePageNumber: number,
        ) => {
            const sourcePage = batchPageByNumber.get(sourcePageNumber);
            if (sourcePage === undefined) {
                throw new ScanCleanupContractError(
                    `Scan cleanup detection reported page ${String(sourcePageNumber)} outside its geometry batch`,
                );
            }
            const sourceDpi = resolveRasterPageDpi(
                sourceRasterStructure,
                sourcePage,
                batchRasterByNumber.get(sourcePageNumber),
            );
            const previousResult = batchResults.get(sourcePageNumber)
                ?? compatibilityResults?.get(sourcePageNumber);
            const isFirstClassification = previousResult === undefined;
            const revision = (previousResult?.revision ?? 0) + 1;
            const result: IScanCleanupDetectionResult = {
                pageNumber: requirePageNumber(sourcePageNumber),
                revision,
                classification: nativeProgress.classification!,
                confidence: nativeProgress.confidence!,
                cutterXPx: nativeProgress.cutterXPx ?? null,
                tier1Verdict: nativeProgress.tier1Verdict ?? nativeProgress.classification!,
                reconciled: nativeProgress.reconciled ?? false,
                clusterAgreement: nativeProgress.clusterAgreement ?? 0,
                documentPrior: nativeProgress.documentPrior ?? null,
                ...(nativeProgress.textAxis === undefined ? {} : {textAxis: nativeProgress.textAxis}),
                ...(nativeProgress.recommendedOutputMode === undefined
                    ? {}
                    : {recommendedOutputMode: nativeProgress.recommendedOutputMode}),
                ...(nativeProgress.recommendedOutputModeConfidence === undefined
                    ? {}
                    : {recommendedOutputModeConfidence: nativeProgress.recommendedOutputModeConfidence}),
                ...(nativeProgress.recommendedOutputModeReason === undefined
                    ? {}
                    : {recommendedOutputModeReason: nativeProgress.recommendedOutputModeReason}),
                ...(nativeProgress.softAlphaForegroundRecommendation === undefined
                    ? {}
                    : {softAlphaForegroundRecommendation: nativeProgress.softAlphaForegroundRecommendation}),
                ...(nativeProgress.outputModeDiagnostics === undefined
                    ? {}
                    : {outputModeDiagnostics: nativeProgress.outputModeDiagnostics}),
                ...(sourceDpi === undefined
                    ? {}
                    : {sourcePageMetadata: {
                        ...sourcePage,
                        pageNumber: requirePageNumber(sourcePage.pageNumber),
                        sourceDpi,
                    }}),
            };
            batchResults.set(sourcePageNumber, result);
            compatibilityResults?.set(sourcePageNumber, result);
            if (compatibilityResults === null) {
                recentResults.push(result);
            }
            if (isFirstClassification) {
                addScanCleanupDocumentCanvasObservedPage(
                    canvasAccumulator,
                    sourcePage,
                    request.options,
                    nativeProgress.classification!,
                );
                addScanCleanupDocumentCanvasObservedPage(
                    resolvedCanvasAccumulator,
                    sourcePage,
                    request.options,
                    nativeProgress.classification!,
                );
            }
            return result;
        };
        try {
            await stagedWindow.prime();
            await dependencies.runSidecar(
                binary,
                manifestPath,
                operationSignal,
                log,
                nativeProgress => {
                    if (nativeProgress.totalPages !== manifestPages.length) {
                        throw new ScanCleanupContractError(
                            `Scan cleanup detection reported ${String(nativeProgress.totalPages)} pages for ${String(manifestPages.length)} submitted pages`,
                        );
                    }
                    if (
                        nativeProgress.stage === 'page-input-required'
                        && nativeProgress.pageNumber !== undefined
                    ) {
                        const sourcePageNumber = resolveSourcePageNumber(nativeProgress.pageNumber, true);
                        if (sourcePageNumber === undefined) {
                            throw new ScanCleanupContractError(
                                `Scan cleanup detection requested unknown page ${String(nativeProgress.pageNumber)}`,
                            );
                        }
                        void stagedWindow.acquire(sourcePageNumber).catch((error: unknown) => {
                            stagingError ??= error;
                            stagingAbort.abort(error);
                        });
                        return;
                    }
                    if (
                        nativeProgress.stage === 'page-input-released'
                        && nativeProgress.pageNumber !== undefined
                    ) {
                        const sourcePageNumber = resolveSourcePageNumber(nativeProgress.pageNumber, true);
                        if (sourcePageNumber === undefined) {
                            throw new ScanCleanupContractError(
                                `Scan cleanup detection released unknown page ${String(nativeProgress.pageNumber)}`,
                            );
                        }
                        stagedWindow.release(sourcePageNumber);
                        return;
                    }
                    if (
                        (nativeProgress.stage === 'page-analyzed' || nativeProgress.stage === 'page-complete')
                        && nativeProgress.pageNumber !== undefined
                    ) {
                        const sourcePageNumber = resolveSourcePageNumber(nativeProgress.pageNumber);
                        if (sourcePageNumber === undefined) {
                            throw new ScanCleanupContractError(
                                `Scan cleanup detection reported unknown page ${String(nativeProgress.pageNumber)}`,
                            );
                        }
                        reportedPageNumbers.add(sourcePageNumber);
                        if (reportedPageNumbers.size > RECENT_PROGRESS_PAGES) {
                            reportedPageNumbers.delete(reportedPageNumbers.values().next().value!);
                        }
                        if (nativeProgress.stage === 'page-analyzed') {
                            analyzedPages = Math.max(
                                analyzedPages,
                                batch.startOffset + nativeProgress.completedPages,
                            );
                            if (
                                nativeProgress.classification === undefined
                                || nativeProgress.confidence === undefined
                            ) {
                                return;
                            }
                            recordResult(nativeProgress, sourcePageNumber);
                            if (!shouldPublishLargeProgress(analyzedPages >= totalPages)) {
                                return;
                            }
                            publish(takePublishableResults(), {
                                stage: 'detecting',
                                completedUnits: analyzedPages,
                                totalUnits: totalPages,
                                percent: totalPages === 0 ? 100 : analyzedPages / totalPages * 100,
                                ...completedPageProgress(reportedPageNumbers, analyzedPages),
                            }, documentCanvasSignature());
                            return;
                        }
                        if (
                            nativeProgress.classification === undefined
                            || nativeProgress.confidence === undefined
                        ) {
                            return;
                        }
                        recordResult(nativeProgress, sourcePageNumber);
                        const completedUnits = Math.max(
                            analyzedPages,
                            batch.startOffset + nativeProgress.completedPages,
                        );
                        if (!shouldPublishLargeProgress(completedUnits >= totalPages)) {
                            return;
                        }
                        publish(takePublishableResults(), {
                            stage: 'detecting',
                            completedUnits,
                            totalUnits: totalPages,
                            percent: totalPages === 0 ? 100 : completedUnits / totalPages * 100,
                            ...completedPageProgress(reportedPageNumbers, completedUnits),
                        }, documentCanvasSignature(completedUnits >= totalPages));
                    }
                },
                {
                    priority: 'background',
                    allowedPathRoot: dependencies.getTempDir(),
                },
            );
            for (const page of manifestPages) {
                try {
                    const result = batchResults.get(page.pageNumber);
                    if (result === undefined) continue;
                    const metadata = decodeNativeScanCleanupPageMetadataJson(
                        await fileSystem.readFile(page.pageMetadataPath, 'utf8'),
                    );
                    result.pagePlanEvidence = createDetectionPagePlanEvidence(
                        result,
                        metadata,
                        request.options.autoDewarp !== true,
                    );
                    if (metadata.splitDiagnostics !== undefined) {
                        result.splitDiagnostics = metadata.splitDiagnostics;
                    }
                    const sourcePage = batchPageByNumber.get(page.pageNumber);
                    if (
                        sourcePage !== undefined
                        && mediaBoxRetryCandidates.length < MAX_MEDIA_BOX_RETRY_PAGES
                        && result.classification === 'single-uncut-page'
                        && shouldRetryMediaBoxPage(sourcePage, result)
                    ) {
                        mediaBoxRetryCandidates.push({
                            pageNumber: page.pageNumber,
                            result,
                            sourcePage,
                        });
                    }
                } finally {
                    // Metadata is decoded into the page-indexed result before
                    // its per-batch file is dropped.
                    await fileSystem.rm(page.pageMetadataPath, {force: true});
                }
            }
            for (const pageNumber of batchPageNumbers) {
                const result = batchResults.get(pageNumber);
                if (result !== undefined) {
                    await resultStore.append(result);
                }
            }
            batchCompleted = true;
        } catch (error) {
            throw stagingError ?? error;
        } finally {
            // Detection results do not need to keep every source raster in the
            // preview cache. Only the final successful batch hands its window
            // to the cache. Releasing earlier batches keeps both file and
            // in-memory raster residency bounded across the whole document.
            const retainPreStaged = batchCompleted && batch.endOffsetExclusive >= pageScope.length;
            try {
                await stagedWindow.dispose({retainStaged: retainPreStaged});
            } finally {
                const cachePreStagedPages = retainPreStaged
                    ? new Set(rasterScope.slice(-Math.max(1, admission.windowPages)))
                    : new Set<number>();
                await releasePreStaged(cachePreStagedPages);
            }
        }
    }

    signal.throwIfAborted();
    if (resultStore.resultCount !== totalPages) {
        throw new Error(`evb-scan-cleanup returned ${resultStore.resultCount} classifications for ${totalPages} pages`);
    }
    if (mediaBoxRetryCandidates.length > 0) {
        const retryPlans = mediaBoxRetryCandidates.map(candidate => {
            const mediaPage = toMediaBoxPageSize(candidate.sourcePage);
            const limits = resolveRasterRenderLimits(mediaPage, DETECTION_DPI);
            return {
                renderDpi: DETECTION_DPI,
                raster: {
                    dpi: DETECTION_DPI,
                    width: limits.expectedWidthPx,
                    height: limits.expectedHeightPx,
                },
            };
        });
        const retryAdmission = await resolveStagedRasterWindow(
            retryPlans,
            retryPlans.length,
            scratch,
            getAvailableScratchBytes,
        );
        let candidates = mediaBoxRetryCandidates;
        if (
            !retryAdmission.admitted
            || retryAdmission.windowPages < mediaBoxRetryCandidates.length
        ) {
            log(
                'warn',
                'Scan cleanup skipped optional MediaBox retry because its rasters do not fit the remaining scratch budget',
            );
            candidates = [];
        }
        const retryRoot = join(scratch, 'mediabox-retry');
        await fileSystem.mkdir(retryRoot, {recursive: true});
        const renderedRetryPages: Array<{
            sourcePage: IPdfPageSize;
            pageNumber: number;
            path: string;
            metadataPath: string;
            width: number;
            height: number;
        }> = [];
        try {
            for (const candidate of candidates) {
                signal.throwIfAborted();
                const mediaPage = toMediaBoxPageSize(candidate.sourcePage);
                const path = join(retryRoot, `page-${String(candidate.pageNumber)}.png`);
                let dimensions;
                try {
                    dimensions = await renderRasterToDisk(
                        request.sourcePdfPath,
                        candidate.pageNumber,
                        path,
                        signal,
                        {
                            ...dependencies,
                            fileSystem,
                        },
                        log,
                        DETECTION_DPI,
                        undefined,
                        undefined,
                        'png',
                        resolveRasterRenderLimits(mediaPage, DETECTION_DPI),
                        'MediaBox retry raster',
                        'MediaBox retry',
                        'mediabox',
                    );
                } catch (error) {
                    if (signal.aborted) throw error;
                    log(
                        'warn',
                        `Scan cleanup kept the first-pass classification for page ${String(candidate.pageNumber)} because its optional MediaBox retry failed: ${getErrorMessage(error)}`,
                    );
                    continue;
                }
                renderedRetryPages.push({
                    sourcePage: candidate.sourcePage,
                    pageNumber: candidate.pageNumber,
                    path,
                    metadataPath: join(retryRoot, `page-${String(candidate.pageNumber)}.json`),
                    width: dimensions.width,
                    height: dimensions.height,
                });
            }
            const retryRasterByNumber = new Map(await Promise.all(renderedRetryPages.map(async page => [
                page.pageNumber,
                await getPageRaster(sourceRasterStructure, page.pageNumber),
            ] as const)));
            const retryManifestPages = renderedRetryPages.map((page, index) => {
                const sourceRaster = retryRasterByNumber.get(page.pageNumber);
                const sourceBackgroundDpi = sourceRaster?.backgroundDpi;
                return {
                    inputPath: page.path,
                    pageNumber: index + 1,
                    dpi: DETECTION_DPI,
                    sourceDpi: resolvePageGeometrySourceDpi(
                        page.sourcePage,
                        undefined,
                    ) ?? sourceRaster?.dpi ?? getRasterDocumentDpi(sourceRasterStructure) ?? DETECTION_DPI,
                    sourceHasBilevelLayer: sourceRaster?.hasBilevelLayer ?? false,
                    ...(sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi}),
                    pageMetadataPath: page.metadataPath,
                };
            });
            if (retryManifestPages.length > 0) {
                const retryManifestPath = join(retryRoot, 'classify-manifest.json');
                await fileSystem.writeFile(retryManifestPath, JSON.stringify(buildRunnableNativeScanCleanupManifest({
                    operation: 'analyze',
                    analysisPurpose: 'page-plan',
                    renderMode: 'preview',
                    canvasScope: 'page',
                    qualityPath: request.options.preserveOriginalQuality ? 'lossless' : 'raster',
                    options: request.options,
                    experimental: {
                        autoDewarp: request.options.autoDewarp ?? false,
                        ...(request.options.autoDewarpDepth === undefined
                            ? {}
                            : {autoDewarpDepth: request.options.autoDewarpDepth}),
                    },
                    pages: retryManifestPages,
                    allowedPathRoot: dependencies.getTempDir(),
                })));
                const retryProgressByManifestPage = new Map<number, TNativeScanCleanupProgressV3>();
                await dependencies.runSidecar(
                    binary,
                    retryManifestPath,
                    signal,
                    log,
                    nativeProgress => {
                        if (nativeProgress.totalPages !== retryManifestPages.length) {
                            throw new ScanCleanupContractError(
                                `MediaBox retry reported ${String(nativeProgress.totalPages)} pages for ${String(retryManifestPages.length)} inputs`,
                            );
                        }
                        if (
                            nativeProgress.stage === 'page-complete'
                            && nativeProgress.pageNumber !== undefined
                            && nativeProgress.pageNumber >= 1
                            && nativeProgress.pageNumber <= retryManifestPages.length
                        ) {
                            retryProgressByManifestPage.set(nativeProgress.pageNumber, nativeProgress);
                        }
                    },
                    {
                        priority: 'background',
                        allowedPathRoot: dependencies.getTempDir(),
                    },
                );
                for (const [
                    index,
                    page,
                ] of renderedRetryPages.entries()) {
                    const retryProgress = retryProgressByManifestPage.get(index + 1);
                    if (retryProgress === undefined) continue;
                    const retryMetadata = decodeNativeScanCleanupPageMetadataJson(
                        await fileSystem.readFile(page.metadataPath, 'utf8'),
                    );
                    if (!isStrongMediaBoxSpread(
                        retryProgress,
                        retryMetadata,
                        page.width,
                        page.height,
                    )) {
                        continue;
                    }
                    const mediaPage = toMediaBoxPageSize(page.sourcePage);
                    const result = await resultStore.getPage(page.pageNumber);
                    if (result === undefined) continue;
                    const accepted: IScanCleanupDetectionResult = {
                        ...result,
                        revision: (result.revision ?? 0) + 1,
                        classification: retryProgress.classification ?? retryMetadata.layoutClassification,
                        confidence: retryProgress.confidence ?? retryMetadata.layoutConfidence ?? result.confidence,
                        cutterXPx: retryProgress.cutterXPx ?? retryMetadata.cutterXPx,
                        tier1Verdict: retryProgress.tier1Verdict ?? retryMetadata.layoutClassification,
                        reconciled: retryProgress.reconciled ?? false,
                        clusterAgreement: retryProgress.clusterAgreement ?? 0,
                        documentPrior: retryProgress.documentPrior ?? null,
                        sourcePageMetadata: {
                            ...mediaPage,
                            pageNumber: requirePageNumber(mediaPage.pageNumber),
                            sourceDpi: resolveRasterPageDpi(
                                sourceRasterStructure,
                                page.sourcePage,
                                retryRasterByNumber.get(page.pageNumber),
                            ) ?? DETECTION_DPI,
                            renderBox: 'mediabox',
                        },
                        ...(retryMetadata.splitDiagnostics === undefined
                            ? {}
                            : {splitDiagnostics: retryMetadata.splitDiagnostics}),
                        ...(retryProgress.textAxis === undefined ? {} : {textAxis: retryProgress.textAxis}),
                        ...(retryProgress.recommendedOutputMode === undefined
                            ? {}
                            : {recommendedOutputMode: retryProgress.recommendedOutputMode}),
                        ...(retryProgress.recommendedOutputModeConfidence === undefined
                            ? {}
                            : {recommendedOutputModeConfidence: retryProgress.recommendedOutputModeConfidence}),
                        ...(retryProgress.recommendedOutputModeReason === undefined
                            ? {}
                            : {recommendedOutputModeReason: retryProgress.recommendedOutputModeReason}),
                        ...(retryProgress.softAlphaForegroundRecommendation === undefined
                            ? {}
                            : {softAlphaForegroundRecommendation: retryProgress.softAlphaForegroundRecommendation}),
                        ...(retryProgress.outputModeDiagnostics === undefined
                            ? {}
                            : {outputModeDiagnostics: retryProgress.outputModeDiagnostics}),
                    };
                    accepted.pagePlanEvidence = createDetectionPagePlanEvidence(
                        accepted,
                        retryMetadata,
                        request.options.autoDewarp !== true,
                    );
                    await resultStore.replace(page.pageNumber, accepted);
                    compatibilityResults?.set(page.pageNumber, accepted);
                    log(
                        'debug',
                        `MediaBox retry accepted page ${String(page.pageNumber)} as a two-page spread`,
                    );
                }
            }
        } finally {
            await fileSystem.rm(retryRoot, {
                recursive: true,
                force: true,
            });
        }
    }
    const placementAnchorSummary = usesScanCleanupInkAlignment(request.options)
        ? await buildScanCleanupPlacementAnchorSummary({
            options: request.options,
            resultStore,
            signal,
        })
        : undefined;
    return {
        resultStore,
        results: publishedResults(),
        ...(placementAnchorSummary === undefined ? {} : {placementAnchorSummary}),
    };
}

export async function runScanCleanupDetection<TDocument>(
    request: IScanCleanupDetectionRequest,
    signal: AbortSignal,
    retention: IScanCleanupDetectionRetention<TDocument>,
    dependencies: IScanCleanupDetectionDependencies,
    policy: Pick<IScanCleanupRuntimePolicy, 'rasterConcurrency'>,
    publish: (
        results: IScanCleanupDetectionResult[],
        progress: TScanCleanupProgress,
        documentCanvasSignature: string,
    ) => void,
    log: TScanCleanupLog = () => undefined,
) {
    const fileSystem = dependencies.fileSystem;
    if (!fileSystem) throw new Error('Scan cleanup detection requires injected filesystem capabilities');
    // The document opens first: a scratch directory created before it has
    // nothing to release if opening throws, and only this function removes it.
    const document = await retention.openDocument(request);
    let scratchDir: string | null = null;
    try {
        const scratch = join(
            dependencies.getTempDir(),
            `scan-cleanup-rasters-${randomUUID()}-${process.pid}`,
        );
        await fileSystem.mkdir(scratch, {recursive: true});
        scratchDir = scratch;
        const totalPages = await retention.pageCount(document, signal);
        const pageScope = resolveScanCleanupPageScopeLazy(undefined, totalPages);
        const pageSizeStore = await resolveDetectionPageSizeStore(retention, document, signal);
        let resultStore: IScanCleanupDetectionResultStore | null = null;
        let resultStoreTransferred = false;
        try {
            resultStore = await createFileBackedScanCleanupDetectionResultStore({
                fileSystem,
                rootDir: dependencies.getTempDir(),
                pageCount: totalPages,
            });
            const outcome = await runBatchedScanCleanupDetection(
                request,
                signal,
                retention,
                pageSizeStore,
                resultStore,
                dependencies,
                policy,
                publish,
                log,
                document,
                pageScope,
                totalPages,
                scratch,
            );
            resultStoreTransferred = true;
            return outcome;
        } finally {
            await pageSizeStore.close();
            if (!resultStoreTransferred && resultStore !== null) {
                await resultStore.close();
            }
        }
    } finally {
        await retention.release(document);
        if (scratchDir !== null) {
            await preserveScanCleanupJsonEvidence(scratchDir, log, fileSystem).catch(error => {
                log(
                    'warn',
                    `Could not preserve scan-cleanup detection evidence: ${getErrorMessage(error)}`,
                );
            });
            await fileSystem.rm(scratchDir, {
                recursive: true,
                force: true,
            });
        }
    }
}
