import type {
    INativeScanCleanupAnalysisOutputV3,
    INativeScanCleanupOptionsV3,
    INativeScanCleanupPageMetadataV3,
    TScanCleanupOutputHalf,
    TScanCleanupProgress,
    TScanCleanupSummary,
    TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {getScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {
    createEmptyScanCleanupSummary,
    createScanCleanupProgressReporter,
    createScanCleanupSummaryWarningReporter,
    reportScanCleanupSummaryWarningEvent,
    type TEmitScanCleanupProgress,
} from '@evb/scan-cleanup/core/createScanCleanupProgressReporter';
import {
    assertScanCleanupInkAnchorCapacity,
    buildBoundedDetectionRequestFields,
    planScanCleanupRunQuality,
    readDetectionResultsForPageNumbers,
    withBoundedDetectionFields,
    type TScanCleanupDocumentCanvas,
} from '@evb/scan-cleanup/core/scanCleanupConversionPlan';
import {
    reportScanCleanupNativeWarnings,
    type IScanCleanupRenderedOutput,
} from '@evb/scan-cleanup/core/scanCleanupOutputComposition';
import {
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
    type TScanCleanupStampBuildIds,
} from '@evb/scan-cleanup/core/provenanceStamp';
import {
    mapScanCleanupPageScope,
    resolveScanCleanupPageScopeLazy,
    type TScanCleanupPageScope,
} from '@evb/scan-cleanup/core/pageScope';
import {ScanCleanupContractError} from '@evb/scan-cleanup/core/errors';
import type {IPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import type {
    IPdfPageSize,
    IRunScanCleanupPipelineRequest,
    IScanCleanupOutputMapping,
    IScanCleanupPageRasterSource,
    TScanCleanupLog,
} from '@evb/scan-cleanup/core/types';

export type TScanCleanupWarnEvent = (
    event: TScanCleanupWarningEvent,
    pageNumber?: number,
    half?: TScanCleanupOutputHalf,
) => void;

export interface IScanCleanupCoordinatedQualityPlan {
    documentCanvas: TScanCleanupDocumentCanvas | null;
    options: IRunScanCleanupPipelineRequest['options'];
    losslessRun: boolean;
}

export interface IScanCleanupCoordinatedConversionContext<
    TPageSizeStore extends IPdfPageSizeStore = IPdfPageSizeStore,
    TRasterSource extends IScanCleanupPageRasterSource = IScanCleanupPageRasterSource,
    TPrepared = unknown,
> {
    /** Original caller request. */
    readonly inputRequest: IRunScanCleanupPipelineRequest;
    /** Request with small-document detection store fields materialized once when applicable. */
    readonly request: IRunScanCleanupPipelineRequest;
    /** Materialized small-document detection fields, or null for large runs / no store. */
    readonly smallStoreFields: ReturnType<typeof buildBoundedDetectionRequestFields> | null;
    readonly documentPageCount: number;
    readonly pageNumbers: TScanCleanupPageScope;
    readonly pageCount: number;
    readonly largeStreamingRun: boolean;
    readonly fullDocumentRun: boolean;
    readonly summary: TScanCleanupSummary;
    readonly emitProgress: TEmitScanCleanupProgress;
    readonly warn: (message: string, level?: 'warn' | 'error') => void;
    readonly warnEvent: TScanCleanupWarnEvent;
    readonly signal: AbortSignal;
    readonly log: TScanCleanupLog;
    readonly prepared: TPrepared;
    readonly pageSizeStore: TPageSizeStore;
    readonly rasterSource: TRasterSource;
    readonly qualityPlan: IScanCleanupCoordinatedQualityPlan;
}

export interface IScanCleanupGeometryAndProbeResult<
    TPageSizeStore extends IPdfPageSizeStore = IPdfPageSizeStore,
    TRasterSource extends IScanCleanupPageRasterSource = IScanCleanupPageRasterSource,
> {
    pageSizeStore: TPageSizeStore;
    rasterSource: TRasterSource;
    rasterDetectionAvailable: boolean;
    rasterMaxPixels?: number | undefined;
    onGeometryPage?: ((page: IPdfPageSize) => Promise<void> | void) | undefined;
    afterQualityPlan?: (() => Promise<void> | void) | undefined;
}

export interface IScanCleanupConversionHost<
    TResult,
    TExecution = void,
    TPageSizeStore extends IPdfPageSizeStore = IPdfPageSizeStore,
    TRasterSource extends IScanCleanupPageRasterSource = IScanCleanupPageRasterSource,
    TPrepared = unknown,
> {
    prepareSource: (input: {
        request: IRunScanCleanupPipelineRequest;
        signal: AbortSignal;
        emitProgress: TEmitScanCleanupProgress;
    }) => Promise<{
        documentPageCount: number;
        preparedWarnings: readonly string[];
        prepared: TPrepared;
    }>;
    openGeometryAndProbe: (input: {
        inputRequest: IRunScanCleanupPipelineRequest;
        request: IRunScanCleanupPipelineRequest;
        smallStoreFields: ReturnType<typeof buildBoundedDetectionRequestFields> | null;
        documentPageCount: number;
        pageNumbers: TScanCleanupPageScope;
        pageCount: number;
        largeStreamingRun: boolean;
        fullDocumentRun: boolean;
        summary: TScanCleanupSummary;
        emitProgress: TEmitScanCleanupProgress;
        warn: (message: string, level?: 'warn' | 'error') => void;
        warnEvent: TScanCleanupWarnEvent;
        prepared: TPrepared;
        signal: AbortSignal;
    }) => Promise<IScanCleanupGeometryAndProbeResult<TPageSizeStore, TRasterSource>>;
    executeConversion: (
        context: IScanCleanupCoordinatedConversionContext<TPageSizeStore, TRasterSource, TPrepared>,
    ) => Promise<TExecution>;
    validateAndPublish: (
        context: IScanCleanupCoordinatedConversionContext<TPageSizeStore, TRasterSource, TPrepared>,
        execution: TExecution,
    ) => Promise<TResult>;
    onError?: (error: unknown) => void;
    cleanup?: () => Promise<void> | void;
}

export interface ICoordinateScanCleanupConversionInput<
    TResult,
    TExecution = void,
    TPageSizeStore extends IPdfPageSizeStore = IPdfPageSizeStore,
    TRasterSource extends IScanCleanupPageRasterSource = IScanCleanupPageRasterSource,
    TPrepared = unknown,
> {
    request: IRunScanCleanupPipelineRequest;
    signal: AbortSignal;
    onProgress: (progress: TScanCleanupProgress) => void;
    log?: TScanCleanupLog;
    host: IScanCleanupConversionHost<TResult, TExecution, TPageSizeStore, TRasterSource, TPrepared>;
}

/**
 * Host-agnostic scan-cleanup conversion coordinator shared by desktop
 * (Electron/CLI) and browser (WASM) runtimes.
 *
 * Owns the canonical run lifecycle: normalizing, page-scope & ink-anchor
 * admission, small-document detection store materialization, summary/warning
 * reporting, document quality & canvas planning, execution dispatch, and
 * handoff progress. Hosts supply only transport and storage adapters.
 */
export async function coordinateScanCleanupConversion<
    TResult,
    TExecution = void,
    TPageSizeStore extends IPdfPageSizeStore = IPdfPageSizeStore,
    TRasterSource extends IScanCleanupPageRasterSource = IScanCleanupPageRasterSource,
    TPrepared = unknown,
>({
    request: inputRequest,
    signal,
    onProgress,
    log = () => undefined,
    host,
}: ICoordinateScanCleanupConversionInput<TResult, TExecution, TPageSizeStore, TRasterSource, TPrepared>): Promise<TResult> {
    let losslessRun = inputRequest.options.preserveOriginalQuality === true;
    const emitProgress = createScanCleanupProgressReporter(onProgress, () => losslessRun);
    try {
        emitProgress('normalizing', 0, 1, []);
        const {
            documentPageCount,
            preparedWarnings,
            prepared,
        } = await host.prepareSource({
            request: inputRequest,
            signal,
            emitProgress,
        });
        const pageNumbers = resolveScanCleanupPageScopeLazy(
            inputRequest.sourcePageNumbers,
            documentPageCount,
            inputRequest.sourcePageRange,
        );
        const pageCount = pageNumbers.length;
        assertScanCleanupInkAnchorCapacity(
            pageCount,
            inputRequest.options,
            inputRequest.placementAnchorSummary,
        );
        const largeStreamingRun = documentPageCount > SCAN_CLEANUP_STREAMING_BATCH_PAGES;
        const fullDocumentRun = inputRequest.sourcePageNumbers === undefined
            && inputRequest.sourcePageRange === undefined;
        // A detection store is the decision owner at every document size. A
        // document small enough for one batch materializes its bounded maps
        // from it once, identically across desktop and browser.
        const smallStoreFields = !largeStreamingRun && inputRequest.detectionResultStore !== undefined
            ? await (async (store, documentPages) => buildBoundedDetectionRequestFields(
                inputRequest,
                await readDetectionResultsForPageNumbers(store, documentPages, signal),
                documentPages,
            ))(
                inputRequest.detectionResultStore,
                Array.from({length: documentPageCount}, (_, index) => index + 1),
            )
            : null;
        const request = smallStoreFields === null
            ? inputRequest
            : withBoundedDetectionFields(inputRequest, smallStoreFields);
        const summary = createEmptyScanCleanupSummary(pageCount, preparedWarnings);
        const warn = createScanCleanupSummaryWarningReporter(summary, log);
        const warnEvent: TScanCleanupWarnEvent = (event, pageNumber, half) => {
            reportScanCleanupSummaryWarningEvent(summary, {
                event,
                ...(pageNumber === undefined ? {} : {pageNumber: requirePageNumber(pageNumber)}),
                ...(half === undefined ? {} : {half}),
            }, warn);
        };
        emitProgress('normalizing', 1, 1);

        const probed = await host.openGeometryAndProbe({
            inputRequest,
            request,
            smallStoreFields,
            documentPageCount,
            pageNumbers,
            pageCount,
            largeStreamingRun,
            fullDocumentRun,
            summary,
            emitProgress,
            warn,
            warnEvent,
            prepared,
            signal,
        });
        let qualityPlan: IScanCleanupCoordinatedQualityPlan;
        try {
            qualityPlan = await planScanCleanupRunQuality({
                request: inputRequest,
                documentPageCount,
                pageSizeStore: probed.pageSizeStore,
                rasterSource: probed.rasterSource,
                rasterDetectionAvailable: probed.rasterDetectionAvailable,
                ...(probed.rasterMaxPixels === undefined ? {} : {rasterMaxPixels: probed.rasterMaxPixels}),
                signal,
                warn,
                warnEvent,
                ...(probed.onGeometryPage === undefined
                    ? {}
                    : {onGeometryPage: page => Promise.resolve(probed.onGeometryPage!(page))}),
            });
        } catch (error) {
            if (probed.afterQualityPlan !== undefined) {
                try {
                    await probed.afterQualityPlan();
                } catch (cleanupError) {
                    log(
                        'warn',
                        `Scan cleanup geometry cleanup failed after planning error: ${
                            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                        }`,
                    );
                }
            }
            throw error;
        }
        await probed.afterQualityPlan?.();
        losslessRun = qualityPlan.losslessRun;

        const context: IScanCleanupCoordinatedConversionContext<TPageSizeStore, TRasterSource, TPrepared> = {
            inputRequest,
            request,
            smallStoreFields,
            documentPageCount,
            pageNumbers,
            pageCount,
            largeStreamingRun,
            fullDocumentRun,
            summary,
            emitProgress,
            warn,
            warnEvent,
            signal,
            log,
            prepared,
            pageSizeStore: probed.pageSizeStore,
            rasterSource: probed.rasterSource,
            qualityPlan,
        };
        const execution = await host.executeConversion(context);
        signal.throwIfAborted();
        return await host.validateAndPublish(context, execution);
    } catch (error) {
        host.onError?.(error);
        throw error;
    } finally {
        if (host.cleanup !== undefined) {
            try {
                await host.cleanup();
            } catch (cleanupError) {
                log(
                    'warn',
                    `Scan cleanup post-run cleanup failed: ${
                        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                    }`,
                );
            }
        }
    }
}

export interface IScanCleanupAnalyzedLosslessPage {
    sourcePageIndex: number;
    rotationQuarterTurns: number;
    outputs: Array<{
        half: INativeScanCleanupAnalysisOutputV3['half'];
        placement: NonNullable<INativeScanCleanupAnalysisOutputV3['pdfPlacement']>;
    }>;
    sourceDpi: number;
    sourceRasterDetected: boolean;
}

/**
 * Strips planned PDF placement from lossless page metadata so provenance
 * hashing depends only on the observed page analysis.
 */
export function stripScanCleanupLosslessPlacement(
    metadata: INativeScanCleanupPageMetadataV3,
): INativeScanCleanupPageMetadataV3 {
    return metadata.outputs === undefined
        ? metadata
        : {
            ...metadata,
            outputs: metadata.outputs.map(({
                pdfPlacement: _pdfPlacement,
                ...rest
            }) => rest),
        };
}

/**
 * Reduces one analyzed lossless page's metadata into summary counts,
 * provenance metadata, and ordered output placements.
 */
export function reduceScanCleanupLosslessPage(input: {
    request: IRunScanCleanupPipelineRequest;
    pageNumber: number;
    metadata: INativeScanCleanupPageMetadataV3;
    sourceDpi: number;
    sourceRasterDetected: boolean;
    summary: TScanCleanupSummary;
    pageMetadataBySource: Map<number, INativeScanCleanupPageMetadataV3>;
}): IScanCleanupAnalyzedLosslessPage | null {
    const {
        request,
        pageNumber,
        metadata,
        sourceDpi,
        sourceRasterDetected,
        summary,
        pageMetadataBySource,
    } = input;
    pageMetadataBySource.set(pageNumber, stripScanCleanupLosslessPlacement(metadata));
    if (metadata.excluded) {
        summary.excludedPages += 1;
        return null;
    }
    if (metadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
    if (metadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
    const outputs = (metadata.outputs ?? []).map(output => {
        if (output.pdfPlacement === undefined) {
            throw new ScanCleanupContractError(
                `evb-scan-cleanup returned no placement for page ${String(pageNumber)}`,
            );
        }
        return {
            half: output.half,
            placement: output.pdfPlacement,
        };
    });
    if (request.options.readingOrder === 'rtl' && metadata.layoutClassification === 'two-page-spread') {
        outputs.reverse();
    }
    const pageOverride = getScanCleanupPageOverride(
        request.options.pageOverrides,
        requirePageNumber(pageNumber),
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
    return {
        sourcePageIndex: pageNumber - 1,
        rotationQuarterTurns: pageOverride.rotationDegrees / 90,
        outputs,
        sourceDpi,
        sourceRasterDetected,
    };
}

/**
 * Aggregates lossless placement warnings, scaled-in-place raster warnings,
 * output counts, and source-to-output page mappings.
 */
export function finalizeScanCleanupLosslessOutputs(input: {
    request: IRunScanCleanupPipelineRequest;
    pageNumbers: TScanCleanupPageScope;
    analyzedPages: readonly IScanCleanupAnalyzedLosslessPage[];
    pageMetadataBySource: ReadonlyMap<number, INativeScanCleanupPageMetadataV3>;
    summary: TScanCleanupSummary;
    warnEvent: TScanCleanupWarnEvent;
    allowEmptyOutputs?: boolean;
}) {
    const {
        request,
        pageNumbers,
        analyzedPages,
        pageMetadataBySource,
        summary,
        warnEvent,
        allowEmptyOutputs = false,
    } = input;
    const allOutputs = analyzedPages.flatMap(page => page.outputs.map(output => ({
        ...output,
        sourcePageIndex: page.sourcePageIndex,
        sourceDpi: page.sourceDpi,
        sourceRasterDetected: page.sourceRasterDetected,
    })));
    if (allOutputs.length === 0 && !allowEmptyOutputs) {
        throw new ScanCleanupContractError('evb-scan-cleanup analysis produced no output pages');
    }
    const scaledRasterPages = new Set<number>();
    const placementEvents: Array<[TScanCleanupWarningEvent, number, TScanCleanupOutputHalf]> = [];
    for (const page of analyzedPages) {
        for (const {
            half,
            placement,
        } of page.outputs) {
            for (const event of placement.warningEvents ?? []) {
                placementEvents.push([
                    event,
                    page.sourcePageIndex + 1,
                    half,
                ]);
            }
            if (placement.contentScaled && page.sourceRasterDetected) {
                scaledRasterPages.add(page.sourcePageIndex + 1);
            }
        }
    }
    if (scaledRasterPages.size > 0) {
        warnEvent({
            code: 'matched-canvas-pages-scaled-in-place',
            pages: [...scaledRasterPages].map(pageNumber => requirePageNumber(pageNumber)),
        });
    }
    for (const [
        event,
        pageNumber,
        half,
    ] of placementEvents) {
        warnEvent(event, pageNumber, half);
    }
    summary.outputPages = allOutputs.length;
    const outputMappings: IScanCleanupOutputMapping[] = allOutputs.map((output, outputIndex) => {
        const sourcePage = output.sourcePageIndex + 1;
        const metadata = pageMetadataBySource.get(sourcePage);
        return {
            sourcePage,
            half: output.half,
            outputOrdinal: outputIndex + 1,
            rotationDegrees: metadata?.rotationDegrees ?? 0,
            excluded: false,
            blank: false,
        };
    });
    const coveredPages = new Set(outputMappings.map(mapping => mapping.sourcePage));
    for (const pageNumber of pageNumbers) {
        if (coveredPages.has(pageNumber)) continue;
        const metadata = pageMetadataBySource.get(pageNumber);
        outputMappings.push({
            sourcePage: pageNumber,
            half: 'full',
            outputOrdinal: null,
            rotationDegrees: metadata?.rotationDegrees ?? getScanCleanupPageOverride(
                request.options.pageOverrides,
                requirePageNumber(pageNumber),
                request.options.pageOverrideDefaults,
                request.options.marginsMm,
            ).rotationDegrees,
            excluded: metadata?.excluded === true,
            blank: metadata?.excluded !== true,
        });
    }
    return {
        allOutputs,
        outputMappings,
    };
}

/**
 * Builds the canonical scan-cleanup provenance stamp and its encoded hex payload
 * for both lossless and raster runs on desktop and browser.
 */
export function buildScanCleanupConversionProvenanceStamp(input: {
    options: IRunScanCleanupPipelineRequest['options'];
    pageNumbers: TScanCleanupPageScope;
    qualityPath: 'lossless' | 'raster';
    sourceSha256: string;
    nativeOptionsBySource: ReadonlyMap<number, INativeScanCleanupOptionsV3>;
    pageMetadataBySource: ReadonlyMap<number, INativeScanCleanupPageMetadataV3>;
    outputMappings: readonly IScanCleanupOutputMapping[];
    buildIds: TScanCleanupStampBuildIds;
}) {
    const {
        options,
        pageNumbers,
        qualityPath,
        sourceSha256,
        nativeOptionsBySource,
        pageMetadataBySource,
        outputMappings,
        buildIds,
    } = input;
    const effectiveOptions = mapScanCleanupPageScope(pageNumbers, sourcePage => {
        const nativeOptions = nativeOptionsBySource.get(sourcePage);
        if (nativeOptions === undefined) {
            throw new ScanCleanupContractError(
                `Scan cleanup lost manifest page ${String(sourcePage)} during batching`,
            );
        }
        return {
            sourcePage,
            options: materializeScanCleanupStampOptions({
                nativeOptions,
                options,
                qualityPath,
            }),
        };
    });
    const stamp = buildScanCleanupProvenanceStamp({
        sourceSha256,
        effectiveOptions,
        outputMappings: [...outputMappings],
        pagePlanDigests: effectiveOptions.map(record => buildScanCleanupPagePlanDigest(
            record.sourcePage,
            record.options,
            pageMetadataBySource.get(record.sourcePage) ?? {excluded: true},
        )),
        buildIds,
    });
    return {
        stamp,
        stampHex: encodeScanCleanupProvenanceStampHex(stamp),
    };
}

/**
 * Commits one rendered page's counters and native warnings in document order.
 */
export function commitScanCleanupRenderedPageSummary<TPath>(input: {
    summary: TScanCleanupSummary;
    pageNumber: number;
    pageMetadata: INativeScanCleanupPageMetadataV3;
    pageOutputs: readonly IScanCleanupRenderedOutput<TPath>[];
    deskewSkipped: number;
    cropSkipped: number;
    mixedLayerMismatchWarnings: readonly string[];
    pageEmptyOutputMappings: readonly IScanCleanupOutputMapping[];
    emptyOutputMappings: IScanCleanupOutputMapping[];
    fittedMarginBoxPages: Set<number>;
    warn: (message: string, level?: 'warn' | 'error') => void;
}) {
    const {
        summary,
        pageNumber,
        pageMetadata,
        pageOutputs,
        deskewSkipped,
        cropSkipped,
        mixedLayerMismatchWarnings,
        pageEmptyOutputMappings,
        emptyOutputMappings,
        fittedMarginBoxPages,
        warn,
    } = input;
    emptyOutputMappings.push(...pageEmptyOutputMappings);
    if (pageMetadata.excluded) {
        summary.excludedPages += 1;
        return;
    }
    summary.blankPagesSkipped += pageMetadata.blankOutputsSkipped;
    summary.deskewSkipped += deskewSkipped;
    summary.cropSkipped += cropSkipped;
    for (const warning of mixedLayerMismatchWarnings) {
        warn(warning, 'error');
    }
    for (const output of pageOutputs) {
        reportScanCleanupNativeWarnings(summary, output.metadata, pageNumber, fittedMarginBoxPages, warn);
    }
    if (pageMetadata.layoutClassification === 'two-page-spread') summary.spreadsSplit += 1;
    if (pageMetadata.layoutClassification === 'page-with-offcut') summary.offcutsDiscarded += 1;
}
