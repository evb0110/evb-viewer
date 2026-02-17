import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { stat } from 'fs/promises';
import { join } from 'path';
import {
    buildDjvuRuntimeEnv,
    getDjvuToolPaths,
} from '@electron/djvu/paths';

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

interface IParallelConvertOptions {
    subsample?: number;
    onPagesCompleted?: (completedPages: number, totalPages: number) => void;
}

const PARALLEL_WORKERS = 8;

const activeProcesses = new Map<string, ChildProcess>();

export async function convertDjvuToPdf(
    inputPath: string,
    outputPath: string,
    jobId: string,
    options: IDjvuConvertOptions = {},
): Promise<IDjvuConvertResult> {
    const { ddjvu } = getDjvuToolPaths();

    const args = [
        '-format=pdf',
        '-verbose',
    ];

    if (options.subsample && options.subsample > 1) {
        args.push(`-subsample=${options.subsample}`);
    }

    if (options.pages) {
        args.push(`-page=${options.pages}`);
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
        let lastPageSeen = 0;
        const totalPages = options.pageCount ?? 0;

        proc.stderr?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stderr += chunk;

            if (options.onProgress && totalPages > 0) {
                const pageMatches = chunk.matchAll(/-------- page (\d+)/g);
                for (const match of pageMatches) {
                    const pageNum = parseInt(match[1] ?? '0', 10);
                    if (pageNum > lastPageSeen) {
                        lastPageSeen = pageNum;
                        const percent = Math.min(90, Math.round((lastPageSeen / totalPages) * 90));
                        options.onProgress(percent);
                    }
                }
            }
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

            if (code !== 0) {
                resolve({
                    success: false,
                    outputPath,
                    fileSize: 0,
                    error: `ddjvu exited with code ${code}: ${stderr}`,
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
                    error: `Output file not found after conversion: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
        });
    });
}

interface IRangeConvertOptions {
    subsample?: number;
    onPageConverted?: (pageNum: number) => void;
}

function convertDjvuPageRange(
    inputPath: string,
    outputPath: string,
    pageSpec: string,
    jobId: string,
    options: IRangeConvertOptions = {},
): Promise<IDjvuConvertResult> {
    const { ddjvu } = getDjvuToolPaths();

    const args = [
        '-format=pdf',
        '-verbose',
        `-page=${pageSpec}`,
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
        let lastPageSeen = 0;

        proc.stderr?.on('data', (data: Buffer) => {
            const chunk = data.toString();
            stderr += chunk;

            if (options.onPageConverted) {
                const pageMatches = chunk.matchAll(/-------- page (\d+)/g);
                for (const match of pageMatches) {
                    const pageNum = parseInt(match[1] ?? '0', 10);
                    if (pageNum > lastPageSeen) {
                        lastPageSeen = pageNum;
                        options.onPageConverted(pageNum);
                    }
                }
            }
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

            if (code !== 0) {
                resolve({
                    success: false,
                    outputPath,
                    fileSize: 0,
                    error: `ddjvu exited with code ${code}: ${stderr}`,
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
                    error: `Output file not found after conversion: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
        });
    });
}

interface IPageRange {
    start: number;
    end: number;
    pageCount: number;
}

function buildPageRanges(totalPages: number, workerCount: number): IPageRange[] {
    const pagesPerWorker = Math.ceil(totalPages / workerCount);
    const ranges: IPageRange[] = [];

    for (let i = 0; i < workerCount; i++) {
        const start = i * pagesPerWorker + 1;
        const end = Math.min((i + 1) * pagesPerWorker, totalPages);
        if (start > totalPages) break;
        ranges.push({
            start,
            end,
            pageCount: end - start + 1,
        });
    }

    return ranges;
}

export async function convertAllPagesParallel(
    inputPath: string,
    outputDir: string,
    pageCount: number,
    jobId: string,
    options: IParallelConvertOptions = {},
): Promise<{
    success: boolean;
    rangePaths: string[];
    error?: string 
}> {
    const ranges = buildPageRanges(pageCount, PARALLEL_WORKERS);
    let completedPages = 0;

    const tasks = ranges.map((range, index) => {
        const rangeOutputPath = `${outputDir}/range-${index}.pdf`;
        const rangeJobId = `${jobId}-range-${index}`;
        const pageSpec = `${range.start}-${range.end}`;

        return convertDjvuPageRange(
            inputPath,
            rangeOutputPath,
            pageSpec,
            rangeJobId,
            {
                subsample: options.subsample,
                onPageConverted: () => {
                    completedPages++;
                    options.onPagesCompleted?.(completedPages, pageCount);
                },
            },
        ).then((result) => ({
            result,
            index,
            range,
        }));
    });

    const results = await Promise.all(tasks);

    const errors = results.filter((r) => !r.result.success);
    if (errors.length > 0) {
        const errorMessages = errors.map(
            (e) => `Range ${e.range.start}-${e.range.end}: ${e.result.error}`,
        );
        return {
            success: false,
            rangePaths: [],
            error: errorMessages.join('; '),
        };
    }

    const sortedPaths = results
        .sort((a, b) => a.index - b.index)
        .map((r) => r.result.outputPath);

    return {
        success: true,
        rangePaths: sortedPaths, 
    };
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

            if (code !== 0) {
                resolve({
                    success: false,
                    outputPath,
                    fileSize: 0,
                    error: `ddjvu exited with code ${code}: ${stderr}`,
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

    const workers = Array.from(
        { length: Math.min(PARALLEL_WORKERS, pageCount) },
        () => worker(),
    );

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
