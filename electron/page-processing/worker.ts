/**
 * Page Processing Worker Thread
 *
 * This worker handles all heavy page processing operations off the main Electron thread,
 * preventing UI freezing during long-running page processing operations like
 * splitting, dewarping, deskewing, and cropping.
 *
 * Communication protocol:
 * - Receives: { type: 'start', jobId, data: { pdfPath, pages, options } }
 * - Sends: { type: 'progress', jobId, progress: {...} }
 * - Sends: { type: 'complete', jobId, result: {...} }
 * - Sends: { type: 'log', level, message }
 */

import {
    parentPort,
    workerData,
} from 'worker_threads';
import { spawn } from 'child_process';
import {
    readFile,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    availableParallelism,
    cpus,
} from 'os';
import { extname, join } from 'path';
import type {
    IPageResult,
    IProcessingOptions,
    IProcessingProgress,
    IProcessingResult,
    TProcessingOperation,
} from '@electron/page-processing/types';

// Worker-local logger (no Electron dependencies)
function log(level: 'debug' | 'warn' | 'error', message: string) {
    const timestamp = new Date().toISOString();
    parentPort?.postMessage({
        type: 'log',
        level,
        message: `[${timestamp}] [page-processing-worker] ${message}`,
    });
}

let completionSent = false;
let lastStep = 'init';

function setStep(step: string) {
    lastStep = step;
    log('debug', `Step: ${step}`);
}

function sendComplete(result: IProcessingResult) {
    if (completionSent) {
        return;
    }
    completionSent = true;
    parentPort?.postMessage({
        type: 'complete',
        jobId: result.jobId,
        result,
    });
}

// Get paths and request from workerData (passed when worker is created)
const {
    processorBinary,
    pdftoppmBinary,
    qpdfBinary,
    tempDir,
    request,
} = workerData as {
    processorBinary: string;
    pdftoppmBinary: string;
    qpdfBinary: string;
    tempDir: string;
    request: {
        jobId: string;
        pdfPath: string;
        pages: number[];
        options: IProcessingOptions;
        workingCopyPath?: string;
    };
};

process.on('uncaughtException', (err) => {
    if (!request || completionSent) {
        return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    log('error', `Uncaught exception at step "${lastStep}": ${errMsg}`);
    sendComplete({
        jobId: request.jobId,
        success: false,
        pageResults: [],
        errors: [`Worker crashed: ${errMsg}`],
        stats: {
            totalPagesInput: request.pages?.length ?? 0,
            totalPagesOutput: 0,
            processingTimeMs: 0,
        },
    });
});

process.on('unhandledRejection', (reason) => {
    if (!request || completionSent) {
        return;
    }
    const errMsg = reason instanceof Error ? reason.message : String(reason);
    log('error', `Unhandled rejection at step "${lastStep}": ${errMsg}`);
    sendComplete({
        jobId: request.jobId,
        success: false,
        pageResults: [],
        errors: [`Worker crashed: ${errMsg}`],
        stats: {
            totalPagesInput: request.pages?.length ?? 0,
            totalPagesOutput: 0,
            processingTimeMs: 0,
        },
    });
});

// Debug: Log the paths received (using console for early debugging)
console.error('[pp-worker] Paths:', {
    processorBinary,
    pdftoppmBinary,
    qpdfBinary,
    tempDir, 
});
console.error('[pp-worker] Request:', request ? {
    jobId: request.jobId,
    pdfPath: request.pdfPath,
    pages: request.pages?.length, 
} : 'NULL');
log('debug', `Worker received paths: processor=${processorBinary}, pdftoppm=${pdftoppmBinary}, qpdf=${qpdfBinary}`);
log('debug', `Worker received request: jobId=${request?.jobId}, pdfPath=${request?.pdfPath}, pages=${request?.pages?.length}`);

interface IPythonProcessorResult {
    success: boolean;
    pageNumber: number;
    operationsApplied: TProcessingOperation[];
    detection: {
        wasFacingPages: boolean;
        skewAngle: number;
        curvatureScore: number;
        contentBounds: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
    };
    outputPaths: string[];
    outputSizes?: Array<{
        width: number;
        height: number;
    }>;
    notes: string[];
    error?: string;
}

function getCpuCount(): number {
    const count = typeof availableParallelism === 'function'
        ? availableParallelism()
        : cpus().length;
    return Math.max(1, count);
}

function parsePositiveInt(value: string | undefined): number | null {
    if (!value) {
        return null;
    }
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function getProcessingConcurrency(targetCount: number): number {
    const configured = parsePositiveInt(process.env.PAGE_PROCESSING_CONCURRENCY);
    if (configured) {
        return Math.max(1, Math.min(configured, targetCount));
    }
    const cpuCount = getCpuCount();
    // Page processing is CPU-intensive; use at most half the cores
    const defaultConcurrency = Math.min(Math.ceil(cpuCount / 2), 4);
    return Math.max(1, Math.min(defaultConcurrency, targetCount));
}

async function forEachConcurrent<T>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;

    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) {
                return;
            }
            await fn(items[index]!, index);
        }
    });

    await Promise.all(workers);
}

