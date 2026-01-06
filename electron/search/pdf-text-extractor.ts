import { execSync } from 'child_process';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

const LOG_FILE = join(app.getPath('temp'), 'search-debug.log');

function debugLog(msg: string) {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [pdf-text-extractor] ${msg}\n`);
}

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
    debugLog(`Extracting text from PDF: ${pdfPath}`);

    try {
        // Use pdftotext -layout to preserve some structure
        // Each page is separated by form feed character (0x0C)
        const output = execSync(`pdftotext -layout "${pdfPath}" -`, {encoding: 'utf-8'});

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

        debugLog(`Extracted ${pages.length} page segments from PDF`);

        const pageTexts: IPageText[] = pages.map((text, index) => ({
            pageNumber: index + 1,
            text: text.trim(),
        }));

        return pageTexts;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`Failed to extract text: ${errMsg}`);
        throw new Error(`Failed to extract text from PDF: ${errMsg}`);
    }
}
