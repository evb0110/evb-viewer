import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {
    BROWSER_OCR_ENGINE_IMAGE_PATH,
    BROWSER_OCR_ENGINE_OUTPUT_BASE,
    BROWSER_OCR_ENGINE_TESSDATA_PATH,
} from '@contracts/browserOcrEngine';
import {
    getBrowserOcrLaneCount,
    runBrowserOcrEngine,
} from '@app/platform/browser-api/browserOcrEngineClient';
import {
    ensureBrowserOcrModel,
    readCachedOcrModel,
} from '@app/platform/browser-api/browserOcrModels';
import {
    BROWSER_OCR_ANNOTATION_MODE,
    readPageSourceDpi,
    renderBrowserOcrRaster,
} from '@app/platform/browser-api/browserOcrRaster';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {loadBrowserPdfjsDocument} from '@app/platform/browser-api/loadBrowserPdfjsDocument';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import {OCR_TEXT_LAYER_HEADER} from '@contracts/browserPageOpsWasm.generated';
import {getErrorMessage} from '@app/utils/error';
import {
    isBrowserPageOpsWasmFailure,
    type IOcrTextLayerInstructions,
} from '@contracts/browserPageOpsWorker';
import {
    canReadEarlyPrint,
    createEarlyPrintDictionary,
    hasLongSSignature,
    planEarlyPrintWordEdits,
} from '@ocr-core/earlyPrintReading';
import {
    hocrWordText,
    readHocrLines,
} from '@ocr-core/hocrReading';
import {readTraineddataWordList} from '@ocr-core/readTraineddataWordList';
import type {IOcrWordEdit} from '@ocr-core/types';
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
    OCR_LANGUAGE_MODEL_BYTES, type TOcrModelCode,
} from '@contracts/ocrLanguages';
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
    readTesseractWords,
    TESSERACT_MAX_HOCR_BYTES,
    TESSERACT_MAX_TSV_BYTES,
} from '@ocr-core/tesseractTsv';

const LONG_S_OUTPUT_BASE = '/work/ita_old';
const LIGATURES_OUTPUT_BASE = '/work/fra';
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
    wordEdits: IOcrWordEdit[];
}

function requireTesseractPdf(bytes: Uint8Array | undefined) {
    if (!bytes || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
        throw new Error('Tesseract did not produce PDF output');
    }
    return bytes;
}

function decodeBoundedText(bytes: Uint8Array | undefined, maxBytes: number, label: string) {
    if (!bytes || bytes.byteLength > maxBytes) {
        throw new Error(`Tesseract ${label} output is missing or exceeds its limit`);
    }
    return new TextDecoder().decode(bytes);
}

/**
 * The early-print dictionary of the selected languages, built from their own
 * models' word lists as desktop builds it (Latin is not a browser language).
 */
