import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {IOcrCheckpointPageResult} from '@electron/features/ocr/worker/ocrPageSelectionStream';
import {runOcrCommand} from '@electron/features/ocr/worker/runOcrCommand';
import {getErrorMessage} from '@electron/utils/error';

/**
 * One pdf-page-ops call writes the invisible text of every recognized page as
 * one incremental revision of the source. The writer maps each Tesseract page
 * into its target page view and removes previous OCR text from that page.
 */
export async function writeSearchablePdf(input: {
    pdfPageOpsBinary: string;
    qpdfBinary: string;
    sourcePdfPath: string;
    pages: AsyncIterable<IOcrCheckpointPageResult>;
    tempDir: string;
    sessionId: string;
    trackTempFile: (path: string) => string;
    signal: AbortSignal;
}) {
    const instructions = [];
    for await (const page of input.pages) {
        instructions.push({
            pageNumber: page.pageData.pageNumber,
            sourcePath: page.pdfPath,
            normalizeGreekMicroSign: page.normalizeGreekMicroSign,
            ...(page.preprocessInverse === undefined ? {} : {preprocessInverse: {
                rasterWidthPx: page.pageData.imageWidth,
                rasterHeightPx: page.pageData.imageHeight,
                matrix: page.preprocessInverse,
            }}),
        });
    }
    if (instructions.length === 0) {
        throw new Error('No recognized OCR pages were available to write');
    }
    const instructionsPath = input.trackTempFile(join(input.tempDir, `${input.sessionId}-text-layer.json`));
    const outputPath = input.trackTempFile(join(input.tempDir, `${input.sessionId}-merged.pdf`));
    await writeFile(instructionsPath, JSON.stringify({pages: instructions}));
    await runOcrCommand(input.pdfPageOpsBinary, [
        'ocr-text-layer',
        '--input',
        input.sourcePdfPath,
        '--output',
        outputPath,
        '--instructions-file',
        instructionsPath,
        '--qpdf',
        input.qpdfBinary,
    ], {
        commandLabel: 'evb-pdf-page-ops(ocr-text-layer)',
        signal: input.signal,
    });
    return outputPath;
}

export async function readPdfPageCount(
    qpdfBinary: string,
    pdfPath: string,
    fallback: number,
    signal: AbortSignal,
) {
    try {
        const result = await runOcrCommand(qpdfBinary, [
            '--show-npages',
            pdfPath,
        ], {
            commandLabel: 'qpdf(show-npages)',
            signal,
        });
        const parsed = Number.parseInt(result.stdout.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return {
                pageCount: parsed,
                warnings: [],
            };
        }
        return {
            pageCount: fallback,
            warnings: [`qpdf page-count returned no usable page count; using OCR page fallback ${fallback}`],
        };
    } catch (error) {
        if (signal.aborted) throw error;
        return {
            pageCount: fallback,
            warnings: [`qpdf page-count failed; using OCR page fallback ${fallback}: ${getErrorMessage(error)}`],
        };
    }
}
