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

/**
 * Extract all text from a PDF using pdftotext command
 * Returns text organized by page
 */
export async function extractTextFromPdf(pdfPath: string): Promise<IPageText[]> {
    debugLog(`Extracting text from PDF: ${pdfPath}`);

    try {
        // Use pdftotext -layout to preserve some structure
        // Each page is separated by form feed character (0x0C)
        const output = execSync(`pdftotext -layout "${pdfPath}" -`, {
            encoding: 'utf-8',
        });

        // Split by form feed character (page separator)
        const pages = output.split('\f');
        debugLog(`Extracted ${pages.length} pages from PDF`);

        const pageTexts: IPageText[] = pages
            .map((text, index) => ({
                pageNumber: index + 1,
                text: text.trim(),
            }))
            .filter(p => p.text.length > 0);

        debugLog(`Filtered to ${pageTexts.length} pages with text`);
        return pageTexts;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`Failed to extract text: ${errMsg}`);
        throw new Error(`Failed to extract text from PDF: ${errMsg}`);
    }
}
