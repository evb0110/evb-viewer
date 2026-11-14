import {
    BROWSER_OCR_ENGINE_IMAGE_PATH,
    BROWSER_OCR_ENGINE_OUTPUT_BASE,
    BROWSER_OCR_ENGINE_TESSDATA_PATH,
} from '@contracts/browserOcrEngine';
import type {
    IOcrTextLayerInstructions,
    TOcrWordGeometry,
} from '@contracts/browserPageOpsWorker';
import type {
    IOcrDiagnostic,
    IOcrSearchablePdfOptions,
} from '@contracts/electronApiOcr';
import type {TOcrModelCode} from '@contracts/ocrLanguages';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    canReadEarlyPrint,
    hasLongSSignature,
    planEarlyPrintWordEdits,
    readEarlyPrintDictionary,
} from '@ocr-core/earlyPrintReading';
import {
    hocrWordText,
    readHocrLines,
} from '@ocr-core/hocrReading';
import {resolveOcrPageDpi} from '@ocr-core/ocrRenderDpi';
import type {
    IOcrEngineRequest,
    IOcrEngineResult,
} from '@ocr-core/tesseractEngine';
import {
    buildTesseractArgs,
    findUnsupportedTesseractOptions,
    shouldNormalizeGreekMicroSign,
    type ITesseractOutputs,
} from '@ocr-core/tesseractRecipe';
import {
    parseTsvOcrData,
    readTesseractWords,
    TESSERACT_MAX_HOCR_BYTES,
    TESSERACT_MAX_TSV_BYTES,
} from '@ocr-core/tesseractTsv';
import type {IOcrWordEdit} from '@ocr-core/types';

const LONG_S_OUTPUT_BASE = '/work/ita_old';
const LIGATURES_OUTPUT_BASE = '/work/fra';
const MAX_JOB_MESSAGES = 10_000;

export type TOcrPreprocessInverse = NonNullable<IOcrTextLayerInstructions['pages'][number]['preprocessInverse']>;

/** The raster Tesseract reads and how its pixels map back to the rendered page. */
export interface IOcrPageRaster<TImage> {
    image: TImage;
    /** The rendered page's size, in which the recognized words are placed. */
    width: number;
    height: number;
    preprocessInverse?: TOcrPreprocessInverse;
    /** Why the page is recognized from its render rather than the cleaned page. */
    diagnostic?: IOcrDiagnostic;
}

/** One recognized page, as the text-layer writer appends it. */
export interface IOcrRecognizedPage {
    pageNumber: number;
    languages: readonly string[];
    /** Tesseract's text-only page PDF. */
    pdf: Uint8Array;
    text: string;
    /** Edits early-print reading made that Tesseract's PDF does not carry. */
    wordEdits: IOcrWordEdit[];
    wordGeometry: TOcrWordGeometry;
    preprocessInverse?: TOcrPreprocessInverse;
    diagnostics: IOcrDiagnostic[];
}

/**
 * The ports a host gives the OCR job: page rasters (PDF.js in the browser,
 * Poppler on desktop), the engine pool (Web Workers or Node worker threads
 * running `createTesseractEngine`), and where recognized pages go.
 */
/** A page to recognize, in the languages chosen for it. */
interface IOcrPageRequest {
    pageNumber: number;
    languages: readonly string[];
}

export interface IRecognizeOcrPagesInput<TImage> {
    pages: readonly IOcrPageRequest[];
    /** The job's render resolution; a page renders no finer than its own image. */
    extractionDpi: number;
    sourceDpiByPage: ReadonlyMap<number, number>;
    options: IOcrSearchablePdfOptions;
    lanes: number;
    signal: AbortSignal;
    renderPage: (pageNumber: number, dpi: number, signal: AbortSignal) => Promise<IOcrPageRaster<TImage>>;
    runEngine: (request: IOcrEngineRequest<TImage>, signal: AbortSignal) => Promise<IOcrEngineResult>;
    /** Installs the early-print models; called once, when a page first needs them. */
    prepareEarlyPrintModels: () => Promise<void>;
    readModel: (code: TOcrModelCode) => Promise<Uint8Array>;
    /** The page as an earlier, interrupted run of this job recognized and accepted it. */
    restorePage?: (pageNumber: number) => Promise<IOcrRecognizedPage | null>;
    /** Takes a newly recognized page; a page it rejects is reported as failed. */
    acceptPage: (page: IOcrRecognizedPage) => Promise<void>;
    onPageStart?: (pageNumber: number, activePages: readonly number[]) => void;
    onPageDone?: (pageNumber: number, activePages: readonly number[], processedCount: number) => void;
}

