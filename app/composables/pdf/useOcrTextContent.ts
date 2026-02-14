import type { PageViewport } from 'pdfjs-dist';
import type { IPdfRawDims } from '@app/types/pdf';
import { getElectronAPI } from '@app/utils/electron';
import type { IOcrWord } from '@app/types/shared';
import { BrowserLogger } from '@app/utils/browser-logger';

const RTL_OCR_LANGUAGES = new Set([
    'heb',
    'syr',
]);

/**
 * OCR index v2 manifest schema
 */
interface IOcrManifest {
    version: number;
    createdAt: number;
    source: { pdfPath: string };
    pageCount: number;
    pageBox: 'crop';
    ocr: {
        engine: 'tesseract';
        languages: string[];
        renderDpi: number;
    };
    pages: Record<number, { path: string }>;
}

/**
 * OCR index v2 per-page data schema
 */
interface IOcrPageData {
    pageNumber: number;
    rotation: 0 | 90 | 180 | 270;
    render: {
        dpi: number;
        imagePx: {
            w: number;
            h: number;
        };
    };
    text: string;
    words: IOcrWord[];
}

/**
 * PDF.js TextItem interface for TextLayer rendering
 */
interface ITextItem {
    str: string;
    dir: string;
    transform: number[]; // [a, b, c, d, tx, ty]
    width: number;
    height: number;
    fontName: string;
    hasEOL: boolean;
}

/**
 * PDF.js TextContent interface for TextLayer rendering
 */
interface ITextContent {
    items: ITextItem[];
    styles: Record<string, {
        fontFamily: string;
        ascent: number;
        descent: number;
        vertical: boolean;
    }>;
    lang: string | null;
}

/**
 * Composable for loading OCR index data and converting it to PDF.js TextContent format.
 *
 * This enables the PDF viewer to use OCR-derived text positioning for text selection
 * and search highlighting, ensuring accurate alignment between visual content and
 * selectable/searchable text.
 */
