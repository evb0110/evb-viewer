import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import {
    mkdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {
    availableParallelism,
    cpus,
    tmpdir,
} from 'os';
import { join } from 'path';
import { PDFDocument } from 'pdf-lib';
import {
    buildDjvuRuntimeEnv,
    getDjvuToolPaths,
} from '@electron/djvu/paths';
import { getOcrToolPaths } from '@electron/ocr/paths';
import { createLogger } from '@electron/utils/logger';
import { describeProcessExitCode } from '@electron/utils/process-exit';

interface IDjvuConvertOptions {
    subsample?: number;
    pages?: string;
    pageCount?: number;
    onProgress?: (percent: number) => void;
}

interface IDjvuConvertResult {
    success: boolean;
    outputPath: string;
    fileSize: number;
    error?: string;
}

const MAX_RANGE_WORKERS = 12;
const MAX_IMAGE_WORKERS = 16;
const MIN_PAGES_FOR_RANGE_PARALLELISM = 24;
const PROGRESS_CAP = 90;

const activeProcesses = new Map<string, ChildProcess>();
const logger = createLogger('djvu-convert');

export async function convertDjvuToPdf(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConvertOptions = {},
): Promise<IDjvuConvertResult> {
    const totalPages = options.pageCount ?? 0;
    const shouldUseRangeParallelism = shouldUseParallelRangeConversion(options);

    if (shouldUseRangeParallelism) {
        logger.info(`[${jobId}] Using parallel DjVu conversion: pages=${totalPages}, workers=${getRangeWorkerCount(totalPages)}`);
        return convertDjvuToPdfWithRanges(
            inputPath,
            outputPath,
            jobId,
            options,
        );
    }

    logger.info(`[${jobId}] Using single-process DjVu conversion: pages=${totalPages}`);
    return convertDjvuToPdfSingleProcess(inputPath, outputPath, jobId, options, totalPages);
}

async function convertDjvuToPdfWithRanges(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConvertOptions,
): Promise<IDjvuConvertResult> {
    const totalPages = options.pageCount ?? 0;
    const workerCount = getRangeWorkerCount(totalPages);
    if (workerCount < 2) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: 'Parallel conversion is not applicable',
        };
    }

    const tempDir = join(tmpdir(), `djvu-pages-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const chunkPaths = Array.from({ length: totalPages }, (_, index) => join(tempDir, `page-${index + 1}.pdf`));
    const completedPages = new Set<number>();
    const pageQueue = Array.from({ length: totalPages }, (_, index) => index + 1);
    let firstError: string | null = null;

    await mkdir(tempDir, { recursive: true });

    try {
        async function worker(workerIndex: number) {
            while (!firstError && pageQueue.length > 0) {
                const pageNum = pageQueue.shift();
                if (!pageNum) {
                    return;
                }

                const pageOutputPath = chunkPaths[pageNum - 1]!;
                const pageResult = await convertPageToPdf(
                    inputPath,
                    pageOutputPath,
                    `${jobId}-range-${workerIndex}-page-${pageNum}`,
                    pageNum,
                    options.subsample,
                );

                if (!pageResult.success) {
                    firstError = pageResult.error ?? `Failed to convert page ${pageNum}`;
                    cancelConversion(jobId);
                    return;
                }

                if (!completedPages.has(pageNum)) {
                    completedPages.add(pageNum);
                    if (options.onProgress) {
                        const percent = Math.min(
                            PROGRESS_CAP,
                            Math.round((completedPages.size / totalPages) * PROGRESS_CAP),
                        );
                        options.onProgress(percent);
                    }
                }
            }
        }

        const tasks = Array.from({ length: workerCount }, (_, index) => worker(index + 1));
        await Promise.all(tasks);

        if (firstError) {
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: firstError,
            };
        }

        const mergeResult = await mergePdfChunks(chunkPaths, outputPath, `${jobId}-merge`);
        if (!mergeResult.success) {
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: mergeResult.error,
            };
        }

        try {
            const s = await stat(outputPath);
            if (options.onProgress) {
                options.onProgress(PROGRESS_CAP + 5);
            }
            return {
                success: true,
                outputPath,
                fileSize: s.size,
            };
        } catch (err) {
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: `Output file not found after parallel conversion: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => {});
    }
}

