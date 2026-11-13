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
import { runPageStructureCommand } from '@electron/features/page-ops/main/pageStructureCommand';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';

const log = createLogger('page-ops-insert-service');

interface IInsertPagesFromSourcePathsOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
}

async function prepareInsertionSourcePdf(
    targetPath: string,
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
        targetPath,
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

/** Writes `sourcePath` with the pages of `sourcePaths` inserted after `afterPage` to `targetPath`. */
export async function insertPagesFromSourcePaths(
    sourcePath: string,
    targetPath: string,
    totalPages: number,
    sourcePaths: TOpenPath[],
    afterPage: number,
    onProgress?: (progress: ICreatePdfFromInputPathsProgress) => void,
    options: IInsertPagesFromSourcePathsOptions = {},
) {
    if (afterPage > totalPages) {
        throw new Error('Invalid afterPage');
    }
    const {
        sourcePdfPath,
        cleanup,
    } = await prepareInsertionSourcePdf(targetPath, sourcePaths, onProgress, options);

    try {
        await runPageStructureCommand('insert-pages', sourcePath, targetPath, {
            sources: [sourcePdfPath],
            afterPage,
        }, options);
    } finally {
        await cleanup();
    }
}
