import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain, app, BrowserWindow } from 'electron';
import { appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadSearchIndex, buildSearchIndex } from './index-builder';
import { extractTextFromPdf } from './pdf-text-extractor';

const LOG_FILE = join(app.getPath('temp'), 'search-debug.log');

function debugLog(msg: string, event?: IpcMainInvokeEvent) {
    const ts = new Date().toISOString();
    const logMsg = `[${ts}] [search-ipc] ${msg}`;
    appendFileSync(LOG_FILE, `${logMsg}\n`);

    // Forward to renderer console if event is available
    if (event) {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window) {
            window.webContents.send('debug:log', { source: 'search-ipc', message: msg, timestamp: ts });
        }
    }
}

interface IOcrWord {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface ISearchMatch {
    pageNumber: number;
    matchIndex: number;
    text: string;
    startOffset: number;
    endOffset: number;
    words: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

interface ISearchRequest {
    pdfPath: string;
    query: string;
}

/**
 * Search a PDF using cached index (for OCR'd PDFs) or pdftotext (for user PDFs)
 */
async function handlePdfSearch(
    event: IpcMainInvokeEvent,
    request: ISearchRequest,
): Promise<ISearchMatch[]> {
    const { pdfPath, query } = request;

    debugLog(`Search requested: pdfPath=${pdfPath}, query="${query}"`, event);

    if (!pdfPath || !existsSync(pdfPath)) {
        throw new Error(`PDF not found: ${pdfPath}`);
    }

    if (!query || query.trim().length === 0) {
        return [];
    }

    const normalizedQuery = query.trim();
    const lowerQuery = normalizedQuery.toLowerCase();

    try {
        // Try to load cached OCR index first
        let index = await loadSearchIndex(pdfPath);
        let isOcrIndex = !!index;

        if (!index) {
            debugLog(`No index found for ${pdfPath}, extracting text with pdftotext`, event);
            // For non-OCR PDFs, extract text and build temporary index
            const pageTexts = await extractTextFromPdf(pdfPath);

            // Build minimal index from extracted text
            index = {
                pdfPath,
                createdAt: Date.now(),
                pages: pageTexts.map(pt => ({
                    pageNumber: pt.pageNumber,
                    text: pt.text,
                    words: [], // No word boxes for non-OCR PDFs
                })),
            };
        }

        debugLog(`Searching ${index.pages.length} pages for "${query}", isOcrIndex=${isOcrIndex}`, event);

        // DEBUG: Log page dimensions from stored index
        if (index.pages.length > 0) {
            const firstPage = index.pages[0];
            debugLog(`DEBUG: First page dimensions: width=${firstPage.pageWidth}, height=${firstPage.pageHeight}, words=${firstPage.words?.length || 0}`, event);
        }

        const results: ISearchMatch[] = [];
        let globalMatchIndex = 0;

        for (const page of index.pages) {
            const lowerPageText = page.text.toLowerCase();
            let position = 0;
            let matchIndexOnPage = 0;

            while ((position = lowerPageText.indexOf(lowerQuery, position)) !== -1) {
                const startOffset = position;
                const endOffset = position + normalizedQuery.length;

                // Find words that overlap with this match (if available)
                const matchedWords = page.words.filter(word => {
                    // Simple overlap check: word starts before match ends and word ends after match starts
                    const wordStart = word.text.toLowerCase();
                    const wordIndex = lowerPageText.indexOf(wordStart);
                    return wordIndex !== -1 && wordIndex < endOffset && wordIndex + wordStart.length > startOffset;
                });

                results.push({
                    pageNumber: page.pageNumber,
                    matchIndex: globalMatchIndex,
                    text: page.text,
                    startOffset,
                    endOffset,
                    words: matchedWords.length > 0 ? matchedWords : [],
                    pageWidth: page.pageWidth,
                    pageHeight: page.pageHeight,
                });

                globalMatchIndex++;
                matchIndexOnPage++;
                position += normalizedQuery.length;
            }

            if (matchIndexOnPage > 0) {
                debugLog(`Found ${matchIndexOnPage} matches on page ${page.pageNumber}`, event);
            }
        }

        debugLog(`Total matches found: ${results.length}`, event);
        return results;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`Search error: ${errMsg}`, event);
        throw new Error(`Search failed: ${errMsg}`);
    }
}

export function registerSearchHandlers() {
    ipcMain.handle('pdf:search', handlePdfSearch);
}

/**
 * Public function to build index during OCR completion
 */
export async function saveOcrIndex(
    pdfPath: string,
    pageData: Array<{
        pageNumber: number;
        words: IOcrWord[];
    }>,
): Promise<void> {
    try {
        await buildSearchIndex(pdfPath, pageData);
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`Failed to save OCR index: ${errMsg}`);
        // Non-blocking - don't fail OCR if index save fails
    }
}
