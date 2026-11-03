 

import {randomUUID} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupDetectionResult,
    TScanCleanupProgress,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {TNativeScanCleanupProgressV3} from '@contracts/scan-cleanup/nativeProtocolV3';
import {decodeNativeScanCleanupPageMetadataJson} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {getErrorMessage} from '@contracts/getErrorMessage';
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
    detectPageRasterFromPageSize,
    isScanCleanupCompactLayeredRaster,
    type IDetectedPageRaster,
    type IPdfPageSize,
    type IScanCleanupDetectionResultStore,
    type IScanCleanupPageRasterSource,
    type IScanCleanupRasterRenderLimits,
    type TScanCleanupLog,
    type TScanCleanupRenderPage,
    type TScanCleanupRunSidecar,
} from '@evb/scan-cleanup/core/types';
import type {IPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {
    type readAvailableScratchBytes,
    resolveStagedRasterWindow,
} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {createStagedRasterWindow} from '@evb/scan-cleanup/core/createStagedRasterWindow';
import {renderScanCleanupRasterToDisk as renderRasterToDisk} from '@evb/scan-cleanup/core/rasterValidation';
import {
    DETECTION_DPI,
    PREVIEW_DPI,
    resolvePagePreviewDpi,
    resolvePreviewProcessingDpi,
    resolvePreviewRasterPlan,
    resolveScanCleanupAnalysisDpi,
    resolveScanCleanupPagePreviewDpi,
    resolveScanCleanupRasterRenderLimits as resolveRasterRenderLimits,
    SCAN_CLEANUP_RASTER_MAX_PIXELS,
    toCropBoxPageSize,
    toMediaBoxPageSize,
} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';
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
import {splitContiguousPageRuns} from '@evb/scan-cleanup/core/splitContiguousPageRuns';
import {createScanCleanupDetectionRecorder} from '@evb/scan-cleanup/core/createScanCleanupDetectionRecorder';

export {
    DETECTION_DPI,
    PREVIEW_DPI,
    resolvePagePreviewDpi,
    resolvePreviewProcessingDpi,
    resolvePreviewRasterPlan,
    resolveScanCleanupAnalysisDpi,
    resolveScanCleanupPagePreviewDpi,
};

function getPageRaster(
    source: IScanCleanupPageRasterSource,
    pageNumber: number,
) {
    return source.getPageRaster(pageNumber);
}

function getRasterDocumentDpi(source: IScanCleanupPageRasterSource) {
    return Number.isFinite(source.documentDpi) && (source.documentDpi ?? 0) > 0
        ? source.documentDpi!
        : undefined;
}

function resolveRasterPageDpi(
    source: IScanCleanupPageRasterSource,
    page: IPdfPageSize,
    raster: IDetectedPageRaster | undefined,
) {
    const rasterDpi = raster?.dpi;
    if (Number.isFinite(rasterDpi) && (rasterDpi ?? 0) > 0) {
        return rasterDpi;
    }
    return resolvePageGeometrySourceDpi(page, undefined) ?? getRasterDocumentDpi(source);
}

export function createScanCleanupDocumentRasterPages(
    detected: boolean,
    rasterByPage: ReadonlyMap<number, IDetectedPageRaster>,
): IScanCleanupPageRasterSource {
    let documentDpi = 0;
    let compactLayeredPageCount = 0;
    for (const raster of rasterByPage.values()) {
        documentDpi = Math.max(documentDpi, raster.dpi);
        if (isScanCleanupCompactLayeredRaster(raster)) {
            compactLayeredPageCount += 1;
        }
    }
    return {
        detected,
        documentDpi: documentDpi > 0 ? documentDpi : null,
        compactLayeredPageCount,
        compactLayeredPageCountComplete: true,
        getPageRaster: pageNumber => rasterByPage.get(pageNumber),
    };
}

/**
 * Detection's share of the runtime policy. Host memory is optional because
 * only the desktop host measures it; without it the native tool assumes a
 * small machine and analyzes one page at a time.
 */
type TScanCleanupDetectionPolicy = Pick<IScanCleanupRuntimePolicy, 'rasterConcurrency' | 'rasterMaxPixels'>
    & Partial<Pick<IScanCleanupRuntimePolicy, 'totalRamBytes'>>;

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
    pageSizeStore: (document: TDocument, signal: AbortSignal) => Promise<IPdfPageSizeStore>;
    rasterPages: (
        document: TDocument,
        signal: AbortSignal,
    ) => Promise<IScanCleanupPageRasterSource>;
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
    evidenceDirectory?: string | undefined;
    onResultStoreReady?: (store: IScanCleanupDetectionResultStore) => void;
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
        onPageRendered?: (pageNumber: number) => void;
    }) => Promise<ReadonlyArray<{
        height: number;
        pageNumber: number;
        width: number
    }>>;
    runSidecar: TScanCleanupRunSidecar;
}

