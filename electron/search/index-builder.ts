import { appendFileSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

interface IOcrWord {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface IPageIndex {
    pageNumber: number;
    text: string;
    words: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

interface IPdfSearchIndex {
    pdfPath: string;
    createdAt: number;
    pages: IPageIndex[];
}

const LOG_FILE = join(app.getPath('temp'), 'search-debug.log');

function debugLog(msg: string) {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [index-builder] ${msg}\n`);
}

/**
 * Build and save a search index from OCR page data
 * Index is saved as {pdfPath}.index.json for quick access on future searches
 */
export async function buildSearchIndex(
    pdfPath: string,
    pageData: Array<{
        pageNumber: number;
        words: IOcrWord[];
        pageWidth?: number;
        pageHeight?: number;
    }>,
): Promise<string> {
    debugLog(`Building search index for ${pdfPath}`);

    if (!pageData || pageData.length === 0) {
        throw new Error('No page data provided for index building');
    }

    // Build index structure
    const pages: IPageIndex[] = pageData.map(page => ({
        pageNumber: page.pageNumber,
        text: page.words.map(w => w.text).join(' '),
        words: page.words,
        pageWidth: page.pageWidth,
        pageHeight: page.pageHeight,
    }));

    const index: IPdfSearchIndex = {
        pdfPath,
        createdAt: Date.now(),
        pages,
    };

    // Save index file alongside PDF
    const indexPath = `${pdfPath}.index.json`;
    debugLog(`Saving index to ${indexPath}`);

    try {
        writeFileSync(indexPath, JSON.stringify(index, null, 2));
        debugLog(`Index saved successfully: ${indexPath}`);
        return indexPath;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`Failed to save index: ${errMsg}`);
        throw err;
    }
}

/**
 * Load a cached search index from disk
 */
export async function loadSearchIndex(pdfPath: string): Promise<IPdfSearchIndex | null> {
    const indexPath = `${pdfPath}.index.json`;

    try {
        const content = readFileSync(indexPath, 'utf-8');
        const index = JSON.parse(content) as IPdfSearchIndex;
        debugLog(`Loaded index from ${indexPath}`);
        return index;
    } catch (err) {
        debugLog(`Index not found or invalid: ${indexPath}`);
        return null;
    }
}
