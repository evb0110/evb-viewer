import {
    copyFile,
    rm,
    writeFile,
} from 'fs/promises';
import {constants as fsConstants} from 'node:fs';
import {join} from 'path';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { createManagedScratchTempDir } from '@electron/utils/managedScratchTemp';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { ensureWorkingCopyMaterialized } from '@electron/file-access/workingCopyMaterialization';
import { getWorkingCopyBackingEntry } from '@electron/file-access/workingCopyStore';
import { runWithWorkingCopyMutationCommitSignal } from '@electron/file-access/workingCopyMutationCommitSignal';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/main/resolveNativePageOpsPath';
import {
    type IPageStructureOptions,
    runPageStructureCommand,
} from '@electron/features/page-ops/main/pageStructureCommand';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import {
    assertNonEmptyPdfOutput,
    getPdfPageCount,
    QPDF_TIMEOUT_MS,
} from '@electron/features/page-ops/main/qpdf';
import {
    formatPageDeleteRanges,
    formatPageMoveRange,
    formatPageMoveRanges,
    isPageMoveNoOp,
    isPageMoveRangesNoOp,
} from '@electron/features/page-ops/domain/pageNumbers';
import {
    createPageMoveRange,
    createPageMoveRanges,
} from '@pdf-core/pdfPageSelection';
import type {
    IPageMoveRangeSegment,
    IPageMoveRanges,
} from '@contracts/pageNumbers';
import { createLogger } from '@electron/utils/createLogger';

const log = createLogger('page-ops-structure');

const NON_COMMITTING_MATERIALIZATION_SIGNAL = {markCommitStarted: () => undefined};

export async function materializePageOperationWorkingCopy(
    workingCopyPath: string,
    senderWebContentsId?: number,
    signal?: AbortSignal,
) {
    if (!getWorkingCopyBackingEntry(workingCopyPath, senderWebContentsId)) {
        if (!await ensureWorkingCopyDirectory(workingCopyPath, senderWebContentsId)) {
            throw new Error('Working copy path is not managed');
        }
        return workingCopyPath;
    }
    // Materializing copies the original's bytes into place atomically: it is
    // not the page operation's commit, and a cancel before or after it leaves
    // the document's content unchanged.
    const result = await runWithWorkingCopyMutationCommitSignal(NON_COMMITTING_MATERIALIZATION_SIGNAL, () =>
        ensureWorkingCopyMaterialized(workingCopyPath, {
            reason: 'page-operation',
            ...(senderWebContentsId === undefined ? {} : {ownerWebContentsId: senderWebContentsId}),
            ...(signal ? {signal} : {}),
        }));
    return result.physicalWorkingCopyPath;
}

/** Consecutive pages as `first-last` runs, in the given order. */
function pageRuns(pages: readonly number[]) {
    const runs: string[] = [];
    let start = pages[0];
    let previous = start;
    for (const page of [...pages.slice(1), undefined]) {
        if (page !== undefined && previous !== undefined && page === previous + 1) {
            previous = page;
            continue;
        }
        if (start !== undefined) runs.push(start === previous ? String(start) : `${start}-${previous}`);
        start = page;
        previous = page;
    }
    return runs;
}

function rangeRuns(ranges: readonly IPageMoveRangeSegment[]) {
    return ranges.map(range => range.startPage === range.endPage
        ? String(range.startPage)
        : `${range.startPage}-${range.endPage}`);
}

async function extractPageList(srcPath: string, destPath: string, pages: string[], options: IPageStructureOptions) {
    const readPath = getWorkingCopyBackingEntry(srcPath, options.senderWebContentsId)
        ? await materializePageOperationWorkingCopy(srcPath, options.senderWebContentsId, options.signal)
        : srcPath;
    await runPageStructureCommand('extract-pages', readPath, destPath, {pages}, options);
}

export async function extractPages(
    srcPath: string,
    destPath: string,
    pages: number[],
    options: IPageStructureOptions = {},
) {
    return extractPageList(srcPath, destPath, pageRuns(pages), options);
}

/** Extracts validated page ranges without expanding them into a dense page array. */
export async function extractPageRanges(
    srcPath: string,
    destPath: string,
    ranges: readonly IPageMoveRangeSegment[],
    options: IPageStructureOptions = {},
) {
    return extractPageList(srcPath, destPath, rangeRuns(ranges), options);
}

async function materializeWithPageCount(
    workingCopyPath: string,
    expectedTotalPages: number | undefined,
    senderWebContentsId: number | undefined,
    options: IPageStructureOptions,
) {
    const materializedPath = await materializePageOperationWorkingCopy(
        workingCopyPath,
        senderWebContentsId,
        options.signal,
    );
    const totalPages = await getPdfPageCount(materializedPath, options);
    if (expectedTotalPages !== undefined && expectedTotalPages !== totalPages) {
        throw new Error('Renderer page count is stale');
    }
    return {
        materializedPath,
        totalPages,
    };
}

export async function deletePages(
    workingCopyPath: string,
    pagesToDelete: number[],
    expectedTotalPages?: number,
    senderWebContentsId?: number,
    options: IPageStructureOptions = {},
) {
    const {
        materializedPath, totalPages,
    } = await materializeWithPageCount(workingCopyPath, expectedTotalPages, senderWebContentsId, options);
    const removed = [...new Set(pagesToDelete)]
        .filter(page => Number.isSafeInteger(page) && page >= 1 && page <= totalPages)
        .sort((left, right) => left - right);
    if (removed.length >= totalPages) {
        throw new Error('Cannot delete all pages from the document');
    }
    await runPageStructureCommand('delete-pages', materializedPath, materializedPath, {pages: pageRuns(removed)}, options);
    return {pageCount: totalPages - removed.length};
}

