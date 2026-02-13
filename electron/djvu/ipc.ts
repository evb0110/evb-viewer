import {
    BrowserWindow,
    ipcMain,
    app,
} from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'path';
import {
    mkdir,
    readFile,
    writeFile,
    unlink,
    rm,
} from 'fs/promises';
import { existsSync } from 'fs';
import {
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFHexString,
    rgb,
} from 'pdf-lib';
import type {
    PDFDict,
    PDFRef,
} from 'pdf-lib';
import {
    convertDjvuToPdf,
    convertAllPagesParallel,
    convertAllPagesToImages,
    cancelConversion,
} from '@electron/djvu/convert';
import { buildOptimizedPdf } from '@electron/djvu/pdf-builder';
import {
    getDjvuPageCount,
    getDjvuOutline,
    getDjvuResolution,
    getDjvuHasText,
    getDjvuMetadata,
} from '@electron/djvu/metadata';
import { parseDjvuOutline } from '@electron/djvu/bookmarks';
import { estimateSizes } from '@electron/djvu/estimate';
import type { IPdfBookmarkEntry } from '@app/types/pdf';

function safeSendToWindow(
    window: BrowserWindow | null | undefined,
    channel: string,
    ...args: unknown[]
) {
    if (!window) {
        return;
    }
    if (window.isDestroyed()) {
        return;
    }
    if (window.webContents.isDestroyed()) {
        return;
    }

    try {
        window.webContents.send(channel, ...args);
    } catch {
        // Window may have been destroyed between checks
    }
}

async function embedBookmarksIntoPdf(
    pdfData: Uint8Array,
    bookmarks: IPdfBookmarkEntry[],
): Promise<Uint8Array> {
    if (bookmarks.length === 0) {
        return pdfData;
    }

    const doc = await PDFDocument.load(pdfData, { updateMetadata: false });

    const outlinesName = PDFName.of('Outlines');
    const parentName = PDFName.of('Parent');
    const prevName = PDFName.of('Prev');
    const nextName = PDFName.of('Next');
    const firstName = PDFName.of('First');
    const lastName = PDFName.of('Last');
    const countName = PDFName.of('Count');
    const titleName = PDFName.of('Title');
    const destName = PDFName.of('Dest');
    const typeName = PDFName.of('Type');

    const pdfNull = doc.context.obj(null);

    interface INodeBuild {
        ref: PDFRef;
        dict: PDFDict;
        item: IPdfBookmarkEntry;
        visibleCount: number;
    }

    function buildLevel(
        items: IPdfBookmarkEntry[],
        parentRef: PDFRef,
    ): {
        first: PDFRef | null;
        last: PDFRef | null;
        visibleCount: number 
    } {
        if (items.length === 0) {
            return {
                first: null,
                last: null,
                visibleCount: 0, 
            };
        }

        const pageCount = doc.getPageCount();
        const nodes: INodeBuild[] = items.map((item) => {
            const dict = doc.context.obj({}) as PDFDict;
            dict.set(titleName, PDFHexString.fromText(item.title));

            if (typeof item.pageIndex === 'number' && item.pageIndex >= 0 && item.pageIndex < pageCount) {
                const pageRef = doc.getPage(item.pageIndex).ref;
                const destArray = doc.context.obj([
                    pageRef,
                    PDFName.of('XYZ'),
                    pdfNull,
                    pdfNull,
                    pdfNull,
                ]);
                dict.set(destName, destArray);
            }

            const ref = doc.context.register(dict);
            return {
                ref,
                dict,
                item,
                visibleCount: 1, 
            };
        });

        for (const [
            index,
            node,
        ] of nodes.entries()) {
            node.dict.set(parentName, parentRef);
            if (index > 0) {
                const previous = nodes[index - 1];
                if (previous) node.dict.set(prevName, previous.ref);
            }
            if (index + 1 < nodes.length) {
                const next = nodes[index + 1];
                if (next) node.dict.set(nextName, next.ref);
            }
        }

        for (const node of nodes) {
            const childResult = buildLevel(node.item.items, node.ref);
            if (childResult.first && childResult.last) {
                node.dict.set(firstName, childResult.first);
                node.dict.set(lastName, childResult.last);
                if (childResult.visibleCount > 0) {
                    node.dict.set(countName, PDFNumber.of(childResult.visibleCount));
                }
                node.visibleCount += childResult.visibleCount;
            }
        }

        return {
            first: nodes[0]?.ref ?? null,
            last: nodes[nodes.length - 1]?.ref ?? null,
            visibleCount: nodes.reduce((total, node) => total + node.visibleCount, 0),
        };
    }

    const outlinesDict = doc.context.obj({}) as PDFDict;
    outlinesDict.set(typeName, PDFName.of('Outlines'));
    const outlinesRef = doc.context.register(outlinesDict);

    const tree = buildLevel(bookmarks, outlinesRef);
    if (tree.first && tree.last) {
        outlinesDict.set(firstName, tree.first);
        outlinesDict.set(lastName, tree.last);
        outlinesDict.set(countName, PDFNumber.of(tree.visibleCount));
        doc.catalog.set(outlinesName, outlinesRef);
    }

    return new Uint8Array(await doc.save());
}