function getSequentialProgressPage(
    pages: number[],
    processedCount: number,
): number {
    if (pages.length === 0) {
        return 0;
    }
    const index = Math.min(Math.max(processedCount, 0), pages.length - 1);
    return pages[index] ?? 0;
}

async function runCommand(
    command: string,
    args: string[],
    options: {
        allowedExitCodes?: number[];
        timeout?: number;
    } = {},
): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    const {
        allowedExitCodes = [0],
        timeout = 120000,
    } = options;

    return new Promise((resolve, reject) => {
        log('debug', `Running command: ${command} ${args.join(' ')}`);
        const proc = spawn(command, args, {
            shell: false,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });

        let stdout = '';
        let stderr = '';
        let killed = false;

        const timeoutId = setTimeout(() => {
            killed = true;
            proc.kill('SIGKILL');
        }, timeout);

        proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('error', (err) => {
            clearTimeout(timeoutId);
            log('error', `Command error: ${command} ${err.message}`);
            reject(err);
        });

        proc.on('close', (code) => {
            clearTimeout(timeoutId);
            const exitCode = typeof code === 'number' ? code : -1;

            if (killed) {
                log('error', `Command timed out: ${command} ${args.join(' ')}`);
                reject(new Error(`${command} timed out after ${timeout}ms`));
                return;
            }

            if (!allowedExitCodes.includes(exitCode)) {
                log('error', `Command failed: ${command} (exit ${exitCode}) stderr=${stderr || ''}`);
                reject(new Error(`${command} failed with exit code ${exitCode}: ${stderr || stdout}`));
                return;
            }
            resolve({
                stdout,
                stderr,
                exitCode,
            });
        });
    });
}

async function writeImagePdf(
    imagePath: string,
    outputPath: string,
    outputDpi: number,
    pdfLib: typeof import('pdf-lib'),
): Promise<void> {
    const { PDFDocument } = pdfLib;
    const imageBytes = await readFile(imagePath);
    const ext = extname(imagePath).toLowerCase();

    const pdfDoc = await PDFDocument.create();
    let embeddedImage;
    if (ext === '.jpg' || ext === '.jpeg') {
        embeddedImage = await pdfDoc.embedJpg(imageBytes);
    } else {
        embeddedImage = await pdfDoc.embedPng(imageBytes);
    }

    const scale = outputDpi > 0 ? 72 / outputDpi : 72 / 300;
    const pageWidth = embeddedImage.width * scale;
    const pageHeight = embeddedImage.height * scale;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
    });

    const pdfBytes = await pdfDoc.save();
    await writeFile(outputPath, pdfBytes);
}

/**
 * Runs the Python page processor binary and parses JSON output.
 */
