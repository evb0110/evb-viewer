import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import {
    PDFDocument,
    rgb,
    StandardFonts,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { IOcrWord } from '@app/types/shared';
import { createLogger } from '@electron/utils/logger';

const log = createLogger('pdf-text-layer');

// Unicode font paths (macOS system fonts that support Arabic)
const UNICODE_FONT_PATHS = [
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/SFNS.ttf',
];

// Cache the font data to avoid re-reading for each page
let cachedFontData: Uint8Array | null = null;

async function loadUnicodeFont(): Promise<Uint8Array | null> {
    if (cachedFontData) {
        return cachedFontData;
    }

    for (const fontPath of UNICODE_FONT_PATHS) {
        if (existsSync(fontPath)) {
            try {
                log.debug(`Loading Unicode font from: ${fontPath}`);
                cachedFontData = await readFile(fontPath);
                log.debug(`Loaded Unicode font: ${cachedFontData.length} bytes`);
                return cachedFontData;
            } catch (err) {
                log.debug(`Failed to load font from ${fontPath}: ${err}`);
            }
        }
    }
    log.debug('No Unicode font found, will use fallback');
    return null;
}

/**
 * Check if text contains non-Latin characters that require Unicode font
 */
function requiresUnicodeFont(text: string): boolean {
    for (const char of text) {
        const code = char.charCodeAt(0);
        if (code > 255) {
            return true;
        }
    }
    return false;
}

/**
 * Creates a searchable PDF page with explicit spaces between words.
 *
 * CRITICAL: This function handles DPI conversion properly:
 * - Input: Image dimensions and OCR coordinates at extraction DPI (e.g., 150)
 * - Output: PDF with page size in points (72 DPI) and properly scaled coordinates
 *
 * @param imageBuffer - The page image (PNG or JPEG)
 * @param words - OCR words with coordinates in IMAGE PIXELS (at extractionDpi)
 * @param imageWidthPixels - Image width in pixels at extractionDpi
 * @param imageHeightPixels - Image height in pixels at extractionDpi
 * @param extractionDpi - DPI used when extracting the image (default 150)
 */
export async function createSearchablePdfWithSpaces(
    imageBuffer: Buffer,
    words: IOcrWord[],
    imageWidthPixels: number,
    imageHeightPixels: number,
    extractionDpi = 150,
): Promise<{
    success: boolean;
    pdfBuffer: Buffer | null;
    error?: string 
}> {
    try {
        // CRITICAL FIX: Convert pixel dimensions to PDF points (72 points per inch)
        // This prevents the 2x upscaling issue
        const scaleFactor = 72 / extractionDpi;
        const pageWidthPts = imageWidthPixels * scaleFactor;
        const pageHeightPts = imageHeightPixels * scaleFactor;

        log.debug(`Creating PDF: image=${imageWidthPixels}x${imageHeightPixels}px at ${extractionDpi}DPI → page=${pageWidthPts.toFixed(1)}x${pageHeightPts.toFixed(1)}pts`);
        log.debug(`Scale factor: ${scaleFactor}, words: ${words.length}`);

        // Check if we need Unicode font
        const allText = words.map(w => w.text).join(' ');
        const needsUnicode = requiresUnicodeFont(allText);

        // Create PDF document
        const pdfDoc = await PDFDocument.create();

        // Embed font
        let font;
        if (needsUnicode) {
            const fontData = await loadUnicodeFont();
            if (fontData) {
                pdfDoc.registerFontkit(fontkit);
                font = await pdfDoc.embedFont(fontData, { subset: true });
                log.debug('Using Unicode font for text layer');
            } else {
                font = await pdfDoc.embedFont(StandardFonts.Helvetica);
                log.debug('Unicode font not available, using Helvetica');
            }
        } else {
            font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }

        // Add page at CORRECT size (PDF points, not image pixels)
        const page = pdfDoc.addPage([
            pageWidthPts,
            pageHeightPts,
        ]);

        // Embed the image
        let image;
        const isPng = imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50;
        if (isPng) {
            image = await pdfDoc.embedPng(imageBuffer);
        } else {
            image = await pdfDoc.embedJpg(imageBuffer);
        }

        // Draw image scaled to fit the page (not at original pixel size)
        page.drawImage(image, {
            x: 0,
            y: 0,
            width: pageWidthPts,
            height: pageHeightPts,
        });

        // Draw text layer with proper coordinate scaling
        // CRITICAL: Do NOT reorder words - preserve Tesseract's logical order
        // This is essential for RTL (Arabic/Hebrew) text to work correctly
        for (const word of words) {
            if (!word.text.trim()) continue;

            // Scale OCR coordinates from image pixels to PDF points
            const pdfX = word.x * scaleFactor;
            const wordHeightPts = word.height * scaleFactor;

            // PDF Y-axis is from bottom, OCR Y-axis is from top
            // word.y is the TOP of the word in image coordinates
            const pdfY = pageHeightPts - (word.y * scaleFactor) - wordHeightPts;

            // Font size based on word height
            const fontSize = Math.max(6, wordHeightPts * 0.85);

            // Add space after each word for copy/paste
            const textWithSpace = word.text + ' ';

            try {
                page.drawText(textWithSpace, {
                    x: pdfX,
                    y: pdfY,
                    size: fontSize,
                    font,
                    color: rgb(0, 0, 0),
                    opacity: 0, // Invisible but selectable
                });
            } catch (drawErr) {
                // Skip words that can't be encoded (e.g., unusual Unicode)
                const drawErrMsg = drawErr instanceof Error ? drawErr.message : String(drawErr);
                log.debug(`Skipped word "${word.text.slice(0, 10)}": ${drawErrMsg}`);
            }
        }

        // Serialize to bytes
        const pdfBytes = await pdfDoc.save();
        log.debug(`PDF created: ${pdfBytes.length} bytes`);

        return {
            success: true,
            pdfBuffer: Buffer.from(pdfBytes),
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`PDF creation failed: ${errMsg}`);
        return {
            success: false,
            pdfBuffer: null,
            error: errMsg,
        };
    }
}
