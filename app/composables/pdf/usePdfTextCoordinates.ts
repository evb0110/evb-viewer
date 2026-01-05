import type { PDFPageProxy } from 'pdfjs-dist';

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
        const textContent = await pdfPage.getTextContent();
        const pageHeight = pdfPage.view[3]; // view is [x0, y0, x1, y1]

        const items: IPdfTextItem[] = [];

        for (const item of textContent.items) {
            // Skip items without text or width/height
            if (!('str' in item) || !item.str) {
                continue;
            }

            // Extract text and transformation matrix
            const text = item.str.trim();
            if (!text) continue;

            // Transform matrix is [a, b, c, d, tx, ty]
            // tx, ty are the X, Y position in PDF coordinates
            const [a, b, c, d, tx, ty] = item.transform;

            // Calculate width/height from the item properties
            const width = item.width * a; // width scaled by x-scale
            const height = item.height * d; // height scaled by y-scale

            // Convert from PDF coordinates (bottom-left origin) to screen coordinates (top-left origin)
            const x = tx;
            const y = pageHeight - ty - height; // Flip Y coordinate

            items.push({
                text,
                x,
                y: Math.max(0, y), // Clamp negative Y to 0
                width: Math.max(0, width),
                height: Math.max(0, height),
            });
        }

        return items;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error('[usePdfTextCoordinates] Failed to extract text:', errMsg);
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
