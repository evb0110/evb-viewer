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
 * - Sends: { type: 'error', jobId, error: string }
 */

import { parentPort, workerData } from 'worker_threads';
import { spawn } from 'child_process';
import {
    existsSync,
    readFileSync,
} from 'fs';
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
import { join } from 'path';
import type { IOcrWord } from '../../app/types/shared';

// Worker-local logger (no Electron dependencies)
function log(level: 'debug' | 'warn' | 'error', message: string) {
    const timestamp = new Date().toISOString();
    parentPort?.postMessage({
        type: 'log',
        level,
        message: `[${timestamp}] [ocr-worker] ${message}`,
    });
}

// Get paths from workerData (passed when worker is created)
const {
    tesseractBinary,
    tessdataPath,
    tempDir,
} = workerData as {
    tesseractBinary: string;
    tessdataPath: string;
    tempDir: string;
};

const PNG_SIGNATURE = Buffer.from([
    0x89,
    0x50,
    0x4E,
    0x47,
    0x0D,
    0x0A,
    0x1A,
    0x0A,
]);

interface IOcrPdfPageRequest {
    pageNumber: number;
    languages: string[];
}

interface IOcrPageWithWords {
    pageNumber: number;
    words: IOcrWord[];
    text: string;
    imageWidth: number;
    imageHeight: number;
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

function getCpuCount(): number {
    const count = typeof availableParallelism === 'function'
        ? availableParallelism()
        : cpus().length;
    return Math.max(1, count);
}

function getOcrConcurrency(targetCount: number): number {
    const configured = parsePositiveInt(process.env.OCR_CONCURRENCY);
    if (configured) {
        return Math.max(1, Math.min(configured, targetCount));
    }
    const cpuCount = getCpuCount();
    const defaultConcurrency = Math.min(cpuCount, 8);
    return Math.max(1, Math.min(defaultConcurrency, targetCount));
}

function getTesseractThreadLimit(concurrency: number): number {
    const configured = parsePositiveInt(process.env.OCR_TESSERACT_THREADS);
    if (configured) {
        return configured;
    }
    const cpuCount = getCpuCount();
    return Math.max(1, Math.floor(cpuCount / Math.max(1, concurrency)));
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

function getPngDimensions(imageBuffer: Buffer): { width: number; height: number } | null {
    if (imageBuffer.length < 24) {
        return null;
    }
    if (!imageBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return null;
    }
    const width = imageBuffer.readUInt32BE(16);
    const height = imageBuffer.readUInt32BE(20);
    if (width <= 0 || height <= 0) {
        return null;
    }
    return { width, height };
}

function getSequentialProgressPage(
    pages: Array<{ pageNumber: number }>,
    processedCount: number,
): number {
    if (pages.length === 0) {
        return 0;
    }
    const index = Math.min(Math.max(processedCount, 0), pages.length - 1);
    return pages[index]?.pageNumber ?? 0;
}

function buildTesseractEnv(threads?: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        TESSDATA_PREFIX: tessdataPath,
    };
    if (typeof threads === 'number' && Number.isFinite(threads) && threads > 0) {
        env.OMP_THREAD_LIMIT = String(Math.floor(threads));
        env.OMP_NUM_THREADS = String(Math.floor(threads));
    }
    return env;
}

async function runCommand(
    command: string,
    args: string[],
    options: { allowedExitCodes?: number[] } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { allowedExitCodes = [0] } = options;

    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('error', (err) => {
            reject(err);
        });

        proc.on('close', (code) => {
            const exitCode = typeof code === 'number' ? code : -1;
            if (!allowedExitCodes.includes(exitCode)) {
                reject(new Error(`${command} failed with exit code ${exitCode}: ${stderr || stdout}`));
                return;
            }
            resolve({ stdout, stderr, exitCode });
        });
    });
}