export const useOcrTextContent = () => {
    const manifestCache = new Map<string, IOcrManifest | null>();
    const pageCache = new Map<string, IOcrPageData>();

    let cachedAscentRatio: number | null = null;

    /**
     * Computes the font ascent ratio for baseline alignment.
     * Uses canvas text metrics to determine what percentage of the font
     * height is above the baseline (the ascent).
     */
    function getAscentRatio(): number {
        if (cachedAscentRatio !== null) {
            return cachedAscentRatio;
        }

        if (typeof document === 'undefined') {
            return 0.8; // Server-side fallback
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return 0.8; // Fallback if canvas not available
        }

        ctx.font = '100px sans-serif';
        const metrics = ctx.measureText('x');
        const ascent = metrics.actualBoundingBoxAscent ?? 80;
        const descent = metrics.actualBoundingBoxDescent ?? 20;
        cachedAscentRatio = ascent / (ascent + descent);
        return cachedAscentRatio;
    }

    /**
     * Loads and caches the OCR manifest for a working copy path.
     */
    async function loadManifest(workingCopyPath: string): Promise<IOcrManifest | null> {
        const cacheKey = workingCopyPath;
        if (manifestCache.has(cacheKey)) {
            return manifestCache.get(cacheKey) ?? null;
        }

        const api = getElectronAPI();
        const manifestPath = `${workingCopyPath}.ocr/manifest.json`;

        try {
            const exists = await api.fileExists(manifestPath);
            if (!exists) {
                manifestCache.set(cacheKey, null);
                return null;
            }

            const json = await api.readTextFile(manifestPath);
            const manifest = JSON.parse(json) as IOcrManifest;
            manifestCache.set(cacheKey, manifest);
            return manifest;
        } catch (err) {
            BrowserLogger.warn('ocr', 'Failed to load manifest', err);
            manifestCache.set(cacheKey, null);
            return null;
        }
    }

    /**
     * Loads and caches per-page OCR data.
     */
    async function loadPageData(
        workingCopyPath: string,
        pageNumber: number,
        manifest: IOcrManifest,
    ): Promise<IOcrPageData | null> {
        const cacheKey = `${workingCopyPath}:${pageNumber}`;
        if (pageCache.has(cacheKey)) {
            return pageCache.get(cacheKey) ?? null;
        }

        const pageMapping = manifest.pages[pageNumber];
        if (!pageMapping) {
            return null;
        }

        const api = getElectronAPI();
        const pagePath = `${workingCopyPath}.ocr/${pageMapping.path}`;

        try {
            const json = await api.readTextFile(pagePath);
            const pageData = JSON.parse(json) as IOcrPageData;
            pageCache.set(cacheKey, pageData);
            return pageData;
        } catch (err) {
            BrowserLogger.warn('ocr', `Failed to load page ${pageNumber}`, err);
            return null;
        }
    }

    /**
     * Transforms an OCR word (in pixel coordinates) to a PDF.js TextItem
     * for use in the TextLayer.
     *
     * Coordinate conversion:
     * - OCR words are in raster pixel coordinates (origin at top-left, y increases downward)
     * - PDF user space has origin at bottom-left, y increases upward
     * - We scale from pixel coords to PDF user space using the image dimensions and viewport
     *
     * Baseline alignment:
     * - PDF.js TextLayer positions text spans using baseline coordinates
     * - We compute the baseline Y position using the font ascent ratio
     */
    function transformWordToTextItem(
        word: IOcrWord,
        ocrPage: IOcrPageData,
        viewport: PageViewport,
        isLastInLine: boolean,
        textDir: string,
    ): ITextItem {
        const { render } = ocrPage;
        const ascentRatio = getAscentRatio();

        // Get raw page dimensions from viewport
        // PDF.js viewport includes a rawDims property with the original page size
        const rawDims = (viewport.rawDims as IPdfRawDims | undefined) ?? {
            pageWidth: viewport.width / viewport.scale,
            pageHeight: viewport.height / viewport.scale,
        };

        // Scale from OCR pixels to PDF user space
        const sx = rawDims.pageWidth / render.imagePx.w;
        const sy = rawDims.pageHeight / render.imagePx.h;

        // Transform coordinates
        // OCR word: x, y are top-left corner in pixel coords (y down)
        // PDF user space: origin at bottom-left, y up
        const pdfX = word.x * sx;
        const pdfW = word.width * sx;
        const pdfH = word.height * sy;

        // Flip Y: pageHeight - (top + height) gives us the bottom Y in PDF coords
        // Then we add height to get the top Y in PDF coords
        const pdfBottomY = rawDims.pageHeight - (word.y + word.height) * sy;

        // Compute baseline Y for PDF.js TextLayer alignment
        // baselineY should place the text so that the top of the glyph box aligns
        // with the OCR word's top position
        // boxTopY = pdfBottomY + pdfH
        // baseline = boxTopY - fontAscent = pdfBottomY + pdfH - (pdfH * ascentRatio)
        //          = pdfBottomY + pdfH * (1 - ascentRatio)
        const baselineY = pdfBottomY + pdfH * (1 - ascentRatio);

        // Transform matrix: [scaleX, skewX, skewY, scaleY, translateX, translateY]
        // For horizontal text, scaleX and scaleY are the font size
        // PDF.js uses transform[0] and transform[3] to compute font height
        return {
            str: word.text + ' ', // Add trailing space for copy/paste word separation
            dir: textDir,
            transform: [
                pdfH,
                0,
                0,
                pdfH,
                pdfX,
                baselineY,
            ],
            width: pdfW,
            height: pdfH,
            fontName: 'ocr-sans',
            hasEOL: isLastInLine,
        };
    }

    /**
     * Determines if a word is the last in its line based on Y position gap.
     * A significant Y gap to the next word indicates a line break.
     */
    function isLastWordInLine(
        words: IOcrWord[],
        idx: number,
    ): boolean {
        if (idx === words.length - 1) {
            return true;
        }

        const currentWord = words[idx]!;
        const nextWord = words[idx + 1]!;

        // If the next word's Y position differs significantly from the current,
        // we're at a line break. Use half the word height as threshold.
        return Math.abs(nextWord.y - currentWord.y) > currentWord.height * 0.5;
    }

    /**
     * Gets OCR-derived TextContent for a page, suitable for PDF.js TextLayer.
     *
     * @param workingCopyPath - Path to the PDF working copy
     * @param pageNumber - 1-based page number
     * @param viewport - PDF.js viewport for coordinate transformation
     * @returns TextContent object or null if no OCR data available
     */
    async function getOcrTextContent(
        workingCopyPath: string,
        pageNumber: number,
        viewport: PageViewport,
    ): Promise<ITextContent | null> {
        const manifest = await loadManifest(workingCopyPath);
        if (!manifest || manifest.version < 2) {
            return null;
        }

        const isRtl = manifest.ocr.languages.some(lang => RTL_OCR_LANGUAGES.has(lang));
        const textDir = isRtl ? 'rtl' : 'ltr';

        const pageData = await loadPageData(workingCopyPath, pageNumber, manifest);
        if (!pageData || !pageData.words || pageData.words.length === 0) {
            return null;
        }

        const ascentRatio = getAscentRatio();

        // Convert OCR words to TextItems
        const items: ITextItem[] = pageData.words.map((word, idx) =>
            transformWordToTextItem(
                word,
                pageData,
                viewport,
                isLastWordInLine(pageData.words, idx),
                textDir,
            ),
        );

        return {
            items,
            styles: {'ocr-sans': {
                fontFamily: 'sans-serif',
                ascent: ascentRatio,
                descent: 1 - ascentRatio,
                vertical: false,
            }},
            lang: manifest.ocr.languages[0] ?? null,
        };
    }

    /**
     * Checks if OCR data is available for a document.
     *
     * @param workingCopyPath - Path to the PDF working copy
     * @returns True if OCR manifest exists and is version 2+
     */
    async function hasOcrData(workingCopyPath: string): Promise<boolean> {
        const manifest = await loadManifest(workingCopyPath);
        return manifest !== null && manifest.version >= 2;
    }

    /**
     * Checks if a specific page has OCR data.
     *
     * @param workingCopyPath - Path to the PDF working copy
     * @param pageNumber - 1-based page number
     * @returns True if the page is in the OCR manifest
     */
    async function hasPageOcrData(
        workingCopyPath: string,
        pageNumber: number,
    ): Promise<boolean> {
        const manifest = await loadManifest(workingCopyPath);
        if (!manifest || manifest.version < 2) {
            return false;
        }
        return pageNumber in manifest.pages;
    }

    /**
     * Clears cached OCR data for a working copy path or all cached data.
     *
     * @param workingCopyPath - Optional path to clear; clears all if omitted
     */
    function clearCache(workingCopyPath?: string): void {
        if (workingCopyPath) {
            manifestCache.delete(workingCopyPath);
            // Clear page cache entries for this path
            for (const key of pageCache.keys()) {
                if (key.startsWith(`${workingCopyPath}:`)) {
                    pageCache.delete(key);
                }
            }
        } else {
            manifestCache.clear();
            pageCache.clear();
        }
    }

    return {
        getOcrTextContent,
        loadManifest,
        hasOcrData,
        hasPageOcrData,
        clearCache,
    };
};
