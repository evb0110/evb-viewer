import type { IpcMainInvokeEvent } from 'electron';
import {
    BrowserWindow,
    ipcMain,
    app,
} from 'electron';
import {
    writeFileSync,
    readFileSync,
    unlinkSync,
    readdirSync,
} from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
    runOcr,
    runOcrWithBoundingBoxes,
    generateSearchablePdfDirect,
} from '@electron/ocr/tesseract';
import {
    preprocessPageForOcr,
    validatePreprocessingSetup,
} from '@electron/ocr/preprocessing';
import { saveOcrIndex } from '@electron/search/ipc';
import { createLogger } from '@electron/utils/logger';

const log = createLogger('ocr-ipc');

interface IOcrPageRequest {
    pageNumber: number;
    imageData: number[];
    languages: string[];
}

interface IOcrPdfPageRequest {
    pageNumber: number;
    languages: string[];
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
    text: string;
    imageWidth: number;
    imageHeight: number;
    imageBuffer?: Buffer;
    languages?: string[];
}

interface IOcrLanguage {
    code: string;
    name: string;
    script: 'latin' | 'cyrillic' | 'rtl';
}

const AVAILABLE_LANGUAGES: IOcrLanguage[] = [
    {
        code: 'eng',
        name: 'English',
        script: 'latin', 
    },
    {
        code: 'fra',
        name: 'French',
        script: 'latin', 
    },
    {
        code: 'deu',
        name: 'German',
        script: 'latin', 
    },
    {
        code: 'tur',
        name: 'Turkish',
        script: 'latin', 
    },
    {
        code: 'kmr',
        name: 'Kurdish (Kurmanji)',
        script: 'latin', 
    },
    {
        code: 'rus',
        name: 'Russian',
        script: 'cyrillic', 
    },
    {
        code: 'ara',
        name: 'Arabic',
        script: 'rtl', 
    },
    {
        code: 'heb',
        name: 'Hebrew',
        script: 'rtl', 
    },
    {
        code: 'syr',
        name: 'Syriac',
        script: 'rtl', 
    },
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
        if (!page) continue;

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

    return {
        results,
        errors, 
    };
}

