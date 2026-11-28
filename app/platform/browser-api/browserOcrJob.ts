import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {TBrowserOcrRecognizeRequest} from '@contracts/browserOcrEngine';
import {limitAsync} from 'es-toolkit/promise';
import {preprocessBrowserOcrRaster, resolveBrowserOcrLanes, runBrowserOcrEngine} from '@app/platform/browser-api/browserOcrEngineClient';
import {createBrowserOcrCheckpointStore} from '@app/platform/browser-api/browserOcrCheckpoints';
import {ensureBrowserOcrModel, readCachedOcrModel} from '@app/platform/browser-api/browserOcrModels';
import {
    BROWSER_OCR_ANNOTATION_MODE,
    getBrowserOcrRasterSize,
    readPageSourceDpi,
    renderBrowserOcrRaster,
} from '@app/platform/browser-api/browserOcrRaster';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {appendPdfMutationsToStoreFile} from '@app/platform/browser/browserStorePort';
import {getErrorMessage} from '@app/utils/error';
import {resolvePerformanceProfile} from '@app/utils/performanceProfile';
import {isBrowserPageOpsWasmFailure, type IOcrTextLayerInstructions} from '@contracts/browserPageOpsWorker';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {
    IOcrDiagnostic,
    IOcrModelDownloadProgress,
    IOcrProgress,
    IOcrSearchablePdfOptions,
    IOcrSearchablePdfPage,
    TOcrProgressPhase,
} from '@contracts/electronApiOcr';
import {EARLY_PRINT_MODEL_CODES, OCR_LANGUAGE_MODEL_BYTES, type TOcrModelCode, withOcrModelSublanguages} from '@contracts/ocrLanguages';
import {requirePageNumber} from '@contracts/pageNumbers';
import {createOcrPreprocessingGeometryDiagnostic, getOcrScanCleanupMode} from '@contracts/scan-cleanup/ocrPreprocessing';
import type {IPdfOcrPageTextVisibility} from '@contracts/pdfOcrTextVisibility';
import {resolveOcrExtractionDpi} from '@ocr-core/ocrRenderDpi';
import {buildOcrTextLayerInstructions, OcrJobMessages, recognizeOcrPages, type IOcrPageRaster} from '@ocr-core/recognizeOcrPages';
import {OCR_TEXT_PROBE_UNAVAILABLE, selectOcrPagesByExistingText} from '@ocr-core/selectOcrPagesByExistingText';

type TBrowserOcrImage = TBrowserOcrRecognizeRequest['payload']['image'];

export interface IBrowserOcrJobInput {
    sourceRef: TDocumentRef;
    pages: readonly IOcrSearchablePdfPage[];
    options: IOcrSearchablePdfOptions;
    signal: AbortSignal;
    emit: (progress: Omit<IOcrProgress, 'requestId'>) => void;
}

export type TBrowserOcrJobOutcome =
    | {
          /** The text layer appended to the document's file, uncommitted, under `lease`. */
          kind: 'written';
          lease: string;
          /**
           * The document's length with the layer, and the SHA-256 digest of the
           * appended layer (raw revision bytes for a single chunk, or the composite
           * SHA-256 over colon-joined per-chunk SHA-256 digests when streamed across
           * multiple chunks).
           */
          length: number;
          sha256: string;
          sourceRevisionToken: TDocumentRevisionToken;
          errors: string[];
          diagnostics: IOcrDiagnostic[];
      }
    | {
          kind: 'nothing-written';
          targeted: boolean;
          errors: string[];
          diagnostics: IOcrDiagnostic[];
      };

/** A failure the workspace explains in the user's language, by its code. */
export class BrowserOcrJobError extends Error {
    public constructor(
        public readonly code: 'OCR_MODEL_DOWNLOAD_FAILED',
        message: string,
    ) {
        super(message);
        this.name = 'BrowserOcrJobError';
    }
}

const MIN_BROWSER_OCR_PREP_CONCURRENCY = 2;
const MAX_BROWSER_OCR_PREP_CONCURRENCY = 4;

