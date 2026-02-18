import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import {
    mkdir,
    rm,
    stat,
} from 'fs/promises';
import {
    availableParallelism,
    cpus,
    tmpdir,
} from 'os';
import { join } from 'path';
import {
    buildDjvuRuntimeEnv,
    getDjvuToolPaths,
} from '@electron/djvu/paths';
import { getOcrToolPaths } from '@electron/ocr/paths';
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

interface IPageRange {
    start: number;
    end: number;
}

export async function convertDjvuToPdf(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConvertOptions = {},
): Promise<IDjvuConvertResult> {
    const totalPages = options.pageCount ?? 0;
    const shouldUseRangeParallelism = shouldUseParallelRangeConversion(options);

    if (shouldUseRangeParallelism) {
        const parallelResult = await convertDjvuToPdfWithRanges(
            inputPath,
            outputPath,
            jobId,
            options,
        );
        if (parallelResult.success) {
            return parallelResult;
        }
        if (!shouldFallbackToSingleProcess(parallelResult.error)) {
            return parallelResult;
        }
    }

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
            error: 'Range parallelism is not applicable',
        };
    }

    const { qpdf } = getOcrToolPaths();
    const tempDir = join(tmpdir(), `djvu-ranges-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const ranges = splitPageRanges(totalPages, workerCount);
    const chunkPaths = ranges.map((_, index) => join(tempDir, `part-${index + 1}.pdf`));
    const completedPages = new Set<number>();
    let firstError: string | null = null;

    await mkdir(tempDir, { recursive: true });

    try {
        const tasks = ranges.map((range, index) => convertRangeToPdf(
            inputPath,
            chunkPaths[index]!,
            `${jobId}-range-${index + 1}`,
            range,
            options.subsample,
            (pageNum) => {
                if (!options.onProgress || totalPages <= 0) {
                    return;
                }

                if (!completedPages.has(pageNum)) {
                    completedPages.add(pageNum);
                    const percent = Math.min(
                        PROGRESS_CAP,
                        Math.round((completedPages.size / totalPages) * PROGRESS_CAP),
                    );
                    options.onProgress(percent);
                }
            },
        ).then((result) => {
            if (!result.success && !firstError) {
                firstError = result.error ?? `Failed to convert range ${range.start}-${range.end}`;
                cancelConversion(jobId);
            }
        }));

        await Promise.all(tasks);

        if (firstError) {
            return {
                success: false,
                outputPath,
                fileSize: 0,
                error: firstError,
            };
        }

        const mergeResult = await runProcess(
            `${jobId}-merge`,
            qpdf,
            [
                '--empty',
                '--pages',
                ...chunkPaths,
                '--',
                outputPath,
            ],
        );
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
                error: `Output file not found after range conversion: ${err instanceof Error ? err.message : String(err)}`,
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

async function convertRangeToPdf(
    inputPath: string,
    outputPath: string,
    rangeJobId: string,
    range: IPageRange,
    subsample: number | undefined,
    onPageSeen: (pageNum: number) => void,
) {
    const args = buildPdfArgs(
        inputPath,
        outputPath,
        subsample,
        `${range.start}-${range.end}`,
    );
    const result = await runProcess(
        rangeJobId,
        getDjvuToolPaths().ddjvu,
        args,
        {
            env: buildDjvuRuntimeEnv(),
            onStderr: (chunk) => {
                const pageMatches = chunk.matchAll(/-------- page (\d+)/g);
                for (const match of pageMatches) {
                    const pageNum = parseInt(match[1] ?? '0', 10);
                    if (!Number.isInteger(pageNum) || pageNum < range.start || pageNum > range.end) {
                        continue;
                    }
                    onPageSeen(pageNum);
                }
            },
        },
    );

    if (!result.success) {
        return {
            success: false,
            error: result.error ?? `Failed to convert page range ${range.start}-${range.end}`,
        };
    }

    return { success: true };
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

function shouldFallbackToSingleProcess(error: string | undefined) {
    if (!error) {
        return false;
    }
    return /ENOENT|EACCES|qpdf/i.test(error);
}

function splitPageRanges(totalPages: number, workerCount: number): IPageRange[] {
    const pagesPerRange = Math.ceil(totalPages / workerCount);
    const ranges: IPageRange[] = [];
    for (let start = 1; start <= totalPages; start += pagesPerRange) {
        const end = Math.min(totalPages, start + pagesPerRange - 1);
        ranges.push({
            start,
            end,
        });
    }
    return ranges;
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
