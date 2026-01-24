import { existsSync } from 'fs';
import { createLogger } from '@electron/utils/logger';
import { runCommand } from '@electron/utils/exec';
import { getOcrToolPaths } from '../ocr/paths';

const log = createLogger('pdf-text-extractor');

interface IPageText {
    pageNumber: number;
    text: string;
}

interface IExtractTextOptions {pageCount?: number;}

/**
 * Extract all text from a PDF using pdftotext command
 * Returns text organized by page
 */
export async function extractTextFromPdf(
    pdfPath: string,
    options: IExtractTextOptions = {},
): Promise<IPageText[]> {
    log.debug(`Extracting text from PDF: ${pdfPath}`);

    const { pdftotext } = getOcrToolPaths();
    log.debug(`Using pdftotext at: ${pdftotext}`);

    // Check if the resolved path exists (if it's an absolute path)
    const isAbsolutePath = pdftotext.includes('/') || pdftotext.includes('\\');
    if (isAbsolutePath && !existsSync(pdftotext)) {
        throw new Error(
            `pdftotext binary not found at: ${pdftotext}. ` +
            'Ensure Poppler is bundled in resources/poppler/ or installed system-wide.',
        );
    }

    try {
        // Use pdftotext -layout to preserve some structure
        // Each page is separated by form feed character (0x0C)
        const result = await runCommand(pdftotext, [
            '-layout',
            pdfPath,
            '-',
        ]);

        const output = result.stdout ?? '';

        // Split by form feed character (page separator)
        let pages = output.split('\f');

        const expectedCount = options.pageCount;
        if (typeof expectedCount === 'number' && expectedCount > 0) {
            if (pages.length < expectedCount) {
                pages = pages.concat(Array.from({ length: expectedCount - pages.length }, () => ''));
            } else if (pages.length > expectedCount) {
                pages = pages.slice(0, expectedCount);
            }
        } else if (pages.length > 1 && pages.at(-1)?.trim() === '') {
            // Some pdftotext versions append a trailing form-feed, leaving an empty segment at the end.
            pages = pages.slice(0, -1);
        }

        log.debug(`Extracted ${pages.length} page segments from PDF`);

        const pageTexts: IPageText[] = pages.map((text, index) => ({
            pageNumber: index + 1,
            text: text.trim(),
        }));

        return pageTexts;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to extract text using ${pdftotext}: ${errMsg}`);

        // Provide actionable error message
        const isNotFound = errMsg.includes('ENOENT') || errMsg.includes('not found');
        if (isNotFound) {
            throw new Error(
                `pdftotext command failed - binary not found or not executable at: ${pdftotext}. ` +
                'Ensure Poppler is bundled in resources/poppler/ or installed system-wide.',
            );
        }

        throw new Error(`Failed to extract text from PDF: ${errMsg}`);
    }
}