/**
 * Bounds browser OCR page probing and model downloads to 2–4 concurrent tasks:
 * 2 on constrained/low-memory hosts (mobile, low tier, <= 4 GiB, or <= 4 cores),
 * scaling up to 4 on higher-tier hosts to prevent memory and connection spikes.
 */
export function resolveBrowserOcrPrepConcurrency(environment?: {
    mobile?: boolean;
    lowMemory?: boolean;
    deviceMemory?: number | undefined;
    hardwareConcurrency?: number | undefined;
}): number {
    const profile = environment ? undefined : resolvePerformanceProfile();
    const mobile = environment?.mobile ?? profile?.mobile ?? false;
    const lowMemory = environment?.lowMemory ?? profile?.lowMemory ?? false;
    const deviceMemory =
        environment && 'deviceMemory' in environment
            ? environment.deviceMemory
            : typeof navigator === 'undefined'
              ? undefined
              : (navigator as Navigator & {deviceMemory?: number}).deviceMemory;
    const cores =
        environment && 'hardwareConcurrency' in environment
            ? (environment.hardwareConcurrency ?? 2)
            : typeof navigator === 'undefined'
              ? 2
              : navigator.hardwareConcurrency || 2;
    if (mobile || lowMemory || (typeof deviceMemory === 'number' && Number.isFinite(deviceMemory) && deviceMemory <= 4) || cores <= 4) {
        return MIN_BROWSER_OCR_PREP_CONCURRENCY;
    }
    return Math.min(MAX_BROWSER_OCR_PREP_CONCURRENCY, Math.max(MIN_BROWSER_OCR_PREP_CONCURRENCY, Math.floor(cores / 2)));
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError');
    }
}

/**
 * Races an unabortable async operation (such as PDF.js page/text/operator-list
 * RPCs) against `signal` so cancellation or a sibling lane error never blocks
 * teardown behind a stuck PDF.js call.
 */
function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        promise.catch(() => undefined);
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError'));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, {once: true});
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/**
 * Runs `worker` over `items` with at most `concurrency` active tasks,
 * preserving exact input ordering in the returned array and stopping sibling
 * lanes cleanly on abort or first error.
 */
async function runBounded<TItem, TResult>(
    items: readonly TItem[],
    concurrency: number,
    signal: AbortSignal,
    worker: (item: TItem, index: number, workerSignal: AbortSignal) => Promise<TResult>,
): Promise<TResult[]> {
    throwIfAborted(signal);
    if (items.length === 0) {
        return [];
    }
    const results = new Array<TResult>(items.length);
    const localAbort = new AbortController();
    const workerSignal = AbortSignal.any([signal, localAbort.signal]);
    let nextIndex = 0;
    let firstError: unknown;
    let hasError = false;
    const laneCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));

    await Promise.all(
        Array.from({length: laneCount}, async () => {
            while (!hasError && !workerSignal.aborted) {
                const index = nextIndex;
                if (index >= items.length) {
                    return;
                }
                nextIndex += 1;
                try {
                    results[index] = await worker(items[index]!, index, workerSignal);
                } catch (error) {
                    if (!hasError) {
                        hasError = true;
                        firstError = error;
                        localAbort.abort(error);
                    }
                    return;
                }
            }
        }),
    );

    if (signal.aborted) {
        throwIfAborted(signal);
    }
    if (hasError) {
        throw firstError;
    }
    return results;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A page's text as `pdftotext` would read it for classification; failure is never an empty page. */
async function extractPageText(page: IPdfPage) {
    try {
        const content = await page.getTextContent();
        return content.items.map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : '')).join('');
    } catch {
        return OCR_TEXT_PROBE_UNAVAILABLE;
    }
}

