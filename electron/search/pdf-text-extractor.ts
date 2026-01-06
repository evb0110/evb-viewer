import { spawnSync } from 'child_process';
import { createLogger } from '@electron/utils/logger';

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

    try {
        // Use pdftotext -layout to preserve some structure
        // Each page is separated by form feed character (0x0C)
        // Using spawnSync with args array to prevent shell injection
        const result = spawnSync('pdftotext', [
            '-layout',
            pdfPath,
            '-',
        ], { encoding: 'utf-8' });

        if (result.status !== 0) {
            throw new Error(result.stderr || `pdftotext failed with status ${result.status}`);
        }

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
        log.debug(`Failed to extract text: ${errMsg}`);
        throw new Error(`Failed to extract text from PDF: ${errMsg}`);
    }
}
