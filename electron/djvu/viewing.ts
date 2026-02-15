import {
    BrowserWindow,
    app,
} from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import {
    mkdir,
    readFile,
    rm,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import {
    PDFDocument,
    rgb,
} from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import {
    cancelConversion,
    convertAllPagesParallel,
    convertDjvuToPdf,
} from '@electron/djvu/convert';
import {
    getDjvuOutline,
    getDjvuPageCount,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/bookmarks';
import { createLogger } from '@electron/utils/logger';
import { safeSendToWindow } from '@electron/djvu/ipc-shared';
import { embedBookmarksIntoPdf } from '@electron/djvu/pdf-bookmarks';

const logger = createLogger('djvu-ipc');

let activeViewingJobId: string | null = null;

export function cancelActiveViewingJob() {
    if (!activeViewingJobId) {
        return;
    }
    cancelConversion(activeViewingJobId);
    activeViewingJobId = null;
}

async function backgroundEmbedBookmarksAndSignal(
    window: BrowserWindow | null | undefined,
    djvuPath: string,
    pdfPath: string,
    jobId: string,
) {
    try {
        const outlineSexp = await getDjvuOutline(djvuPath);
        const bookmarks = parseDjvuOutline(outlineSexp);

        if (bookmarks.length > 0) {
            const pdfData = await readFile(pdfPath);
            const withBookmarks = await embedBookmarksIntoPdf(new Uint8Array(pdfData), bookmarks);
            await writeFile(pdfPath, withBookmarks);
        }

        safeSendToWindow(window, 'djvu:viewingReady', {
            pdfPath,
            isPartial: false,
            jobId,
        });
    } catch (error) {
        safeSendToWindow(window, 'djvu:viewingError', { error: error instanceof Error ? error.message : String(error) });
    }
}

function addSkeletonPage(doc: PDFDocument, width: number, height: number) {
    const page = doc.addPage([
        width,
        height,
    ]);

    const bgColor = rgb(0.96, 0.96, 0.96);
    const barColor = rgb(0.88, 0.88, 0.88);

    page.drawRectangle({
        x: 0,
        y: 0,
        width,
        height,
        color: bgColor,
    });

    const margin = Math.min(width * 0.12, 72);
    const contentWidth = width - 2 * margin;
    const barHeight = Math.max(4, height * 0.008);
    const lineGap = Math.max(8, height * 0.016);
    const paragraphGap = lineGap * 2.5;

    let y = height - margin * 1.5;

    const paragraphs = [
        4,
        6,
        5,
        4,
        6,
        5,
        3,
        5,
        4,
    ];
    const widthPattern = [
        1.0,
        0.95,
        1.0,
        0.85,
        0.92,
        0.78,
    ];

    for (const lineCount of paragraphs) {
        if (y < margin) {
            break;
        }

        for (let j = 0; j < lineCount; j += 1) {
            if (y < margin) {
                break;
            }

            const fraction = widthPattern[j % widthPattern.length]!;
            page.drawRectangle({
                x: margin,
                y,
                width: contentWidth * fraction,
                height: barHeight,
                color: barColor,
            });

            y -= lineGap;
        }

        y -= paragraphGap - lineGap;
    }
}

async function buildSkeletonPdf(
    page1PdfPath: string,
    pageCount: number,
): Promise<string> {
    const page1Data = await readFile(page1PdfPath);
    const page1Doc = await PDFDocument.load(page1Data, { updateMetadata: false });
    const page1 = page1Doc.getPage(0);
    const {
        width,
        height,
    } = page1.getSize();

    const doc = await PDFDocument.create();
    const [copiedPage1] = await doc.copyPages(page1Doc, [0]);
    doc.addPage(copiedPage1!);

    for (let i = 1; i < pageCount; i += 1) {
        addSkeletonPage(doc, width, height);
    }

    const skeletonPath = join(app.getPath('temp'), `djvu-skeleton-${Date.now()}.pdf`);
    await writeFile(skeletonPath, new Uint8Array(await doc.save()));
    return skeletonPath;
}

async function backgroundConvertAll(
    window: BrowserWindow | null | undefined,
    djvuPath: string,
    pageCount: number,
    jobId: string,
) {
    const rangeDir = join(app.getPath('temp'), `djvu-ranges-${Date.now()}`);
    logger.info(`[${jobId}] Background conversion starting: ${pageCount} pages`);

    try {
        await mkdir(rangeDir, { recursive: true });

        safeSendToWindow(window, 'djvu:progress', {
            jobId,
            phase: 'loading' as const,
            current: 0,
            total: pageCount,
            percent: 0,
        });

        const outlinePromise = getDjvuOutline(djvuPath)
            .then(sexp => parseDjvuOutline(sexp))
            .catch(() => [] as IPdfBookmarkEntry[]);

        const parallelResult = await convertAllPagesParallel(
            djvuPath,
            rangeDir,
            pageCount,
            jobId,
            {onPagesCompleted: (completed, total) => {
                safeSendToWindow(window, 'djvu:progress', {
                    jobId,
                    phase: 'loading' as const,
                    current: completed,
                    total,
                    percent: Math.round((completed / total) * 90),
                });
            }},
        );

        if (!parallelResult.success) {
            safeSendToWindow(window, 'djvu:viewingError', { error: parallelResult.error ?? 'Parallel conversion failed' });
            return;
        }

        const mergedDoc = await PDFDocument.create();
        for (const rangePath of parallelResult.rangePaths) {
            const rangeData = await readFile(rangePath);
            const rangeDoc = await PDFDocument.load(rangeData, { updateMetadata: false });
            const copiedPages = await mergedDoc.copyPages(rangeDoc, rangeDoc.getPageIndices());
            for (const page of copiedPages) {
                mergedDoc.addPage(page);
            }
        }

        const bookmarks = await outlinePromise;
        let finalData: Uint8Array;

        if (bookmarks.length > 0) {
            const mergedData = new Uint8Array(await mergedDoc.save());
            finalData = await embedBookmarksIntoPdf(mergedData, bookmarks);
        } else {
            finalData = new Uint8Array(await mergedDoc.save());
        }

        const fullPdfPath = join(app.getPath('temp'), `djvu-full-${Date.now()}.pdf`);
        await writeFile(fullPdfPath, finalData);

        safeSendToWindow(window, 'djvu:progress', {
            jobId,
            phase: 'loading' as const,
            current: pageCount,
            total: pageCount,
            percent: 100,
        });

        logger.info(`[${jobId}] Background conversion complete, signaling renderer`);
        safeSendToWindow(window, 'djvu:viewingReady', {
            pdfPath: fullPdfPath,
            isPartial: false,
            jobId,
        });
    } catch (error) {
        logger.error(`[${jobId}] Background conversion failed: ${error instanceof Error ? error.message : String(error)}`);
        safeSendToWindow(window, 'djvu:viewingError', { error: error instanceof Error ? error.message : String(error) });
    } finally {
        activeViewingJobId = null;
        try {
            await rm(rangeDir, {
                recursive: true,
                force: true,
            });
        } catch {
            // Ignore cleanup errors
        }
    }
}

export async function handleDjvuOpenForViewing(
    event: IpcMainInvokeEvent,
    djvuPath: string,
): Promise<{
    success: boolean;
    pdfPath?: string;
    pageCount?: number;
    jobId?: string;
    error?: string;
}> {
    const window = BrowserWindow.fromWebContents(event.sender);

    cancelActiveViewingJob();

    const jobId = `djvu-view-${Date.now()}`;
    logger.info(`[${jobId}] Opening DjVu for viewing: ${djvuPath}`);

    try {
        const pageCount = await getDjvuPageCount(djvuPath);

        const tempPage1Path = join(
            app.getPath('temp'),
            `djvu-page1-${Date.now()}.pdf`,
        );

        const page1Result = await convertDjvuToPdf(djvuPath, tempPage1Path, jobId, { pages: '1' });

        if (!page1Result.success) {
            return {
                success: false,
                error: page1Result.error,
            };
        }

        let initialPdfPath: string;

        if (pageCount > 1) {
            initialPdfPath = await buildSkeletonPdf(tempPage1Path, pageCount);

            unlink(tempPage1Path).catch(() => {});

            activeViewingJobId = jobId;
            backgroundConvertAll(window, djvuPath, pageCount, jobId).catch(() => {
                // Error handling is done inside backgroundConvertAll via viewingError event
            });
        } else {
            initialPdfPath = tempPage1Path;
            backgroundEmbedBookmarksAndSignal(window, djvuPath, tempPage1Path, jobId).catch(() => {
                // Best effort for single-page files
            });
        }

        logger.info(`[${jobId}] Viewing ready: pageCount=${pageCount}, pdfPath=${initialPdfPath}`);
        return {
            success: true,
            pdfPath: initialPdfPath,
            pageCount,
            jobId,
        };
    } catch (error) {
        logger.error(`[${jobId}] Open failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
