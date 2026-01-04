import { PDFDocument, rgb } from 'pdf-lib';
import { generateSearchablePdf } from './tesseract';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';

const LOG_FILE = join(app.getPath('temp'), 'ocr-debug.log');

function debugLog(msg: string) {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] [pdf-merger] ${msg}\n`);
}

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
    imageBuffer?: Buffer;
    languages?: string[];
}

export async function embedOcrLayers(
    originalPdfBytes: Uint8Array,
    ocrPages: IOcrPageWithWords[],
): Promise<{ pdf: Uint8Array; embedded: boolean; error?: string }> {
    try {
        // Try to load the PDF first to detect incompatibilities early
        let pdf: PDFDocument;
        try {
            pdf = await PDFDocument.load(originalPdfBytes, {
                ignoreEncryption: true,
                updateMetadata: false,
            });
        } catch (loadErr) {
            const errMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);

            debugLog(`PDF load failed: ${errMsg}`);

            // pdf-lib failed - try Tesseract PDF generation as fallback
            if (errMsg.includes('traverse') || errMsg.includes('catalog') || errMsg.includes('Pages')) {
                debugLog(`Detected pdf-lib incompatibility, attempting Tesseract PDF fallback`);

                // pdf-lib cannot parse this complex PDF structure
                // Try to generate a searchable PDF from the first page using Tesseract
                const firstPageWithBuffer = ocrPages.find(p => p.imageBuffer);

                debugLog(`First page with buffer: ${firstPageWithBuffer ? 'found' : 'not found'}`);
                if (firstPageWithBuffer) {
                    debugLog(`  - pageNumber: ${firstPageWithBuffer.pageNumber}`);
                    debugLog(`  - imageBuffer size: ${firstPageWithBuffer.imageBuffer?.length ?? 'undefined'}`);
                    debugLog(`  - languages: ${firstPageWithBuffer.languages?.join(',') ?? 'undefined'}`);
                }

                if (firstPageWithBuffer && firstPageWithBuffer.imageBuffer && firstPageWithBuffer.languages) {
                    try {
                        debugLog(`Calling generateSearchablePdf...`);
                        const fallbackPdf = await generateSearchablePdf(
                            firstPageWithBuffer.imageBuffer,
                            firstPageWithBuffer.languages,
                        );

                        debugLog(`generateSearchablePdf returned: ${fallbackPdf ? `PDF ${fallbackPdf.length} bytes` : 'null'}`);

                        if (fallbackPdf) {
                            debugLog(`Fallback successful! Returning searchable PDF`);
                            return {
                                pdf: fallbackPdf,
                                embedded: true,
                                error: undefined,
                            };
                        } else {
                            debugLog(`Fallback returned null`);
                        }
                    } catch (fallbackErr) {
                        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                        debugLog(`Fallback error: ${fallbackMsg}`);
                        const totalWords = ocrPages.reduce((sum, p) => sum + p.words.length, 0);
                        return {
                            pdf: originalPdfBytes,
                            embedded: false,
                            error: `PDF structure incompatible. Text extracted (${totalWords} words) but fallback PDF generation failed: ${fallbackMsg}`,
                        };
                    }
                } else {
                    debugLog(`Fallback unavailable - missing imageBuffer or languages`);
                }

                // Fallback unavailable, return original with error
                const totalWords = ocrPages.reduce((sum, p) => sum + p.words.length, 0);
                debugLog(`Returning original PDF with error (${totalWords} words extracted)`);
                return {
                    pdf: originalPdfBytes,
                    embedded: false,
                    error: `PDF structure incompatible. Text extracted (${totalWords} words) but could not be embedded.`,
                };
            }

            throw loadErr;
        }

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
                error: `Text extraction successful but could not be embedded in PDF (PDF structure may be incompatible). Text was extracted successfully.`,
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

            // Detect specific pdf-lib incompatibilities
            if (errMsg.includes('traverse') || errMsg.includes('catalog')) {
                return {
                    pdf: originalPdfBytes,
                    embedded: false,
                    error: `PDF structure incompatible with current library. Text was successfully extracted but could not be embedded. This is a complex PDF format limitation.`,
                };
            }

            return {
                pdf: originalPdfBytes,
                embedded: false,
                error: `PDF modification failed: ${errMsg}`,
            };
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Provide helpful error message
        if (errMsg.includes('traverse') || errMsg.includes('catalog')) {
            return {
                pdf: originalPdfBytes,
                embedded: false,
                error: `PDF structure is not compatible with the current PDF library. This is often the case with complex or specially formatted PDFs. Text was extracted successfully, but cannot be embedded in this particular PDF.`,
            };
        }

        // Return original PDF with detailed error message
        return {
            pdf: originalPdfBytes,
            embedded: false,
            error: `PDF modification failed: ${errMsg}`,
        };
    }
}
