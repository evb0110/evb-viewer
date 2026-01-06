import type { PDFPageProxy } from 'pdfjs-dist';
import { BrowserLogger } from 'app/utils/browser-logger';

export interface IPdfTextItem {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Extract text items with their coordinates from a PDF page using PDF.js
 * This works for any PDF with a text layer (OCR'd PDFs, native PDFs, etc.)
 *
 * PDF uses bottom-left origin, but we convert to top-left origin (screen coordinates)
 */
export async function extractPageTextWithCoordinates(
    pdfPage: PDFPageProxy,
): Promise<IPdfTextItem[]> {
    try {
        BrowserLogger.debug('PDF-TEXT-COORDS', 'Starting text extraction from PDF page');

        const textContent = await pdfPage.getTextContent();
        const pageHeight = pdfPage.view[3]; // view is [x0, y0, x1, y1]

        BrowserLogger.debug('PDF-TEXT-COORDS', `Page view: ${pdfPage.view.join(', ')}, pageHeight=${pageHeight}`);
        BrowserLogger.debug('PDF-TEXT-COORDS', `Text content items count: ${textContent.items.length}`);

        const items: IPdfTextItem[] = [];
        let skippedCount = 0;

        for (let idx = 0; idx < textContent.items.length; idx++) {
            const item = textContent.items[idx];

            // Skip items without text or width/height
            if (!('str' in item) || !item.str) {
                skippedCount++;
                continue;
            }

            // Extract text and transformation matrix
            const text = item.str.trim();
            if (!text) {
                skippedCount++;
                continue;
            }

            // Transform matrix is [a, b, c, d, tx, ty]
            // tx, ty are the X, Y position in PDF coordinates
            const [a, b, c, d, tx, ty] = item.transform;

            // Calculate width/height from the item properties
            const width = item.width * a; // width scaled by x-scale
            const height = item.height * d; // height scaled by y-scale

            // Convert from PDF coordinates (bottom-left origin) to screen coordinates (top-left origin)
            const x = tx;
            const y = pageHeight - ty - height; // Flip Y coordinate

            const textItem = {
                text,
                x,
                y: Math.max(0, y), // Clamp negative Y to 0
                width: Math.max(0, width),
                height: Math.max(0, height),
            };

            items.push(textItem);

            // Log first 5 items in detail
            if (idx < 5) {
                BrowserLogger.debug('PDF-TEXT-COORDS', `Item ${idx}:`, {
                    text,
                    transform: [a, b, c, d, tx, ty],
                    width: item.width,
                    height: item.height,
                    computed: textItem,
                });
            }
        }

        BrowserLogger.info('PDF-TEXT-COORDS', `Extraction complete - extracted ${items.length} items, skipped ${skippedCount}`);

        // Log coordinate ranges to understand the space
        if (items.length > 0) {
            const xValues = items.map(i => i.x);
            const yValues = items.map(i => i.y);
            const widthValues = items.map(i => i.width);
            const heightValues = items.map(i => i.height);

            const xMin = Math.min(...xValues);
            const xMax = Math.max(...xValues);
            const yMin = Math.min(...yValues);
            const yMax = Math.max(...yValues);

            BrowserLogger.warn('PDF-TEXT-COORDS', `Coordinate RANGES (this tells us the space):`, {
                xRange: `${xMin.toFixed(1)} to ${xMax.toFixed(1)}`,
                yRange: `${yMin.toFixed(1)} to ${yMax.toFixed(1)}`,
                widthRange: `${Math.min(...widthValues).toFixed(1)} to ${Math.max(...widthValues).toFixed(1)}`,
                heightRange: `${Math.min(...heightValues).toFixed(1)} to ${Math.max(...heightValues).toFixed(1)}`,
                pageHeight,
                firstThreeItems: items.slice(0, 3).map(i => ({ text: i.text, x: i.x.toFixed(1), y: i.y.toFixed(1), w: i.width.toFixed(1), h: i.height.toFixed(1) })),
            });
        }

        BrowserLogger.debug('PDF-TEXT-COORDS', 'All extracted items:', items);

        return items;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        BrowserLogger.error('PDF-TEXT-COORDS', 'Failed to extract text', err);
        return [];
    }
}

/**
 * Find words in text items that match a search query
 * Returns the matching text items with their coordinates
 */
export function findMatchingWords(
    textItems: IPdfTextItem[],
    query: string,
): IPdfTextItem[] {
    const lowerQuery = query.toLowerCase();
    const matches: IPdfTextItem[] = [];

    for (const item of textItems) {
        if (item.text.toLowerCase().includes(lowerQuery)) {
            matches.push(item);
        }
    }

    return matches;
}
