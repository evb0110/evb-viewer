/**
 * One desktop OCR job: select the pages that need recognition, run the shared
 * page job (`recognizeOcrPages`) with Poppler rasters and the engine pool,
 * checkpoint every recognized page, write the searchable PDF in one
 * pdf-page-ops pass, and stage the result. The job runs in the main process
 * inside a job-registry record; recognition runs in worker threads.
 */

import {randomUUID} from 'node:crypto';
import {mkdir, readdir, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {createAbortError} from '@contracts/isAbortError';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import type {IOcrDiagnostic, IOcrSearchablePdfOptions, TOcrProgressPhase} from '@contracts/electronApiOcr';
import type {TOcrModelCode} from '@contracts/ocrLanguages';
import {getOcrScanCleanupMode} from '@contracts/scan-cleanup/ocrPreprocessing';
import {getOcrPageSelectionCount, iterateOcrPageRequestBatches} from '@ocr-core/ocrPageSelection';
import {resolveOcrExtractionDpi} from '@ocr-core/ocrRenderDpi';
import {OcrJobMessages, recognizeOcrPages} from '@ocr-core/recognizeOcrPages';
import type {IOcrEngineResult} from '@ocr-core/tesseractEngine';
import {isOcrEngineImageFile, type TDesktopOcrEngineRequest} from '@electron/features/ocr/main/ocrEngineHostProtocol';
import type {IOcrPipelinePaths, TOcrJobResult, TOcrPdfPageSelection, TWorkerLog} from '@electron/features/ocr/pipeline/types';
import {detectSourceDpiDetails} from '@electron/pdf/sourceDpiDetection';
import {prepareOcrPageRasterFile} from '@electron/features/ocr/pipeline/tryPreprocessOcrImage';
import {writeSearchablePdf} from '@electron/features/ocr/pipeline/writeSearchablePdf';
import {
    buildPopplerEnv,
    createOcrRasterRenderLimits,
    preparePdfForPoppler,
    renderOcrPageToPpm,
    type IPreparedPopplerPdf,
} from '@electron/features/ocr/pipeline/popplerStage';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {getOcrConcurrency} from '@electron/utils/concurrency';
import {selectOcrPagesForSupersession} from '@electron/features/ocr/pipeline/selectOcrPagesForSupersession';
import {hashFileSha256} from '@electron/utils/hashFileSha256';
import {createOcrPageSizeSource} from '@electron/features/ocr/pipeline/pdfPageSizeProbe';
import {
    cleanupStaleOcrJobDirectories,
    createOcrCheckpointFingerprint,
    iterateOcrPageCheckpoints,
    persistOcrPageCheckpoint,
    restoreOcrPageCheckpoint,
} from '@electron/features/ocr/pipeline/ocrPageCheckpoints';
import {getLastOcrSelectionPage, normalizeOcrPageSelection} from '@electron/features/ocr/pipeline/ocrPageSelectionStream';
import {
    createOcrModelBytesReader,
    getOcrRuntimePolicy,
    resolveOcrLaneResources,
    sumOcrModelBytes,
} from '@electron/features/ocr/main/ocrRuntimePolicy';
import {mainJobBroker} from '@electron/resources/jobBroker';

/** One checkpoint directory per job fingerprint; a concurrent twin gets its own. */
const activeCheckpointFingerprints = new Set<string>();

interface IOcrJobProgress {
    currentPage: number;
    processedCount: number;
    totalPages: number;
    phase?: TOcrProgressPhase;
    phaseProgress?: number;
    activePages?: number[];
}

export interface IOcrJob {
    jobId: string;
    sourcePdfPath: string;
    documentRevision: IDocumentRevisionInfo;
    pages: TOcrPdfPageSelection;
    options: IOcrSearchablePdfOptions;
    paths: IOcrPipelinePaths;
    signal: AbortSignal;
    publish: (progress: IOcrJobProgress) => void;
    log: TWorkerLog;
    /** The engine pool that runs one page's Tesseract passes. */
    runEngine: (request: TDesktopOcrEngineRequest, signal: AbortSignal) => Promise<IOcrEngineResult>;
    /**
     * The engine charges the main broker for its workers itself, as the app's
     * pool does; otherwise the job charges each page's passes.
     */
    engineChargesBroker?: boolean;
    /** Installs the early-print models into `paths.tessdataPath`; called once, when a page first needs them. */
    prepareEarlyPrintModels: (signal: AbortSignal) => Promise<void>;
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : createAbortError('OCR job aborted');
    }
}