async function resolveDetectionPageSizeStore<TDocument>(
    retention: IScanCleanupDetectionRetention<TDocument>,
    document: TDocument,
    signal: AbortSignal,
) {
    return retention.pageSizeStore(document, signal);
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
    policy: TScanCleanupDetectionPolicy,
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
    let sourceRasterStructure: IScanCleanupPageRasterSource | undefined;
    const recorder = createScanCleanupDetectionRecorder({
        request,
        totalPages,
        resultStore,
        signal,
        rasterMaxPixels: policy.rasterMaxPixels,
        publish,
    });
    let geometryPages = 0;
    let expectedGeometryPageNumber = 1;
    await pageSizeStore.forEachChunk(async chunk => {
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
        }
        if (sourceRasterStructure === undefined) {
            sourceRasterStructure = await retention.rasterPages(document, signal);
        }
        const chunkSourceRasterStructure = sourceRasterStructure;
        for (const rawPage of chunk.pages) {
            signal.throwIfAborted();
            const page = toCropBoxPageSize(rawPage);
            recorder.addGeometryPage(
                page,
                resolvePageGeometrySourceDpi(page, undefined) ?? getRasterDocumentDpi(chunkSourceRasterStructure),
            );
        }
    });
    if (geometryPages !== totalPages) {
        throw new Error(
            `Scan cleanup page-size store returned ${String(geometryPages)} pages for ${String(totalPages)} document pages`,
        );
    }
    if (sourceRasterStructure === undefined) {
        sourceRasterStructure = await retention.rasterPages(document, signal);
    }
    const resolvedSourceRasterStructure = sourceRasterStructure;
    if (resolvedSourceRasterStructure === undefined) {
        throw new Error('Scan cleanup detection could not resolve source raster facts');
    }
    const binary = dependencies.resolveBinary();
    if (!binary) throw new ScanCleanupNativeToolUnavailableError('evb-scan-cleanup');

    recorder.sealGeometry();

    for (const batch of iterateScanCleanupPageBatches(
        pageScope.length,
        SCAN_CLEANUP_STREAMING_BATCH_PAGES,
    )) {
        signal.throwIfAborted();
        const batchPageNumbers = collectScanCleanupPageScopeBatch(pageScope, batch);
        const batchPageSet = new Set(batchPageNumbers);
        const batchRecorder = recorder.beginBatch(batch);
        const batchPageRecords = await readDetectionPageSizeBatch(pageSizeStore, batchPageNumbers);
        const batchPageByNumber = new Map(batchPageRecords.map(record => [
            record.page.pageNumber,
            record.page,
        ]));
        const batchRasterByNumber = new Map(await Promise.all(batchPageNumbers.map(async pageNumber => [
            pageNumber,
            await getPageRaster(resolvedSourceRasterStructure, pageNumber),
        ] as const)));
        const analysisDpiByPage = new Map(batchPageNumbers.map(pageNumber => [
            pageNumber,
            resolveScanCleanupAnalysisDpi(batchPageByNumber.get(pageNumber)),
        ]));
        const analysisDpi = (pageNumber: number) => analysisDpiByPage.get(pageNumber)!;
        const previouslyBroadenedPages = new Set(
            batchPageRecords
                .filter(record => record.raw.renderBox === 'mediabox')
                .map(record => record.page.pageNumber),
        );
        const retained = new Map<number, IScanCleanupRetainedRaster>();
        for (const dpi of new Set(analysisDpiByPage.values())) {
            const pagesAtDpi = batchPageNumbers.filter(pageNumber => analysisDpi(pageNumber) === dpi);
            for (const [
                pageNumber,
                raster,
            ] of await retention.retainedPaths(document, pagesAtDpi, dpi)) {
                // A preview opened before detection may have cached the
                // compatibility MediaBox render. It cannot be reused for the
                // CropBox-first pass.
                if (!previouslyBroadenedPages.has(pageNumber) && batchPageSet.has(pageNumber)) {
                    const claimed = retention.claimRaster?.(document, pageNumber, dpi) ?? true;
                    if (claimed) {
                        retained.set(pageNumber, raster);
                    }
                }
            }
        }
        const rasterScope = batchPageNumbers.filter(pageNumber => !retained.has(pageNumber));
        const rasterLimitsByPage = new Map(batchPageNumbers.map(pageNumber => [
            pageNumber,
            resolveRasterRenderLimits(
                batchPageByNumber.get(pageNumber),
                analysisDpi(pageNumber),
                Math.min(policy.rasterMaxPixels ?? SCAN_CLEANUP_RASTER_MAX_PIXELS, SCAN_CLEANUP_RASTER_MAX_PIXELS),
            ),
        ]));
        const stagingPlans = rasterScope.map(pageNumber => {
            const limits = rasterLimitsByPage.get(pageNumber)!;
            return {
                renderDpi: analysisDpi(pageNumber),
                renderCopies: 2,
                raster: {
                    dpi: analysisDpi(pageNumber),
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
                    analysisDpi(pageNumber),
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
        batchRecorder.addRetainedRasters(retained.keys());
        const recordRasterizedPage = (pageNumber: number) => batchRecorder.markRasterized(pageNumber);
        const batchRenderer = dependencies.renderPageBatch;
        // The detector's resident window is bounded by admission.windowPages.
        // Batch pre-staging is safe only when the entire requested set fits
        // inside that window. A large manifest may fit the scratch estimate
        // while still being too large for one Poppler process and one burst of
        // retained rasters, so long documents must use the staged windows.
        const canPrestageBatch = batchRenderer !== undefined
            && totalPages > SCAN_CLEANUP_STREAMING_BATCH_PAGES
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
                    await retention.releaseRaster(document, pageNumber, analysisDpi(pageNumber));
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
                await retention.rasterScratchPath(document, pageNumber, analysisDpi(pageNumber)),
            ] as const)));
            try {
                const rendered = [];
                for (const run of splitContiguousPageRuns(pageNumbers, analysisDpi)) {
                    operationSignal.throwIfAborted();
                    rendered.push(...await batchRenderer({
                        dpi: analysisDpi(run[0]!),
                        log,
                        onPageRendered: pageNumber => {
                            recordRasterizedPage(pageNumber);
                            recorder.markProgress();
                        },
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
                        dpi: analysisDpi(pageNumber),
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
                    retention.releaseRaster(document, pageNumber, analysisDpi(pageNumber)),
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
                if (batchRenderer !== undefined) {
                    // Staged renders use independent page ranges. The window's
                    // admitted render concurrency therefore reaches Poppler,
                    // and each page becomes readable as soon as its process
                    // finishes instead of waiting for one large range.
                    await renderAndRetainBatch([pageNumber]);
                    return;
                }
                const scratchPath = await retention.rasterScratchPath(document, pageNumber, analysisDpi(pageNumber));
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
                        analysisDpi(pageNumber),
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
                        dpi: analysisDpi(pageNumber),
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
            unstage: pageNumber => retention.releaseRaster(
                document,
                pageNumber,
                analysisDpi(pageNumber),
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
                if (batchRecorder.awaitingFirstVerdict) recorder.markProgress();
            },
        });
        let batchCompleted = false;
        const manifestPages = batchPageNumbers.map(pageNumber => {
            const sourcePage = batchPageByNumber.get(pageNumber);
            const sourceRaster = batchRasterByNumber.get(pageNumber);
            const sourceBackgroundDpi = sourceRaster?.backgroundDpi;
            const sourceDpi = sourcePage === undefined
                ? undefined
                : resolveRasterPageDpi(resolvedSourceRasterStructure, sourcePage, sourceRaster);
            return {
                inputPath: stagedPathByPage.get(pageNumber)!,
                pageNumber,
                dpi: analysisDpi(pageNumber),
                sourceDpi: sourceDpi ?? analysisDpi(pageNumber),
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
            ...(policy.rasterMaxPixels === undefined ? {} : {rasterMaxPixels: policy.rasterMaxPixels}),
            ...(policy.totalRamBytes === undefined ? {} : {hostMemoryBytes: policy.totalRamBytes}),
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
                for (const run of splitContiguousPageRuns(preStagePageNumbers, analysisDpi)) {
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
            recorder.markProgress();
            log(
                'debug',
                'Scan cleanup pre-staged Poppler batch '
                + JSON.stringify({pages: preStagePageNumbers.length}),
            );
        }
        const resolveSourcePageNumber = (pageNumber: number | undefined) => {
            if (pageNumber === undefined) {
                return undefined;
            }
            return sourcePageByManifestIndex.get(pageNumber);
        };
        const readAnalyzedPage = async (
            nativeProgress: TNativeScanCleanupProgressV3,
            sourcePageNumber: number,
        ) => {
            const sourcePage = batchPageByNumber.get(sourcePageNumber);
            if (sourcePage === undefined) {
                throw new ScanCleanupContractError(
                    `Scan cleanup detection reported page ${String(sourcePageNumber)} outside its geometry batch`,
                );
            }
            return {
                sourcePage,
                sourceDpi: resolveRasterPageDpi(
                    resolvedSourceRasterStructure,
                    sourcePage,
                    batchRasterByNumber.get(sourcePageNumber),
                ),
                metadata: decodeNativeScanCleanupPageMetadataJson(await fileSystem.readFile(
                    manifestPages[nativeProgress.pageNumber! - 1]!.pageMetadataPath, 'utf8',
                )),
            };
        };
        try {
            await stagedWindow.prime();
            await dependencies.runSidecar(
                binary,
                manifestPath,
                operationSignal,
                log,
                async nativeProgress => {
                    if (nativeProgress.totalPages !== manifestPages.length) {
                        throw new ScanCleanupContractError(
                            `Scan cleanup detection reported ${String(nativeProgress.totalPages)} pages for ${String(manifestPages.length)} submitted pages`,
                        );
                    }
                    if (
                        nativeProgress.stage === 'page-input-required'
                        && nativeProgress.pageNumber !== undefined
                    ) {
                        const sourcePageNumber = resolveSourcePageNumber(nativeProgress.pageNumber);
                        if (sourcePageNumber === undefined) {
                            throw new ScanCleanupContractError(
                                `Scan cleanup detection requested unknown page ${String(nativeProgress.pageNumber)}`,
                            );
                        }
                        batchRecorder.noteInputRequired();
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
                        const sourcePageNumber = resolveSourcePageNumber(nativeProgress.pageNumber);
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
                        const verdict = {
                            sourcePageNumber,
                            verdict: nativeProgress,
                            completedPages: nativeProgress.completedPages,
                            read: () => readAnalyzedPage(nativeProgress, sourcePageNumber),
                        };
                        await (nativeProgress.stage === 'page-analyzed'
                            ? batchRecorder.recordAnalyzed(verdict)
                            : batchRecorder.recordComplete(verdict));
                    }
                },
                {
                    priority: 'background',
                    allowedPathRoot: dependencies.getTempDir(),
                },
            );
            batchRecorder.collectMediaBoxCandidates(manifestPages.map(page => ({
                pageNumber: page.pageNumber,
                sourcePage: batchPageByNumber.get(page.pageNumber),
            })));
            for (const page of manifestPages) {
                await fileSystem.rm(page.pageMetadataPath, {force: true});
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

    recorder.assertComplete('evb-scan-cleanup');
    const mediaBoxRetryCandidates = recorder.mediaBoxRetryCandidates;
    if (mediaBoxRetryCandidates.length > 0) {
        const retryMaxPixels = Math.min(
            policy.rasterMaxPixels ?? SCAN_CLEANUP_RASTER_MAX_PIXELS,
            SCAN_CLEANUP_RASTER_MAX_PIXELS,
        );
        // The retry renders the wider MediaBox, so its plane is planned for
        // that geometry rather than reused from the CropBox pass.
        const retryAnalysisDpiByPage = new Map(mediaBoxRetryCandidates.map(candidate => [
            candidate.pageNumber,
            resolveScanCleanupAnalysisDpi(toMediaBoxPageSize(candidate.sourcePage)),
        ]));
        const retryPlans = mediaBoxRetryCandidates.map(candidate => {
            const mediaPage = toMediaBoxPageSize(candidate.sourcePage);
            const dpi = retryAnalysisDpiByPage.get(candidate.pageNumber)!;
            const limits = resolveRasterRenderLimits(mediaPage, dpi, retryMaxPixels);
            return {
                renderDpi: dpi,
                raster: {
                    dpi,
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
            dpi: number;
            path: string;
            metadataPath: string;
            width: number;
            height: number;
        }> = [];
        try {
            for (const candidate of candidates) {
                signal.throwIfAborted();
                const mediaPage = toMediaBoxPageSize(candidate.sourcePage);
                const dpi = retryAnalysisDpiByPage.get(candidate.pageNumber)!;
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
                        dpi,
                        undefined,
                        undefined,
                        'png',
                        resolveRasterRenderLimits(mediaPage, dpi, retryMaxPixels),
                        'MediaBox retry raster',
                        'MediaBox retry',
                        'mediabox',
                    );
                    recorder.markRechecked();
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
                    dpi,
                    path,
                    metadataPath: join(retryRoot, `page-${String(candidate.pageNumber)}.json`),
                    width: dimensions.width,
                    height: dimensions.height,
                });
            }
            const retryRasterByNumber = new Map(await Promise.all(renderedRetryPages.map(async page => [
                page.pageNumber,
                await getPageRaster(resolvedSourceRasterStructure, page.pageNumber),
            ] as const)));
            // The manifest names each source page, whose authored overrides it
            // resolves; native progress counts manifest ordinals separately.
            const retryManifestPages = renderedRetryPages.map((page) => {
                const sourceRaster = retryRasterByNumber.get(page.pageNumber);
                const sourceBackgroundDpi = sourceRaster?.backgroundDpi;
                return {
                    inputPath: page.path,
                    pageNumber: page.pageNumber,
                    dpi: page.dpi,
                    sourceDpi: resolvePageGeometrySourceDpi(
                        page.sourcePage,
                        undefined,
                    ) ?? sourceRaster?.dpi ?? getRasterDocumentDpi(resolvedSourceRasterStructure) ?? DETECTION_DPI,
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
                    ...(policy.rasterMaxPixels === undefined ? {} : {rasterMaxPixels: policy.rasterMaxPixels}),
                    ...(policy.totalRamBytes === undefined ? {} : {hostMemoryBytes: policy.totalRamBytes}),
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
                    const accepted = await recorder.acceptMediaBoxRetry({
                        pageNumber: page.pageNumber,
                        verdict: retryProgress,
                        metadata: retryMetadata,
                        rasterWidth: page.width,
                        rasterHeight: page.height,
                        mediaPage: toMediaBoxPageSize(page.sourcePage),
                        sourceDpi: resolveRasterPageDpi(
                            resolvedSourceRasterStructure,
                            page.sourcePage,
                            retryRasterByNumber.get(page.pageNumber),
                        ) ?? DETECTION_DPI,
                    });
                    if (!accepted) continue;
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
    return recorder.finish();
}

export async function runScanCleanupDetection<TDocument>(
    request: IScanCleanupDetectionRequest,
    signal: AbortSignal,
    retention: IScanCleanupDetectionRetention<TDocument>,
    dependencies: IScanCleanupDetectionDependencies,
    policy: TScanCleanupDetectionPolicy,
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
            dependencies.onResultStoreReady?.(resultStore);
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
            if (!resultStoreTransferred && resultStore !== null) {
                await resultStore.close().catch(error => {
                    log(
                        'warn',
                        `Could not close unreturned scan-cleanup result store: ${getErrorMessage(error)}`,
                    );
                });
            }
        }
    } finally {
        await retention.release(document).catch(error => {
            log(
                'warn',
                `Could not release scan-cleanup document: ${getErrorMessage(error)}`,
            );
        });
        if (scratchDir !== null) {
            await preserveScanCleanupJsonEvidence(scratchDir, log, dependencies.evidenceDirectory, fileSystem).catch(error => {
                log(
                    'warn',
                    `Could not preserve scan-cleanup detection evidence: ${getErrorMessage(error)}`,
                );
            });
            await fileSystem.rm(scratchDir, {
                recursive: true,
                force: true,
            }).catch(error => {
                log(
                    'warn',
                    `Could not remove scan-cleanup detection scratch directory: ${getErrorMessage(error)}`,
                );
            });
        }
    }
}
