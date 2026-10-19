import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    BROWSER_OCR_ENGINE_IMAGE_PATH,
    BROWSER_OCR_ENGINE_OUTPUT_BASE,
    BROWSER_OCR_ENGINE_TESSDATA_PATH,
} from '@app/platform/browser-api/browserOcrEngine.types';
import {
    getBrowserOcrLaneCount,
    runBrowserOcrEngine,
} from '@app/platform/browser-api/browserOcrEngineClient';
import {ensureBrowserOcrModel} from '@app/platform/browser-api/browserOcrModels';
import {
    BROWSER_OCR_ANNOTATION_MODE,
    readPageSourceDpi,
    renderBrowserOcrRaster,
} from '@app/platform/browser-api/browserOcrRaster';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
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
import type {TOcrModelCode} from '@contracts/ocrLanguages';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {IPdfOcrPageTextVisibility} from '@contracts/pdfOcrTextVisibility';
import {
    resolveOcrExtractionDpi,
    resolveOcrPageDpi,
} from '@ocr-core/ocrRenderDpi';
import {
    OCR_TEXT_PROBE_UNAVAILABLE,
    selectOcrPagesByExistingText,
} from '@ocr-core/selectOcrPagesByExistingText';
import {
    buildTesseractArgs,
    findUnsupportedTesseractOptions,
    shouldNormalizeGreekMicroSign,
} from '@ocr-core/tesseractRecipe';
import {
    parseTsvOcrData,
    TESSERACT_MAX_TSV_BYTES,
} from '@ocr-core/tesseractTsv';

const ENGINE_PDF_OUTPUT = `${BROWSER_OCR_ENGINE_OUTPUT_BASE}.pdf`;
const ENGINE_TSV_OUTPUT = `${BROWSER_OCR_ENGINE_OUTPUT_BASE}.tsv`;
const MAX_JOB_MESSAGES = 10_000;

export interface IBrowserOcrJobInput {
    sourceRef: TDocumentRef;
    pages: readonly IOcrSearchablePdfPage[];
    options: IOcrSearchablePdfOptions;
    signal: AbortSignal;
    emit: (progress: Omit<IOcrProgress, 'requestId'>) => void;
}

