import {
    rm,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { createManagedScratchTempDir } from '@electron/utils/managedScratchTemp';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/main/resolveNativePageOpsPath';
import {
    type IPageStructureOptions,
    runPageStructureCommand,
} from '@electron/features/page-ops/main/pageStructureCommand';
import {
    assertNonEmptyPdfOutput,
    QPDF_TIMEOUT_MS,
} from '@electron/features/page-ops/main/qpdf';
import {
    formatPageMoveRanges,
    validatePageDeleteRanges,
} from '@electron/features/page-ops/domain/pageNumbers';
import type {
    IPageMoveRangeSegment,
    IPageMoveRanges,
} from '@contracts/pageNumbers';

// Each edit reads `sourcePath` and writes a new PDF at `targetPath`; the
// caller decides what the target becomes (the next document revision, or an
// extracted file).

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

export function extractPages(
    sourcePath: string,
    targetPath: string,
    pages: number[],
    options: IPageStructureOptions = {},
) {
    return runPageStructureCommand('extract-pages', sourcePath, targetPath, {pages: pageRuns(pages)}, options);
}

/** Extracts validated page ranges without expanding them into a dense page array. */
export function extractPageRanges(
    sourcePath: string,
    targetPath: string,
    ranges: readonly IPageMoveRangeSegment[],
    options: IPageStructureOptions = {},
) {
    return runPageStructureCommand('extract-pages', sourcePath, targetPath, {pages: rangeRuns(ranges)}, options);
}

/** Deletes sorted, disjoint page runs; a page array arrives here as its runs. */
export async function deletePageRanges(
    sourcePath: string,
    targetPath: string,
    ranges: readonly IPageMoveRangeSegment[],
    totalPages: number,
    options: IPageStructureOptions = {},
) {
    validatePageDeleteRanges(ranges, totalPages);
    const keptCount = ranges.reduce((count, range) => count - (range.endPage - range.startPage + 1), totalPages);
    if (keptCount === 0) {
        throw new Error('Cannot delete all pages from the document');
    }
    await runPageStructureCommand('delete-pages', sourcePath, targetPath, {pages: rangeRuns(ranges)}, options);
    return {pageCount: keptCount};
}

export async function reorderPages(
    sourcePath: string,
    targetPath: string,
    newOrder: number[],
    options: IPageStructureOptions = {},
) {
    await runPageStructureCommand('reorder-pages', sourcePath, targetPath, {pages: pageRuns(newOrder)}, options);
    return {pageCount: newOrder.length};
}

/** Moves sorted page runs, one or several; the new order is sent as runs. */
export async function movePageRanges(
    sourcePath: string,
    targetPath: string,
    move: IPageMoveRanges,
    options: IPageStructureOptions = {},
) {
    await runPageStructureCommand('reorder-pages', sourcePath, targetPath, {pages: formatPageMoveRanges(move).split(',')}, options);
    return {pageCount: move.pageCount};
}

export type TRotationAngle = 90 | 180 | 270;

function createNativeModifiedAt() {
    const date = new Date();
    const pad = (value: number, length = 2) => String(value).padStart(length, '0');
    return `D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** Rotation appends the selected page dictionaries to `pdfPath`, a file no one else holds. */
export async function rotatePages(
    pdfPath: string,
    pages: number[],
    angle: TRotationAngle,
    options: IPageStructureOptions = {},
) {
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Native page rotation is unavailable');
    }

    const tempDir = await createManagedScratchTempDir('pdf-page-ops-', getAppTempDir());
    const mutationsPath = join(tempDir, 'mutations.json');
    try {
        const pageRotations = pages.map(page => ({
            pageIndex: page - 1,
            angle,
        }));
        await writeFile(mutationsPath, JSON.stringify({pageRotations}), 'utf8');
        await runNativeToolCommand(binaryPath, [
            'save-mutations',
            '--input',
            pdfPath,
            '--output',
            pdfPath,
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
        await assertNonEmptyPdfOutput(pdfPath, 'Rotating pages');
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    }
}
