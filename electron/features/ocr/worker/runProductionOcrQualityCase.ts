import {
    copyFile,
    mkdir,
    stat,
} from 'node:fs/promises';
import {join} from 'node:path';
import type {
    IOcrDiagnostic,
    IOcrSearchablePdfOptions,
} from '@contracts/electronApiOcr';
import {tryPreprocessOcrImage} from '@electron/features/ocr/worker/tryPreprocessOcrImage';
import {
    getPngDimensionsFromFile,
    runOcrFileBased,
} from '@electron/features/ocr/worker/tesseractRunner';

export interface IOcrProductionQualityCase {
    dpi: number;
    inputPath: string;
    language: string;
    outputDirectory: string;
    recognitionOptions: IOcrSearchablePdfOptions;
    scanCleanupBinary?: string;
    tessdataDirectory: string;
    tesseractBinary: string;
}

/**
 * Worker-owned quality-corpus adapter for the production OCR path.
 * The corpus supplies an already-rendered page, so Poppler rasterization is the
 * only production stage intentionally outside this gate. Clean preprocessing runs
 * only when the recognition options request it, as the popup does for Poor scan.
 * The caller owns the returned pdfPath and must remove it after inspection;
 * the corpus runner does so by removing the per-run output directory.
 */
export async function runProductionOcrQualityCase(testCase: IOcrProductionQualityCase) {
    const abortController = new AbortController();
    const diagnostics: IOcrDiagnostic[] = [];
    await mkdir(testCase.outputDirectory, {recursive: true});
    const stagedInputPath = join(testCase.outputDirectory, 'quality-input.png');
    const cleanedPath = join(testCase.outputDirectory, 'quality-clean.png');
    await copyFile(testCase.inputPath, stagedInputPath);
    const logMessages: string[] = [];
    const processedPath = testCase.recognitionOptions.preprocessingMode === 'clean'
        ? await preprocessPreservingGeometry(testCase, stagedInputPath, cleanedPath, logMessages, diagnostics, abortController.signal)
        : stagedInputPath;
    const dimensions = await getPngDimensionsFromFile(processedPath);
    if (!dimensions) throw new Error('Production OCR quality input is not a valid PNG');
    const result = await runOcrFileBased(
        processedPath,
        testCase.language.split('+'),
        dimensions.width,
        dimensions.height,
        testCase.dpi,
        testCase.tesseractBinary,
        testCase.tessdataDirectory,
        1,
        abortController.signal,
        testCase.recognitionOptions,
    );
    if (!result.success || !result.pageData || !result.pdfPath) {
        throw new Error(result.error ?? 'Production OCR wrapper returned an incomplete result');
    }
    if ((await stat(result.pdfPath)).size <= 0) {
        throw new Error('Production OCR wrapper returned an empty searchable PDF');
    }
    return {
        diagnostics,
        logMessages,
        pdfPath: result.pdfPath,
        preprocessing: describePreprocessing(testCase.recognitionOptions, processedPath, stagedInputPath),
        text: result.pageData.text,
        wordCount: result.pageData.words.length,
        words: result.pageData.words,
        imageWidth: result.pageData.imageWidth,
        imageHeight: result.pageData.imageHeight,
    };
}

async function preprocessPreservingGeometry(
    testCase: IOcrProductionQualityCase,
    stagedInputPath: string,
    cleanedPath: string,
    logMessages: string[],
    diagnostics: IOcrDiagnostic[],
    signal: AbortSignal,
) {
    const candidate = await tryPreprocessOcrImage(
        stagedInputPath,
        cleanedPath,
        (level, message) => logMessages.push(`${level}: ${message}`),
        signal,
        diagnostic => diagnostics.push(diagnostic),
        testCase.scanCleanupBinary,
        `${cleanedPath}.json`,
        testCase.dpi,
    );
    const sourceDimensions = await getPngDimensionsFromFile(stagedInputPath);
    const candidateDimensions = await getPngDimensionsFromFile(candidate.path);
    const preservesGeometry = sourceDimensions !== null
        && candidateDimensions?.width === sourceDimensions.width
        && candidateDimensions.height === sourceDimensions.height;
    return preservesGeometry ? candidate.path : stagedInputPath;
}

function describePreprocessing(
    recognitionOptions: IOcrSearchablePdfOptions,
    processedPath: string,
    stagedInputPath: string,
) {
    if (recognitionOptions.preprocessingMode !== 'clean') {
        return 'off';
    }
    return processedPath === stagedInputPath ? 'raw-fallback' : 'clean-applied';
}
