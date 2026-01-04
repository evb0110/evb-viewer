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
            const stack = loadErr instanceof Error ? loadErr.stack : '';

            debugLog(`PDF load failed: ${errMsg}`);
            if (stack) debugLog(`Stack trace: ${stack}`);

            // pdf-lib failed - try fallback PDF generation with all pages
            if (errMsg.includes('traverse') || errMsg.includes('catalog') || errMsg.includes('Pages')) {
                debugLog(`Detected pdf-lib incompatibility, attempting multi-page fallback`);

                // Get all pages with imageBuffers for fallback
                const pagesWithBuffers = ocrPages.filter(p => p.imageBuffer && p.languages);
                debugLog(`Pages available for fallback: ${pagesWithBuffers.length} of ${ocrPages.length}`);

                if (pagesWithBuffers.length > 0) {
                    try {
                        // Create multi-page searchable PDF from all available pages
                        debugLog(`Creating multi-page searchable PDF from ${pagesWithBuffers.length} pages`);
                        const fallbackPdf = await createMultiPageSearchablePdf(pagesWithBuffers);

                        debugLog(`Multi-page fallback PDF created: ${fallbackPdf ? `${fallbackPdf.length} bytes` : 'null'}`);

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
                        const fallbackStack = fallbackErr instanceof Error ? fallbackErr.stack : '';
                        debugLog(`Fallback error: ${fallbackMsg}`);
                        if (fallbackStack) debugLog(`Stack trace: ${fallbackStack}`);
                        const totalWords = ocrPages.reduce((sum, p) => sum + p.words.length, 0);
                        return {
                            pdf: originalPdfBytes,
                            embedded: false,
                            error: `PDF structure incompatible. Text extracted (${totalWords} words) but fallback PDF generation failed: ${fallbackMsg}`,
                        };
                    }
                } else {
                    debugLog(`Fallback unavailable - no pages with imageBuffer and languages`);
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

/**
 * Create a multi-page searchable PDF from OCR data when pdf-lib cannot process original
 * Uses actual OCR results without re-running Tesseract
 */
async function createMultiPageSearchablePdf(
    pagesWithOcr: IOcrPageWithWords[],
): Promise<Uint8Array | null> {
    try {
        const { PDFDocument, rgb } = await import('pdf-lib');

        // Create new PDF document
        const pdfDoc = await PDFDocument.create();
        debugLog(`Created new PDF document`);

        let totalWords = 0;

        for (const pageData of pagesWithOcr) {
            try {
                // Add new page with A4 dimensions (595 x 842)
                const page = pdfDoc.addPage([595, 842]);

                // Embed image if available
                if (pageData.imageBuffer) {
                    try {
                        let embeddedImage = null;
                        try {
                            embeddedImage = await pdfDoc.embedPng(pageData.imageBuffer);
                        } catch {
                            try {
                                embeddedImage = await pdfDoc.embedJpg(pageData.imageBuffer);
                            } catch {
                                debugLog(`Page ${pageData.pageNumber}: Could not embed as PNG or JPG`);
                            }
                        }

                        if (embeddedImage) {
                            page.drawImage(embeddedImage, {
                                x: 0,
                                y: 0,
                                width: 595,
                                height: 842,
                            });
                            debugLog(`Page ${pageData.pageNumber}: Image embedded`);
                        }
                    } catch (imgErr) {
                        const imgErrMsg = imgErr instanceof Error ? imgErr.message : String(imgErr);
                        debugLog(`Page ${pageData.pageNumber}: Image embedding failed: ${imgErrMsg}`);
                    }
                }

                // Add text layer with actual OCR coordinates (no re-running Tesseract)
                const scaleX = 595 / pageData.imageWidth;
                const scaleY = 842 / pageData.imageHeight;
                let pageWords = 0;

                for (const word of pageData.words) {
                    try {
                        const pdfX = word.x * scaleX;
                        const pdfY = 842 - (word.y * scaleY);
                        const fontSize = Math.max(1, word.height * scaleY * 0.8);

                        page.drawText(word.text, {
                            x: pdfX,
                            y: pdfY - fontSize,
                            size: fontSize,
                            color: rgb(1, 1, 1),
                            opacity: 0.001,
                        });
                        pageWords++;
                        totalWords++;
                    } catch {
                        // Skip individual words that fail
                    }
                }

                debugLog(`Page ${pageData.pageNumber}: Added ${pageWords} words to text layer`);
            } catch (pageErr) {
                const pageErrMsg = pageErr instanceof Error ? pageErr.message : String(pageErr);
                debugLog(`Page ${pageData.pageNumber}: Error processing page: ${pageErrMsg}`);
            }
        }

        if (totalWords === 0) {
            debugLog(`No words were added to any pages`);
            return null;
        }

        const pdfBytes = await pdfDoc.save();
        debugLog(`Multi-page PDF saved: ${pdfBytes.length} bytes with ${totalWords} words`);
        return pdfBytes;
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : '';
        debugLog(`Multi-page PDF creation failed: ${errMsg}`);
        if (stack) debugLog(`Stack trace: ${stack}`);
        return null;
    }
}
