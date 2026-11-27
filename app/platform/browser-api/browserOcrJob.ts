import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {TBrowserOcrRecognizeRequest} from '@contracts/browserOcrEngine';
import {limitAsync} from 'es-toolkit/promise';
import {
    preprocessBrowserOcrRaster,
    resolveBrowserOcrLanes,
    runBrowserOcrEngine,
} from '@app/platform/browser-api/browserOcrEngineClient';
import {createBrowserOcrCheckpointStore} from '@app/platform/browser-api/browserOcrCheckpoints';
import {
    ensureBrowserOcrModel,
    readCachedOcrModel,
} from '@app/platform/browser-api/browserOcrModels';
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
import {
    isBrowserPageOpsWasmFailure,
    type IOcrTextLayerInstructions,
} from '@contracts/browserPageOpsWorker';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {
    IOcrDiagnostic,
    IOcrProgress,
    IOcrSearchablePdfOptions,
    IOcrSearchablePdfPage,
    TOcrProgressPhase,
} from '@contracts/electronApiOcr';
import {
    EARLY_PRINT_MODEL_CODES,
    OCR_LANGUAGE_MODEL_BYTES,
    type TOcrModelCode,
    withOcrModelSublanguages,
} from '@contracts/ocrLanguages';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    createOcrPreprocessingGeometryDiagnostic,
    getOcrScanCleanupMode,
} from '@contracts/scan-cleanup/ocrPreprocessing';
import type {IPdfOcrPageTextVisibility} from '@contracts/pdfOcrTextVisibility';
import {resolveOcrExtractionDpi} from '@ocr-core/ocrRenderDpi';
import {
    buildOcrTextLayerInstructions,
    OcrJobMessages,
    recognizeOcrPages,
    type IOcrPageRaster,
} from '@ocr-core/recognizeOcrPages';
import {
    OCR_TEXT_PROBE_UNAVAILABLE,
    selectOcrPagesByExistingText,
} from '@ocr-core/selectOcrPagesByExistingText';

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
    public constructor(public readonly code: 'OCR_MODEL_DOWNLOAD_FAILED', message: string) {
        super(message);
        this.name = 'BrowserOcrJobError';
    }
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {throw signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError');}
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A page's text as `pdftotext` would read it for classification; failure is never an empty page. */
async function extractPageText(page: IPdfPage) {
    try {
        const content = await page.getTextContent();
        return content.items
            .map(item => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : ''))
            .join('');
    } catch {
        return OCR_TEXT_PROBE_UNAVAILABLE;
    }
}

