import {
    copyFile,
    symlink,
    rm,
    stat,
    unlink,
    writeFile,
} from 'fs/promises';
import {
    constants as fsConstants,
    writeFileSync,
} from 'node:fs';
import {devNull} from 'node:os';
import {
    dirname, join, resolve,
} from 'path';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { isErrnoException } from '@contracts/runtimeGuards';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import { ensureWorkingCopyMaterialized } from '@electron/file-access/workingCopyMaterialization';
import { getWorkingCopyBackingEntry } from '@electron/file-access/workingCopyStore';
import {
    createManagedScratchTempDir, usingManagedScratchScope,
} from '@electron/utils/managedScratchTemp';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public/nativePageOpsPath';
import {
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
} from '@electron/pdf/pdfPageCount';
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
import { runWithWorkingCopyMutationCommitSignal } from '@electron/file-access/workingCopyMutationCommitSignal';
import {runtimeConfig} from '@electron/runtimeConfig';

const log = createLogger('page-ops-qpdf');
export {
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
};

export interface IQpdfOperationOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
    senderWebContentsId?: number;
}

interface IQpdfWorkingCopyMaterialization {
    path: string;
    senderWebContentsId?: number;
    signal?: AbortSignal;
}
type TRunQpdfCommandOptions = Parameters<typeof runNativeToolCommand>[2]
    & {
        workingCopyMaterialization?: IQpdfWorkingCopyMaterialization;
        scratchDirectory?: string;
    };

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

function getQpdfBinary() {
    return getPdfNativeToolPaths().qpdf;
}