async function convertDjvuToPdfSingleProcess(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConvertOptions,
    totalPages: number,
): Promise<IDjvuConvertResult> {
    const args = buildPdfArgs(inputPath, outputPath, options.subsample, options.pages);
    const pageProgressSeen = new Set<number>();
    const result = await runProcess(
        jobId,
        getDjvuToolPaths().ddjvu,
        args,
        {
            env: buildDjvuRuntimeEnv(),
            onStderr: (chunk) => {
                if (!options.onProgress || totalPages <= 0) {
                    return;
                }
                const pageMatches = chunk.matchAll(/-------- page (\d+)/g);
                for (const match of pageMatches) {
                    const pageNum = parseInt(match[1] ?? '0', 10);
                    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > totalPages) {
                        continue;
                    }
                    if (pageProgressSeen.has(pageNum)) {
                        continue;
                    }
                    pageProgressSeen.add(pageNum);
                    const percent = Math.min(
                        PROGRESS_CAP,
                        Math.round((pageProgressSeen.size / totalPages) * PROGRESS_CAP),
                    );
                    options.onProgress(percent);
                }
            },
        },
    );

    if (!result.success) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: result.error,
        };
    }

    try {
        const s = await stat(outputPath);
        return {
            success: true,
            outputPath,
            fileSize: s.size,
        };
    } catch (err) {
        return {
            success: false,
            outputPath,
            fileSize: 0,
            error: `Output file not found after conversion: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

async function convertPageToPdf(
    inputPath: string,
    outputPath: string,
    pageJobId: string,
    page: number,
    subsample: number | undefined,
) {
    const args = buildPdfArgs(
        inputPath,
        outputPath,
        subsample,
        String(page),
    );
    const result = await runProcess(
        pageJobId,
        getDjvuToolPaths().ddjvu,
        args,
        { env: buildDjvuRuntimeEnv() },
    );

    if (!result.success) {
        return {
            success: false,
            error: result.error ?? `Failed to convert page ${page}`,
        };
    }

    return { success: true };
}

async function mergePdfChunks(
    chunkPaths: string[],
    outputPath: string,
    mergeJobId: string,
) {
    const { qpdf } = getOcrToolPaths();
    const qpdfResult = await runProcess(
        mergeJobId,
        qpdf,
        [
            '--empty',
            '--pages',
            ...chunkPaths,
            '--',
            outputPath,
        ],
    );
    if (qpdfResult.success) {
        return { success: true };
    }

    logger.warn(`[${mergeJobId}] qpdf merge failed, falling back to pdf-lib merge: ${qpdfResult.error}`);

    try {
        const mergedDoc = await PDFDocument.create();

        for (const chunkPath of chunkPaths) {
            const chunkData = await readFile(chunkPath);
            const chunkDoc = await PDFDocument.load(chunkData, { updateMetadata: false });
            const chunkIndices = chunkDoc.getPageIndices();
            if (chunkIndices.length === 0) {
                continue;
            }
            const pages = await mergedDoc.copyPages(chunkDoc, chunkIndices);
            for (const page of pages) {
                mergedDoc.addPage(page);
            }
        }

        await writeFile(outputPath, new Uint8Array(await mergedDoc.save()));
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function buildPdfArgs(
    inputPath: string,
    outputPath: string,
    subsample?: number,
    pages?: string,
) {
    const args = [
        '-format=pdf',
        '-verbose',
    ];

    if (subsample && subsample > 1) {
        args.push(`-subsample=${subsample}`);
    }

    if (pages) {
        args.push(`-page=${pages}`);
    }

    args.push(inputPath, outputPath);
    return args;
}

type TImageFormat = 'pgm' | 'ppm';

export function convertDjvuPageToImage(
    inputPath: string,
    outputPath: string,
    pageNum: number,
    jobId: string,
    options: {
        subsample?: number;
        format?: TImageFormat 
    } = {},
): Promise<IDjvuConvertResult> {
    const { ddjvu } = getDjvuToolPaths();
    const format = options.format ?? 'ppm';

    const args = [
        `-format=${format}`,
        `-page=${pageNum}`,
    ];

    if (options.subsample && options.subsample > 1) {
        args.push(`-subsample=${options.subsample}`);
    }

    args.push(inputPath, outputPath);

    return new Promise((resolve) => {
        const proc = spawn(ddjvu, args, {
            shell: false,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
            env: buildDjvuRuntimeEnv(),
        });

        activeProcesses.set(jobId, proc);

        let stderr = '';
        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('error', (err) => {
            activeProcesses.delete(jobId);
            resolve({
                success: false,
                outputPath,
                fileSize: 0,
                error: err.message,
            });
        });

        proc.on('close', async (code) => {
            activeProcesses.delete(jobId);
            const exitCode = typeof code === 'number' ? code : -1;

            if (exitCode !== 0) {
                resolve({
                    success: false,
                    outputPath,
                    fileSize: 0,
                    error: `ddjvu exited with code ${describeProcessExitCode(exitCode)}: ${stderr}`,
                });
                return;
            }

            try {
                const s = await stat(outputPath);
                resolve({
                    success: true,
                    outputPath,
                    fileSize: s.size,
                });
            } catch (err) {
                resolve({
                    success: false,
                    outputPath,
                    fileSize: 0,
                    error: `Output file not found: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
        });
    });
}