export type TBrowserOcrJobOutcome =
    | {
        kind: 'written';
        data: Uint8Array<ArrayBuffer>;
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

interface IRecognizedPage {
    pageNumber: number;
    pdf: Uint8Array;
    languages: readonly string[];
}

/** A failure the workspace explains in the user's language, by its code. */
export class BrowserOcrJobError extends Error {
    public constructor(public readonly code: 'OCR_DOCUMENT_TOO_LARGE' | 'OCR_MODEL_DOWNLOAD_FAILED', message: string) {
        super(message);
        this.name = 'BrowserOcrJobError';
    }
}

class BoundedMessages<T> {
    public readonly items: T[] = [];
    public push(...items: T[]) {
        for (const item of items) {
            if (this.items.length < MAX_JOB_MESSAGES) this.items.push(item);
        }
    }
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError');
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

async function readVisibility(data: Uint8Array, pageNumbers: number[], signal: AbortSignal) {
    try {
        const report = await runBrowserPageOpsWorkerRequest('ocrTextVisibility', {
            data,
            pages: pageNumbers,
            withEvbOcrText: false,
        }, {signal});
        if (report === null || isBrowserPageOpsWasmFailure(report)) {
            return {
                visibility: new Map<number, IPdfOcrPageTextVisibility>(),
                warning: `Existing-text inspection was unavailable: ${report === null ? 'the page tool could not be loaded' : report.error.message}`,
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
    const errors = new BoundedMessages<string>();
    const diagnostics = new BoundedMessages<IOcrDiagnostic>();
    const totalPages = input.pages.length;
    let processedCount = 0;
    const activePages = new Set<number>();
    const stage = (phase: TOcrProgressPhase, extra: Partial<IOcrProgress> = {}) => emit({
        currentPage: 0,
        processedCount,
        totalPages,
        phase,
        status: 'running',
        ...extra,
    });

    stage('preparing');
    const revision = await browserDocumentStore.getDocumentRevision(input.sourceRef);
    const {size} = await browserDocumentStore.stat(input.sourceRef);
    if (size > BROWSER_MAX_FULL_READ_BYTES) {
        throw new BrowserOcrJobError('OCR_DOCUMENT_TOO_LARGE', `Browser OCR accepts documents up to ${BROWSER_MAX_FULL_READ_BYTES / (1024 * 1024)} MB`);
    }
    const data = await browserDocumentStore.read(input.sourceRef);
    throwIfAborted(signal);
    await browserDocumentStore.assertDocumentRevisionCurrent(input.sourceRef, revision.token);

    const modelCodes = [...new Set(input.pages.flatMap(page => page.languages))] as TOcrModelCode[];
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
        const visibility = await readVisibility(data, input.pages.map(page => page.pageNumber), signal);
        if (visibility.warning) errors.push(visibility.warning);
        const texts = new Map<number, string>();
        for (const request of input.pages) {
            throwIfAborted(signal);
            // A page PDF.js cannot load is a page whose text is unknown, never an empty page.
            const page = await pdf.getPage(request.pageNumber).catch(() => null);
            if (!page) {
                texts.set(request.pageNumber, OCR_TEXT_PROBE_UNAVAILABLE);
                continue;
            }
            try {
                texts.set(request.pageNumber, await extractPageText(page));
            } finally {
                page.cleanup();
            }
        }
        const selection = selectOcrPagesByExistingText({
            pages: input.pages,
            supersessionPolicy: input.options.supersessionPolicy ?? 'missing-only',
            visibility: visibility.visibility,
            texts,
        });
        errors.push(...selection.warnings);
        diagnostics.push(...selection.diagnostics);
        processedCount = totalPages - selection.pages.length;

        // As on desktop, the document's resolution is its finest selected page
        // image, read before any page renders, so lane order cannot change it.
        const renderDpi = input.options.renderDpi;
        const sourceDpiByPage = new Map<number, number>();
        let finestSourceDpi: number | null = null;
        if (renderDpi === undefined) {
            stage('dpi-inspection');
            for (const request of selection.pages) {
                throwIfAborted(signal);
                const page = await pdf.getPage(request.pageNumber).catch(() => null);
                if (!page) continue;
                try {
                    const sourceDpi = readPageSourceDpi(await page.getOperatorList({annotationMode: BROWSER_OCR_ANNOTATION_MODE}));
                    if (sourceDpi !== undefined) {
                        sourceDpiByPage.set(request.pageNumber, sourceDpi);
                        finestSourceDpi = Math.max(finestSourceDpi ?? 0, sourceDpi);
                    }
                } finally {
                    page.cleanup();
                }
            }
        }
        const extractionDpi = resolveOcrExtractionDpi(renderDpi ?? finestSourceDpi);
        const recognized: IRecognizedPage[] = [];
        const queue = [...selection.pages];
        const recognizePage = async (request: IOcrSearchablePdfPage) => {
            activePages.add(request.pageNumber);
            stage('processing', {
                currentPage: request.pageNumber,
                activePages: [...activePages],
            });
            let page: IPdfPage | null = null;
            try {
                page = await pdf.getPage(request.pageNumber);
                const dpi = resolveOcrPageDpi(extractionDpi, sourceDpiByPage.get(request.pageNumber));
                if (dpi < extractionDpi) {
                    diagnostics.push({
                        code: 'OCR_SOURCE_DPI_LIMITED',
                        severity: 'info',
                        pageNumber: requirePageNumber(request.pageNumber),
                        message: `Used ${dpi} DPI instead of ${extractionDpi} DPI to avoid upscaling the embedded page image`,
                    });
                }
                const raster = await renderBrowserOcrRaster(page, dpi, signal);
                const result = await runBrowserOcrEngine({
                    image: raster.image,
                    models: [...request.languages] as TOcrModelCode[],
                    passes: [{
                        args: buildTesseractArgs({
                            imagePath: BROWSER_OCR_ENGINE_IMAGE_PATH,
                            outputBase: BROWSER_OCR_ENGINE_OUTPUT_BASE,
                            languages: request.languages,
                            tessdataPath: BROWSER_OCR_ENGINE_TESSDATA_PATH,
                            dpi,
                            options: input.options,
                            outputs: {
                                pdf: true,
                                tsv: true,
                            },
                        }),
                        outputs: [
                            ENGINE_PDF_OUTPUT,
                            ENGINE_TSV_OUTPUT,
                        ],
                    }],
                }, signal);
                const [pass] = result.passes;
                const [
                    pagePdf,
                    tsv,
                ] = pass!.outputs;
                if (!pagePdf || new TextDecoder().decode(pagePdf.subarray(0, 5)) !== '%PDF-') {
                    throw new Error('Tesseract did not produce PDF output');
                }
                if (!tsv || tsv.byteLength > TESSERACT_MAX_TSV_BYTES) {
                    throw new Error('Tesseract TSV output is missing or exceeds its limit');
                }
                // The words are not stored; parsing applies the desktop's TSV bounds.
                parseTsvOcrData(new TextDecoder().decode(tsv).trim());
                const unsupported = findUnsupportedTesseractOptions(pass!.stderr);
                if (unsupported.length > 0) {
                    diagnostics.push({
                        code: 'OCR_ENGINE_OPTION_UNSUPPORTED',
                        severity: 'warning',
                        pageNumber: requirePageNumber(request.pageNumber),
                        message: `Tesseract rejected ${unsupported.join(', ')}; the page was recognized without them`,
                    });
                }
                recognized.push({
                    pageNumber: request.pageNumber,
                    pdf: pagePdf,
                    languages: request.languages,
                });
            } catch (error) {
                throwIfAborted(signal);
                errors.push(`Page ${request.pageNumber}: ${getErrorMessage(error)}`);
            } finally {
                page?.cleanup();
                activePages.delete(request.pageNumber);
                processedCount += 1;
                stage('processing', {
                    currentPage: request.pageNumber,
                    activePages: [...activePages],
                });
            }
        };
        const lane = async () => {
            for (let request = queue.shift(); request; request = queue.shift()) {
                await recognizePage(request);
            }
        };
        await Promise.all(Array.from({length: Math.min(getBrowserOcrLaneCount(), Math.max(1, queue.length))}, lane));

        if (recognized.length === 0) {
            return {
                kind: 'nothing-written',
                targeted: selection.pages.length > 0,
                errors: errors.items,
                diagnostics: diagnostics.items,
            };
        }

        stage('merging');
        recognized.sort((left, right) => left.pageNumber - right.pageNumber);
        const instructions: IOcrTextLayerInstructions = {pages: recognized.map((page, source) => ({
            pageNumber: page.pageNumber,
            source,
            ...(shouldNormalizeGreekMicroSign(page.languages) ? {normalizeGreekMicroSign: true} : {}),
        }))};
        await browserDocumentStore.assertDocumentRevisionCurrent(input.sourceRef, revision.token);
        const written = await runBrowserPageOpsWorkerRequest('ocrTextLayer', {
            data,
            instructions,
            pagePdfs: recognized.map(page => page.pdf),
        }, {signal});
        if (written === null) {
            throw new Error('The browser page tool that writes the searchable layer could not be loaded');
        }
        if (isBrowserPageOpsWasmFailure(written)) {
            throw new Error(`Writing the searchable layer failed: ${written.error.message}`);
        }
        const output = new Uint8Array(data.byteLength + written.data.byteLength);
        output.set(data);
        output.set(written.data, data.byteLength);
        if (output.byteLength > BROWSER_MAX_FULL_READ_BYTES) {
            throw new BrowserOcrJobError('OCR_DOCUMENT_TOO_LARGE', `The searchable PDF would exceed the browser's ${BROWSER_MAX_FULL_READ_BYTES / (1024 * 1024)} MB editing limit`);
        }
        return {
            kind: 'written',
            data: output,
            sourceRevisionToken: revision.token,
            errors: errors.items,
            diagnostics: diagnostics.items,
        };
    } finally {
        await pdf.loadingTask.destroy().catch(() => {});
    }
}
