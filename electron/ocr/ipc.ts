import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
    app,
} from 'electron';
import { appendFileSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { embedOcrLayers } from './pdf-merger';
import {
    runOcr,
    runOcrWithBoundingBoxes,
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

        const ocrPageData: Array<{ pageNumber: number; words: any[]; imageWidth: number; imageHeight: number }> = [];

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

        // Embed OCR text into original PDF
        const originalPdfBytes = new Uint8Array(originalPdfData);
        debugLog(`Calling embedOcrLayers with ${ocrPageData.length} pages`);
        const { pdf: searchablePdf, embedded, error: embedError } = await embedOcrLayers(originalPdfBytes, ocrPageData);
        debugLog(`embedOcrLayers completed, PDF size: ${searchablePdf.length} bytes, embedded=${embedded}`);

        if (embedError) {
            errors.push(embedError);
        }

        return {
            success: embedded,  // Only true if text was actually embedded
            pdfData: Array.from(searchablePdf),
            errors,
        };
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