async function loadEarlyPrintDictionary(languages: readonly string[]) {
    const lists = await Promise.all([...new Set(languages)].map(async code => readTraineddataWordList(await readCachedOcrModel(code as TOcrModelCode))));
    return createEarlyPrintDictionary(lists.flatMap(list => list ?? []), false);
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

// A TSV that cannot be read fails the page when it is parsed for its words.
function readWordsOrNone(tsv: string) {
    try {
        return readTesseractWords(tsv).map(word => word.text);
    } catch {
        return [];
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
    // Reject an impossible source before OCR. The worker accounts for page PDFs
    // and instructions once recognition has produced their actual bytes.
    const maxInputBytes = BROWSER_PAGE_OPS_MAX_REQUEST_BYTES - OCR_TEXT_LAYER_HEADER.bytes;
    if (size > maxInputBytes) {
        throw new BrowserOcrJobError('OCR_DOCUMENT_TOO_LARGE', 'The source PDF exceeds the PDF writer request budget');
    }
    const data = await browserDocumentStore.read(input.sourceRef, {maxBytes: maxInputBytes});
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
        // Probe selected pages once; all lanes receive the same DPI.
        const renderDpi = input.options.renderDpi;
        const sourceDpiByPage = new Map<number, number>();
        const queue: IOcrSearchablePdfPage[] = [];
        let finestSourceDpi: number | null = null;
        let maxPageArea = 0;
        if (renderDpi === undefined) stage('dpi-inspection');
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
                if (!page || selection.pages.length === 0) continue;
                const viewport = page.getViewport({scale: 1});
                maxPageArea = Math.max(maxPageArea, viewport.width * viewport.height);
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
        processedCount = totalPages - queue.length;
        const extractionDpi = resolveOcrExtractionDpi(renderDpi ?? finestSourceDpi);
        const recognized: IRecognizedPage[] = [];
        const enginePass = (
            languages: readonly string[],
            outputBase: string,
            dpi: number,
            outputs: {
                pdf?: boolean;
                tsv?: boolean;
                hocr?: boolean
            },
        ) => ({
            args: buildTesseractArgs({
                imagePath: BROWSER_OCR_ENGINE_IMAGE_PATH,
                outputBase,
                languages,
                tessdataPath: BROWSER_OCR_ENGINE_TESSDATA_PATH,
                dpi,
                options: input.options,
                outputs,
            }),
            outputs: ([
                'pdf',
                'tsv',
                'hocr',
            ] as const).filter(kind => outputs[kind]).map(kind => `${outputBase}.${kind}`),
        });
        // The early-print models and each language set's dictionary load once per job.
        let earlyPrintModels: Promise<void> | null = null;
        const dictionaries = new Map<string, Promise<ReadonlySet<string>>>();
        /**
         * On a page its own model read with the long-s signature, reads the
         * raster again, as desktop does: the selected models writing hOCR as
         * well, then ita_old for the long s and graves, fra for æ and œ. The
         * reread PDF and the planned word edits replace the first reading only
         * when every pass succeeded.
         */
        const readEarlyPrint = async (page: IPdfPage, dpi: number, languages: readonly string[]) => {
            earlyPrintModels ??= (async () => {
                for (const code of [
                    'ita_old',
                    'fra',
                ] as const) {
                    await ensureBrowserOcrModel(code, {signal});
                }
            })();
            await earlyPrintModels;
            const dictionaryKey = [...languages].sort().join('+');
            let dictionary = dictionaries.get(dictionaryKey);
            if (!dictionary) {
                dictionary = loadEarlyPrintDictionary(languages);
                // Awaited after the engine runs; an early rejection is not an unhandled one.
                dictionary.catch(() => {});
                dictionaries.set(dictionaryKey, dictionary);
            }
            // The first request handed its raster to the engine; render the page again.
            const raster = await renderBrowserOcrRaster(page, dpi, signal);
            const result = await runBrowserOcrEngine({
                image: raster.image,
                models: [...new Set([
                    ...languages,
                    'ita_old',
                    'fra',
                ])] as TOcrModelCode[],
                passes: [
                    enginePass(languages, BROWSER_OCR_ENGINE_OUTPUT_BASE, dpi, {
                        pdf: true,
                        tsv: true,
                        hocr: true,
                    }),
                    enginePass(['ita_old'], LONG_S_OUTPUT_BASE, dpi, {hocr: true}),
                    enginePass(['fra'], LIGATURES_OUTPUT_BASE, dpi, {hocr: true}),
                ],
            }, signal);
            const [
                base,
                longS,
                ligatures,
            ] = result.passes;
            const [
                pdf,
                tsv,
                hocr,
            ] = base!.outputs;
            const rereadTsv = decodeBoundedText(tsv, TESSERACT_MAX_TSV_BYTES, 'TSV').trim();
            const baseLines = readHocrLines(decodeBoundedText(hocr, TESSERACT_MAX_HOCR_BYTES, 'hOCR'));
            // Edits name words by their place in the TSV, which lists the hOCR's words in order.
            const hocrWords = baseLines.flatMap(line => line.words.map(word => hocrWordText(word).trim()));
            const tsvWords = readTesseractWords(rereadTsv).map(word => word.text);
            if (hocrWords.length !== tsvWords.length || hocrWords.some((word, index) => word !== tsvWords[index])) {
                throw new Error('Tesseract listed different words in its hOCR and TSV');
            }
            const wordEdits = planEarlyPrintWordEdits({
                base: baseLines,
                longS: readHocrLines(decodeBoundedText(longS!.outputs[0], TESSERACT_MAX_HOCR_BYTES, 'hOCR')),
                ligatures: readHocrLines(decodeBoundedText(ligatures!.outputs[0], TESSERACT_MAX_HOCR_BYTES, 'hOCR')),
            }, await dictionary, {latin: false});
            parseTsvOcrData(rereadTsv, {}, wordEdits);
            return {
                pdf: requireTesseractPdf(pdf),
                wordEdits,
            };
        };
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
                    passes: [enginePass(request.languages, BROWSER_OCR_ENGINE_OUTPUT_BASE, dpi, {
                        pdf: true,
                        tsv: true,
                    })],
                }, signal);
                const [pass] = result.passes;
                const [
                    firstPdf,
                    tsv,
                ] = pass!.outputs;
                const tsvText = decodeBoundedText(tsv, TESSERACT_MAX_TSV_BYTES, 'TSV').trim();
                // The words are not stored; parsing applies the desktop's TSV bounds.
                parseTsvOcrData(tsvText);
                let pagePdf = requireTesseractPdf(firstPdf);
                let wordEdits: IOcrWordEdit[] = [];
                if (canReadEarlyPrint(request.languages) && hasLongSSignature(readWordsOrNone(tsvText))) {
                    try {
                        const early = await readEarlyPrint(page, dpi, request.languages);
                        pagePdf = early.pdf;
                        wordEdits = early.wordEdits;
                    } catch (error) {
                        throwIfAborted(signal);
                        diagnostics.push({
                            code: 'OCR_EARLY_PRINT_UNAVAILABLE',
                            severity: 'warning',
                            pageNumber: requirePageNumber(request.pageNumber),
                            message: `The page looks like early print, but the early-print models could not run: ${getErrorMessage(error)}`,
                        });
                    }
                }
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
                    wordEdits,
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
        const memoryLanes = getBrowserOcrLaneCount(maxPageArea * (extractionDpi / 72) ** 2,
            modelCodes.reduce((bytes, code) => bytes + OCR_LANGUAGE_MODEL_BYTES[code], 0));
        const targeted = queue.length > 0;
        await Promise.all(Array.from({length: Math.min(memoryLanes, Math.max(1, queue.length))}, lane));

        if (recognized.length === 0) {
            return {
                kind: 'nothing-written',
                targeted,
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
            ...(page.wordEdits.length > 0 ? {wordEdits: page.wordEdits} : {}),
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
