import { existsSync } from 'fs';
import {
    readFile,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import type { IOcrWord } from '@app/types/shared';
import { extractTextFromPdf } from '@electron/search/pdf-text-extractor';
import { createLogger } from '@electron/utils/logger';

export interface IPageIndex {
    pageNumber: number;
    text: string;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

export interface IPdfSearchIndex {
    pdfPath: string;
    createdAt: number;
    pages: IPageIndex[];
    pageCount?: number;
}

const log = createLogger('index-builder');

const STORE_WORD_BOXES = false;

interface IOcrIndexV2Manifest {
    version: number;
    createdAt: number;
    source: { pdfPath: string };
    pageCount: number;
    pageBox: string;
    ocr: {
        engine: string;
        languages: string[];
        renderDpi: number;
    };
    pages: Record<number, { path: string }>;
}

interface IOcrIndexV2Page {
    pageNumber: number;
    text: string;
}

/**
 * Load OCR v2 index text for all pages.
 * Returns a Map of pageNumber -> text, or null if no v2 index exists.
 */
async function loadOcrIndexText(pdfPath: string): Promise<Map<number, string> | null> {
    const ocrDir = `${pdfPath}.ocr`;
    const manifestPath = join(ocrDir, 'manifest.json');

    if (!existsSync(manifestPath)) {
        return null;
    }

    try {
        const manifestJson = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestJson) as IOcrIndexV2Manifest;

        if (manifest.version < 2) {
            log.debug(`OCR index version ${manifest.version} < 2, skipping`);
            return null;
        }

        const pageTexts = new Map<number, string>();

        for (const [
            pageNumStr,
            pageInfo,
        ] of Object.entries(manifest.pages)) {
            const pageNum = parseInt(pageNumStr, 10);
            const pagePath = join(ocrDir, pageInfo.path);

            if (existsSync(pagePath)) {
                const pageJson = await readFile(pagePath, 'utf-8');
                const pageData = JSON.parse(pageJson) as IOcrIndexV2Page;
                pageTexts.set(pageNum, pageData.text || '');
            }
        }

        log.debug(`Loaded OCR v2 index with ${pageTexts.size} pages from ${ocrDir}`);
        return pageTexts;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to load OCR v2 index: ${errMsg}`);
        return null;
    }
}

function getIndexPath(pdfPath: string) {
    return `${pdfPath}.index.json`;
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
        text?: string;
        pageWidth?: number;
        pageHeight?: number;
    }>,
    options: {pageCount?: number;} = {},
): Promise<IPdfSearchIndex> {
    log.debug(`Building search index for ${pdfPath}`);

    const expectedCount = options.pageCount;

    // Try OCR v2 index first - this is the preferred source for OCR'd PDFs
    // as it matches the text layer that PDF.js will display
    const ocrTexts = await loadOcrIndexText(pdfPath);
    if (ocrTexts && ocrTexts.size > 0) {
        log.debug(`Using OCR v2 index with ${ocrTexts.size} pages`);
        const pages: IPageIndex[] = [];
        for (const [
            pageNum,
            text,
        ] of ocrTexts) {
            pages.push({
                pageNumber: pageNum,
                text,
            });
        }
        pages.sort((a, b) => a.pageNumber - b.pageNumber);

        const index: IPdfSearchIndex = {
            pdfPath,
            createdAt: Date.now(),
            pages,
            pageCount: typeof expectedCount === 'number' && expectedCount > 0
                ? expectedCount
                : pages.length,
        };

        // Save index for future use
        const indexPath = getIndexPath(pdfPath);
        try {
            await writeFile(indexPath, JSON.stringify(index), 'utf-8');
            log.debug(`Saved OCR-based index to ${indexPath}`);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.debug(`Warning: Failed to save OCR-based index: ${errMsg}`);
        }

        return index;
    }

    // Fall back to existing index or pdftotext
    const pagesByNumber = new Map<number, IPageIndex>();
    const existing = await loadSearchIndex(pdfPath);

    if (existing?.pages?.length) {
        existing.pages.forEach((page) => {
            pagesByNumber.set(page.pageNumber, {
                pageNumber: page.pageNumber,
                text: page.text ?? '',
                pageWidth: page.pageWidth,
                pageHeight: page.pageHeight,
                words: STORE_WORD_BOXES ? page.words : undefined,
            });
        });
    }

    const needsPdfText = !existing
        || (typeof expectedCount === 'number' && expectedCount > 0 && pagesByNumber.size < expectedCount);

    if (needsPdfText) {
        try {
            log.debug(`Seeding index with pdftotext output (pageCount=${expectedCount ?? 'unknown'})`);
            const pageTexts = await extractTextFromPdf(pdfPath, { pageCount: expectedCount });
            pageTexts.forEach((pt) => {
                const entry = pagesByNumber.get(pt.pageNumber);
                if (!entry) {
                    pagesByNumber.set(pt.pageNumber, {
                        pageNumber: pt.pageNumber,
                        text: pt.text,
                        words: undefined,
                    });
                    return;
                }

                if (!entry.text && pt.text) {
                    entry.text = pt.text;
                }
            });
        } catch (pdfTextErr) {
            const errMsg = pdfTextErr instanceof Error ? pdfTextErr.message : String(pdfTextErr);
            log.debug(`Warning: Failed to seed index with pdftotext: ${errMsg}`);
        }
    }

    if (typeof expectedCount === 'number' && expectedCount > 0) {
        for (let pageNumber = 1; pageNumber <= expectedCount; pageNumber += 1) {
            if (!pagesByNumber.has(pageNumber)) {
                pagesByNumber.set(pageNumber, {
                    pageNumber,
                    text: '',
                    words: undefined,
                });
            }
        }
    }

    if (pageData?.length) {
        pageData.forEach((page) => {
            const textFromOcr = page.text?.trim() ?? '';
            const textFromWords = page.words.map(w => w.text).join(' ').trim();
            const text = textFromOcr || textFromWords;
            const previous = pagesByNumber.get(page.pageNumber);
            pagesByNumber.set(page.pageNumber, {
                pageNumber: page.pageNumber,
                text: text || previous?.text || '',
                pageWidth: page.pageWidth,
                pageHeight: page.pageHeight,
                words: STORE_WORD_BOXES ? page.words : undefined,
            });
        });
    }

    if (pagesByNumber.size === 0) {
        throw new Error('No pages available to build search index');
    }

    const pages: IPageIndex[] = Array.from(pagesByNumber.values()).sort((a, b) => a.pageNumber - b.pageNumber);

    const index: IPdfSearchIndex = {
        pdfPath,
        createdAt: Date.now(),
        pages,
        pageCount: typeof expectedCount === 'number' && expectedCount > 0 ? expectedCount : existing?.pageCount,
    };

    const indexPath = getIndexPath(pdfPath);
    log.debug(`Saving index to ${indexPath}`);

    try {
        await writeFile(indexPath, JSON.stringify(index), 'utf-8');
        log.debug(`Index saved successfully: ${indexPath}`);
        return index;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Failed to save index: ${errMsg}`);
        throw err;
    }
}

/**
 * Load a cached search index from disk
 */
export async function loadSearchIndex(pdfPath: string): Promise<IPdfSearchIndex | null> {
    const indexPath = getIndexPath(pdfPath);

    try {
        const content = await readFile(indexPath, 'utf-8');
        const index = JSON.parse(content) as IPdfSearchIndex;
        log.debug(`Loaded index from ${indexPath}`);
        return index;
    } catch {
        log.debug(`Index not found or invalid: ${indexPath}`);
        return null;
    }
}
