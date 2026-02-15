import {
    BrowserWindow,
    app,
} from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import {
    mkdir,
    rm,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import {
    cancelConversion,
    convertAllPagesToImages,
} from '@electron/djvu/convert';
import { buildOptimizedPdf } from '@electron/djvu/pdf-builder';
import {
    getDjvuOutline,
    getDjvuPageCount,
    getDjvuResolution,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/bookmarks';
import { createLogger } from '@electron/utils/logger';
import { safeSendToWindow } from '@electron/djvu/ipc-shared';
import { embedBookmarksIntoPdf } from '@electron/djvu/pdf-bookmarks';

const logger = createLogger('djvu-ipc');

export async function handleDjvuConvertToPdf(
    event: IpcMainInvokeEvent,
    djvuPath: string,
    outputPath: string,
    options: {
        subsample?: number;
        preserveBookmarks?: boolean;
    },
): Promise<{
    success: boolean;
    pdfPath?: string;
    jobId?: string;
    error?: string;
}> {
    const window = BrowserWindow.fromWebContents(event.sender);
    const jobId = `djvu-convert-${Date.now()}`;
    const imageDir = join(app.getPath('temp'), `djvu-images-${Date.now()}`);
    logger.info(`[${jobId}] Converting DjVu to PDF: ${djvuPath} -> ${outputPath}`);

    try {
        const [
            pageCount,
            sourceDpi,
        ] = await Promise.all([
            getDjvuPageCount(djvuPath),
            getDjvuResolution(djvuPath),
        ]);

        const subsample = options.subsample ?? 1;
        const effectiveDpi = Math.round(sourceDpi / subsample);

        await mkdir(imageDir, { recursive: true });

        safeSendToWindow(window, 'djvu:progress', {
            jobId,
            phase: 'converting' as const,
            percent: 0,
        });

        const outlinePromise = (options.preserveBookmarks !== false)
            ? getDjvuOutline(djvuPath).then(sexp => parseDjvuOutline(sexp)).catch(() => [] as IPdfBookmarkEntry[])
            : Promise.resolve([] as IPdfBookmarkEntry[]);

        const imageResult = await convertAllPagesToImages(djvuPath, imageDir, pageCount, jobId, {
            subsample: subsample > 1 ? subsample : undefined,
            format: 'ppm',
            onPageConverted: (completed, total) => {
                safeSendToWindow(window, 'djvu:progress', {
                    jobId,
                    phase: 'converting' as const,
                    percent: Math.round((completed / total) * 70),
                });
            },
        });

        if (!imageResult.success) {
            return {
                success: false,
                jobId,
                error: imageResult.error,
            };
        }

        const imagePaths = Array.from(
            { length: pageCount },
            (_, index) => join(imageDir, `page-${index + 1}.ppm`),
        );

        let pdfData: Uint8Array = await buildOptimizedPdf(imagePaths, effectiveDpi, (page, total) => {
            safeSendToWindow(window, 'djvu:progress', {
                jobId,
                phase: 'converting' as const,
                percent: 70 + Math.round((page / total) * 20),
            });
        });

        const bookmarks = await outlinePromise;
        if (bookmarks.length > 0) {
            safeSendToWindow(window, 'djvu:progress', {
                jobId,
                phase: 'bookmarks' as const,
                percent: 92,
            });
            pdfData = await embedBookmarksIntoPdf(pdfData, bookmarks);
        }

        await writeFile(outputPath, pdfData);

        safeSendToWindow(window, 'djvu:progress', {
            jobId,
            phase: 'bookmarks' as const,
            percent: 100,
        });

        logger.info(`[${jobId}] Conversion to PDF complete: ${outputPath}`);
        return {
            success: true,
            pdfPath: outputPath,
            jobId,
        };
    } catch (error) {
        logger.error(`[${jobId}] Conversion failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
            success: false,
            jobId,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        try {
            await rm(imageDir, {
                recursive: true,
                force: true,
            });
        } catch {
            // Ignore cleanup errors
        }
    }
}

export function handleDjvuCancel(
    _event: IpcMainInvokeEvent,
    jobId: string,
): { canceled: boolean } {
    logger.info(`[${jobId}] Cancel requested`);
    const canceled = cancelConversion(jobId);
    logger.info(`[${jobId}] Cancel result: ${canceled}`);
    return { canceled };
}