async function handleDjvuOpenForViewing(
    event: IpcMainInvokeEvent,
    djvuPath: string,
): Promise<{
    success: boolean;
    pdfPath?: string;
    pageCount?: number;
    error?: string
}> {
    const window = BrowserWindow.fromWebContents(event.sender);
    const jobId = `djvu-view-${Date.now()}`;

    try {
        const pageCount = await getDjvuPageCount(djvuPath);

        // Phase 1: Convert page 1 immediately for fast display
        const tempPage1Path = join(
            app.getPath('temp'),
            `djvu-page1-${Date.now()}.pdf`,
        );

        const page1Result = await convertDjvuToPdf(djvuPath, tempPage1Path, jobId, {pages: '1'});

        if (!page1Result.success) {
            return {
                success: false,
                error: page1Result.error,
            };
        }

        // Phase 2: Build skeleton PDF or start background conversion
        let initialPdfPath: string;

        if (pageCount > 1) {
            // Build skeleton: page 1 content + (N-1) blank pages with correct dimensions.
            // This gives pdf.js the correct page count immediately for scrollbar/thumbnails.
            initialPdfPath = await buildSkeletonPdf(tempPage1Path, pageCount);

            // Page 1 content is now embedded in the skeleton — clean up the original
            unlink(tempPage1Path).catch(() => {});

            backgroundConvertAll(window, djvuPath, pageCount, jobId).catch(() => {
                // Error handling is done inside backgroundConvertAll via viewingError event
            });
        } else {
            initialPdfPath = tempPage1Path;
            backgroundEmbedBookmarksAndSignal(window, djvuPath, tempPage1Path).catch(() => {
                // Best effort for single-page files
            });
        }

        return {
            success: true,
            pdfPath: initialPdfPath,
            pageCount,
        };
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

async function backgroundEmbedBookmarksAndSignal(
    window: BrowserWindow | null | undefined,
    djvuPath: string,
    pdfPath: string,
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
        });
    } catch (err) {
        safeSendToWindow(window, 'djvu:viewingError', {error: err instanceof Error ? err.message : String(err)});
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
        if (y < margin) break;

        for (let j = 0; j < lineCount; j++) {
            if (y < margin) break;

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

    for (let i = 1; i < pageCount; i++) {
        addSkeletonPage(doc, width, height);
    }

    const skeletonPath = join(app.getPath('temp'), `djvu-skeleton-${Date.now()}.pdf`);
    await writeFile(skeletonPath, new Uint8Array(await doc.save()));
    return skeletonPath;
}

async function buildIntermediatePdf(
    quickPdfPath: string,
    pageCount: number,
): Promise<string> {
    const quickData = await readFile(quickPdfPath);
    const quickDoc = await PDFDocument.load(quickData, { updateMetadata: false });

    const doc = await PDFDocument.create();
    const quickPages = await doc.copyPages(quickDoc, quickDoc.getPageIndices());

    let width = 612;
    let height = 792;

    for (const page of quickPages) {
        doc.addPage(page);
        const size = page.getSize();
        width = size.width;
        height = size.height;
    }

    const pagesAdded = quickPages.length;
    for (let i = pagesAdded; i < pageCount; i++) {
        addSkeletonPage(doc, width, height);
    }

    const intermediatePath = join(app.getPath('temp'), `djvu-intermediate-${Date.now()}.pdf`);
    await writeFile(intermediatePath, new Uint8Array(await doc.save()));
    return intermediatePath;
}

async function backgroundConvertAll(
    window: BrowserWindow | null | undefined,
    djvuPath: string,
    pageCount: number,
    jobId: string,
) {
    const rangeDir = join(app.getPath('temp'), `djvu-ranges-${Date.now()}`);
    const quickPdfPath = join(app.getPath('temp'), `djvu-quick-${Date.now()}.pdf`);
    let fullConversionDone = false;

    try {
        await mkdir(rangeDir, { recursive: true });

        safeSendToWindow(window, 'djvu:progress', {
            jobId,
            phase: 'loading' as const,
            current: 0,
            total: pageCount,
            percent: 0,
        });

        // Start outline extraction in parallel with page conversion
        const outlinePromise = getDjvuOutline(djvuPath)
            .then((sexp) => parseDjvuOutline(sexp))
            .catch(() => [] as IPdfBookmarkEntry[]);

        // Quick phase: convert pages 1-3 for fast intermediate update.
        // Runs concurrently with the full parallel conversion.
        // Re-converts page 1 for simplicity (avoids passing temp files between phases).
        const quickEndPage = Math.min(3, pageCount);
        const quickJobId = `${jobId}-quick`;

        const quickPromise = convertDjvuToPdf(djvuPath, quickPdfPath, quickJobId, {pages: `1-${quickEndPage}`}).then(async (quickResult) => {
            if (!quickResult.success || fullConversionDone) {
                return;
            }

            try {
                const intermediatePath = await buildIntermediatePdf(quickPdfPath, pageCount);

                if (!fullConversionDone) {
                    safeSendToWindow(window, 'djvu:viewingReady', {
                        pdfPath: intermediatePath,
                        isPartial: true,
                    });
                }
            } catch {
                // Non-critical: intermediate PDF build failed, full conversion will handle it
            }
        }).catch(() => {
            // Quick phase failure is non-critical
        });

        // Full phase: convert all pages in parallel
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

        // Prevent late partial swap after full conversion is ready
        fullConversionDone = true;

        // Wait for quick phase to settle (may still be building intermediate PDF)
        await quickPromise;

        if (!parallelResult.success) {
            safeSendToWindow(window, 'djvu:viewingError', { error: parallelResult.error ?? 'Parallel conversion failed' });
            return;
        }

        // Merge all range PDFs into one document (single pass, single save)
        const mergedDoc = await PDFDocument.create();
        for (const rangePath of parallelResult.rangePaths) {
            const rangeData = await readFile(rangePath);
            const rangeDoc = await PDFDocument.load(rangeData, { updateMetadata: false });
            const copiedPages = await mergedDoc.copyPages(rangeDoc, rangeDoc.getPageIndices());
            for (const page of copiedPages) {
                mergedDoc.addPage(page);
            }
        }

        // Embed bookmarks if present
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

        safeSendToWindow(window, 'djvu:viewingReady', {
            pdfPath: fullPdfPath,
            isPartial: false,
        });
    } catch (err) {
        safeSendToWindow(window, 'djvu:viewingError', { error: err instanceof Error ? err.message : String(err) });
    } finally {
        // Clean up temp directories and quick phase files
        const cleanups = [
            rm(rangeDir, {
                recursive: true,
                force: true, 
            }),
            unlink(quickPdfPath).catch(() => {}),
        ];
        await Promise.allSettled(cleanups);
    }
}

async function handleDjvuConvertToPdf(
    event: IpcMainInvokeEvent,
    djvuPath: string,
    outputPath: string,
    options: {
        subsample?: number;
        preserveBookmarks?: boolean
    },
): Promise<{
    success: boolean;
    pdfPath?: string;
    error?: string
}> {
    const window = BrowserWindow.fromWebContents(event.sender);
    const jobId = `djvu-convert-${Date.now()}`;
    const imageDir = join(app.getPath('temp'), `djvu-images-${Date.now()}`);

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

        // Start outline extraction in parallel with image conversion
        const outlinePromise = (options.preserveBookmarks !== false)
            ? getDjvuOutline(djvuPath).then((sexp) => parseDjvuOutline(sexp)).catch(() => [] as IPdfBookmarkEntry[])
            : Promise.resolve([] as IPdfBookmarkEntry[]);

        // Phase 1: Convert all pages to PPM images in parallel (0-70%)
        // PPM preserves color for any DjVu files that contain color content
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
                error: imageResult.error,
            };
        }

        // Phase 2: Build optimized PDF from images (70-90%)
        // Per-page detection: grayscale pages → DeviceGray, color pages → DeviceRGB
        const imagePaths = Array.from(
            { length: pageCount },
            (_, i) => join(imageDir, `page-${i + 1}.ppm`),
        );

        let pdfData: Uint8Array = await buildOptimizedPdf(imagePaths, effectiveDpi, (page, total) => {
            safeSendToWindow(window, 'djvu:progress', {
                jobId,
                phase: 'converting' as const,
                percent: 70 + Math.round((page / total) * 20),
            });
        });

        // Phase 3: Embed bookmarks (90-100%)
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

        return {
            success: true,
            pdfPath: outputPath,
        };
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
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

