import {
    readFile,
    writeFile,
} from 'fs/promises';
import type { IOcrWord } from 'app/types/shared';
import { extractTextFromPdf } from '@electron/search/pdf-text-extractor';
import { createLogger } from '@electron/utils/logger';

export type { IOcrWord } from 'app/types/shared';

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