async function readVisibility(source: Blob, pageNumbers: number[], signal: AbortSignal) {
    try {
        const report = await runBrowserPageOpsWorkerRequest(
            'ocrTextVisibility',
            {
                source,
                pages: pageNumbers,
                withEvbOcrText: false,
            },
            {signal},
        );
        if (isBrowserPageOpsWasmFailure(report)) {
            return {
                visibility: new Map<number, IPdfOcrPageTextVisibility>(),
                warning: `Existing-text inspection was unavailable: ${report.error.message}`,
            };
        }
        return {visibility: new Map(report.pages.map((page) => [page.pageNumber, page]))};
    } catch (error) {
        throwIfAborted(signal);
        return {
            visibility: new Map<number, IPdfOcrPageTextVisibility>(),
            warning: `Existing-text inspection was unavailable: ${getErrorMessage(error)}`,
        };
    }
}

/**
 * One browser OCR job: model download, existing-text selection, then for each
 * page a PDF.js raster read by the WebAssembly Tesseract with the desktop's
 * arguments, and one Rust pass that appends the searchable layer to the
 * document as an incremental revision. The document is read once; the result
 * is rejected if the document changes meanwhile.
 */
export async function runBrowserOcrJob(input: IBrowserOcrJobInput): Promise<TBrowserOcrJobOutcome> {
    const {signal, emit} = input;
    const errors = new OcrJobMessages<string>();
    const diagnostics = new OcrJobMessages<IOcrDiagnostic>();
    let totalPages = input.pages.length;
    let processedCount = 0;
    let lastPhase: TOcrProgressPhase = 'preparing';
    const stage = (phase: TOcrProgressPhase, extra: Partial<IOcrProgress> = {}) => {
        lastPhase = phase;
        emit({
            currentPage: 0,
            processedCount,
            totalPages,
            phase,
            status: 'running',
            ...extra,
        });
    };

    stage('preparing');
    // The document is read by range, from the revision read now; the layer is appended to that revision.
    const revision = await browserDocumentStore.getDocumentRevision(input.sourceRef);
    const source = await browserDocumentStore.readableBlob(input.sourceRef);

    const prepConcurrency = resolveBrowserOcrPrepConcurrency();
    /**
     * Ensures `codes` with bounded concurrency while keeping `model-prep`
     * progress focused on one active download at a time so concurrent downloads
     * never interleave language labels, misattribute totals, or jump backward.
     */
    const ensureModelsBounded = async (
        codes: readonly TOcrModelCode[],
        downloadSignal: AbortSignal,
        {announceStart = true}: {announceStart?: boolean} = {},
    ) => {
        if (codes.length === 0) {
            return;
        }
        if (announceStart) {
            stage('model-prep', {languageCode: codes[0]!});
        }
        let focusedCode: TOcrModelCode | null = null;
        const activeDownloads = new Map<TOcrModelCode, IOcrModelDownloadProgress>();
        await runBounded(codes, prepConcurrency, downloadSignal, async (code, _index, laneSignal) => {
            try {
                await ensureBrowserOcrModel(code, {
                    signal: laneSignal,
                    onProgress: (modelDownload) => {
                        activeDownloads.set(code, modelDownload);
                        if (focusedCode === null) {
                            focusedCode = code;
                        }
                        if (focusedCode === code) {
                            stage('model-prep', {
                                languageCode: code,
                                modelDownload,
                            });
                        }
                    },
                });
            } finally {
                activeDownloads.delete(code);
                if (focusedCode === code) {
                    const nextEntry = activeDownloads.entries().next().value;
                    if (nextEntry) {
                        focusedCode = nextEntry[0];
                        if (!laneSignal.aborted) {
                            stage('model-prep', {
                                languageCode: nextEntry[0],
                                modelDownload: nextEntry[1],
                            });
                        }
                    } else {
                        focusedCode = null;
                    }
                }
            }
        });
    };

    const modelCodes = withOcrModelSublanguages(input.pages.flatMap((page) => page.languages) as TOcrModelCode[]);
    try {
        await ensureModelsBounded(modelCodes, signal);
    } catch (error) {
        throwIfAborted(signal);
        throw new BrowserOcrJobError('OCR_MODEL_DOWNLOAD_FAILED', getErrorMessage(error));
    }

    const pdf = await loadBrowserPdfjsDocument(input.sourceRef);
    let stagedLease: string | null = null;
    let outcome: TBrowserOcrJobOutcome;
    try {
        stage('pdf-prep');
        const visibility = await readVisibility(
            source,
            input.pages.map((page) => page.pageNumber),
            signal,
        );
        if (visibility.warning) {
            errors.push(visibility.warning);
        }
        // Probe selected pages once with bounded concurrency; all lanes receive the same DPI.
        const renderDpi = input.options.renderDpi;
        const sourceDpiByPage = new Map<number, number>();
        const queue: IOcrSearchablePdfPage[] = [];
        let finestSourceDpi: number | null = null;
        let maxPageArea = 0;
        if (renderDpi === undefined) {
            stage('dpi-inspection');
        }
        const probedPages = await runBounded(input.pages, prepConcurrency, signal, async (request, _index, probeSignal) => {
            throwIfAborted(probeSignal);
            const pagePromise = pdf.getPage(request.pageNumber).catch(() => null);
            let page: IPdfPage | null = null;
            try {
                page = await awaitWithAbort(pagePromise, probeSignal);
            } catch (error) {
                void pagePromise.then((latePage) => latePage?.cleanup());
                throw error;
            }
            try {
                throwIfAborted(probeSignal);
                const pageText = page ? await awaitWithAbort(extractPageText(page), probeSignal) : OCR_TEXT_PROBE_UNAVAILABLE;
                throwIfAborted(probeSignal);
                const selection = selectOcrPagesByExistingText({
                    pages: [request],
                    supersessionPolicy: input.options.supersessionPolicy ?? 'missing-only',
                    visibility: visibility.visibility,
                    texts: new Map([[request.pageNumber, pageText]]),
                });
                let pageArea = 0;
                let sourceDpi: number | undefined;
                if (page && selection.pages.length > 0) {
                    const viewport = page.getViewport({scale: 1});
                    // In user-space units, as the raster is rendered.
                    pageArea = (viewport.width * viewport.height) / (viewport.userUnit || 1) ** 2;
                    if (renderDpi === undefined) {
                        const operatorList = await awaitWithAbort(
                            page.getOperatorList({annotationMode: BROWSER_OCR_ANNOTATION_MODE}),
                            probeSignal,
                        );
                        sourceDpi = readPageSourceDpi(operatorList);
                    }
                }
                return {
                    pageNumber: request.pageNumber,
                    selection,
                    pageArea,
                    sourceDpi,
                };
            } finally {
                page?.cleanup();
            }
        });
        for (const probed of probedPages) {
            errors.push(...probed.selection.warnings);
            diagnostics.push(...probed.selection.diagnostics);
            queue.push(...probed.selection.pages);
            if (probed.selection.pages.length === 0) {
                continue;
            }
            maxPageArea = Math.max(maxPageArea, probed.pageArea);
            if (probed.sourceDpi !== undefined) {
                sourceDpiByPage.set(probed.pageNumber, probed.sourceDpi);
                finestSourceDpi = Math.max(finestSourceDpi ?? 0, probed.sourceDpi);
            }
        }
        // Progress counts the pages being recognized; a kept page is not one of them.
        totalPages = queue.length;
        const extractionDpi = resolveOcrExtractionDpi(renderDpi ?? finestSourceDpi);
        const cleanupMode =
            input.options.preprocessingMode === undefined ? undefined : getOcrScanCleanupMode(input.options.preprocessingMode);
        const {lanes, preprocessLanes} = resolveBrowserOcrLanes(
            maxPageArea * (extractionDpi / 72) ** 2,
            modelCodes.reduce((bytes, code) => bytes + OCR_LANGUAGE_MODEL_BYTES[code], 0),
            cleanupMode,
        );
        // Lanes share the preprocessing workers this job's memory affords. A
        // threaded cleanup engine splits the cores among the pages in flight:
        // each lane renders, preprocesses and recognizes its page in turn.
        const pagesInFlight = Math.min(lanes, queue.length);
        const preprocess = limitAsync(
            (payload: Parameters<typeof preprocessBrowserOcrRaster>[0], preprocessSignal: AbortSignal) =>
                preprocessBrowserOcrRaster(payload, preprocessSignal, pagesInFlight),
            Math.max(1, preprocessLanes),
        );
        /**
         * Renders the page and, when the run sets a preprocessing mode, cleans
         * it as desktop does: 'off' still normalizes polarity. A cleaned page
         * of the rendered size is recognized and its words are mapped back
         * through the inverse transform; otherwise the rendered page is, with
         * a diagnostic.
         */
        const renderPage = async (pageNumber: number, dpi: number, pageSignal: AbortSignal): Promise<IOcrPageRaster<TBrowserOcrImage>> => {
            throwIfAborted(pageSignal);
            const page = await pdf.getPage(pageNumber);
            try {
                const size = getBrowserOcrRasterSize(page, dpi);
                const rendered = {
                    ...size,
                    image: (await renderBrowserOcrRaster(page, dpi, pageSignal)).image,
                };
                if (cleanupMode === undefined) {
                    return rendered;
                }
                const failed = (reason: string): IOcrDiagnostic => ({
                    code: 'OCR_PREPROCESSING_FAILED',
                    severity: 'warning',
                    pageNumber: requirePageNumber(pageNumber),
                    message: `OCR preprocessing failed; using raw page render: ${reason}`,
                });
                let cleaned;
                try {
                    cleaned = await preprocess(
                        {
                            image: rendered.image,
                            mode: cleanupMode,
                            dpi,
                        },
                        pageSignal,
                    );
                } catch (error) {
                    throwIfAborted(pageSignal);
                    // The engine stopped or ran out of time with the raster; render it again.
                    return {
                        ...size,
                        image: (await renderBrowserOcrRaster(page, dpi, pageSignal)).image,
                        diagnostic: failed(getErrorMessage(error)),
                    };
                }
                if (cleaned.failure !== undefined) {
                    return {
                        ...size,
                        image: cleaned.image,
                        diagnostic: failed(cleaned.failure),
                    };
                }
                if (cleaned.preprocessedSize !== undefined) {
                    return {
                        ...size,
                        image: cleaned.image,
                        diagnostic: createOcrPreprocessingGeometryDiagnostic(
                            requirePageNumber(pageNumber),
                            cleaned,
                            cleaned.preprocessedSize,
                        ),
                    };
                }
                return {
                    ...size,
                    image: cleaned.image,
                    ...(cleaned.inverseMatrix
                        ? {
                              preprocessInverse: {
                                  rasterWidthPx: cleaned.width,
                                  rasterHeightPx: cleaned.height,
                                  matrix: cleaned.inverseMatrix,
                              },
                          }
                        : {}),
                };
            } finally {
                page.cleanup();
            }
        };
        const durablePort =
            typeof browserDocumentStore.stores === 'function'
                ? ((await browserDocumentStore.stores().catch(() => null))?.durable?.port ?? null)
                : null;
        const checkpoints = await createBrowserOcrCheckpointStore(durablePort);
        try {
            let lastProcessingPage = 0;
            let lastProcessingActive: readonly number[] = [];
            let earlyPrintDownloading = false;
            const progress = (currentPage: number, active: readonly number[]) => {
                lastProcessingPage = currentPage;
                lastProcessingActive = [...active];
                // Keep an active Early Print model download visible while sibling pages report progress.
                if (earlyPrintDownloading && lastPhase === 'model-prep') {
                    return;
                }
                stage('processing', {
                    currentPage,
                    activePages: [...active],
                });
            };
            const targeted = queue.length > 0;
            const result = await recognizeOcrPages({
                pages: queue,
                extractionDpi,
                sourceDpiByPage,
                options: input.options,
                lanes,
                signal,
                renderPage,
                runEngine: runBrowserOcrEngine,
                prepareEarlyPrintModels: async (earlyPrintSignal = signal) => {
                    // Only switch to `model-prep` if a model actually downloads; restore
                    // `processing` immediately once downloads settle (success or fallback)
                    // so the reread never stays stuck showing model preparation.
                    earlyPrintDownloading = true;
                    try {
                        await ensureModelsBounded(EARLY_PRINT_MODEL_CODES, earlyPrintSignal, {announceStart: false});
                    } finally {
                        earlyPrintDownloading = false;
                        if (lastPhase === 'model-prep' && !earlyPrintSignal.aborted) {
                            progress(lastProcessingPage, lastProcessingActive);
                        }
                    }
                },
                readModel: readCachedOcrModel,
                acceptPage: (page) => checkpoints.stagePage(page),
                onPageStart: progress,
                onPageDone: (pageNumber, active, processed) => {
                    processedCount = processed;
                    progress(pageNumber, active);
                },
            });
            errors.push(...result.errors.items);
            diagnostics.push(...result.diagnostics.items);

            if (checkpoints.getPageCount() === 0) {
                outcome = {
                    kind: 'nothing-written',
                    targeted,
                    errors: errors.items,
                    diagnostics: diagnostics.items,
                };
            } else {
                stage('merging');
                throwIfAborted(signal);
                let writtenLength: number | undefined;
                let writtenSha256: string | undefined;
                let failure: string | undefined;
                const lease = await browserDocumentStore.stageAppend(input.sourceRef, revision.token, async (file, base) => {
                    let currentLength = base;
                    const chunkHashes: string[] = [];
                    for await (const chunk of checkpoints.iterateChunks({signal, consume: true})) {
                        throwIfAborted(signal);
                        const instructions: IOcrTextLayerInstructions = {
                            pages: buildOcrTextLayerInstructions(chunk.records),
                        };
                        const appendResult = await appendPdfMutationsToStoreFile(file, currentLength, {
                            instructions,
                            pagePdfs: chunk.pagePdfs,
                        });
                        throwIfAborted(signal);
                        if (isBrowserPageOpsWasmFailure(appendResult)) {
                            failure = appendResult.error.message;
                            return null;
                        }
                        currentLength = appendResult.length;
                        chunkHashes.push(appendResult.sha256);
                    }
                    if (chunkHashes.length === 0 || currentLength <= base) {
                        return null;
                    }
                    writtenLength = currentLength;
                    writtenSha256 =
                        chunkHashes.length === 1 ? chunkHashes[0]! : await sha256Hex(new TextEncoder().encode(chunkHashes.join(':')));
                    throwIfAborted(signal);
                    return currentLength;
                });
                stagedLease = lease;
                if (lease === null || writtenLength === undefined || writtenSha256 === undefined) {
                    throw new Error(`Writing the searchable layer failed: ${failure ?? 'nothing was written'}`);
                }
                outcome = {
                    kind: 'written',
                    lease,
                    length: writtenLength,
                    sha256: writtenSha256,
                    sourceRevisionToken: revision.token,
                    errors: errors.items,
                    diagnostics: diagnostics.items,
                };
            }
        } finally {
            await checkpoints.cleanup().catch(async (cleanupError: unknown) => {
                if (stagedLease !== null) {
                    const leaseToDiscard = stagedLease;
                    stagedLease = null;
                    await browserDocumentStore.discardAppend(input.sourceRef, leaseToDiscard).catch(() => undefined);
                }
                return Promise.reject(cleanupError);
            });
        }
    } finally {
        await pdf.loadingTask.destroy().catch(() => {});
    }
    if (signal.aborted) {
        if (stagedLease !== null) {
            const leaseToDiscard = stagedLease;
            stagedLease = null;
            await browserDocumentStore.discardAppend(input.sourceRef, leaseToDiscard).catch(() => undefined);
        }
        throwIfAborted(signal);
    }
    return outcome;
}