/**
 * Pages one job recognizes at once, and the threads each page's native
 * cleanup may use: desktop's page slots, within the CPU the job broker grants.
 */
function getOcrPageConcurrency(pageCount: number, paths: IOcrPipelinePaths, options: IOcrSearchablePdfOptions) {
    const {globalPageSlots} = getOcrRuntimePolicy();
    const cpuTokens = mainJobBroker.getSnapshot().capacity.cpuTokens;
    const cleanupThreads =
        paths.scanCleanupBinary && cpuTokens > 2 && (options.preprocessingMode === 'clean' || options.preprocessingMode === 'off')
            ? Math.max(1, Math.ceil(cpuTokens / globalPageSlots))
            : 1;
    return {
        lanes: Math.max(1, Math.min(globalPageSlots, Math.floor(cpuTokens / cleanupThreads), getOcrConcurrency(pageCount))),
        cleanupThreads,
    };
}

/**
 * Runs each page's engine passes under a main broker lease when the engine does
 * not charge the broker itself, and unlinks file-backed rasters once done
 * unless native termination is unproven.
 */
function createJobOcrEngine(job: Pick<IOcrJob, 'jobId' | 'paths' | 'runEngine' | 'engineChargesBroker'>) {
    const readModelBytes = job.engineChargesBroker ? null : createOcrModelBytesReader(job.paths.tessdataPath);
    return async (request: TDesktopOcrEngineRequest, signal: AbortSignal) => {
        let failure: unknown;
        try {
            if (!readModelBytes) {
                return await job.runEngine(request, signal);
            }
            const modelBytes = sumOcrModelBytes(await readModelBytes(request.models));
            return await mainJobBroker.run(
                {
                    ownerId: `ocr:${job.jobId}`,
                    kind: 'ocr-engine-pass',
                    priority: 'user',
                    resources: resolveOcrLaneResources(modelBytes, request.image, mainJobBroker.getSnapshot().capacity),
                    signal,
                },
                () => job.runEngine(request, signal),
            );
        } catch (error) {
            failure = error;
            throw error;
        } finally {
            if (isOcrEngineImageFile(request.image) && getUnprovenNativeTerminationDetail(failure) === undefined) {
                await rm(request.image.path, {force: true}).catch(() => undefined);
            }
        }
    };
}

async function removeSessionFiles(tempDir: string, sessionId: string, keepPath?: string) {
    const entries = await readdir(tempDir).catch(() => []);
    await Promise.all(
        entries
            .filter((name) => name.startsWith(`${sessionId}-`) && join(tempDir, name) !== keepPath)
            .map((name) => rm(join(tempDir, name), {recursive: true, force: true}).catch(() => undefined)),
    );
}

type TPublishOcrProgress = (
    currentPage: number,
    processedCount: number,
    extra: Omit<IOcrJobProgress, 'currentPage' | 'processedCount' | 'totalPages'>,
) => void;

/**
 * Runs supersession selection, DPI/geometry probing, lazy Poppler repair,
 * raster preparation, and checkpointed page recognition across all batches.
 */