function formatPageList(pages: number[]) {
    const ranges: string[] = [];
    let rangeStart: number | null = null;
    let previous: number | null = null;

    for (const page of pages) {
        if (rangeStart === null || previous === null) {
            rangeStart = page;
            previous = page;
            continue;
        }

        if (page === previous + 1) {
            previous = page;
            continue;
        }

        ranges.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`);
        rangeStart = page;
        previous = page;
    }

    if (rangeStart !== null && previous !== null) {
        ranges.push(rangeStart === previous ? String(rangeStart) : `${rangeStart}-${previous}`);
    }

    return ranges.join(',');
}

function formatPageRangeList(ranges: readonly IPageMoveRangeSegment[]) {
    return ranges
        .map(range => range.startPage === range.endPage
            ? String(range.startPage)
            : `${range.startPage}-${range.endPage}`)
        .join(',');
}

function createSelectedPagePrintQpdfSpawnHold(argsPath: string, cancelGroup?: string) {
    const markerPath = runtimeConfig.test.holdSelectedPageQpdfMarker;
    if (
        !runtimeConfig.test.issue124Acceptance
        || !markerPath
        || !cancelGroup?.startsWith('print-selected-pages:')
    ) {
        return undefined;
    }

    return (pid: number) => {
        process.kill(pid, 'SIGSTOP');
        writeFileSync(markerPath, JSON.stringify({
            argsPath,
            pid,
        }));
    };
}

function formatComplementPageList(pagesToRemove: number[], totalPages: number) {
    const removePages = [...new Set(pagesToRemove)]
        .filter(page => Number.isSafeInteger(page) && page >= 1 && page <= totalPages)
        .sort((left, right) => left - right);
    const ranges: string[] = [];
    let nextKeptPage = 1;

    for (const removedPage of removePages) {
        if (nextKeptPage < removedPage) {
            ranges.push(nextKeptPage === removedPage - 1
                ? String(nextKeptPage)
                : `${nextKeptPage}-${removedPage - 1}`);
        }
        nextKeptPage = removedPage + 1;
    }

    if (nextKeptPage <= totalPages) {
        ranges.push(nextKeptPage === totalPages
            ? String(nextKeptPage)
            : `${nextKeptPage}-${totalPages}`);
    }

    return {
        pageList: ranges.join(','),
        keptCount: totalPages - removePages.length,
    };
}

// A page operation's `--pages` output, reconciled with the kept pages' tags, layers and forms.
// Removing pages rewrites it so no old revision keeps their text.
export async function runQpdfPageOperation(args: string[], options: TRunQpdfCommandOptions, removesPages = false) {
    const output = args.at(-1)!;
    const {
        workingCopyMaterialization: _materialized, ...rewrite
    } = options;
    await runQpdfCommand(args, options);
    await finalizeSubsetForms(output, {
        ...(options.signal ? {signal: options.signal} : {}),
        ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
    });
    if (removesPages) await runQpdfCommand([
        output,
        '--replace-input',
    ], {
        ...rewrite,
        commandLabel: 'qpdf(compact-page-subset)',
    });
}

export async function runQpdfCommand(
    args: string[],
    options: TRunQpdfCommandOptions,
) {
    const {
        workingCopyMaterialization,
        scratchDirectory,
        ...nativeOptions
    } = options;
    if (workingCopyMaterialization) {
        await materializePageOperationWorkingCopy(
            workingCopyMaterialization.path,
            workingCopyMaterialization.senderWebContentsId,
            workingCopyMaterialization.signal,
        );
    }
    const runWithArguments = async (tempDir: string) => {
        const argsPath = join(tempDir, 'args.txt');
        if (/[\r\n]/u.test(argsPath)) throw new TypeError('qpdf argument scratch path contains a line break');
        const binary = getQpdfBinary();
        const aliases = new Map<string, string>();
        const encoded: string[] = [];
        // The supported commands put CR/LF only in path operands. A symlink
        // preserves their spelling, including a not-yet-created staged output.
        for (const arg of args) {
            if (!/[\r\n]/u.test(arg)) {
                encoded.push(arg);
                continue;
            }
            const target = resolve(nativeOptions.cwd ?? dirname(binary), arg);
            let alias = aliases.get(target);
            if (alias === undefined) {
                alias = join(tempDir, `path-${aliases.size}.pdf`);
                await symlink(target, alias, 'file');
                aliases.set(target, alias);
            }
            encoded.push(alias);
        }
        await writeFile(argsPath, encoded.join('\n'));
        const onSpawn = createSelectedPagePrintQpdfSpawnHold(argsPath, nativeOptions.cancelGroup);
        await runNativeToolCommand(binary, [`@${argsPath}`], {
            ...nativeOptions,
            ...(onSpawn ? {onSpawn} : {}),
        });
    };
    if (scratchDirectory === undefined) {
        await usingManagedScratchScope('qpdfArgs-', getAppTempDir(), runWithArguments);
    } else {
        await runWithArguments(scratchDirectory);
    }
}

/** Strict reopen/xref gate: warning-corrupt output is not promotable. */
export async function verifyPdfStructureStrict(pdfPath: string, options: IQpdfOperationOptions = {}) {
    // Page operations rewrite objects, never stream data, so a full reparse and
    // rewrite without stream decoding covers what they can break. `qpdf --check`
    // also decodes every image, which takes most of a minute on a large scan.
    await runNativeToolCommand(getQpdfBinary(), [
        '--decode-level=none',
        '--compress-streams=n',
        pdfPath,
        devNull,
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: [0],
        commandLabel: 'qpdf(strict-structure-check)',
        ...options,
    });
}

async function finalizeSubsetForms(pdfPath: string, options: IQpdfOperationOptions) {
    const command = 'finalize-subset-forms';
    const binary = resolveNativePageOpsPath();
    if (!binary) throw new Error('Native page structure finalization is unavailable');
    await runNativeToolCommand(binary, [
        command,
        '--input',
        pdfPath,
        '--output',
        pdfPath,
        '--qpdf',
        getQpdfBinary(),
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        commandLabel: `pdf-page-ops(${command})`,
        ...options,
    });
}

async function cleanupQpdfTemp(tempPath: string) {
    await cleanupTempOutput(tempPath, log, 'qpdf temp file');
}

async function createManagedQpdfOutputPath() {
    const tempDir = await createManagedScratchTempDir('qpdfOutput-', getAppTempDir());
    return {
        outputPath: join(tempDir, 'output.pdf'),
        tempDir,
    };
}

async function cleanupManagedQpdfOutput(tempDir: string) {
    try {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    } catch (cleanupError) {
        log.debug(`Failed to cleanup qpdf output directory "${tempDir}": ${
            getErrorMessage(cleanupError)
        }`);
    }
}

async function cleanupEmptyTarget(targetPath: string) {
    try {
        const outputStat = await stat(targetPath);
        if (outputStat.size === 0) {
            await unlink(targetPath);
        }
    } catch (cleanupError) {
        if (isErrnoException(cleanupError) && cleanupError.code === 'ENOENT') {
            return;
        }

        log.debug(`Failed to cleanup empty output file "${targetPath}": ${
            getErrorMessage(cleanupError)
        }`);
    }
}

export async function assertNonEmptyPdfOutput(outputPath: string, operationLabel: string) {
    let outputStat: Awaited<ReturnType<typeof stat>>;
    try {
        outputStat = await stat(outputPath);
    } catch (error) {
        throw new Error(`${operationLabel} failed: qpdf did not produce an output file`, {cause: error});
    }

    if (outputStat.size === 0) {
        throw new Error(`${operationLabel} failed: qpdf produced an empty PDF`);
    }
}

async function extractPageList(
    srcPath: string,
    destPath: string,
    pageList: string,
    commandLabel: string,
    options: IQpdfOperationOptions = {},
) {
    const physicalReadPath = getWorkingCopyBackingEntry(srcPath, options.senderWebContentsId)
        ? await materializePageOperationWorkingCopy(
            srcPath,
            options.senderWebContentsId,
            options.signal,
        )
        : srcPath;
    const qpdfOutput = await createManagedQpdfOutputPath();
    const finalTempPath = makeTempPdfOutputPath(destPath);
    try {
        await runQpdfPageOperation([
            physicalReadPath,
            '--pages',
            physicalReadPath,
            pageList,
            '--',
            qpdfOutput.outputPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel,
            ...options,
        }, true);
        await assertNonEmptyPdfOutput(qpdfOutput.outputPath, 'Extracting pages');
        await copyFile(qpdfOutput.outputPath, finalTempPath);
        await assertNonEmptyPdfOutput(finalTempPath, 'Extracting pages');
        await replaceTempOutput(finalTempPath, destPath);
    } catch (err) {
        await cleanupQpdfTemp(finalTempPath);
        await cleanupEmptyTarget(destPath);
        throw err;
    } finally {
        await cleanupManagedQpdfOutput(qpdfOutput.tempDir);
    }
}

export async function extractPages(
    srcPath: string,
    destPath: string,
    pages: number[],
    options: IQpdfOperationOptions = {},
) {
    return extractPageList(srcPath, destPath, formatPageList(pages), 'qpdf(extract-pages)', options);
}

/** Extracts validated page ranges without expanding them into a dense page array. */
export async function extractPageRanges(
    srcPath: string,
    destPath: string,
    ranges: readonly IPageMoveRangeSegment[],
    options: IQpdfOperationOptions = {},
) {
    return extractPageList(
        srcPath,
        destPath,
        formatPageRangeList(ranges),
        'qpdf(extract-page-ranges)',
        options,
    );
}

export async function deletePages(
    workingCopyPath: string,
    pagesToDelete: number[],
    expectedTotalPages?: number,
    senderWebContentsId?: number,
    options: IQpdfOperationOptions = {},
) {
    return deletePageSelection(
        workingCopyPath,
        totalPages => formatComplementPageList(pagesToDelete, totalPages),
        expectedTotalPages,
        senderWebContentsId,
        options,
    );
}

async function deletePageSelection(
    workingCopyPath: string,
    selection: (totalPages: number) => ReturnType<typeof formatComplementPageList>,
    expectedTotalPages: number | undefined,
    senderWebContentsId: number | undefined,
    options: IQpdfOperationOptions,
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

    const {
        pageList,
        keptCount,
    } = selection(totalPages);
    if (keptCount === 0) {
        throw new Error('Cannot delete all pages from the document');
    }

    const tempPath = makeTempPdfOutputPath(materializedPath);

    try {
        await runQpdfPageOperation([
            materializedPath,
            '--pages',
            materializedPath,
            pageList,
            '--',
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(delete-pages)',
            ...options,
        }, true);
        await assertNonEmptyPdfOutput(tempPath, 'Deleting pages');
        await replaceTempOutput(tempPath, materializedPath);
    } catch (err) {
        await cleanupQpdfTemp(tempPath);
        throw err;
    }

    return { pageCount: keptCount };
}

/**
 * Deletes sorted, disjoint page runs using qpdf's compact survivor list.
 * Unlike the legacy page-array operation, this path never expands a large
 * selection into one entry per document page.
 */
export async function deletePageRanges(
    workingCopyPath: string,
    ranges: readonly IPageMoveRangeSegment[],
    expectedTotalPages?: number,
    senderWebContentsId?: number,
    options: IQpdfOperationOptions = {},
) {
    return deletePageSelection(
        workingCopyPath,
        totalPages => formatPageDeleteRanges(ranges, totalPages),
        expectedTotalPages,
        senderWebContentsId,
        options,
    );
}

export async function reorderPages(
    workingCopyPath: string,
    newOrder: number[],
    senderWebContentsId?: number,
    options: IQpdfOperationOptions = {},
) {
    const materializedPath = await materializePageOperationWorkingCopy(
        workingCopyPath,
        senderWebContentsId,
        options.signal,
    );
    const tempPath = makeTempPdfOutputPath(materializedPath);

    try {
        await runQpdfPageOperation([
            materializedPath,
            '--pages',
            materializedPath,
            formatPageList(newOrder),
            '--',
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(reorder-pages)',
            ...options,
        });
        await assertNonEmptyPdfOutput(tempPath, 'Reordering pages');
        await replaceTempOutput(tempPath, materializedPath);
    } catch (err) {
        await cleanupQpdfTemp(tempPath);
        throw err;
    }

    return { pageCount: newOrder.length };
}

/**
 * Moves one contiguous page range using qpdf's compact page-list syntax.
 * Unlike reorderPages this never constructs the full permutation, which is
 * what lets the desktop path handle a very large page count.
 */
export async function movePages(
    workingCopyPath: string,
    startPage: number,
    endPage: number,
    insertAt: number,
    expectedTotalPages?: number,
    senderWebContentsId?: number,
    options: IQpdfOperationOptions = {},
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
    const move = createPageMoveRange(totalPages, startPage, endPage, insertAt);
    if (isPageMoveNoOp(move)) {
        return { pageCount: totalPages };
    }

    const tempPath = makeTempPdfOutputPath(materializedPath);
    try {
        await runQpdfPageOperation([
            materializedPath,
            '--pages',
            materializedPath,
            formatPageMoveRange(move),
            '--',
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(move-pages)',
            ...options,
        });
        await assertNonEmptyPdfOutput(tempPath, 'Moving pages');
        await replaceTempOutput(tempPath, materializedPath);
    } catch (err) {
        await cleanupQpdfTemp(tempPath);
        throw err;
    }

    return { pageCount: totalPages };
}

export const movePageRange = movePages;

/**
 * Moves sorted, non-contiguous page runs using a compact qpdf page list.
 * The JavaScript side retains only the selected runs and source gaps.
 */
export async function movePageRanges(
    workingCopyPath: string,
    requestedMove: IPageMoveRanges,
    expectedTotalPages?: number,
    senderWebContentsId?: number,
    options: IQpdfOperationOptions = {},
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
    const move = createPageMoveRanges(totalPages, requestedMove.ranges, requestedMove.insertAt);
    if (isPageMoveRangesNoOp(move)) {
        return {pageCount: totalPages};
    }

    const tempPath = makeTempPdfOutputPath(materializedPath);
    try {
        await runQpdfPageOperation([
            materializedPath,
            '--pages',
            materializedPath,
            formatPageMoveRanges(move),
            '--',
            tempPath,
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(move-page-ranges)',
            ...options,
        });
        await assertNonEmptyPdfOutput(tempPath, 'Moving page ranges');
        await replaceTempOutput(tempPath, materializedPath);
    } catch (err) {
        await cleanupQpdfTemp(tempPath);
        throw err;
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
    options: IQpdfOperationOptions = {},
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
            await cleanupQpdfTemp(targetPath);
        }
        throw err;
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    }
}