function handleDjvuCancel(
    _event: IpcMainInvokeEvent,
    jobId: string,
): { canceled: boolean } {
    return { canceled: cancelConversion(jobId) };
}

async function handleDjvuGetInfo(
    _event: IpcMainInvokeEvent,
    djvuPath: string,
): Promise<{
    pageCount: number;
    sourceDpi: number;
    hasBookmarks: boolean;
    hasText: boolean;
    metadata: Record<string, string>;
}> {
    const [
        pageCount,
        sourceDpi,
        outlineSexp,
        hasText,
        metadata,
    ] = await Promise.all([
        getDjvuPageCount(djvuPath),
        getDjvuResolution(djvuPath),
        getDjvuOutline(djvuPath),
        getDjvuHasText(djvuPath),
        getDjvuMetadata(djvuPath),
    ]);

    const bookmarks = parseDjvuOutline(outlineSexp);

    return {
        pageCount,
        sourceDpi,
        hasBookmarks: bookmarks.length > 0,
        hasText,
        metadata,
    };
}

async function handleDjvuEstimateSizes(
    _event: IpcMainInvokeEvent,
    djvuPath: string,
) {
    const pageCount = await getDjvuPageCount(djvuPath);
    return estimateSizes(djvuPath, pageCount);
}

async function handleDjvuCleanupTemp(
    _event: IpcMainInvokeEvent,
    tempPdfPath: string,
) {
    if (!tempPdfPath) {
        return;
    }

    try {
        const tempDir = app.getPath('temp');
        if (!tempPdfPath.startsWith(tempDir)) {
            return;
        }
        if (!tempPdfPath.includes('djvu-')) {
            return;
        }

        if (existsSync(tempPdfPath)) {
            await unlink(tempPdfPath);
        }
    } catch {
        // Ignore cleanup errors
    }
}

export function registerDjvuHandlers() {
    ipcMain.handle('djvu:openForViewing', handleDjvuOpenForViewing);
    ipcMain.handle('djvu:convertToPdf', handleDjvuConvertToPdf);
    ipcMain.handle('djvu:cancel', handleDjvuCancel);
    ipcMain.handle('djvu:getInfo', handleDjvuGetInfo);
    ipcMain.handle('djvu:estimateSizes', handleDjvuEstimateSizes);
    ipcMain.handle('djvu:cleanupTemp', handleDjvuCleanupTemp);
}