async function readVisibility(source: Blob, pageNumbers: number[], signal: AbortSignal) {
    try {
        const report = await runBrowserPageOpsWorkerRequest('ocrTextVisibility', {
            source,
            pages: pageNumbers,
            withEvbOcrText: false,
        }, {signal});
        if (isBrowserPageOpsWasmFailure(report)) {
            return {
                visibility: new Map<number, IPdfOcrPageTextVisibility>(),
                warning: `Existing-text inspection was unavailable: ${report.error.message}`,
            };
        }
        return {visibility: new Map(report.pages.map(page => [
            page.pageNumber,
            page,
        ]))};
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
    const {
        signal, emit,
    } = input;
    const errors = new OcrJobMessages<string>();
    const diagnostics = new OcrJobMessages<IOcrDiagnostic>();
    let totalPages = input.pages.length;
    let processedCount = 0;
    const stage = (phase: TOcrProgressPhase, extra: Partial<IOcrProgress> = {}) => emit({
        currentPage: 0,
        processedCount,
        totalPages,
        phase,
        status: 'running',
        ...extra,
    });

    stage('preparing');
    // The document is read by range, from the revision read now; the layer is appended to that revision.
    const revision = await browserDocumentStore.getDocumentRevision(input.sourceRef);
    const source = await browserDocumentStore.readableBlob(input.sourceRef);

    const modelCodes = withOcrModelSublanguages(input.pages.flatMap(page => page.languages) as TOcrModelCode[]);
    for (const code of modelCodes) {
        stage('model-prep', {languageCode: code});
        try {
            await ensureBrowserOcrModel(code, {
                signal,
                onProgress: modelDownload => stage('model-prep', {
                    languageCode: code,
                    modelDownload,
                }),
            });
        } catch (error) {
            throwIfAborted(signal);
            throw new BrowserOcrJobError('OCR_MODEL_DOWNLOAD_FAILED', getErrorMessage(error));
        }
    }

    const pdf = await loadBrowserPdfjsDocument(input.sourceRef);
    try {
        stage('pdf-prep');
        const visibility = await readVisibility(source, input.pages.map(page => page.pageNumber), signal);
        if (visibility.warning) {errors.push(visibility.warning);}
        // Probe selected pages once; all lanes receive the same DPI.
        const renderDpi = input.options.renderDpi;
        const sourceDpiByPage = new Map<number, number>();
        const queue: IOcrSearchablePdfPage[] = [];
        let finestSourceDpi: number | null = null;
        let maxPageArea = 0;
        if (renderDpi === undefined) {stage('dpi-inspection');}
        for (const request of input.pages) {
            throwIfAborted(signal);
            const page = await pdf.getPage(request.pageNumber).catch(() => null);
            try {
                const selection = selectOcrPagesByExistingText({
                    pages: [request],
                    supersessionPolicy: input.options.supersessionPolicy ?? 'missing-only',
                    visibility: visibility.visibility,
                    texts: new Map([[
                        request.pageNumber,
                        page ? await extractPageText(page) : OCR_TEXT_PROBE_UNAVAILABLE,
                    ]]),
                });
                errors.push(...selection.warnings);
                diagnostics.push(...selection.diagnostics);
                queue.push(...selection.pages);
                if (!page || selection.pages.length === 0) {continue;}
                const viewport = page.getViewport({scale: 1});
                // In user-space units, as the raster is rendered.
                maxPageArea = Math.max(maxPageArea, viewport.width * viewport.height / (viewport.userUnit || 1) ** 2);
                if (renderDpi === undefined) {
                    const sourceDpi = readPageSourceDpi(await page.getOperatorList({annotationMode: BROWSER_OCR_ANNOTATION_MODE}));
                    if (sourceDpi !== undefined) {
                        sourceDpiByPage.set(request.pageNumber, sourceDpi);
                        finestSourceDpi = Math.max(finestSourceDpi ?? 0, sourceDpi);
                    }
                }
            } finally {
                page?.cleanup();
            }
        }
        // Progress counts the pages being recognized; a kept page is not one of them.
        totalPages = queue.length;
        const extractionDpi = resolveOcrExtractionDpi(renderDpi ?? finestSourceDpi);
        const cleanupMode = input.options.preprocessingMode === undefined
            ? undefined
            : getOcrScanCleanupMode(input.options.preprocessingMode);
        const {
            lanes, preprocessLanes,
        } = resolveBrowserOcrLanes(maxPageArea * (extractionDpi / 72) ** 2,
            modelCodes.reduce((bytes, code) => bytes + OCR_LANGUAGE_MODEL_BYTES[code], 0), cleanupMode);
        // Lanes share the preprocessing workers this job's memory affords. A
        // threaded cleanup engine splits the cores among the pages in flight:
        // each lane renders, preprocesses and recognizes its page in turn.
        const pagesInFlight = Math.min(lanes, queue.length);
        const preprocess = limitAsync(
            (payload: Parameters<typeof preprocessBrowserOcrRaster>[0], preprocessSignal: AbortSignal) => preprocessBrowserOcrRaster(payload, preprocessSignal, pagesInFlight),
            Math.max(1, preprocessLanes),
        );
        /**
         * Renders the page and, when the run sets a preprocessing mode, cleans
         * it as desktop does: 'off' still normalizes polarity. A cleaned page
         * of the rendered size is recognized and its words are mapped back
         * through the inverse transform; otherwise the rendered page is, with
         * a diagnostic.
         */
        const renderPage = async (pageNumber: number, dpi: number): Promise<IOcrPageRaster<TBrowserOcrImage>> => {
            const page = await pdf.getPage(pageNumber);
            try {
                const size = getBrowserOcrRasterSize(page, dpi);
                const rendered = {
                    ...size,
                    image: (await renderBrowserOcrRaster(page, dpi, signal)).image,
                };
                if (cleanupMode === undefined) {return rendered;}
                const failed = (reason: string): IOcrDiagnostic => ({
                    code: 'OCR_PREPROCESSING_FAILED',
                    severity: 'warning',
                    pageNumber: requirePageNumber(pageNumber),
                    message: `OCR preprocessing failed; using raw page render: ${reason}`,
                });
                let cleaned;
                try {
                    cleaned = await preprocess({
                        image: rendered.image,
                        mode: cleanupMode,
                        dpi,
                    }, signal);
                } catch (error) {
                    throwIfAborted(signal);
                    // The engine stopped or ran out of time with the raster; render it again.
                    return {
                        ...size,
                        image: (await renderBrowserOcrRaster(page, dpi, signal)).image,
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
                    ...(cleaned.inverseMatrix ? {preprocessInverse: {
                        rasterWidthPx: cleaned.width,
                        rasterHeightPx: cleaned.height,
                        matrix: cleaned.inverseMatrix,
                    }} : {}),
                };
            } finally {
                page.cleanup();
            }
        };
        const durablePort = typeof browserDocumentStore.stores === 'function'
            ? (await browserDocumentStore.stores().catch(() => null))?.durable?.port ?? null
            : null;
        const checkpoints = await createBrowserOcrCheckpointStore(durablePort);
        try {
            const progress = (currentPage: number, active: readonly number[]) => stage('processing', {
                currentPage,
                activePages: [...active],
            });
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
                prepareEarlyPrintModels: async () => {
                    for (const code of EARLY_PRINT_MODEL_CODES) {
                        await ensureBrowserOcrModel(code, {signal});
                    }
                },
                readModel: readCachedOcrModel,
                acceptPage: page => checkpoints.stagePage(page),
                onPageStart: progress,
                onPageDone: (pageNumber, active, processed) => {
                    processedCount = processed;
                    progress(pageNumber, active);
                },
            });
            errors.push(...result.errors.items);
            diagnostics.push(...result.diagnostics.items);

            if (checkpoints.getPageCount() === 0) {
                return {
                    kind: 'nothing-written',
                    targeted,
                    errors: errors.items,
                    diagnostics: diagnostics.items,
                };
            }

            stage('merging');
            throwIfAborted(signal);
            let writtenLength: number | undefined;
            let writtenSha256: string | undefined;
            let failure: string | undefined;
            const lease = await browserDocumentStore.stageAppend(input.sourceRef, revision.token, async (file, base) => {
                let currentLength = base;
                const chunkHashes: string[] = [];
                for await (const chunk of checkpoints.iterateChunks({signal})) {
                    throwIfAborted(signal);
                    const instructions: IOcrTextLayerInstructions = {
                        pages: buildOcrTextLayerInstructions(chunk.records),
                    };
                    const appendResult = await appendPdfMutationsToStoreFile(file, currentLength, {
                        instructions,
                        pagePdfs: chunk.pagePdfs,
                    });
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
                writtenSha256 = chunkHashes.length === 1
                    ? chunkHashes[0]!
                    : await sha256Hex(new TextEncoder().encode(chunkHashes.join(':')));
                return currentLength;
            });
            if (lease === null || writtenLength === undefined || writtenSha256 === undefined) {
                throw new Error(`Writing the searchable layer failed: ${failure ?? 'nothing was written'}`);
            }
            return {
                kind: 'written',
                lease,
                length: writtenLength,
                sha256: writtenSha256,
                sourceRevisionToken: revision.token,
                errors: errors.items,
                diagnostics: diagnostics.items,
            };
        } finally {
            await checkpoints.cleanup();
        }
    } finally {
        await pdf.loadingTask.destroy().catch(() => {});
    }
}