async function runPythonProcessor(
    imagePath: string,
    outputDir: string,
    pageNumber: number,
    options: IProcessingOptions,
): Promise<IPythonProcessorResult> {
    // Timeout for Python processor (2 minutes per page should be plenty)
    const PROCESSOR_TIMEOUT_MS = 120000;

    // Python CLI: page-processor process <input> <output_dir> [options]
    const args = [
        'process',           // subcommand
        imagePath,           // positional: input
        outputDir,           // positional: output_dir
        '--operations',
        ...options.operations, // space-separated, not comma
        '--crop-padding',
        String(options.cropPadding),
        '--min-skew-angle',
        String(options.minSkewAngle),
        '--min-curvature',
        String(options.minCurvatureThreshold),
    ];

    if (!options.autoDetectFacingPages) {
        args.push('--no-auto-detect');
    }
    if (options.forceSplit) {
        args.push('--force-split');
    }

    return new Promise((resolve) => {
        const proc = spawn(processorBinary, args, {
            shell: false,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });

        let stdout = '';
        let stderr = '';
        let killed = false;

        // Timeout to prevent infinite hangs
        const timeoutId = setTimeout(() => {
            killed = true;
            proc.kill('SIGKILL');
            log('warn', `Python processor timed out after ${PROCESSOR_TIMEOUT_MS}ms for page ${pageNumber}`);
        }, PROCESSOR_TIMEOUT_MS);

        proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('error', (err) => {
            clearTimeout(timeoutId);
            resolve({
                success: false,
                pageNumber,
                operationsApplied: [],
                detection: {
                    wasFacingPages: false,
                    skewAngle: 0,
                    curvatureScore: 0,
                    contentBounds: {
                        x: 0,
                        y: 0,
                        width: 0,
                        height: 0,
                    },
                },
                outputPaths: [],
                notes: [],
                error: err.message,
            });
        });

        proc.on('close', (code) => {
            clearTimeout(timeoutId);

            // Handle timeout case
            if (killed) {
                resolve({
                    success: false,
                    pageNumber,
                    operationsApplied: [],
                    detection: {
                        wasFacingPages: false,
                        skewAngle: 0,
                        curvatureScore: 0,
                        contentBounds: {
                            x: 0,
                            y: 0,
                            width: 0,
                            height: 0,
                        },
                    },
                    outputPaths: [],
                    notes: [],
                    error: `Processor timed out after ${PROCESSOR_TIMEOUT_MS}ms`,
                });
                return;
            }

            if (code !== 0) {
                resolve({
                    success: false,
                    pageNumber,
                    operationsApplied: [],
                    detection: {
                        wasFacingPages: false,
                        skewAngle: 0,
                        curvatureScore: 0,
                        contentBounds: {
                            x: 0,
                            y: 0,
                            width: 0,
                            height: 0,
                        },
                    },
                    outputPaths: [],
                    notes: [],
                    error: stderr || `Processor exited with code ${code}`,
                });
                return;
            }

            try {
                // Python outputs multiple JSON lines (progress + result)
                // Parse each line and find the result
                const lines = stdout.trim().split('\n');
                let resultData: Record<string, unknown> | null = null;

                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line) as Record<string, unknown>;
                        if (parsed.type === 'result') {
                            resultData = parsed;
                            break;
                        }
                    } catch {
                        // Skip non-JSON lines
                    }
                }

                if (!resultData) {
                    throw new Error('No result found in processor output');
                }

                // Optional profiling info from the processor (helps diagnose slow pages).
                const timings = (resultData.timings_ms as Record<string, unknown> | undefined);
                if (timings) {
                    try {
                        log('debug', `Processor timings for page ${pageNumber}: ${JSON.stringify(timings)}`);
                    } catch {
                        // Ignore JSON stringify failures
                    }
                }

                // Map Python output format to our interface
                const result: IPythonProcessorResult = {
                    success: resultData.success as boolean ?? true,
                    pageNumber,
                    operationsApplied: (resultData.operations_applied as TProcessingOperation[]) ?? [],
                    detection: {
                        wasFacingPages: (resultData.detection as Record<string, unknown>)?.was_facing_pages as boolean ?? false,
                        skewAngle: (resultData.detection as Record<string, unknown>)?.skew_angle as number ?? 0,
                        curvatureScore: (resultData.detection as Record<string, unknown>)?.curvature_score as number ?? 0,
                        contentBounds: {
                            x: ((resultData.detection as Record<string, unknown>)?.content_bounds as Record<string, number>)?.x ?? 0,
                            y: ((resultData.detection as Record<string, unknown>)?.content_bounds as Record<string, number>)?.y ?? 0,
                            width: ((resultData.detection as Record<string, unknown>)?.content_bounds as Record<string, number>)?.width ?? 0,
                            height: ((resultData.detection as Record<string, unknown>)?.content_bounds as Record<string, number>)?.height ?? 0,
                        },
                    },
                    outputPaths: (resultData.output_paths as string[]) ?? [],
                    outputSizes: (resultData.output_sizes as Array<{ width: number; height: number }> | undefined),
                    notes: [],
                };
                resolve({
                    ...result,
                    success: true,
                    pageNumber,
                });
            } catch (parseErr) {
                const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                resolve({
                    success: false,
                    pageNumber,
                    operationsApplied: [],
                    detection: {
                        wasFacingPages: false,
                        skewAngle: 0,
                        curvatureScore: 0,
                        contentBounds: {
                            x: 0,
                            y: 0,
                            width: 0,
                            height: 0,
                        },
                    },
                    outputPaths: [],
                    notes: [],
                    error: `Failed to parse processor output: ${parseMsg}`,
                });
            }
        });
    });
}

