import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
    app,
} from 'electron';
import { appendFileSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import {
    runOcr,
    runOcrWithBoundingBoxes,
    generateSearchablePdfDirect,
} from './tesseract';
import {
    preprocessPageForOcr,
    validatePreprocessingSetup,
} from './preprocessing';

const LOG_FILE = join(app.getPath('temp'), 'ocr-debug.log');

function debugLog(msg: string) {
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`);
}

interface IOcrPageRequest {
    pageNumber: number;
    imageData: number[];
    languages: string[];
}

interface IOcrPdfPageRequest {
    pageNumber: number;
    imageData: number[];
    languages: string[];
    dpi: number;
    imageWidth: number;
    imageHeight: number;
}

interface IOcrLanguage {
    code: string;
    name: string;
    script: 'latin' | 'cyrillic' | 'rtl';
}

const AVAILABLE_LANGUAGES: IOcrLanguage[] = [
    { code: 'eng', name: 'English', script: 'latin' },
    { code: 'fra', name: 'French', script: 'latin' },
    { code: 'deu', name: 'German', script: 'latin' },
    { code: 'tur', name: 'Turkish', script: 'latin' },
    { code: 'kmr', name: 'Kurdish (Kurmanji)', script: 'latin' },
    { code: 'rus', name: 'Russian', script: 'cyrillic' },
    { code: 'ara', name: 'Arabic', script: 'rtl' },
    { code: 'heb', name: 'Hebrew', script: 'rtl' },
    { code: 'syr', name: 'Syriac', script: 'rtl' },
];

async function handleOcrRecognize(
    _event: IpcMainInvokeEvent,
    request: IOcrPageRequest,
) {
    const imageBuffer = Buffer.from(request.imageData);
    const result = await runOcr(imageBuffer, request.languages);

    return {
        pageNumber: request.pageNumber,
        success: result.success,
        text: result.text,
        error: result.error,
    };
}

async function handleOcrRecognizeBatch(
    event: IpcMainInvokeEvent,
    pages: IOcrPageRequest[],
    requestId: string,
) {
    const window = BrowserWindow.fromWebContents(event.sender);
    const results: Record<number, string> = {};
    const errors: string[] = [];

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];

        // Send progress update
        window?.webContents.send('ocr:progress', {
            requestId,
            currentPage: page.pageNumber,
            processedCount: i,
            totalPages: pages.length,
        });

        const imageBuffer = Buffer.from(page.imageData);
        const result = await runOcr(imageBuffer, page.languages);

        if (result.success) {
            results[page.pageNumber] = result.text;
        } else {
            errors.push(`Page ${page.pageNumber}: ${result.error}`);
        }
    }

    // Send final progress
    window?.webContents.send('ocr:progress', {
        requestId,
        currentPage: pages[pages.length - 1]?.pageNumber ?? 0,
        processedCount: pages.length,
        totalPages: pages.length,
    });

    return { results, errors };
}

async function handleOcrCreateSearchablePdf(
    event: IpcMainInvokeEvent,
    originalPdfData: number[],
    pages: IOcrPdfPageRequest[],
    requestId: string,
) {
    try {
        debugLog(`handleOcrCreateSearchablePdf called: pdfLen=${originalPdfData.length}, pages=${pages.length}, reqId=${requestId}`);

        const window = BrowserWindow.fromWebContents(event.sender);
        const errors: string[] = [];

        const ocrPageData: IOcrPageWithWords[] = [];

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            debugLog(`Processing page ${page.pageNumber}, imageLen=${page.imageData.length}, dpi=${page.dpi}`);

            // Send progress update
            window?.webContents.send('ocr:progress', {
                requestId,
                currentPage: page.pageNumber,
                processedCount: i,
                totalPages: pages.length,
            });

            const imageBuffer = Buffer.from(page.imageData);
            debugLog(`Calling runOcrWithBoundingBoxes, bufferSize=${imageBuffer.length}`);
            try {
                const result = await runOcrWithBoundingBoxes(
                    imageBuffer,
                    page.languages,
                    page.dpi,
                    page.imageWidth,
                    page.imageHeight,
                );
                debugLog(`runOcrWithBoundingBoxes result: success=${result.success}, words=${result.pageData?.words.length}, error=${result.error}`);

                if (result.success && result.pageData) {
                    ocrPageData.push({
                        pageNumber: page.pageNumber,
                        words: result.pageData.words,
                        imageWidth: result.pageData.pageWidth,
                        imageHeight: result.pageData.pageHeight,
                        imageBuffer,
                        languages: page.languages,
                    });
                } else {
                    errors.push(`Page ${page.pageNumber}: ${result.error}`);
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                debugLog(`runOcrWithBoundingBoxes threw: ${errMsg}`);
                errors.push(`Page ${page.pageNumber}: ${errMsg}`);
            }
        }

        debugLog(`OCR loop done. ocrPageData=${ocrPageData.length}, errors=${errors.length}`);

        // Send final progress
        window?.webContents.send('ocr:progress', {
            requestId,
            currentPage: pages[pages.length - 1]?.pageNumber ?? 0,
            processedCount: pages.length,
            totalPages: pages.length,
        });

        if (ocrPageData.length === 0) {
            return { success: false, pdfData: null, errors };
        }

        // Generate searchable Tesseract PDF for EACH OCR'd page
        const tempDir = app.getPath('temp');
        const sessionId = `merge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const ocrPdfMap: Map<number, string> = new Map(); // pageNumber -> path to OCR PDF

        try {
            debugLog(`Generating Tesseract PDF for ${ocrPageData.length} OCR'd page(s)`);

            for (const pageData of ocrPageData) {
                debugLog(`Generating Tesseract PDF for page ${pageData.pageNumber}`);

                try {
                    const result = await generateSearchablePdfDirect(
                        pageData.imageBuffer!,
                        pageData.languages!,
                    );

                    if (result.success && result.pdfBuffer) {
                        const ocrPdfPath = join(tempDir, `${sessionId}-ocr-page-${pageData.pageNumber}.pdf`);
                        writeFileSync(ocrPdfPath, result.pdfBuffer);
                        ocrPdfMap.set(pageData.pageNumber, ocrPdfPath);
                        debugLog(`Saved OCR PDF for page ${pageData.pageNumber}: ${result.pdfBuffer.length} bytes`);
                    } else {
                        errors.push(`Failed to generate PDF for page ${pageData.pageNumber}: ${result.error}`);
                        debugLog(`Tesseract PDF generation failed for page ${pageData.pageNumber}: ${result.error}`);
                    }
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    errors.push(`Error generating PDF for page ${pageData.pageNumber}: ${errMsg}`);
                    debugLog(`Exception generating PDF for page ${pageData.pageNumber}: ${errMsg}`);
                }
            }

            if (ocrPdfMap.size === 0) {
                debugLog(`No OCR PDFs generated successfully`);
                return { success: false, pdfData: null, errors };
            }

            debugLog(`Successfully generated ${ocrPdfMap.size} OCR PDF(s)`);

            // Write original PDF to temp file and extract all pages
            const originalPdfBytes = new Uint8Array(originalPdfData);
            const originalPdfPath = join(tempDir, `${sessionId}-original.pdf`);
            writeFileSync(originalPdfPath, originalPdfBytes);
            debugLog(`Wrote original PDF to ${originalPdfPath}`);

            try {
                // Use qpdf for efficient page substitution (no need to extract all pages)
                const ocrPageNumbers = Array.from(ocrPdfMap.keys()).sort((a, b) => a - b);
                const minOcrPage = ocrPageNumbers[0] ?? 1;
                const maxOcrPage = ocrPageNumbers[ocrPageNumbers.length - 1] ?? 1;

                debugLog(`OCR'd pages: ${minOcrPage} to ${maxOcrPage}`);

                // Merge using qpdf for efficient page substitution
                const mergedPdfPath = join(tempDir, `${sessionId}-merged.pdf`);

                if (ocrPageNumbers.length === 0) {
                    return { success: false, pdfData: null, errors: ['No OCR pages to process'] };
                }

                try {
                    // Build qpdf command for intelligent substitution
                    // Strategy: Use OCR'd pages where available, original pages otherwise
                    // Note: qpdf --pages syntax is: file1 page-spec file2 page-spec ...

                    const pageSpecs: string[] = [];
                    let lastPage = 0;

                    for (const pageNum of ocrPageNumbers) {
                        // Add original pages before this OCR page (if any gap)
                        if (lastPage + 1 < pageNum) {
                            pageSpecs.push(`${originalPdfPath} ${lastPage + 1}-${pageNum - 1}`);
                        }
                        // Add OCR page
                        const ocrPath = ocrPdfMap.get(pageNum)!;
                        pageSpecs.push(`${ocrPath} 1`);
                        lastPage = pageNum;
                    }

                    // Add any remaining pages from the original after the last OCR page
                    pageSpecs.push(`${originalPdfPath} ${lastPage + 1}-end`);

                    // Build the full qpdf command
                    const qpdfCmd = `qpdf ${originalPdfPath} --pages ${pageSpecs.join(' ')} -- ${mergedPdfPath}`;

                    debugLog(`Using qpdf for efficient page substitution`);
                    debugLog(`qpdf command: ${qpdfCmd}`);

                    execSync(qpdfCmd, { encoding: 'utf-8', stdio: 'pipe' });
                    debugLog(`qpdf substitution completed successfully`);
                } catch (qpdfErr) {
                    // qpdf is required for efficient page substitution
                    const errMsg = qpdfErr instanceof Error ? qpdfErr.message : String(qpdfErr);
                    debugLog(`qpdf page substitution failed: ${errMsg}`);
                    errors.push(`Failed to merge OCR'd pages with original PDF: ${errMsg}`);
                    return { success: false, pdfData: null, errors };
                }

                // Read merged PDF
                const mergedPdfBuffer = readFileSync(mergedPdfPath);
                debugLog(`Merged PDF size: ${mergedPdfBuffer.length} bytes`);

                // For large PDFs (>50MB), save to temp file and return path instead of trying to serialize huge array
                if (mergedPdfBuffer.length > 50 * 1024 * 1024) {
                    const resultPath = join(tempDir, `ocr-result-${sessionId}.pdf`);
                    writeFileSync(resultPath, mergedPdfBuffer);
                    debugLog(`Large PDF saved to temp file: ${resultPath}`);
                    return {
                        success: true,
                        pdfData: null,
                        pdfPath: resultPath,
                        errors,
                    };
                }

                return {
                    success: true,
                    pdfData: Array.from(mergedPdfBuffer),
                    errors,
                };

            } catch (mergeErr) {
                const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
                debugLog(`PDF merge failed: ${mergeMsg}`);
                errors.push(`PDF merge failed: ${mergeMsg}`);
                return { success: false, pdfData: null, errors };
            } finally {
                // Cleanup temp files
                try {
                    execSync(`rm -f ${tempDir}/${sessionId}-*.pdf 2>/dev/null`);
                    debugLog(`Cleaned up temp files`);
                } catch {}
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            debugLog(`Error in page substitution: ${errMsg}`);
            errors.push(`Page substitution failed: ${errMsg}`);
            return { success: false, pdfData: null, errors };
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? err.stack : '';
        debugLog(`CRITICAL ERROR in handleOcrCreateSearchablePdf: ${errMsg}`);
        debugLog(`Stack: ${errStack}`);
        return {
            success: false,
            pdfData: null,
            errors: [`Critical error: ${errMsg}`],
        };
    }
}

function handleOcrGetLanguages() {
    return AVAILABLE_LANGUAGES;
}

function handlePreprocessingValidate() {
    const validation = validatePreprocessingSetup();
    return {
        valid: validation.valid,
        available: validation.available,
        missing: validation.missing,
    };
}

async function handlePreprocessPage(
    _event: IpcMainInvokeEvent,
    imageData: number[],
    usePreprocessing: boolean,
) {
    try {
        if (!usePreprocessing) {
            return {
                success: true,
                imageData,
                message: 'Preprocessing disabled',
            };
        }

        const validation = validatePreprocessingSetup();
        if (!validation.valid) {
            return {
                success: false,
                imageData,
                error: `Preprocessing tools not available: ${validation.missing.join(', ')}`,
            };
        }

        // Write image to temp file
        const tempDir = app.getPath('temp');
        const inputPath = join(tempDir, `preprocess-input-${Date.now()}.png`);
        const outputPath = join(tempDir, `preprocess-output-${Date.now()}.png`);

        const imageBuffer = Buffer.from(imageData);
        writeFileSync(inputPath, imageBuffer);

        debugLog(`Preprocessing image: ${inputPath}`);
        const result = await preprocessPageForOcr(inputPath, outputPath);

        if (!result.success) {
            debugLog(`Preprocessing failed: ${result.error}`);
            return {
                success: false,
                imageData,
                error: result.error || 'Preprocessing failed',
            };
        }

        // Read preprocessed image
        const preprocessedBuffer = readFileSync(outputPath);
        const preprocessedData = Array.from(preprocessedBuffer);

        debugLog(`Preprocessing successful: ${inputPath} -> ${outputPath}`);

        // Cleanup temp files
        try {
            require('fs').unlinkSync(inputPath);
            require('fs').unlinkSync(outputPath);
        } catch (e) {
            // Ignore cleanup errors
        }

        return {
            success: true,
            imageData: preprocessedData,
            message: 'Preprocessing complete',
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`Preprocessing error: ${errMsg}`);
        return {
            success: false,
            imageData,
            error: errMsg,
        };
    }
}

export function registerOcrHandlers() {
    ipcMain.handle('ocr:recognize', handleOcrRecognize);
    ipcMain.handle('ocr:recognizeBatch', handleOcrRecognizeBatch);
    ipcMain.handle('ocr:createSearchablePdf', handleOcrCreateSearchablePdf);
    ipcMain.handle('ocr:getLanguages', handleOcrGetLanguages);
    ipcMain.handle('preprocessing:validate', handlePreprocessingValidate);
    ipcMain.handle('preprocessing:preprocessPage', handlePreprocessPage);
}
