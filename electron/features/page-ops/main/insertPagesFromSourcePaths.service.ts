import { randomUUID } from 'node:crypto';
import { existsSync } from 'fs';
import {unlink} from 'fs/promises';
import {
    extname,
    join,
} from 'path';
import {
    type ICreatePdfFromInputPathsProgress,
    createPdfFileFromInputPaths,
    isPdfOrImagePath,
} from '@electron/image/pdfConversion';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import {
    assertNonEmptyPdfOutput,
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
    runQpdfCommand,
} from '@electron/features/page-ops/main/qpdf';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';

const log = createLogger('page-ops-insert-service');

interface IInsertPagesFromSourcePathsOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
}

async function prepareInsertionSourcePdf(
    workingCopyPath: string,
    sourcePaths: TOpenPath[],
    onProgress?: (progress: ICreatePdfFromInputPathsProgress) => void,
    options: IInsertPagesFromSourcePathsOptions = {},
) {
    if (sourcePaths.length === 0) {
        throw new Error('At least one source file is required');
    }

    for (const sourcePath of sourcePaths) {
        if (!existsSync(sourcePath)) {
            throw new Error(`Source file not found: ${sourcePath}`);
        }
        if (!isPdfOrImagePath(sourcePath)) {
            throw new Error(`Unsupported source file type: ${sourcePath}`);
        }
    }

    if (sourcePaths.length === 1 && extname(sourcePaths[0]!).toLowerCase() === '.pdf') {
        return {
            sourcePdfPath: sourcePaths[0]!,
            cleanup: async () => {},
        };
    }

    const combineOptions = {
        ...(onProgress ? {onProgress} : {}),
        ...(options.signal ? {signal: options.signal} : {}),
    };
    const tempSourcePdfPath = join(
        workingCopyPath,
        '..',
        `insert-source-${randomUUID()}.pdf`,
    );

    await createPdfFileFromInputPaths(sourcePaths, tempSourcePdfPath, combineOptions);

    return {
        sourcePdfPath: tempSourcePdfPath,
        cleanup: async () => {
            try {
                if (existsSync(tempSourcePdfPath)) {
                    await unlink(tempSourcePdfPath);
                }
            } catch (cleanupError) {
                log.debug(`Failed to cleanup insertion source PDF "${tempSourcePdfPath}": ${
                    getErrorMessage(cleanupError)
                }`);
            }
        },
    };
}

export async function insertPagesFromSourcePaths(
    workingCopyPath: string,
    expectedTotalPages: number,
    sourcePaths: TOpenPath[],
    afterPage: number,
    senderWebContentsId?: number,
    onProgress?: (progress: ICreatePdfFromInputPathsProgress) => void,
    options: IInsertPagesFromSourcePathsOptions = {},
) {
    if (!await ensureWorkingCopyDirectory(workingCopyPath, senderWebContentsId)) {
        throw new Error('Working copy path is not managed');
    }
    const totalPages = await getPdfPageCount(workingCopyPath, options);
    if (expectedTotalPages !== totalPages) {
        throw new Error('Renderer page count is stale');
    }
    if (afterPage > totalPages) {
        throw new Error('Invalid afterPage');
    }
    const tempPath = makeTempPdfOutputPath(workingCopyPath);

    const {
        sourcePdfPath,
        cleanup,
    } = await prepareInsertionSourcePdf(workingCopyPath, sourcePaths, onProgress, options);

    try {
        const pagesArgs: string[] = [];

        if (afterPage >= 1) {
            pagesArgs.push(workingCopyPath, `1-${afterPage}`);
        }

        pagesArgs.push(sourcePdfPath, '1-z');

        if (afterPage < totalPages) {
            pagesArgs.push(workingCopyPath, `${afterPage + 1}-${totalPages}`);
        }

        const args = [
            workingCopyPath,
            '--pages',
            ...pagesArgs,
            '--',
            tempPath,
        ];
        await runQpdfCommand(args, {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
            commandLabel: 'qpdf(insert-pages)',
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
            workingCopyMaterialization: {
                path: workingCopyPath,
                ...(senderWebContentsId === undefined ? {} : {senderWebContentsId}),
                ...(options.signal ? {signal: options.signal} : {}),
            },
        });
        await assertNonEmptyPdfOutput(tempPath, 'Inserting pages');
        await replaceTempOutput(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTempOutput(tempPath, log, 'temporary insert output');
        throw err;
    } finally {
        await cleanup();
    }
}
