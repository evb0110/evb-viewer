import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
    buildOcrTextLayerInstructions,
    type IOcrRecognizedPage,
} from '@ocr-core/recognizeOcrPages';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';

/**
 * One pdf-page-ops call writes the invisible text of every recognized page as
 * one incremental revision of the source. The writer maps each Tesseract page
 * into its target page view and removes previous OCR text from that page.
 */
export async function writeSearchablePdf(input: {
    pdfPageOpsBinary: string;
    qpdfBinary: string;
    sourcePdfPath: string;
    pages: AsyncIterable<{
        pdfPath: string;
        page: Omit<IOcrRecognizedPage, 'pdf'>;
    }>;
    tempDir: string;
    sessionId: string;
    signal: AbortSignal;
}) {
    const records: Omit<IOcrRecognizedPage, 'pdf'>[] = [];
    const pdfPaths: string[] = [];
    for await (const checkpoint of input.pages) {
        records.push(checkpoint.page);
        pdfPaths.push(checkpoint.pdfPath);
    }
    if (records.length === 0) {
        throw new Error('No recognized OCR pages were available to write');
    }
    const instructionsPath = join(input.tempDir, `${input.sessionId}-text-layer.json`);
    const outputPath = join(input.tempDir, `${input.sessionId}-merged.pdf`);
    await writeFile(instructionsPath, JSON.stringify({pages: buildOcrTextLayerInstructions(records).map(page => ({
        ...page,
        source: pdfPaths[page.source],
    }))}));
    await runNativeToolCommand(input.pdfPageOpsBinary, [
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