interface IImageConvertOptions {
    subsample?: number;
    format?: TImageFormat;
    onPageConverted?: (completedPages: number, totalPages: number) => void;
}

export async function convertAllPagesToImages(
    inputPath: string,
    outputDir: string,
    pageCount: number,
    jobId: string,
    options: IImageConvertOptions = {},
): Promise<{
    success: boolean;
    error?: string 
}> {
    const format = options.format ?? 'ppm';
    let completedPages = 0;
    let firstError: string | undefined;

    const queue: number[] = [];
    for (let i = 1; i <= pageCount; i++) queue.push(i);

    async function worker() {
        while (queue.length > 0 && !firstError) {
            const page = queue.shift()!;
            const imagePath = join(outputDir, `page-${page}.${format}`);
            const pageJobId = `${jobId}-img-${page}`;

            const result = await convertDjvuPageToImage(
                inputPath,
                imagePath,
                page,
                pageJobId,
                {
                    subsample: options.subsample,
                    format, 
                },
            );

            if (!result.success) {
                firstError = result.error ?? `Failed to convert page ${page}`;
                break;
            }

            completedPages++;
            options.onPageConverted?.(completedPages, pageCount);
        }
    }

    const workers = Array.from({ length: getImageWorkerCount(pageCount) }, () => worker());

    await Promise.all(workers);

    if (firstError) {
        return {
            success: false,
            error: firstError, 
        };
    }

    return { success: true };
}

export function cancelConversion(jobId: string): boolean {
    let canceled = false;

    // Cancel the exact job ID
    const proc = activeProcesses.get(jobId);
    if (proc) {
        killProcess(proc);
        activeProcesses.delete(jobId);
        canceled = true;
    }

    // Cancel any child workers belonging to this job (range-N, pgm-N)
    for (const [
        id,
        childProc,
    ] of activeProcesses) {
        if (id.startsWith(`${jobId}-`)) {
            killProcess(childProc);
            activeProcesses.delete(id);
            canceled = true;
        }
    }

    return canceled;
}

function killProcess(proc: ChildProcess) {
    try {
        proc.kill('SIGTERM');
        setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            } catch {
                // Already dead
            }
        }, 2000);
    } catch {
        // Process may have already exited
    }
}

interface IRunProcessOptions {
    env?: NodeJS.ProcessEnv;
    onStderr?: (chunk: string) => void;
}

async function runProcess(
    processId: string,
    command: string,
    args: string[],
    options: IRunProcessOptions = {},
): Promise<{ success: true } | {
    success: false;
    error: string 
}> {
    return new Promise((resolve) => {
        const proc = spawn(command, args, {
            shell: false,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
            ...(options.env ? { env: options.env } : {}),
        });

        activeProcesses.set(processId, proc);
        let stderr = '';

        proc.stdout?.on('data', () => {
            // Drain stdout to avoid child process back-pressure stalls.
        });

        proc.stderr?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stderr += chunk;
            options.onStderr?.(chunk);
        });

        proc.on('error', (err) => {
            activeProcesses.delete(processId);
            resolve({
                success: false,
                error: err.message,
            });
        });

        proc.on('close', (code) => {
            activeProcesses.delete(processId);
            const exitCode = typeof code === 'number' ? code : -1;
            if (exitCode !== 0) {
                resolve({
                    success: false,
                    error: `${command} exited with code ${describeProcessExitCode(exitCode)}: ${stderr}`,
                });
                return;
            }
            resolve({ success: true });
        });
    });
}

function shouldUseParallelRangeConversion(options: IDjvuConvertOptions) {
    const totalPages = options.pageCount ?? 0;
    if (options.pages) {
        return false;
    }
    if (totalPages < MIN_PAGES_FOR_RANGE_PARALLELISM) {
        return false;
    }
    return getRangeWorkerCount(totalPages) > 1;
}

function getLogicalCpuCount() {
    if (typeof availableParallelism === 'function') {
        return availableParallelism();
    }
    return cpus().length;
}

function getRangeWorkerCount(pageCount: number) {
    const cpuBound = Math.max(1, getLogicalCpuCount() - 1);
    const desired = Math.max(2, Math.min(MAX_RANGE_WORKERS, cpuBound));
    return Math.min(pageCount, desired);
}

function getImageWorkerCount(pageCount: number) {
    const cpuBound = Math.max(1, getLogicalCpuCount() - 1);
    const desired = Math.max(2, Math.min(MAX_IMAGE_WORKERS, cpuBound));
    return Math.min(pageCount, desired);
}