async function handleOcrCreateSearchablePdf(
    event: IpcMainInvokeEvent,
    originalPdfData: number[],
    pages: IOcrPdfPageRequest[],
    requestId: string,
    workingCopyPath?: string,
) {
    try {
        log.debug(`handleOcrCreateSearchablePdf called: pdfLen=${originalPdfData.length}, pages=${pages.length}, reqId=${requestId}`);

        const window = BrowserWindow.fromWebContents(event.sender);
        const errors: string[] = [];
        const tempDir = app.getPath('temp');
        const sessionId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // Write original PDF to temp file first
        const originalPdfBytes = new Uint8Array(originalPdfData);
        const originalPdfPath = join(tempDir, `${sessionId}-original.pdf`);
        writeFileSync(originalPdfPath, originalPdfBytes);
        const writtenFileSize = readFileSync(originalPdfPath).length;
        log.debug(`Wrote original PDF to ${originalPdfPath}, size: ${writtenFileSize} bytes (expected: ${originalPdfData.length})`);
        if (writtenFileSize !== originalPdfData.length) {
            const errMsg = `PDF file size mismatch: wrote ${writtenFileSize} bytes but expected ${originalPdfData.length}`;
            log.debug(`ERROR: ${errMsg}`);
            errors.push(errMsg);
            return {
                success: false,
                pdfData: null,
                errors, 
            };
        }

        const ocrPageData: IOcrPageWithWords[] = [];

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            if (!page) continue;
            log.debug(`Processing page ${page.pageNumber}`);

            // Send progress update
            window?.webContents.send('ocr:progress', {
                requestId,
                currentPage: page.pageNumber,
                processedCount: i,
                totalPages: pages.length,
            });

            try {
                // Extract page image from source PDF using pdftoppm at 150 DPI for good quality
                // 150 DPI gives us ~2.1x scale on standard letter-size pages
                const pageImagePath = join(tempDir, `${sessionId}-page-${page.pageNumber}.png`);
                log.debug(`Extracting page ${page.pageNumber} from PDF to ${pageImagePath}`);

                // pdftoppm: -png output as PNG, -singlefile output single file (not -001, -002, etc), -f/-l first/last page
                // Using spawnSync with args array to prevent shell injection
                const pdftoppmResult = spawnSync('pdftoppm', [
                    '-png',
                    '-r',
                    '150',
                    '-f',
                    String(page.pageNumber),
                    '-l',
                    String(page.pageNumber),
                    '-singlefile',
                    originalPdfPath,
                    pageImagePath.replace(/\.png$/, ''),
                ], { encoding: 'utf-8' });

                if (pdftoppmResult.status !== 0) {
                    throw new Error(`pdftoppm failed: ${pdftoppmResult.stderr || pdftoppmResult.error?.message}`);
                }

                const imageBuffer = readFileSync(pageImagePath);
                log.debug(`Extracted page image: ${imageBuffer.length} bytes`);

                // Measure the extracted image dimensions to pass to Tesseract
                // pdftoppm creates images at the exact page size, but we need to tell Tesseract the dimensions
                // Using spawnSync with args array to prevent shell injection
                const identifyResult = spawnSync('identify', [
                    '-format',
                    '%wx%h',
                    pageImagePath,
                ], { encoding: 'utf-8' });
                if (identifyResult.status !== 0) {
                    throw new Error(`identify failed: ${identifyResult.stderr || identifyResult.error?.message}`);
                }
                const identifyOutput = (identifyResult.stdout ?? '').trim();
                const [
                    widthStr,
                    heightStr,
                ] = identifyOutput.split('x');
                const imageWidth = parseInt(widthStr ?? '0', 10);
                const imageHeight = parseInt(heightStr ?? '0', 10);
                log.debug(`Page image dimensions: ${imageWidth}x${imageHeight}`);

                try {
                    const result = await runOcrWithBoundingBoxes(
                        imageBuffer,
                        page.languages,
                        imageWidth,
                        imageHeight,
                    );
                    log.debug(`runOcrWithBoundingBoxes result: success=${result.success}, words=${result.pageData?.words.length}, error=${result.error}`);

                    if (result.success && result.pageData) {
                        ocrPageData.push({
                            pageNumber: page.pageNumber,
                            words: result.pageData.words,
                            text: result.pageData.text,
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
                    log.debug(`runOcrWithBoundingBoxes threw: ${errMsg}`);
                    errors.push(`Page ${page.pageNumber}: ${errMsg}`);
                } finally {
                    // Cleanup extracted page image
                    try {
                        unlinkSync(pageImagePath);
                    } catch (cleanupErr) {
                        log.warn(`Cleanup warning (pageImagePath): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
                    }
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log.debug(`Failed to extract page ${page.pageNumber}: ${errMsg}`);
                errors.push(`Failed to extract page ${page.pageNumber}: ${errMsg}`);
            }
        }

        log.debug(`OCR loop done. ocrPageData=${ocrPageData.length}, errors=${errors.length}`);

        // Send final progress
        window?.webContents.send('ocr:progress', {
            requestId,
            currentPage: pages[pages.length - 1]?.pageNumber ?? 0,
            processedCount: pages.length,
            totalPages: pages.length,
        });

        if (ocrPageData.length === 0) {
            return {
                success: false,
                pdfData: null,
                errors, 
            };
        }

        // Generate searchable Tesseract PDF for EACH OCR'd page
        const ocrPdfMap: Map<number, string> = new Map(); // pageNumber -> path to OCR PDF

        try {
            log.debug(`Generating Tesseract PDF for ${ocrPageData.length} OCR'd page(s)`);

            for (const pageData of ocrPageData) {
                log.debug(`Generating Tesseract PDF for page ${pageData.pageNumber}`);

                try {
                    const result = await generateSearchablePdfDirect(
                        pageData.imageBuffer!,
                        pageData.languages!,
                    );

                    if (result.success && result.pdfBuffer) {
                        const ocrPdfPath = join(tempDir, `${sessionId}-ocr-page-${pageData.pageNumber}.pdf`);
                        writeFileSync(ocrPdfPath, result.pdfBuffer);
                        ocrPdfMap.set(pageData.pageNumber, ocrPdfPath);
                        log.debug(`Saved OCR PDF for page ${pageData.pageNumber}: ${result.pdfBuffer.length} bytes`);
                    } else {
                        errors.push(`Failed to generate PDF for page ${pageData.pageNumber}: ${result.error}`);
                        log.debug(`Tesseract PDF generation failed for page ${pageData.pageNumber}: ${result.error}`);
                    }
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    errors.push(`Error generating PDF for page ${pageData.pageNumber}: ${errMsg}`);
                    log.debug(`Exception generating PDF for page ${pageData.pageNumber}: ${errMsg}`);
                }
            }

            if (ocrPdfMap.size === 0) {
                log.debug('No OCR PDFs generated successfully');
                return {
                    success: false,
                    pdfData: null,
                    errors, 
                };
            }

            log.debug(`Successfully generated ${ocrPdfMap.size} OCR PDF(s)`);

            try {
                // Use qpdf for efficient page substitution (no need to extract all pages)
                const ocrPageNumbers = Array.from(ocrPdfMap.keys()).sort((a, b) => a - b);
                const minOcrPage = ocrPageNumbers[0] ?? 1;
                const maxOcrPage = ocrPageNumbers[ocrPageNumbers.length - 1] ?? 1;

                log.debug(`OCR'd pages: ${minOcrPage} to ${maxOcrPage}`);

                // Merge using qpdf for efficient page substitution
                const mergedPdfPath = join(tempDir, `${sessionId}-merged.pdf`);

                if (ocrPageNumbers.length === 0) {
                    return {
                        success: false,
                        pdfData: null,
                        errors: ['No OCR pages to process'],
                    };
                }

                // Get page count from original PDF using qpdf --show-npages
                // Declared outside try block so it's accessible for saveOcrIndex later
                // Using spawnSync with args array to prevent shell injection
                let pageCount = 0;
                try {
                    const pageCountResult = spawnSync('qpdf', [
                        '--show-npages',
                        originalPdfPath,
                    ], { encoding: 'utf-8' });
                    if (pageCountResult.status === 0) {
                        pageCount = parseInt((pageCountResult.stdout ?? '').trim(), 10);
                        log.debug(`Original PDF has ${pageCount} pages`);
                    } else {
                        throw new Error(pageCountResult.stderr || 'qpdf failed');
                    }
                } catch (err) {
                    log.debug(`Failed to get page count, using fallback: ${err}`);
                    pageCount = 9999; // Fallback: use large number
                }

                try {
                    // Build qpdf args array for intelligent substitution
                    // Using spawnSync with args array to prevent shell injection
                    // Strategy: Use OCR'd pages where available, original pages otherwise
                    // qpdf --pages syntax is: file1 page-spec file2 page-spec ...

                    const qpdfArgs: string[] = [
                        originalPdfPath,
                        '--pages',
                    ];
                    let lastPage = 0;

                    for (const pageNum of ocrPageNumbers) {
                        // Add original pages before this OCR page (if any gap)
                        if (lastPage + 1 < pageNum) {
                            qpdfArgs.push(originalPdfPath, `${lastPage + 1}-${pageNum - 1}`);
                        }
                        // Add OCR page
                        const ocrPath = ocrPdfMap.get(pageNum)!;
                        qpdfArgs.push(ocrPath, '1');
                        lastPage = pageNum;
                    }

                    // Add any remaining pages from the original after the last OCR page
                    if (lastPage < pageCount) {
                        qpdfArgs.push(originalPdfPath, `${lastPage + 1}-${pageCount}`);
                    }

                    // Add output path
                    qpdfArgs.push('--', mergedPdfPath);

                    log.debug('Using qpdf for efficient page substitution');
                    log.debug(`qpdf args: ${qpdfArgs.join(' ')}`);

                    const qpdfResult = spawnSync('qpdf', qpdfArgs, { encoding: 'utf-8' });

                    // qpdf returns exit code 3 for "operation succeeded with warnings"
                    // The file is still created successfully in this case
                    if (qpdfResult.status === 0) {
                        log.debug('qpdf substitution completed successfully');
                    } else if (qpdfResult.status === 3) {
                        log.debug('qpdf completed with exit code 3 (warnings, but file created successfully)');
                    } else {
                        throw new Error(qpdfResult.stderr || `qpdf failed with status ${qpdfResult.status}`);
                    }
                } catch (qpdfErr) {
                    // qpdf is required for efficient page substitution
                    const errMsg = qpdfErr instanceof Error ? qpdfErr.message : String(qpdfErr);
                    log.debug(`qpdf page substitution failed: ${errMsg}`);
                    errors.push(`Failed to merge OCR'd pages with original PDF: ${errMsg}`);
                    return {
                        success: false,
                        pdfData: null,
                        errors, 
                    };
                }

                // Read merged PDF
                const mergedPdfBuffer = readFileSync(mergedPdfPath);
                log.debug(`Merged PDF size: ${mergedPdfBuffer.length} bytes`);

                // Save search index for OCR'd pages
                try {
                    const indexPageData = ocrPageData.map(pd => ({
                        pageNumber: pd.pageNumber,
                        words: pd.words,
                        text: pd.text,
                        pageWidth: pd.imageWidth,
                        pageHeight: pd.imageHeight,
                    }));

                    // Save index to working copy path if provided, otherwise to original path
                    // The index file will be: /working/copy/path/file.pdf.index.json or /original/path/file.pdf.index.json
                    const indexPath = workingCopyPath || originalPdfPath;
                    await saveOcrIndex(indexPath, indexPageData, pageCount);
                    log.debug(`Search index saved for OCR'd PDF at ${indexPath}.index.json`);
                } catch (indexErr) {
                    const indexErrMsg = indexErr instanceof Error ? indexErr.message : String(indexErr);
                    log.debug(`Warning: Failed to save search index: ${indexErrMsg}`);
                    // Non-blocking - don't fail OCR if index save fails
                }

                // For large PDFs (>50MB), save to temp file and return path instead of trying to serialize huge array
                if (mergedPdfBuffer.length > 50 * 1024 * 1024) {
                    const resultPath = join(tempDir, `ocr-result-${sessionId}.pdf`);
                    // File already written above
                    log.debug(`Large PDF saved to temp file: ${resultPath}`);
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
                log.debug(`PDF merge failed: ${mergeMsg}`);
                errors.push(`PDF merge failed: ${mergeMsg}`);
                return {
                    success: false,
                    pdfData: null,
                    errors, 
                };
            } finally {
                // Cleanup temp files safely without shell
                try {
                    const tempFiles = readdirSync(tempDir);
                    const sessionPrefix = `${sessionId}-`;
                    for (const file of tempFiles) {
                        if (file.startsWith(sessionPrefix) && file.endsWith('.pdf')) {
                            try {
                                unlinkSync(join(tempDir, file));
                            } catch {
                                // Ignore individual file cleanup errors
                            }
                        }
                    }
                    log.debug('Cleaned up temp files');
                } catch (cleanupErr) {
                    log.warn(`Cleanup warning: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
                }
            }
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.debug(`Error in page substitution: ${errMsg}`);
            errors.push(`Page substitution failed: ${errMsg}`);
            return {
                success: false,
                pdfData: null,
                errors, 
            };
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? err.stack : '';
        log.debug(`CRITICAL ERROR in handleOcrCreateSearchablePdf: ${errMsg}`);
        log.debug(`Stack: ${errStack}`);
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

        log.debug(`Preprocessing image: ${inputPath}`);
        const result = await preprocessPageForOcr(inputPath, outputPath);

        if (!result.success) {
            log.debug(`Preprocessing failed: ${result.error}`);
            return {
                success: false,
                imageData,
                error: result.error || 'Preprocessing failed',
            };
        }

        // Read preprocessed image
        const preprocessedBuffer = readFileSync(outputPath);
        const preprocessedData = Array.from(preprocessedBuffer);

        log.debug(`Preprocessing successful: ${inputPath} -> ${outputPath}`);

        // Cleanup temp files
        try {
            unlinkSync(inputPath);
        } catch (cleanupErr) {
            log.warn(`Cleanup warning (inputPath): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }
        try {
            unlinkSync(outputPath);
        } catch (cleanupErr) {
            log.warn(`Cleanup warning (outputPath): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
        }

        return {
            success: true,
            imageData: preprocessedData,
            message: 'Preprocessing complete',
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Preprocessing error: ${errMsg}`);
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