/** Deletes sorted, disjoint page runs without expanding them into one entry per page. */
export async function deletePageRanges(
    workingCopyPath: string,
    ranges: readonly IPageMoveRangeSegment[],
    expectedTotalPages?: number,
    senderWebContentsId?: number,
    options: IPageStructureOptions = {},
) {
    const {
        materializedPath, totalPages,
    } = await materializeWithPageCount(workingCopyPath, expectedTotalPages, senderWebContentsId, options);
    const {keptCount} = formatPageDeleteRanges(ranges, totalPages);
    if (keptCount === 0) {
        throw new Error('Cannot delete all pages from the document');
    }
    await runPageStructureCommand('delete-pages', materializedPath, materializedPath, {pages: rangeRuns(ranges)}, options);
    return {pageCount: keptCount};
}

export async function reorderPages(
    workingCopyPath: string,
    newOrder: number[],
    senderWebContentsId?: number,
    options: IPageStructureOptions = {},
) {
    const materializedPath = await materializePageOperationWorkingCopy(workingCopyPath, senderWebContentsId, options.signal);
    await runPageStructureCommand('reorder-pages', materializedPath, materializedPath, {pages: pageRuns(newOrder)}, options);
    return {pageCount: newOrder.length};
}

/** Moves one contiguous page range; the new order is sent as a few runs. */
export async function movePages(
    workingCopyPath: string,
    startPage: number,
    endPage: number,
    insertAt: number,
    expectedTotalPages?: number,
    senderWebContentsId?: number,
    options: IPageStructureOptions = {},
) {
    const {
        materializedPath, totalPages,
    } = await materializeWithPageCount(workingCopyPath, expectedTotalPages, senderWebContentsId, options);
    const move = createPageMoveRange(totalPages, startPage, endPage, insertAt);
    if (!isPageMoveNoOp(move)) {
        await runPageStructureCommand('reorder-pages', materializedPath, materializedPath, {pages: formatPageMoveRange(move).split(',')}, options);
    }
    return {pageCount: totalPages};
}

export const movePageRange = movePages;

/** Moves sorted, non-contiguous page runs; the new order is sent as runs. */
export async function movePageRanges(
    workingCopyPath: string,
    requestedMove: IPageMoveRanges,
    expectedTotalPages?: number,
    senderWebContentsId?: number,
    options: IPageStructureOptions = {},
) {
    const {
        materializedPath, totalPages,
    } = await materializeWithPageCount(workingCopyPath, expectedTotalPages, senderWebContentsId, options);
    const move = createPageMoveRanges(totalPages, requestedMove.ranges, requestedMove.insertAt);
    if (!isPageMoveRangesNoOp(move)) {
        await runPageStructureCommand('reorder-pages', materializedPath, materializedPath, {pages: formatPageMoveRanges(move).split(',')}, options);
    }
    return {pageCount: totalPages};
}

export type TRotationAngle = 90 | 180 | 270;

function createNativeModifiedAt() {
    const date = new Date();
    const pad = (value: number, length = 2) => String(value).padStart(length, '0');
    return `D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * Rotation appends only the selected page dictionaries. An in-place append
 * writes through every hard link to the file, so a working copy that shares
 * its inode with the original is copied first, the copy takes the append, and
 * it replaces the working copy. The caller owns the revision journal and must
 * materialize a managed working copy before entering the transition.
 */
export async function rotatePages(
    workingCopyPath: string,
    pages: number[],
    angle: TRotationAngle,
    appendInPlace: boolean,
    senderWebContentsId?: number,
    options: IPageStructureOptions = {},
) {
    const materializedPath = await materializePageOperationWorkingCopy(
        workingCopyPath,
        senderWebContentsId,
        options.signal,
    );
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Native page rotation is unavailable');
    }

    const tempDir = await createManagedScratchTempDir('pdf-page-ops-', getAppTempDir());
    const mutationsPath = join(tempDir, 'mutations.json');
    const targetPath = appendInPlace ? materializedPath : makeTempPdfOutputPath(materializedPath);
    try {
        if (!appendInPlace) {
            await copyFile(materializedPath, targetPath, fsConstants.COPYFILE_FICLONE);
        }
        const pageRotations = pages.map(page => ({
            pageIndex: page - 1,
            angle,
        }));
        await writeFile(mutationsPath, JSON.stringify({pageRotations}), 'utf8');
        await runNativeToolCommand(binaryPath, [
            'save-mutations',
            '--input',
            targetPath,
            '--output',
            targetPath,
            '--mutations-file',
            mutationsPath,
            '--qpdf',
            getPdfNativeToolPaths().qpdf,
            '--modified-at',
            createNativeModifiedAt(),
            '--append',
            '--append-in-place',
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            commandLabel: 'evb-pdf-page-ops(page-rotation)',
            ...options,
        });
        await assertNonEmptyPdfOutput(targetPath, 'Rotating pages');
        if (!appendInPlace) {
            await replaceTempOutput(targetPath, materializedPath);
        }
    } catch (err) {
        if (!appendInPlace) {
            await cleanupTempOutput(targetPath, log, 'rotation temp file');
        }
        throw err;
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    }
}
