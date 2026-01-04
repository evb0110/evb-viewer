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
): Promise<Uint8Array> {
    try {
        const pdf = await PDFDocument.load(originalPdfBytes, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
        const pageCount = pdf.getPageCount();

        for (const { pageNumber, words, imageWidth, imageHeight } of ocrPages) {
            if (pageNumber < 1 || pageNumber > pageCount) {
                continue;
            }

            try {
                const page = pdf.getPage(pageNumber - 1);
                const { width: pageWidth, height: pageHeight } = page.getSize();

                // Calculate scaling factor from image coordinates to PDF coordinates
                const scaleX = pageWidth / imageWidth;
                const scaleY = pageHeight / imageHeight;

                // Add invisible text to the page
                // PDF coordinates have origin at bottom-left, but image coordinates are top-left
                for (const word of words) {
                    try {
                        // Convert image coordinates to PDF coordinates
                        const pdfX = word.x * scaleX;
                        const pdfY = pageHeight - (word.y * scaleY); // Flip Y axis

                        // Draw invisible text (white text on white background or very small font)
                        // Font size is estimated from word height
                        const fontSize = Math.max(1, word.height * scaleY * 0.8);

                        page.drawText(word.text, {
                            x: pdfX,
                            y: pdfY - fontSize, // Adjust for text baseline
                            size: fontSize,
                            color: rgb(1, 1, 1), // Nearly white (invisible)
                            opacity: 0.001, // Almost fully transparent
                        });
                    } catch (wordErr) {
                        // Skip individual words that fail to draw
                        console.warn(`Failed to draw word "${word.text}": ${wordErr}`);
                    }
                }
            } catch (pageErr) {
                // Skip pages that fail
                console.warn(`Failed to process page ${pageNumber}: ${pageErr}`);
            }
        }

        return pdf.save();
    } catch (err) {
        // If PDF modification fails, return original PDF as fallback
        // This ensures at least the original content is preserved
        console.warn(`Failed to embed OCR layers: ${err}`);
        return originalPdfBytes;
    }
}