async function recognizeOcrJobPages(stage: {
    job: IOcrJob;
    sessionId: string;
    checkpointDir: string;
    requestedSelection: TOcrPdfPageSelection;
    supersessionPolicy: NonNullable<IOcrSearchablePdfOptions['supersessionPolicy']>;
    jobAbort: AbortController;
    jobSignal: AbortSignal;
    publish: TPublishOcrProgress;
}) {
    const {job, sessionId, checkpointDir, requestedSelection, supersessionPolicy, jobAbort, jobSignal, publish} = stage;
    const {paths, sourcePdfPath, options, log} = job;
    const warnings = new OcrJobMessages<string>();
    const errors = new OcrJobMessages<string>();
    const diagnostics = new OcrJobMessages<IOcrDiagnostic>();
    const runEngine = createJobOcrEngine(job);
    const pageSizeSource = createOcrPageSizeSource({
        ...(paths.pdfPageOpsBinary ? {pdfPageOpsBinary: paths.pdfPageOpsBinary} : {}),
        tempDir: paths.tempDir,
        signal: jobSignal,
        log,
    });
    let popplerSourcePdfPath = sourcePdfPath;
    let popplerFallback: Promise<IPreparedPopplerPdf> | undefined;
    // Most PDFs render directly; a qpdf rewrite repairs the rest, once per job.
    const preparePopplerFallback = () =>
        (popplerFallback ??= (async () => {
            const prepared = await preparePdfForPoppler(paths, log, sourcePdfPath, sessionId, (path) => path, jobSignal);
            warnings.push(...prepared.warnings);
            popplerSourcePdfPath = prepared.pdfPath;
            return prepared;
        })());
    const popplerEnv = buildPopplerEnv(paths);
    const cleanupMode = options.preprocessingMode === undefined ? undefined : getOcrScanCleanupMode(options.preprocessingMode);
    let earlyPrintModels: Promise<void> | undefined;
    let processedPageCount = 0;
    let successfulPageCount = 0;
    let hadTargetPages = false;
    let pageSizeWarningReported = false;

    try {
        for (const requestBatch of iterateOcrPageRequestBatches(requestedSelection)) {
            throwIfAborted(jobSignal);
            const selection = await selectOcrPagesForSupersession({
                sourcePdfPath,
                pages: requestBatch,
                supersessionPolicy,
                ...(paths.pdftotextBinary ? {pdftotextBinary: paths.pdftotextBinary} : {}),
                ...(paths.pdfPageOpsBinary ? {pdfPageOpsBinary: paths.pdfPageOpsBinary} : {}),
                tempDir: paths.tempDir,
                log,
                signal: jobSignal,
            });
            warnings.push(...selection.warnings);
            diagnostics.push(...selection.diagnostics);
            const targetPages = selection.pages;
            const batchOffset = processedPageCount;
            const batchFirstPage = targetPages[0]?.pageNumber ?? requestBatch[0]?.pageNumber ?? 0;
            processedPageCount += requestBatch.length;
            if (targetPages.length === 0) {
                publish(requestBatch.at(-1)?.pageNumber ?? 0, processedPageCount, {phase: 'processing'});
                continue;
            }
            hadTargetPages = true;
            const pageNumbers = targetPages.map((page) => page.pageNumber);

            publish(batchFirstPage, batchOffset, {phase: 'dpi-inspection'});
            const sourceDpi =
                options.renderDpi === undefined
                    ? await detectSourceDpiDetails(
                          popplerSourcePdfPath,
                          paths.pdfimagesBinary,
                          log,
                          popplerEnv,
                          jobSignal,
                          pageNumbers,
                      ).catch((error: unknown) => {
                          if (jobSignal.aborted || isAbortError(error) || getUnprovenNativeTerminationDetail(error) !== undefined) {
                              throw error;
                          }
                          log('warn', 'Source DPI inspection failed; using default OCR resolution', {error: getErrorMessage(error)});
                          return null;
                      })
                    : null;
            const sourceDpiByPage = new Map<number, number>();
            for (const pageNumber of pageNumbers) {
                const raster = await sourceDpi?.getPageRaster(pageNumber);
                if (raster !== undefined) {
                    sourceDpiByPage.set(pageNumber, raster.dpi);
                }
            }
            publish(batchFirstPage, batchOffset, {phase: 'page-size-probing'});
            let pageSizeProbe = await pageSizeSource.read(popplerSourcePdfPath, pageNumbers);
            if (
                pageSizeProbe.status === 'degraded' &&
                pageSizeProbe.reason === 'native-tool-failed' &&
                (await preparePopplerFallback()).pdfPath !== sourcePdfPath
            ) {
                pageSizeProbe = await pageSizeSource.read(popplerSourcePdfPath, pageNumbers);
            }
            if (pageSizeProbe.status === 'degraded' && !pageSizeWarningReported) {
                warnings.push(pageSizeProbe.message);
                pageSizeWarningReported = true;
            }
            const {pageSizes} = pageSizeProbe;
            const {lanes, cleanupThreads} = getOcrPageConcurrency(targetPages.length, paths, options);

            /**
             * Renders the page with Poppler and, when the run sets a
             * preprocessing mode, cleans it as the browser does: 'off' still
             * normalizes polarity. A cleaned page of another size, or a
             * cleanup that failed, leaves the rendered page with a diagnostic.
             */
            const renderPage = async (pageNumber: number, dpi: number, pageSignal: AbortSignal) => {
                const renderedPath = join(paths.tempDir, `${sessionId}-page-${pageNumber}-${randomUUID()}.ppm`);
                try {
                    const pageSize = pageSizes.get(pageNumber);
                    await renderOcrPageToPpm(
                        [
                            paths,
                            log,
                            pageNumber,
                            popplerSourcePdfPath,
                            renderedPath,
                            dpi,
                            popplerEnv,
                            pageSignal,
                            undefined,
                            pageSize === undefined ? undefined : createOcrRasterRenderLimits(pageSize, dpi),
                        ],
                        preparePopplerFallback,
                    );
                    return await prepareOcrPageRasterFile({
                        renderedPath,
                        pageNumber,
                        dpi,
                        cleanupMode,
                        scanCleanupBinary: paths.scanCleanupBinary,
                        cleanupThreads,
                        log,
                        signal: pageSignal,
                    });
                } catch (error) {
                    if (getUnprovenNativeTerminationDetail(error) !== undefined) {
                        jobAbort.abort(error);
                    } else {
                        await rm(renderedPath, {force: true}).catch(() => undefined);
                    }
                    throw error;
                }
            };

            publish(batchFirstPage, batchOffset, {phase: 'processing'});
            const batch = await recognizeOcrPages({
                pages: targetPages,
                extractionDpi: resolveOcrExtractionDpi(sourceDpi?.documentDpi ?? options.renderDpi),
                sourceDpiByPage,
                options,
                lanes,
                signal: jobSignal,
                renderPage,
                runEngine,
                prepareEarlyPrintModels: () => (earlyPrintModels ??= job.prepareEarlyPrintModels(jobSignal)),
                readModel: (code: TOcrModelCode) => readFile(join(paths.tessdataPath, `${code}.traineddata`)),
                restorePage: (pageNumber) => restoreOcrPageCheckpoint(checkpointDir, pageNumber),
                acceptPage: (page) => persistOcrPageCheckpoint(checkpointDir, page),
                onPageDone: (pageNumber, activePages, processed) =>
                    publish(pageNumber, batchOffset + processed, {
                        phase: 'processing',
                        activePages: [...activePages],
                    }),
            });
            errors.push(...batch.errors.items);
            diagnostics.push(...batch.diagnostics.items);
            successfulPageCount += batch.recognizedCount;
            publish(requestBatch.at(-1)?.pageNumber ?? batchFirstPage, processedPageCount, {phase: 'processing'});
        }
    } finally {
        await pageSizeSource.close();
    }

    return {successfulPageCount, hadTargetPages, warnings, errors, diagnostics};
}

