/**
 * OCR Worker Thread
 *
 * This worker handles all heavy OCR processing off the main Electron thread,
 * preventing UI freezing during long-running OCR operations.
 *
 * Communication protocol:
 * - Receives: { type: 'start', jobId, data: { originalPdfData, pages, workingCopyPath } }
 * - Sends: { type: 'progress', jobId, progress: {...} }
 * - Sends: { type: 'complete', jobId, result: {...} }
 * - Sends: { type: 'log', level, message }
 */

import {
    parentPort,
    workerData,
} from 'worker_threads';
import {
    readFile,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { uniq } from 'es-toolkit/array';
import {
    forEachConcurrent,
    getOcrConcurrency,
    getSequentialProgressPage,
    getTesseractThreadLimit,
} from '../../utils/concurrency';
import type {
    IOcrPageWithWords,
    IOcrPdfPageRequest,
    IWorkerPaths,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import {
    clampDpi,
    detectSourceDpi,
} from '@electron/ocr/worker/dpi-detection';
import {
    getPngDimensions,
    runOcrFileBased,
} from '@electron/ocr/worker/tesseract-runner';
import {
    assembleSearchablePdf,
    getPageCount,
} from '@electron/ocr/worker/pdf-assembler';
import {
    writeOcrIndexV1,
    writeOcrIndexV2,
} from '@electron/ocr/worker/index-writer';
import { runCommand } from '@electron/ocr/worker/run-command';

const paths = workerData as IWorkerPaths;

const log: TWorkerLog = (level, message) => {
    const timestamp = new Date().toISOString();
    parentPort?.postMessage({
        type: 'log',
        level,
        message: `[${timestamp}] [ocr-worker] ${message}`,
    });
};

function sendProgress(jobId: string, currentPage: number, processedCount: number, totalPages: number) {
    parentPort?.postMessage({
        type: 'progress',
        jobId,
        progress: {
            requestId: jobId,
            currentPage,
            processedCount,
            totalPages,
        },
    });
}

function sendComplete(jobId: string, result: {
    success: boolean;
    pdfData: Uint8Array | null;
    pdfPath?: string;
    errors: string[];
}) {
    const normalizedPdfData = result.pdfData
        ? (result.pdfData.buffer instanceof ArrayBuffer ? result.pdfData : result.pdfData.slice())
        : null;
    const transferList: ArrayBuffer[] = [];
    if (normalizedPdfData && normalizedPdfData.buffer instanceof ArrayBuffer) {
        transferList.push(normalizedPdfData.buffer);
    }
    parentPort?.postMessage({
        type: 'complete',
        jobId,
        result: {
            ...result,
            pdfData: normalizedPdfData,
        },
    }, transferList);
}

async function processOcrJob(
    jobId: string,
    originalPdfData: Uint8Array,
    pages: IOcrPdfPageRequest[],
    workingCopyPath?: string,
    renderDpi?: number,
) {
    const tempFiles = new Set<string>();
    const keepFiles = new Set<string>();

    const trackTempFile = (filePath: string) => {
        tempFiles.add(filePath);
        return filePath;
    };

    try {
        log('debug', `Processing OCR job ${jobId}: pdfLen=${originalPdfData.length}, pages=${pages.length}`);

        const errors: string[] = [];
        const sessionId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const originalPdfPath = trackTempFile(join(paths.tempDir, `${sessionId}-original.pdf`));
        await writeFile(originalPdfPath, originalPdfData);
        const writtenFileSize = (await stat(originalPdfPath)).size;

        if (writtenFileSize !== originalPdfData.length) {
            const errMsg = `PDF file size mismatch: wrote ${writtenFileSize} bytes but expected ${originalPdfData.length}`;
            log('debug', `ERROR: ${errMsg}`);
            sendComplete(jobId, {
                success: false,
                pdfData: null,
                errors: [errMsg],
            });
            return;
        }

        const ocrPageData: IOcrPageWithWords[] = [];
        const ocrPdfMap: Map<number, string> = new Map();

        const targetPages = pages.filter((p): p is IOcrPdfPageRequest => !!p);
        const detectedDpi = renderDpi ?? await detectSourceDpi(originalPdfPath, paths.pdfimagesBinary, log);
        const extractionDpi = clampDpi(detectedDpi ?? 300);
        const concurrency = getOcrConcurrency(targetPages.length);
        const tesseractThreads = getTesseractThreadLimit(concurrency);

        log('debug', `OCR PDF: pages=${targetPages.length}, dpi=${extractionDpi}, concurrency=${concurrency}, threads=${tesseractThreads}`);

        let processedCount = 0;

        sendProgress(jobId, targetPages[0]?.pageNumber ?? 0, 0, targetPages.length);

        await forEachConcurrent(targetPages, concurrency, async (page) => {
            log('debug', `Processing page ${page.pageNumber}`);

            const pageImagePath = trackTempFile(join(paths.tempDir, `${sessionId}-page-${page.pageNumber}.png`));

            try {
                await runCommand(paths.pdftoppmBinary, [
                    '-png',
                    '-r',
                    String(extractionDpi),
                    '-f',
                    String(page.pageNumber),
                    '-l',
                    String(page.pageNumber),
                    '-singlefile',
                    originalPdfPath,
                    pageImagePath.replace(/\.png$/, ''),
                ]);

                const imageBuffer = await readFile(pageImagePath);

                let imageWidth = 0;
                let imageHeight = 0;

                const dims = getPngDimensions(imageBuffer);
                if (dims) {
                    imageWidth = dims.width;
                    imageHeight = dims.height;
                } else {
                    throw new Error('Failed to determine PNG dimensions from pdftoppm output');
                }

                if (imageWidth <= 0 || imageHeight <= 0) {
                    throw new Error(`Invalid page image dimensions: ${imageWidth}x${imageHeight}`);
                }

                const ocrResult = await runOcrFileBased(
                    pageImagePath,
                    page.languages,
                    imageWidth,
                    imageHeight,
                    extractionDpi,
                    paths.tesseractBinary,
                    paths.tessdataPath,
                    tesseractThreads,
                );

                if (ocrResult.success && ocrResult.pageData) {
                    ocrPageData.push({
                        pageNumber: page.pageNumber,
                        words: ocrResult.pageData.words,
                        text: ocrResult.pageData.text,
                        imageWidth: ocrResult.pageData.imageWidth,
                        imageHeight: ocrResult.pageData.imageHeight,
                    });

                    if (ocrResult.pdfPath) {
                        trackTempFile(ocrResult.pdfPath);
                        ocrPdfMap.set(page.pageNumber, ocrResult.pdfPath);
                    } else {
                        errors.push(`Page ${page.pageNumber}: Tesseract did not produce PDF output`);
                    }
                } else {
                    errors.push(`Page ${page.pageNumber}: ${ocrResult.error}`);
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log('debug', `Failed to process page ${page.pageNumber}: ${errMsg}`);
                errors.push(`Failed to process page ${page.pageNumber}: ${errMsg}`);
            } finally {
                try {
                    await unlink(pageImagePath);
                } catch {
                    // Ignore cleanup errors
                }

                processedCount += 1;
                sendProgress(
                    jobId,
                    getSequentialProgressPage(targetPages, processedCount),
                    processedCount,
                    targetPages.length,
                );
            }
        });

        ocrPageData.sort((a, b) => a.pageNumber - b.pageNumber);

        log('debug', `OCR done. ocrPageData=${ocrPageData.length}, ocrPdfMap=${ocrPdfMap.size}, errors=${errors.length}`);

        sendProgress(
            jobId,
            targetPages[targetPages.length - 1]?.pageNumber ?? 0,
            targetPages.length,
            targetPages.length,
        );

        if (ocrPageData.length === 0 || ocrPdfMap.size === 0) {
            sendComplete(jobId, {
                success: false,
                pdfData: null,
                errors,
            });
            return;
        }

        const ocrPageNumbers = Array.from(ocrPdfMap.keys()).sort((a, b) => a - b);
        const maxOcrPage = ocrPageNumbers[ocrPageNumbers.length - 1] ?? 1;
        const pageCount = await getPageCount(paths.qpdfBinary, originalPdfPath, maxOcrPage);

        let mergedPdfPath: string;
        try {
            mergedPdfPath = await assembleSearchablePdf(
                originalPdfPath,
                ocrPdfMap,
                pageCount,
                paths.tempDir,
                sessionId,
                paths.qpdfBinary,
                log,
                trackTempFile,
            );
        } catch (qpdfErr) {
            const errMsg = qpdfErr instanceof Error ? qpdfErr.message : String(qpdfErr);
            errors.push(`Failed to merge OCR'd pages with original PDF: ${errMsg}`);
            sendComplete(jobId, {
                success: false,
                pdfData: null,
                errors,
            });
            return;
        }

        const mergedPdfBuffer = await readFile(mergedPdfPath);
        const allLanguages = uniq(targetPages.flatMap(p => p.languages));

        if (workingCopyPath) {
            try {
                await writeOcrIndexV2(
                    workingCopyPath,
                    ocrPageData,
                    pageCount,
                    allLanguages,
                    extractionDpi,
                    log,
                );
            } catch (v2Err) {
                const v2ErrMsg = v2Err instanceof Error ? v2Err.message : String(v2Err);
                log('warn', `Failed to write OCR index v2: ${v2ErrMsg}`);
            }
        }

        const indexPath = workingCopyPath || originalPdfPath;
        try {
            await writeOcrIndexV1(indexPath, ocrPageData, pageCount);
            if (!workingCopyPath) {
                trackTempFile(`${indexPath}.index.json`);
            }
        } catch {
            // Non-blocking - don't fail OCR if index save fails
        }

        if (mergedPdfBuffer.length > 50 * 1024 * 1024) {
            keepFiles.add(mergedPdfPath);
            sendComplete(jobId, {
                success: true,
                pdfData: null,
                pdfPath: mergedPdfPath,
                errors,
            });
        } else {
            sendComplete(jobId, {
                success: true,
                pdfData: new Uint8Array(mergedPdfBuffer),
                errors,
            });
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log('debug', `CRITICAL ERROR in processOcrJob: ${errMsg}`);
        sendComplete(jobId, {
            success: false,
            pdfData: null,
            errors: [`Critical error: ${errMsg}`],
        });
    } finally {
        for (const filePath of tempFiles) {
            if (keepFiles.has(filePath)) {
                continue;
            }
            try {
                await unlink(filePath);
            } catch {
                // Ignore cleanup errors
            }
        }
    }
}

parentPort?.on('message', async (message: {
    type: 'start';
    jobId: string;
    data: {
        originalPdfData: Uint8Array;
        pages: IOcrPdfPageRequest[];
        workingCopyPath?: string;
        renderDpi?: number;
    };
}) => {
    if (message.type === 'start') {
        await processOcrJob(
            message.jobId,
            message.data.originalPdfData,
            message.data.pages,
            message.data.workingCopyPath,
            message.data.renderDpi,
        );
    }
});

log('debug', 'OCR worker initialized and ready');