async function runOcrWithBoundingBoxes(
    imageBuffer: Buffer,
    languages: string[],
    imageWidth: number,
    imageHeight: number,
    threads?: number,
): Promise<{
    success: boolean;
    pageData: IOcrPageWithWords | null;
    error?: string;
}> {
    const args = [
        'stdin',
        'stdout',
        '-l',
        languages.join('+'),
        '--tessdata-dir',
        tessdataPath,
        '-c', 'preserve_interword_spaces=1',
        '-c', 'textord_words_default_minspace=0.3',
        '-c', 'textord_words_min_minspace=0.2',
        '-c', 'tosp_fuzzy_space_factor=0.5',
        '-c', 'tosp_min_sane_kn_sp=1.2',
        '-c', 'tosp_kern_gap_factor1=1.5',
        '-c', 'tosp_kern_gap_factor2=1.0',
        '-c', 'load_system_dawg=0',
        '-c', 'load_freq_dawg=0',
        '-c', 'tessedit_create_tsv=1',
    ];

    return new Promise((resolve) => {
        const proc = spawn(tesseractBinary, args, { env: buildTesseractEnv(threads) });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                try {
                    const tsvContent = stdout.trim();
                    const words = parseTsvOutput(tsvContent);
                    const pageText = parseTsvText(tsvContent);

                    resolve({
                        success: true,
                        pageData: {
                            pageNumber: 0,
                            words,
                            text: pageText,
                            imageWidth,
                            imageHeight,
                        },
                    });
                } catch (parseErr) {
                    const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                    resolve({
                        success: false,
                        pageData: null,
                        error: parseMsg,
                    });
                }
                return;
            }

            resolve({
                success: false,
                pageData: null,
                error: stderr || `Tesseract exited with code ${code}`,
            });
        });

        proc.on('error', (err) => {
            resolve({
                success: false,
                pageData: null,
                error: err.message,
            });
        });

        proc.stdin.write(imageBuffer);
        proc.stdin.end();
    });
}

function parseTsvOutput(tsvContent: string): IOcrWord[] {
    const lines = tsvContent.trim().split('\n');
    if (lines.length < 2) {
        return [];
    }

    const words: IOcrWord[] = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;

        const parts = line.split('\t');
        if (parts.length < 12) continue;

        const level = parseInt(parts[0]!, 10);
        if (level !== 5) continue;

        const left = parseInt(parts[6]!, 10);
        const top = parseInt(parts[7]!, 10);
        const width = parseInt(parts[8]!, 10);
        const height = parseInt(parts[9]!, 10);
        const confidence = parseInt(parts[10]!, 10);
        const text = parts[11] || '';

        if (confidence < 20) continue;
        if (width <= 0 || height <= 0) continue;

        words.push({
            text: text.trim(),
            x: left,
            y: top,
            width,
            height,
        });
    }

    return words;
}

function parseTsvText(tsvContent: string): string {
    const lines = tsvContent.trim().split('\n');
    if (lines.length < 2) {
        return '';
    }

    const outputLines: string[] = [];
    let currentLineKey: string | null = null;
    let currentWords: string[] = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;

        const parts = line.split('\t');
        if (parts.length < 12) continue;

        const level = parseInt(parts[0]!, 10);
        if (level !== 5) continue;

        const blockNum = parts[2] || '0';
        const parNum = parts[3] || '0';
        const lineNum = parts[4] || '0';
        const lineKey = `${blockNum}-${parNum}-${lineNum}`;

        const text = (parts[11] || '').trim();
        if (!text) continue;

        if (currentLineKey !== null && lineKey !== currentLineKey) {
            if (currentWords.length > 0) {
                outputLines.push(currentWords.join(' '));
            }
            currentWords = [];
        }

        currentLineKey = lineKey;
        currentWords.push(text);
    }

    if (currentWords.length > 0) {
        outputLines.push(currentWords.join(' '));
    }

    return outputLines.join('\n').trim();
}

// Unicode font loading for PDF text layer
const UNICODE_FONT_PATHS = [
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/System/Library/Fonts/AppleSDGothicNeo.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
];

let cachedFontData: Uint8Array | null = null;

