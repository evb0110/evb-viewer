import { PDFDocument, rgb } from 'pdf-lib';

interface IOcrWord {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface IOcrPageWithWords {
    pageNumber: number;
    words: IOcrWord[];
    imageWidth: number;
    imageHeight: number;
}

export async function embedOcrLayers(
    originalPdfBytes: Uint8Array,
    ocrPages: IOcrPageWithWords[],
): Promise<{ pdf: Uint8Array; embedded: boolean; error?: string }> {
    try {
        // Try to load the PDF first to detect incompatibilities early
        const pdf = await PDFDocument.load(originalPdfBytes, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
        const pageCount = pdf.getPageCount();
        let totalWordsAttempted = 0;
        let totalWordsSuccess = 0;

        for (const { pageNumber, words, imageWidth, imageHeight } of ocrPages) {
            if (pageNumber < 1 || pageNumber > pageCount) {
                continue;
            }

            try {
                // Test page access early to catch incompatibilities
                const page = pdf.getPage(pageNumber - 1);
                const { width: pageWidth, height: pageHeight } = page.getSize();

                // Calculate scaling factor from image coordinates to PDF coordinates
                const scaleX = pageWidth / imageWidth;
                const scaleY = pageHeight / imageHeight;

                // Add invisible text to the page
                // PDF coordinates have origin at bottom-left, but image coordinates are top-left
                for (const word of words) {
                    totalWordsAttempted++;
                    try {
                        // Convert image coordinates to PDF coordinates
                        const pdfX = word.x * scaleX;
                        const pdfY = pageHeight - (word.y * scaleY); // Flip Y axis

                        // Draw invisible text
                        const fontSize = Math.max(1, word.height * scaleY * 0.8);

                        page.drawText(word.text, {
                            x: pdfX,
                            y: pdfY - fontSize,
                            size: fontSize,
                            color: rgb(1, 1, 1),
                            opacity: 0.001,
                        });
                        totalWordsSuccess++;
                    } catch (wordErr) {
                        // Skip individual words that fail
                    }
                }
            } catch (pageErr) {
                // Skip pages that fail to access
            }
        }

        // Only try to save if we successfully embedded at least some text
        if (totalWordsSuccess === 0) {
            return {
                pdf: originalPdfBytes,
                embedded: false,
                error: `No text could be embedded (PDF may have incompatible structure)`,
            };
        }

        try {
            const modifiedPdf = await pdf.save();
            return {
                pdf: modifiedPdf,
                embedded: true,
                error: undefined,
            };
        } catch (saveErr) {
            // If save fails, return original PDF
            const errMsg = saveErr instanceof Error ? saveErr.message : String(saveErr);
            return {
                pdf: originalPdfBytes,
                embedded: false,
                error: `PDF modification failed during save: ${errMsg}`,
            };
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Return original PDF with detailed error message
        return {
            pdf: originalPdfBytes,
            embedded: false,
            error: `PDF modification failed: ${errMsg}`,
        };
    }
}