/** Collects at most `MAX_JOB_MESSAGES` items, so a huge document cannot flood its result. */
export class OcrJobMessages<T> {
    public readonly items: T[] = [];
    public omitted = 0;
    public push(...items: T[]) {
        for (const item of items) {
            if (this.items.length < MAX_JOB_MESSAGES) this.items.push(item);
            else this.omitted += 1;
        }
    }
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('OCR was canceled', 'AbortError');
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
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

// A TSV that cannot be read fails the page when it is parsed for its words.
function readWordsOrNone(tsv: string) {
    try {
        return readTesseractWords(tsv).map(word => word.text);
    } catch {
        return [];
    }
}

function enginePass(
    languages: readonly string[],
    outputBase: string,
    dpi: number,
    options: IOcrSearchablePdfOptions,
    outputs: ITesseractOutputs,
) {
    return {
        args: buildTesseractArgs({
            imagePath: BROWSER_OCR_ENGINE_IMAGE_PATH,
            outputBase,
            languages,
            tessdataPath: BROWSER_OCR_ENGINE_TESSDATA_PATH,
            dpi,
            options,
            outputs,
        }),
        outputs: ([
            'pdf',
            'tsv',
            'hocr',
        ] as const).filter(kind => outputs[kind]).map(kind => `${outputBase}.${kind}`),
    };
}

/**
 * The OCR job's page work, the same in the browser and on desktop: each page
 * renders at its resolution, the engine reads it with the recipe's arguments,
 * a page with the long-s signature is read again with the early-print models,
 * and the recognized page goes to the host's text-layer writer. Pages run in
 * `lanes` parallel lanes; a page that fails is reported and the job goes on.
 */
export async function recognizeOcrPages<TImage>(input: IRecognizeOcrPagesInput<TImage>) {
    const {
        signal, options,
    } = input;
    const errors = new OcrJobMessages<string>();
    const diagnostics = new OcrJobMessages<IOcrDiagnostic>();
    const queue = [...input.pages];
    const activePages = new Set<number>();
    let processedCount = 0;
    let recognizedCount = 0;
    let earlyPrintModels: Promise<void> | null = null;
    const dictionaries = new Map<string, Promise<ReadonlySet<string>>>();

    /**
     * On a page its own model read with the long-s signature, reads a fresh
     * raster again: the selected models writing hOCR as well, then ita_old for
     * the long s and graves, fra for æ and œ. The reread PDF and the planned
     * word edits replace the first reading only when every pass succeeded.
     */
    const readEarlyPrint = async (pageNumber: number, dpi: number, languages: readonly string[]) => {
        earlyPrintModels ??= input.prepareEarlyPrintModels();
        await earlyPrintModels;
        const dictionaryKey = [...languages].sort().join('+');
        let dictionary = dictionaries.get(dictionaryKey);
        if (!dictionary) {
            dictionary = readEarlyPrintDictionary(languages, code => input.readModel(code as TOcrModelCode));
            // Awaited after the engine runs; an early rejection is not an unhandled one.
            dictionary.catch(() => {});
            dictionaries.set(dictionaryKey, dictionary);
        }
        // The first request handed its raster to the engine; render the page again.
        const raster = await input.renderPage(pageNumber, dpi, signal);
        const result = await input.runEngine({
            image: raster.image,
            models: [...new Set([
                ...languages,
                'ita_old',
                'fra',
            ])] as TOcrModelCode[],
            passes: [
                enginePass(languages, BROWSER_OCR_ENGINE_OUTPUT_BASE, dpi, options, {
                    pdf: true,
                    tsv: true,
                    hocr: true,
                }),
                enginePass(['ita_old'], LONG_S_OUTPUT_BASE, dpi, options, {hocr: true}),
                enginePass(['fra'], LIGATURES_OUTPUT_BASE, dpi, options, {hocr: true}),
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
        }, await dictionary, {latin: languages.includes('lat')});
        return {
            pdf: requireTesseractPdf(pdf),
            tsv: rereadTsv,
            wordEdits,
            raster,
        };
    };

    const recognizePage = async (request: IOcrPageRequest): Promise<IOcrRecognizedPage> => {
        const pageNumber = requirePageNumber(request.pageNumber);
        const pageDiagnostics: IOcrDiagnostic[] = [];
        try {
            const dpi = resolveOcrPageDpi(input.extractionDpi, input.sourceDpiByPage.get(pageNumber));
            if (dpi < input.extractionDpi) {
                pageDiagnostics.push({
                    code: 'OCR_SOURCE_DPI_LIMITED',
                    severity: 'info',
                    pageNumber,
                    message: `Used ${dpi} DPI instead of ${input.extractionDpi} DPI to avoid upscaling the embedded page image`,
                });
            }
            let raster = await input.renderPage(pageNumber, dpi, signal);
            if (raster.diagnostic) pageDiagnostics.push(raster.diagnostic);
            const result = await input.runEngine({
                image: raster.image,
                models: [...request.languages] as TOcrModelCode[],
                passes: [enginePass(request.languages, BROWSER_OCR_ENGINE_OUTPUT_BASE, dpi, options, {
                    pdf: true,
                    tsv: true,
                })],
            }, signal);
            const [pass] = result.passes;
            const [
                firstPdf,
                firstTsv,
            ] = pass!.outputs;
            let tsv = decodeBoundedText(firstTsv, TESSERACT_MAX_TSV_BYTES, 'TSV').trim();
            let pdf = requireTesseractPdf(firstPdf);
            let wordEdits: IOcrWordEdit[] = [];
            if (canReadEarlyPrint(request.languages) && hasLongSSignature(readWordsOrNone(tsv))) {
                try {
                    const early = await readEarlyPrint(pageNumber, dpi, request.languages);
                    pdf = early.pdf;
                    tsv = early.tsv;
                    wordEdits = early.wordEdits;
                    // The reread PDF was recognized on this raster; one diagnostic per page.
                    if (early.raster.diagnostic && !raster.diagnostic) pageDiagnostics.push(early.raster.diagnostic);
                    raster = early.raster;
                } catch (error) {
                    throwIfAborted(signal);
                    pageDiagnostics.push({
                        code: 'OCR_EARLY_PRINT_UNAVAILABLE',
                        severity: 'warning',
                        pageNumber,
                        message: `The page looks like early print, but the early-print models could not run: ${errorMessage(error)}`,
                    });
                }
            }
            const unsupported = findUnsupportedTesseractOptions(pass!.stderr);
            if (unsupported.length > 0) {
                pageDiagnostics.push({
                    code: 'OCR_ENGINE_OPTION_UNSUPPORTED',
                    severity: 'warning',
                    pageNumber,
                    message: `Tesseract rejected ${unsupported.join(', ')}; the page was recognized without them`,
                });
            }
            // The TSV parser applies its bounds and keeps each word's ink rectangle.
            const parsed = parseTsvOcrData(tsv, {normalizeGreekMicroSign: shouldNormalizeGreekMicroSign(request.languages)}, wordEdits);
            return {
                pageNumber,
                languages: request.languages,
                pdf,
                text: parsed.text,
                wordEdits,
                wordGeometry: {
                    rasterWidthPx: raster.width,
                    rasterHeightPx: raster.height,
                    words: parsed.inkWords,
                },
                ...(raster.preprocessInverse ? {preprocessInverse: raster.preprocessInverse} : {}),
                diagnostics: pageDiagnostics,
            };
        } catch (error) {
            diagnostics.push(...pageDiagnostics);
            throw error;
        }
    };

    const runPage = async (request: IOcrPageRequest) => {
        activePages.add(request.pageNumber);
        input.onPageStart?.(request.pageNumber, [...activePages]);
        try {
            const restored = await input.restorePage?.(request.pageNumber) ?? null;
            const page = restored ?? await recognizePage(request);
            if (!restored) await input.acceptPage(page);
            diagnostics.push(...page.diagnostics);
            recognizedCount += 1;
        } catch (error) {
            throwIfAborted(signal);
            errors.push(`Page ${request.pageNumber}: ${errorMessage(error)}`);
        } finally {
            activePages.delete(request.pageNumber);
            processedCount += 1;
            input.onPageDone?.(request.pageNumber, [...activePages], processedCount);
        }
    };

    const lanes = await Promise.allSettled(Array.from(
        {length: Math.max(1, Math.min(input.lanes, queue.length))},
        async () => {
            for (let request = queue.shift(); request; request = queue.shift()) {
                throwIfAborted(signal);
                await runPage(request);
            }
        },
    ));
    const failed = lanes.find(lane => lane.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return {
        recognizedCount,
        errors,
        diagnostics,
    };
}

/** The writer's instructions for recognized pages, in page order; `source` indexes their page PDFs. */
export function buildOcrTextLayerInstructions(
    pages: readonly Omit<IOcrRecognizedPage, 'pdf'>[],
): IOcrTextLayerInstructions['pages'] {
    return pages.map((page, source) => ({
        pageNumber: page.pageNumber,
        source,
        wordGeometry: page.wordGeometry,
        ...(shouldNormalizeGreekMicroSign(page.languages) ? {normalizeGreekMicroSign: true} : {}),
        ...(page.wordEdits.length > 0 ? {wordEdits: page.wordEdits} : {}),
        ...(page.preprocessInverse ? {preprocessInverse: page.preprocessInverse} : {}),
    }));
}