function loadUnicodeFontSync(): Uint8Array | null {
    if (cachedFontData) {
        return cachedFontData;
    }

    for (const fontPath of UNICODE_FONT_PATHS) {
        if (existsSync(fontPath)) {
            try {
                cachedFontData = readFileSync(fontPath);
                log('debug', `Loaded Unicode font from ${fontPath}`);
                return cachedFontData;
            } catch {
                continue;
            }
        }
    }

    log('warn', 'No Unicode font found, text layer may have limited character support');
    return null;
}

/**
 * Creates a text-layer-only PDF (no image) for overlay onto original pages.
 * This preserves original PDF structure including bookmarks.
 */
async function createTextLayerOnlyPdf(
    words: IOcrWord[],
    imageWidth: number,
    imageHeight: number,
    extractionDpi: number,
): Promise<{ success: boolean; pdfBuffer: Buffer | null; error?: string }> {
    const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');

    try {
        const scale = 72 / extractionDpi;
        const pdfWidth = imageWidth * scale;
        const pdfHeight = imageHeight * scale;

        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([pdfWidth, pdfHeight]);

        // No image - this is a text-only overlay

        // Load font for text layer
        const fontData = loadUnicodeFontSync();
        let font;
        if (fontData) {
            try {
                font = await pdfDoc.embedFont(fontData, { subset: true });
            } catch {
                font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            }
        } else {
            font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }

        // Add invisible text layer
        for (const word of words) {
            if (!word.text.trim()) continue;

            const x = word.x * scale;
            const y = pdfHeight - (word.y + word.height) * scale;
            const targetHeight = word.height * scale;
            const fontSize = Math.max(1, Math.min(targetHeight * 0.9, 72));

            try {
                page.drawText(word.text, {
                    x,
                    y,
                    size: fontSize,
                    font,
                    color: rgb(0, 0, 0),
                    opacity: 0,
                });
            } catch {
                // Skip words that can't be rendered
            }
        }

        const pdfBytes = await pdfDoc.save();
        return {
            success: true,
            pdfBuffer: Buffer.from(pdfBytes),
        };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            pdfBuffer: null,
            error: errMsg,
        };
    }
}

