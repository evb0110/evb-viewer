import {
    mkdir,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import type {IOcrSearchablePdfOptions} from '@contracts/electronApiOcr';
import {requirePageNumber} from '@contracts/pageNumbers';
import {getOcrScanCleanupMode} from '@contracts/scan-cleanup/ocrPreprocessing';
import {
    recognizeOcrPages,
    type IOcrRecognizedPage,
} from '@ocr-core/recognizeOcrPages';
import type {
    IOcrEngineRequest,
    IOcrEngineResult,
} from '@ocr-core/tesseractEngine';
import {prepareOcrPageRaster} from '@electron/features/ocr/pipeline/tryPreprocessOcrImage';

export interface IOcrProductionQualityCase {
    dpi: number;
    inputPath: string;
    language: string;
    outputDirectory: string;
    recognitionOptions: IOcrSearchablePdfOptions;
    scanCleanupBinary?: string;
    tessdataDirectory: string;
    runEngine: (request: IOcrEngineRequest, signal: AbortSignal) => Promise<IOcrEngineResult>;
}

/**
 * Quality-corpus adapter for the production OCR path: the shared page job on
 * an already-rendered page, so Poppler rasterization is the only production
 * stage outside this gate. Preprocessing follows the recognition options, as
 * in the app. The caller owns the returned pdfPath; the corpus runner removes
 * it with the per-run output directory.
 */
export async function runProductionOcrQualityCase(testCase: IOcrProductionQualityCase) {
    const signal = new AbortController().signal;
    const logMessages: string[] = [];
    const cleanupMode = testCase.recognitionOptions.preprocessingMode === undefined
        ? undefined
        : getOcrScanCleanupMode(testCase.recognitionOptions.preprocessingMode);
    await mkdir(testCase.outputDirectory, {recursive: true});
    let recognized: IOcrRecognizedPage | undefined;
    const result = await recognizeOcrPages({
        pages: [{
            pageNumber: requirePageNumber(1),
            languages: testCase.language.split('+'),
        }],
        extractionDpi: testCase.dpi,
        sourceDpiByPage: new Map(),
        options: testCase.recognitionOptions,
        lanes: 1,
        signal,
        renderPage: (pageNumber, dpi) => prepareOcrPageRaster({
            renderedPath: testCase.inputPath,
            pageNumber,
            dpi,
            cleanupMode,
            scanCleanupBinary: testCase.scanCleanupBinary,
            log: (level, message) => logMessages.push(`${level}: ${message}`),
            signal,
        }),
        runEngine: testCase.runEngine,
        prepareEarlyPrintModels: async () => {},
        readModel: code => readFile(join(testCase.tessdataDirectory, `${code}.traineddata`)),
        acceptPage: async (page) => {
            recognized = page;
        },
    });
    if (!recognized) {
        throw new Error(result.errors.items.join('; ') || 'Production OCR returned no page');
    }
    const pdfPath = join(testCase.outputDirectory, 'quality-ocr.pdf');
    await writeFile(pdfPath, recognized.pdf);
    const {words} = recognized.wordGeometry;
    return {
        diagnostics: recognized.diagnostics,
        logMessages,
        pdfPath,
        preprocessing: testCase.recognitionOptions.preprocessingMode !== 'clean'
            ? 'off'
            : recognized.diagnostics.some(diagnostic => diagnostic.code.startsWith('OCR_PREPROCESSING'))
                ? 'raw-fallback'
                : 'clean-applied',
        text: recognized.text,
        wordCount: words.length,
        words,
        imageWidth: recognized.wordGeometry.rasterWidthPx,
        imageHeight: recognized.wordGeometry.rasterHeightPx,
    };
}