export async function runOcrJob(job: IOcrJob): Promise<TOcrJobResult> {
    const {paths, signal, sourcePdfPath, documentRevision, options, log} = job;
    const sessionId = `ocr-${randomUUID()}`;
    // A native process whose end is unproven stops the job and keeps its files.
    const jobAbort = new AbortController();
    const jobSignal = AbortSignal.any([signal, jobAbort.signal]);
    const requestedSelection = normalizeOcrPageSelection(job.pages);
    const requestedPageCount = getOcrPageSelectionCount(requestedSelection);
    const firstPage = iterateOcrPageRequestBatches(requestedSelection, 1).next().value?.[0]?.pageNumber ?? 0;
    const publish: TPublishOcrProgress = (currentPage, processedCount, extra) =>
        job.publish({
            currentPage,
            processedCount,
            totalPages: requestedPageCount,
            ...extra,
        });
    let ownedCheckpointFingerprint: string | null = null;
    let jobFailure: unknown;
    let resultPath: string | undefined;

    try {
        const sourceStat = await stat(sourcePdfPath);
        if (sourceStat.size <= 0) {
            throw new Error(`Source PDF is empty: ${sourcePdfPath}`);
        }
        log('debug', 'Processing OCR job', {
            jobId: job.jobId,
            sourcePath: sourcePdfPath,
            pdfBytes: sourceStat.size,
            pages: requestedPageCount,
        });
        const supersessionPolicy = options.supersessionPolicy ?? 'missing-only';
        if (supersessionPolicy === 'replace-all' && options.replaceAllAcknowledged !== true) {
            throw new Error('replace-all OCR requires explicit acknowledgement');
        }

        const checkpointFingerprint = createOcrCheckpointFingerprint({...job, pages: requestedSelection});
        const checkpointRoot = join(paths.tempDir, 'ocr-checkpoints');
        const useSharedCheckpoint = !activeCheckpointFingerprints.has(checkpointFingerprint);
        if (useSharedCheckpoint) {
            activeCheckpointFingerprints.add(checkpointFingerprint);
            ownedCheckpointFingerprint = checkpointFingerprint;
        }
        const checkpointDir = join(
            checkpointRoot,
            useSharedCheckpoint ? checkpointFingerprint : `${checkpointFingerprint}-concurrent-${randomUUID()}`,
        );
        await mkdir(checkpointDir, {recursive: true});
        await cleanupStaleOcrJobDirectories(checkpointRoot);
        publish(firstPage, 0, {phase: 'pdf-prep'});

        const {successfulPageCount, hadTargetPages, warnings, errors, diagnostics} = await recognizeOcrJobPages({
            job,
            sessionId,
            checkpointDir,
            requestedSelection,
            supersessionPolicy,
            jobAbort,
            jobSignal,
            publish,
        });

        const omitted = warnings.omitted + errors.omitted;
        const completionMessages = [
            ...warnings.items,
            ...errors.items,
            ...(omitted > 0 ? [`${omitted} OCR diagnostic message(s) omitted from the completion payload`] : []),
        ];
        log('debug', 'OCR recognition finished', {
            successfulPages: successfulPageCount,
            requestedPages: requestedPageCount,
            errors: errors.items.length,
        });
        const lastPage = getLastOcrSelectionPage(requestedSelection);

        if (successfulPageCount === 0) {
            // A page skipped because its text could not be inspected still
            // needs OCR; only pages classified as text-bearing do not.
            if (!hadTargetPages && !diagnostics.items.some((diagnostic) => diagnostic.severity === 'warning')) {
                return {
                    success: false,
                    errors: [],
                    outcome: 'no-pages-to-process',
                    ...(diagnostics.items.length === 0 ? {} : {diagnostics: diagnostics.items}),
                };
            }
            log('error', 'OCR failed to produce searchable output', {errors: completionMessages});
            return {success: false, errors: completionMessages};
        }

        throwIfAborted(jobSignal);
        publish(firstPage, 0, {phase: 'merging'});
        try {
            if (!paths.pdfPageOpsBinary) {
                throw new Error('evb-pdf-page-ops is unavailable');
            }
            resultPath = await writeSearchablePdf({
                pdfPageOpsBinary: paths.pdfPageOpsBinary,
                sourcePdfPath,
                pages: iterateOcrPageCheckpoints(requestedSelection, checkpointDir, jobSignal),
                tempDir: paths.tempDir,
                sessionId,
                signal: jobSignal,
            });
        } catch (mergeError) {
            if (isAbortError(mergeError) || jobSignal.aborted || getUnprovenNativeTerminationDetail(mergeError) !== undefined) {
                throw mergeError;
            }
            return {
                success: false,
                errors: [...completionMessages, `Failed to merge OCR'd pages with original PDF: ${getErrorMessage(mergeError)}`],
            };
        }
        const resultSha256 = await hashFileSha256(resultPath, jobSignal);
        publish(lastPage, requestedPageCount, {phase: 'indexing', phaseProgress: 100});
        return {
            success: true,
            pdfPath: resultPath,
            sourceDocumentRevisionToken: documentRevision.token,
            resultSha256,
            requiresCleanupAck: true,
            errors: completionMessages,
            diagnostics: diagnostics.items,
        };
    } catch (caughtError) {
        resultPath = undefined;
        const error = jobAbort.signal.aborted ? jobAbort.signal.reason : caughtError;
        jobFailure = error;
        if (getUnprovenNativeTerminationDetail(error) !== undefined || signal.aborted) {
            throw error;
        }
        const errMsg = getErrorMessage(error);
        log('error', 'Critical OCR job failure', {jobId: job.jobId, error: errMsg});
        return {success: false, errors: [`Critical error: ${errMsg}`]};
    } finally {
        if (ownedCheckpointFingerprint) {
            activeCheckpointFingerprints.delete(ownedCheckpointFingerprint);
        }
        if (getUnprovenNativeTerminationDetail(jobFailure) === undefined) {
            await removeSessionFiles(paths.tempDir, sessionId, resultPath);
        }
    }
}