async function processOcrJob(
    jobId: string,
    originalPdfData: Uint8Array,
    pages: IOcrPdfPageRequest[],
    workingCopyPath?: string,
) {
    const tempFiles = new Set<string>();
    const keepFiles = new Set<string>();

    const trackTempFile = (filePath: string) => {
        tempFiles.add(filePath);
        return filePath;
    };

    const sendProgress = (currentPage: number, processedCount: number, totalPages: number) => {
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
    };

    try {
        log('debug', `Processing OCR job ${jobId}: pdfLen=${originalPdfData.length}, pages=${pages.length}`);

        const errors: string[] = [];
        const sessionId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // Write original PDF to temp file
        const originalPdfPath = trackTempFile(join(tempDir, `${sessionId}-original.pdf`));
        await writeFile(originalPdfPath, originalPdfData);
        const writtenFileSize = (await stat(originalPdfPath)).size;

        if (writtenFileSize !== originalPdfData.length) {
            const errMsg = `PDF file size mismatch: wrote ${writtenFileSize} bytes but expected ${originalPdfData.length}`;
            log('debug', `ERROR: ${errMsg}`);
            parentPort?.postMessage({
                type: 'complete',
                jobId,
                result: {
                    success: false,
                    pdfData: null,
                    errors: [errMsg],
                },
            });
            return;
        }

        const ocrPageData: IOcrPageWithWords[] = [];
        const ocrPdfMap: Map<number, string> = new Map();

        const targetPages = pages.filter((p): p is IOcrPdfPageRequest => !!p);
        const extractionDpi = 150;
        const concurrency = getOcrConcurrency(targetPages.length);
        const tesseractThreads = getTesseractThreadLimit(concurrency);

        log('debug', `OCR PDF: pages=${targetPages.length}, dpi=${extractionDpi}, concurrency=${concurrency}, threads=${tesseractThreads}`);

        let processedCount = 0;

        // Send initial progress
        sendProgress(targetPages[0]?.pageNumber ?? 0, 0, targetPages.length);

        await forEachConcurrent(targetPages, concurrency, async (page) => {
            log('debug', `Processing page ${page.pageNumber}`);

            const pageImagePath = trackTempFile(join(tempDir, `${sessionId}-page-${page.pageNumber}.png`));

            try {
                // Extract page image from PDF
                await runCommand('pdftoppm', [
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
                    const identifyResult = await runCommand('identify', [
                        '-format',
                        '%wx%h',
                        pageImagePath,
                    ]);
                    const identifyOutput = (identifyResult.stdout ?? '').trim();
                    const [widthStr, heightStr] = identifyOutput.split('x');
                    imageWidth = parseInt(widthStr ?? '0', 10);
                    imageHeight = parseInt(heightStr ?? '0', 10);
                }

                if (imageWidth <= 0 || imageHeight <= 0) {
                    throw new Error(`Invalid page image dimensions: ${imageWidth}x${imageHeight}`);
                }

                const ocrResult = await runOcrWithBoundingBoxes(
                    imageBuffer,
                    page.languages,
                    imageWidth,
                    imageHeight,
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

                    const pdfResult = await createTextLayerOnlyPdf(
                        ocrResult.pageData.words,
                        imageWidth,
                        imageHeight,
                        extractionDpi,
                    );

                    if (pdfResult.success && pdfResult.pdfBuffer) {
                        const ocrPdfPath = trackTempFile(join(tempDir, `${sessionId}-ocr-page-${page.pageNumber}.pdf`));
                        await writeFile(ocrPdfPath, pdfResult.pdfBuffer);
                        ocrPdfMap.set(page.pageNumber, ocrPdfPath);
                    } else {
                        errors.push(`Failed to generate PDF for page ${page.pageNumber}: ${pdfResult.error}`);
                    }
                } else {
                    errors.push(`Page ${page.pageNumber}: ${ocrResult.error}`);
                }
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                log('debug', `Failed to process page ${page.pageNumber}: ${errMsg}`);
                errors.push(`Failed to process page ${page.pageNumber}: ${errMsg}`);
            } finally {
                // Cleanup extracted page image
                try {
                    await unlink(pageImagePath);
                } catch {
                    // Ignore cleanup errors
                }

                processedCount += 1;
                sendProgress(
                    getSequentialProgressPage(targetPages, processedCount),
                    processedCount,
                    targetPages.length,
                );
            }
        });

        ocrPageData.sort((a, b) => a.pageNumber - b.pageNumber);

        log('debug', `OCR done. ocrPageData=${ocrPageData.length}, ocrPdfMap=${ocrPdfMap.size}, errors=${errors.length}`);

        // Send final progress
        sendProgress(
            targetPages[targetPages.length - 1]?.pageNumber ?? 0,
            targetPages.length,
            targetPages.length,
        );

        if (ocrPageData.length === 0 || ocrPdfMap.size === 0) {
            parentPort?.postMessage({
                type: 'complete',
                jobId,
                result: {
                    success: false,
                    pdfData: null,
                    errors,
                },
            });
            return;
        }

        // Merge OCR'd pages with original PDF using qpdf
        const mergedPdfPath = trackTempFile(join(tempDir, `${sessionId}-merged.pdf`));
        const ocrPageNumbers = Array.from(ocrPdfMap.keys()).sort((a, b) => a - b);
        const maxOcrPage = ocrPageNumbers[ocrPageNumbers.length - 1] ?? 1;

        let pageCount = maxOcrPage;
        try {
            const pageCountResult = await runCommand('qpdf', [
                '--show-npages',
                originalPdfPath,
            ]);
            const parsed = parseInt((pageCountResult.stdout ?? '').trim(), 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                pageCount = parsed;
            }
        } catch {
            // Use fallback
        }

        try {
            // Use overlay approach instead of page replacement to preserve bookmarks
            // Original page objects remain intact, so bookmark references stay valid
            log('debug', `Overlaying ${ocrPageNumbers.length} text layers onto original PDF`);

            // Build a single multi-page overlay PDF to minimize qpdf calls
            const { PDFDocument } = await import('pdf-lib');
            const overlayDoc = await PDFDocument.create();

            // For each page position (1 to pageCount), add either OCR text layer or blank page
            for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
                const ocrPath = ocrPdfMap.get(pageNum);
                if (ocrPath) {
                    // Load and copy the text layer page
                    const ocrPdfBytes = await readFile(ocrPath);
                    const ocrPdf = await PDFDocument.load(ocrPdfBytes);
                    const [copiedPage] = await overlayDoc.copyPages(ocrPdf, [0]);
                    overlayDoc.addPage(copiedPage);
                } else {
                    // Add a minimal blank page (will be transparent overlay)
                    overlayDoc.addPage([1, 1]); // Minimal size - qpdf scales overlay to match
                }
            }

            const overlayPdfPath = trackTempFile(join(tempDir, `${sessionId}-overlay.pdf`));
            const overlayBytes = await overlayDoc.save();
            await writeFile(overlayPdfPath, overlayBytes);

            // Single qpdf overlay command - preserves original structure including bookmarks
            await runCommand('qpdf', [
                originalPdfPath,
                '--overlay', overlayPdfPath, '--',
                '--', mergedPdfPath,
            ], { allowedExitCodes: [0, 3] });
        } catch (qpdfErr) {
            const errMsg = qpdfErr instanceof Error ? qpdfErr.message : String(qpdfErr);
            errors.push(`Failed to merge OCR'd pages with original PDF: ${errMsg}`);
            parentPort?.postMessage({
                type: 'complete',
                jobId,
                result: {
                    success: false,
                    pdfData: null,
                    errors,
                },
            });
            return;
        }

        const mergedPdfBuffer = await readFile(mergedPdfPath);

        // Save OCR index
        const indexPageData = ocrPageData.map(pd => ({
            pageNumber: pd.pageNumber,
            words: pd.words,
            text: pd.text,
            pageWidth: pd.imageWidth,
            pageHeight: pd.imageHeight,
        }));

        const indexPath = workingCopyPath || originalPdfPath;
        try {
            const indexContent = JSON.stringify({
                version: 1,
                pageCount,
                pages: indexPageData,
            });
            await writeFile(`${indexPath}.index.json`, indexContent, 'utf-8');
            if (!workingCopyPath) {
                trackTempFile(`${indexPath}.index.json`);
            }
        } catch {
            // Non-blocking - don't fail OCR if index save fails
        }

        // For large PDFs, save to temp file and return path
        if (mergedPdfBuffer.length > 50 * 1024 * 1024) {
            keepFiles.add(mergedPdfPath);
            parentPort?.postMessage({
                type: 'complete',
                jobId,
                result: {
                    success: true,
                    pdfData: null,
                    pdfPath: mergedPdfPath,
                    errors,
                },
            });
        } else {
            parentPort?.postMessage({
                type: 'complete',
                jobId,
                result: {
                    success: true,
                    pdfData: Array.from(mergedPdfBuffer),
                    errors,
                },
            });
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log('debug', `CRITICAL ERROR in processOcrJob: ${errMsg}`);
        parentPort?.postMessage({
            type: 'complete',
            jobId,
            result: {
                success: false,
                pdfData: null,
                errors: [`Critical error: ${errMsg}`],
            },
        });
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

// Listen for messages from main thread
parentPort?.on('message', async (message: {
    type: 'start';
    jobId: string;
    data: {
        originalPdfData: Uint8Array;
        pages: IOcrPdfPageRequest[];
        workingCopyPath?: string;
    };
}) => {
    if (message.type === 'start') {
        await processOcrJob(
            message.jobId,
            message.data.originalPdfData,
            message.data.pages,
            message.data.workingCopyPath,
        );
    }
});

log('debug', 'OCR worker initialized and ready');