async function processJob(
    jobId: string,
    pdfPath: string,
    pages: number[],
    options: IProcessingOptions,
) {
    // Auto-crop is intentionally disabled. Keep the binary capable, but never run it from the app.
    const effectiveOptions: IProcessingOptions = {
        ...options,
        operations: options.operations.filter(op => op !== 'crop'),
    };
    // Make DPI handling foolproof:
    // - extractionDpi controls raster pixel dimensions (quality/perf tradeoff)
    // - outputDpi controls the PDF page physical size for those pixels
    // If they differ, the output PDF will look "scaled" even though pixels aren't downsampled.
    // We always keep them in sync to behave correctly for arbitrary DPIs.
    effectiveOptions.outputDpi = effectiveOptions.extractionDpi;

    const tempFiles = new Set<string>();
    const keepFiles = new Set<string>();

    const trackTempFile = (filePath: string) => {
        tempFiles.add(filePath);
        return filePath;
    };

    const sendProgress = (
        currentPage: number,
        currentOperation: TProcessingOperation | 'extracting' | 'merging',
        processedCount: number,
        totalPages: number,
        message: string,
    ) => {
        const progress: IProcessingProgress = {
            jobId,
            currentPage,
            currentOperation,
            processedCount,
            totalPages,
            percentage: Math.round((processedCount / totalPages) * 100),
            message,
        };
        parentPort?.postMessage({
            type: 'progress',
            jobId,
            progress,
        });
    };

    const startTime = Date.now();

    try {
        log('debug', `Processing job ${jobId}: pdf=${pdfPath}, pages=${pages.length}`);
        setStep('verify-pdf');

        const errors: string[] = [];
        const sessionId = `pp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const _sessionDir = join(tempDir, sessionId);

        // Verify PDF exists
        try {
            await stat(pdfPath);
        } catch {
            const errMsg = `PDF file not found: ${pdfPath}`;
            log('error', errMsg);
            sendComplete({
                jobId,
                success: false,
                pageResults: [],
                errors: [errMsg],
                stats: {
                    totalPagesInput: pages.length,
                    totalPagesOutput: 0,
                    processingTimeMs: Date.now() - startTime,
                },
            } satisfies IProcessingResult);
            return;
        }

        const pageResults: IPageResult[] = [];
        const processedPageImages: Map<number, string[]> = new Map();
        const processedImageSizes: Map<string, { width: number; height: number }> = new Map();

        const concurrency = getProcessingConcurrency(pages.length);
        log('debug', `Page processing: pages=${pages.length}, concurrency=${concurrency}`);
        setStep('extract-pages');

        let processedCount = 0;

        // Send initial progress
        sendProgress(
            pages[0] ?? 0,
            'extracting',
            0,
            pages.length,
            'Starting page extraction...',
        );

        // Step 1: Extract pages from PDF
        log('debug', 'Extracting pages from PDF...');
        const extractedPaths: Map<number, string> = new Map();

        for (const pageNum of pages) {
            const pageImagePath = trackTempFile(join(tempDir, `${sessionId}-page-${pageNum}.png`));

            try {
                await runCommand(pdftoppmBinary, [
                    '-png',
                    '-r',
                    String(options.extractionDpi),
                    '-f',
                    String(pageNum),
                    '-l',
                    String(pageNum),
                    '-singlefile',
                    pdfPath,
                    pageImagePath.replace(/\.png$/, ''),
                ]);

                extractedPaths.set(pageNum, pageImagePath);
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log('error', `Failed to extract page ${pageNum}: ${errMsg}`);
                errors.push(`Failed to extract page ${pageNum}: ${errMsg}`);
            }

            sendProgress(
                pageNum,
                'extracting',
                Math.floor(processedCount * 0.3), // Extraction is ~30% of work
                pages.length,
                `Extracted page ${pageNum}...`,
            );
        }

        // Step 2: Process each page through Python processor
        setStep('process-pages');
        log('debug', 'Processing pages...');

        await forEachConcurrent(pages, concurrency, async (pageNum) => {
            const imagePath = extractedPaths.get(pageNum);
            if (!imagePath) {
                return;
            }

            // Determine current operation for progress
            const currentOp = effectiveOptions.operations[0] ?? 'deskew';

            sendProgress(
                pageNum,
                currentOp,
                processedCount,
                pages.length,
                `Processing page ${pageNum}...`,
            );

            // Track output paths for cleanup decision (Python may overwrite input file)
            let resultOutputPaths: string[] = [];

            try {
                const result = await runPythonProcessor(
                    imagePath,
                    tempDir,
                    pageNum,
                    effectiveOptions,
                );

                if (result.success) {
                    resultOutputPaths = result.outputPaths;

                    // Track output files for later cleanup
                    for (const outputPath of result.outputPaths) {
                        trackTempFile(outputPath);
                    }

                    processedPageImages.set(pageNum, result.outputPaths);
                    if (result.outputSizes && result.outputSizes.length === result.outputPaths.length) {
                        for (let i = 0; i < result.outputPaths.length; i++) {
                            const p = result.outputPaths[i]!;
                            const s = result.outputSizes[i]!;
                            processedImageSizes.set(p, { width: s.width, height: s.height });
                        }
                    }

                    pageResults.push({
                        pageNumber: pageNum,
                        operationsApplied: result.operationsApplied,
                        detection: result.detection,
                        outputPageNumbers: result.outputPaths.map((_, idx) =>
                            result.detection.wasFacingPages ? pageNum * 2 - 1 + idx : pageNum),
                        notes: result.notes,
                    });
                } else {
                    errors.push(`Page ${pageNum}: ${result.error}`);
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log('error', `Failed to process page ${pageNum}: ${errMsg}`);
                errors.push(`Failed to process page ${pageNum}: ${errMsg}`);
            } finally {
                // Clean up extracted page image (only if not overwritten by processor output)
                // Python processor outputs to same path as input, so we must NOT delete if it's in outputPaths
                if (!resultOutputPaths.includes(imagePath)) {
                    try {
                        await unlink(imagePath);
                    } catch {
                        // Ignore cleanup errors
                    }
                }

                processedCount += 1;
                sendProgress(
                    getSequentialProgressPage(pages, processedCount),
                    effectiveOptions.operations[effectiveOptions.operations.length - 1] ?? 'deskew',
                    processedCount,
                    pages.length,
                    `Processed ${processedCount}/${pages.length} pages`,
                );
            }
        });

        // Sort page results by original page number
        pageResults.sort((a, b) => a.pageNumber - b.pageNumber);

        log('debug', `Processing done. pageResults=${pageResults.length}, errors=${errors.length}`);
        setStep('merge');

        // Step 2.5: Normalize output page sizes (symmetric white padding).
        //
        // User intent: after splitting a spread, resulting pages should have uniform WxH so the
        // PDF viewer doesn't "jump" and OCR pipelines see stable raster dimensions.
        //
        // We do this by padding *processed output images* to the max width/height across all
        // processed outputs in this job (no scaling, no cropping).
        if (processedPageImages.size > 0 && effectiveOptions.operations.includes('split')) {
            let maxW = 0;
            let maxH = 0;

            for (const p of processedImageSizes.values()) {
                maxW = Math.max(maxW, p.width);
                maxH = Math.max(maxH, p.height);
            }

            // Fallback if the processor didn't provide sizes (older binary).
            if (maxW <= 0 || maxH <= 0) {
                for (const images of processedPageImages.values()) {
                    for (const imagePath of images) {
                        try {
                            const det = await runCommand(processorBinary, ['detect', imagePath], { timeout: 60000 });
                            const resultLine = (det.stdout ?? '').trim().split('\n').find(l => l.includes('"type"') && l.includes('"result"')) ?? '';
                            const parsed = resultLine ? JSON.parse(resultLine) as Record<string, unknown> : null;
                            const size = (parsed && (parsed.size as Record<string, number> | undefined)) ?? null;
                            const w = size ? Number(size.width) : 0;
                            const h = size ? Number(size.height) : 0;
                            if (Number.isFinite(w) && Number.isFinite(h)) {
                                maxW = Math.max(maxW, w);
                                maxH = Math.max(maxH, h);
                                processedImageSizes.set(imagePath, { width: w, height: h });
                            }
                        } catch {
                            // Ignore and continue; padding will be skipped if we can't compute a target.
                        }
                    }
                }
            }

            if (maxW > 0 && maxH > 0) {
                let anyPad = false;
                for (const images of processedPageImages.values()) {
                    for (const imagePath of images) {
                        const s = processedImageSizes.get(imagePath);
                        if (!s) {
                            anyPad = true;
                            break;
                        }
                        if (s.width !== maxW || s.height !== maxH) {
                            anyPad = true;
                            break;
                        }
                    }
                    if (anyPad) {
                        break;
                    }
                }

                if (anyPad) {
                    log('debug', `Padding processed outputs to uniform size: ${maxW}x${maxH}`);

                    for (const [pageNum, images] of processedPageImages.entries()) {
                        const padded: string[] = [];
                        for (let i = 0; i < images.length; i++) {
                            const imagePath = images[i]!;
                            const s = processedImageSizes.get(imagePath);
                            if (s && s.width === maxW && s.height === maxH) {
                                padded.push(imagePath);
                                continue;
                            }

                            const paddedPath = trackTempFile(
                                join(tempDir, `${sessionId}-page-${pageNum}-${i + 1}__padded.png`),
                            );

                            await runCommand(
                                processorBinary,
                                [
                                    'pad',
                                    imagePath,
                                    paddedPath,
                                    '--width',
                                    String(maxW),
                                    '--height',
                                    String(maxH),
                                ],
                                { timeout: 120000 },
                            );
                            padded.push(paddedPath);
                            processedImageSizes.set(paddedPath, { width: maxW, height: maxH });
                        }

                        processedPageImages.set(pageNum, padded);
                    }
                }
            }
        }

        // Step 3: Merge processed pages into output PDF
        sendProgress(
            pages[pages.length - 1] ?? 0,
            'merging',
            pages.length,
            pages.length,
            'Merging pages into PDF...',
        );

        if (processedPageImages.size === 0) {
            sendComplete({
                jobId,
                success: false,
                pageResults: [],
                errors: errors.length > 0 ? errors : ['No pages were processed successfully'],
                stats: {
                    totalPagesInput: pages.length,
                    totalPagesOutput: 0,
                    processingTimeMs: Date.now() - startTime,
                },
            } satisfies IProcessingResult);
            return;
        }

        let pdfLibModule: typeof import('pdf-lib') | null = null;
        const loadPdfLib = async () => {
            if (!pdfLibModule) {
                pdfLibModule = await import('pdf-lib');
            }
            return pdfLibModule;
        };

        // Determine original PDF page count
        let pageCount = 0;
        let pageCountResolved = false;
        try {
            const pageCountResult = await runCommand(qpdfBinary, [
                '--show-npages',
                pdfPath,
            ]);
            const parsed = parseInt((pageCountResult.stdout ?? '').trim(), 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                pageCount = parsed;
                pageCountResolved = true;
            }
        } catch {
            // Fallback below
        }

        if (!pageCountResolved) {
            try {
                const { PDFDocument } = await loadPdfLib();
                const pdfBytes = await readFile(pdfPath);
                const pdfDoc = await PDFDocument.load(pdfBytes);
                const parsed = pdfDoc.getPageCount();
                if (Number.isFinite(parsed) && parsed > 0) {
                    pageCount = parsed;
                    pageCountResolved = true;
                }
            } catch {
                // Ignore and fall through to error
            }
        }

        if (!pageCountResolved || pageCount <= 0) {
            throw new Error('Failed to determine page count for source PDF');
        }
        log('debug', `Resolved page count: ${pageCount}`);

        // Convert processed images to single-page PDFs
        const processedPagePdfs = new Map<number, string[]>();
        const sortedPageNums = Array.from(processedPageImages.keys()).sort((a, b) => a - b);
        const outputPdfPath = trackTempFile(join(tempDir, `${sessionId}-output.pdf`));
        let mergedTotalPagesOutput = pageCount;

        try {
            const pdfLib = await loadPdfLib();

            for (const pageNum of sortedPageNums) {
                const images = processedPageImages.get(pageNum);
                if (!images) {
                    continue;
                }

                log('debug', `Converting page ${pageNum} (${images.length} image(s)) to PDF...`);
                const pagePdfPaths: string[] = [];
                for (let i = 0; i < images.length; i++) {
                    const imagePath = images[i]!;
                    const pagePdfPath = trackTempFile(
                        join(tempDir, `${sessionId}-page-${pageNum}-${i + 1}.pdf`),
                    );

                    await writeImagePdf(
                        imagePath,
                        pagePdfPath,
                        options.outputDpi,
                        pdfLib,
                    );

                    pagePdfPaths.push(pagePdfPath);
                }

                processedPagePdfs.set(pageNum, pagePdfPaths);
                mergedTotalPagesOutput += pagePdfPaths.length - 1;
            }

            // Update output page numbering to match merged PDF ordering
            const outputPageMap = new Map<number, number[]>();
            let outputIndex = 1;
            for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
                const replacement = processedPagePdfs.get(pageNum);
                if (replacement) {
                    const mapped = Array.from({ length: replacement.length }, (_, i) => outputIndex + i);
                    outputPageMap.set(pageNum, mapped);
                    outputIndex += replacement.length;
                } else {
                    outputIndex += 1;
                }
            }
            for (const result of pageResults) {
                const mapped = outputPageMap.get(result.pageNumber);
                if (mapped) {
                    result.outputPageNumbers = mapped;
                }
            }

            // Merge processed pages with original PDF using qpdf --pages
            const qpdfArgs = [
                '--empty',
                '--pages',
            ];

            let rangeStart = 1;
            for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
                const replacement = processedPagePdfs.get(pageNum);
                if (replacement) {
                    if (rangeStart <= pageNum - 1) {
                        const range = rangeStart === pageNum - 1
                            ? `${rangeStart}`
                            : `${rangeStart}-${pageNum - 1}`;
                        qpdfArgs.push(pdfPath, range);
                    }

                    for (const processedPdf of replacement) {
                        qpdfArgs.push(processedPdf, '1');
                    }

                    rangeStart = pageNum + 1;
                }
            }

            if (rangeStart <= pageCount) {
                const range = rangeStart === pageCount
                    ? `${rangeStart}`
                    : `${rangeStart}-${pageCount}`;
                qpdfArgs.push(pdfPath, range);
            }

            if (qpdfArgs.length === 2) {
                throw new Error('No pages available to merge');
            }

            qpdfArgs.push('--', outputPdfPath);

            log('debug', `Merging PDF with qpdf (args=${qpdfArgs.length})`);
            await runCommand(qpdfBinary, qpdfArgs, { allowedExitCodes: [
                0,
                3,
            ] });
        } catch (mergeErr) {
            const errMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
            log('error', `Merge failed: ${errMsg}`);
            errors.push(`Failed to merge pages into PDF: ${errMsg}`);
            sendComplete({
                jobId,
                success: false,
                pageResults,
                errors,
                stats: {
                    totalPagesInput: pages.length,
                    totalPagesOutput: 0,
                    processingTimeMs: Date.now() - startTime,
                },
            } satisfies IProcessingResult);
            return;
        }

        const totalPagesOutput = mergedTotalPagesOutput;

        // Always return a file path. Returning `pdfData: number[]` is extremely memory-hungry
        // (Array.from(Buffer) can explode memory for multi-page PDFs).
        keepFiles.add(outputPdfPath);

        try {
            const outputStats = await stat(outputPdfPath);
            log('debug', `Merged PDF size: ${outputStats.size} bytes`);
        } catch {
            // Non-blocking; output still exists or qpdf would have failed earlier.
        }

        sendComplete({
            jobId,
            success: true,
            pdfPath: outputPdfPath,
            pageResults,
            errors,
            stats: {
                totalPagesInput: pages.length,
                totalPagesOutput,
                processingTimeMs: Date.now() - startTime,
            },
        } satisfies IProcessingResult);
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log('error', `CRITICAL ERROR in processJob: ${errMsg}`);
        sendComplete({
            jobId,
            success: false,
            pageResults: [],
            errors: [`Critical error: ${errMsg}`],
            stats: {
                totalPagesInput: pages.length,
                totalPagesOutput: 0,
                processingTimeMs: Date.now() - startTime,
            },
        } satisfies IProcessingResult);
    } finally {
        // Cleanup temp files
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

// Auto-start processing from workerData (request is passed when worker is created)
try {
    if (request) {
        log('debug', 'Page processing worker starting job from workerData');
        processJob(
            request.jobId,
            request.pdfPath,
            request.pages,
            request.options,
        ).catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            log('error', `Unhandled error in processJob: ${errMsg}`);
            // Send failure completion so UI knows processing failed
            sendComplete({
                jobId: request.jobId,
                success: false,
                pageResults: [],
                errors: [`Processing failed: ${errMsg}`],
                stats: {
                    totalPagesInput: request.pages?.length ?? 0,
                    totalPagesOutput: 0,
                    processingTimeMs: 0,
                },
            } satisfies IProcessingResult);
        });
    } else {
        log('error', 'No request in workerData - worker has nothing to process');
    }
} catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log('error', `FATAL: Worker startup error: ${errMsg}`);
}
