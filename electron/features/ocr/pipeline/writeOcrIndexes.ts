import {
    lstat,
    realpath,
} from 'node:fs/promises';
import {
    dirname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from 'node:path';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import {OCR_SHARD_SIZE} from '@contracts/ocrIndex';
import type {
    IOcrPageWithWords,
    TWorkerLog,
} from '@electron/features/ocr/pipeline/types';
import {
    prepareOcrCatalogV4Generation,
    rollbackPreparedOcrCatalogV4,
} from '@electron/features/ocr/pipeline/indexWriterV4';
import type {TOcrJobStorageBudget} from '@electron/features/ocr/pipeline/ocrJobStorageBudget';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';

function isPathInsideBaseDir(baseDir: string, candidatePath: string) {
    const relativePath = relative(baseDir, candidatePath);
    return (
        relativePath !== ''
        && relativePath !== '.'
        && relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
    );
}

function isPathInsideAnyBaseDir(baseDirs: string[], candidatePath: string) {
    return baseDirs.some(baseDir => isPathInsideBaseDir(baseDir, candidatePath));
}

export async function resolveSafeOcrIndexBasePath(
    indexPath: string,
    tempDirPath: string,
) {
    const normalizedPath = indexPath.trim();
    if (!normalizedPath) {
        throw new Error('OCR index path must not be empty');
    }

    const absoluteIndexPath = resolve(normalizedPath);
    const absoluteTempDir = resolve(tempDirPath);
    const tempBaseDirs = [absoluteTempDir];
    try {
        const canonicalTempDir = await realpath(absoluteTempDir);
        if (canonicalTempDir !== absoluteTempDir) {
            tempBaseDirs.push(canonicalTempDir);
        }
    } catch {
        // Keep the non-canonical temp directory as the fallback base.
    }

    if (!isPathInsideAnyBaseDir(tempBaseDirs, absoluteIndexPath)) {
        throw new Error('OCR index path is outside the allowed temp directory');
    }

    const indexStat = await lstat(absoluteIndexPath).catch(() => null);
    if (!indexStat) {
        throw new Error('OCR index path does not exist');
    }
    if (indexStat.isSymbolicLink()) {
        throw new Error('OCR index path cannot be a symbolic link');
    }

    const resolvedIndexPath = await realpath(absoluteIndexPath);
    if (!isPathInsideAnyBaseDir(tempBaseDirs, resolvedIndexPath)) {
        throw new Error('OCR index path resolves outside the allowed temp directory');
    }

    const resolvedParentDir = await realpath(dirname(resolvedIndexPath));
    const isInsideTempDir = isPathInsideAnyBaseDir(tempBaseDirs, resolvedParentDir) || tempBaseDirs.includes(resolvedParentDir);
    if (!isInsideTempDir) {
        throw new Error('OCR index path parent directory is outside the allowed temp directory');
    }

    return resolvedIndexPath;
}

export async function writeOcrIndexes(options: {
    sourcePdfPath: string;
    /**
     * The descriptor is written beside this staged PDF. The v4 generation is
     * prepared below the shared working-copy catalog root and remains
     * unpublished until the document apply transition validates this path.
     */
    stagedResultPdfPath: string;
    resultIdentity: string;
    documentRevision: IDocumentRevisionInfo;
    ocrPageData: readonly IOcrPageWithWords[] | AsyncIterable<IOcrPageWithWords>;
    successfulPageCount: number;
    pageCount: number;
    allLanguages: string[];
    effectiveRenderDpi: number;
    signal: AbortSignal;
    tempDir: string;
    log: TWorkerLog;
    storageBudget?: TOcrJobStorageBudget;
}) {
    return writeOcrIndexesWithValidatedPath(options);
}

async function writeOcrIndexesWithValidatedPath(options: Parameters<typeof writeOcrIndexes>[0]) {
    let validatedWorkingCopyPath: string;
    try {
        validatedWorkingCopyPath = await resolveSafeOcrIndexBasePath(options.sourcePdfPath, options.tempDir);
    } catch (pathErr) {
        const pathErrMsg = getErrorMessage(pathErr);
        options.log('warn', `Rejected OCR index path "${options.sourcePdfPath}": ${pathErrMsg}`);
        return ['Skipping OCR index writes due to invalid source PDF path'];
    }

    let prepared: Awaited<ReturnType<typeof prepareOcrCatalogV4Generation>> | null = null;
    try {
        await options.storageBudget?.assertWithinBudget();
        const validatedResultPath = await resolveSafeOcrIndexBasePath(
            options.stagedResultPdfPath,
            options.tempDir,
        );
        prepared = await prepareOcrCatalogV4Generation({
            catalogRoot: `${validatedWorkingCopyPath}.ocr`,
            sourcePdfPath: validatedWorkingCopyPath,
            documentRevision: options.documentRevision,
            pageCount: options.pageCount,
            pageBatches: toOcrIndexPageBatches(options.ocrPageData, options.signal),
            workingCopyPath: validatedWorkingCopyPath,
            resultPath: validatedResultPath,
            resultIdentity: options.resultIdentity,
            signal: options.signal,
            log: options.log,
            extractionDpi: options.effectiveRenderDpi,
        });
        await options.storageBudget?.assertWithinBudget();
    } catch (indexError) {
        if (prepared !== null) {
            await rollbackPreparedOcrCatalogV4(
                prepared,
                {catalogRoot: `${validatedWorkingCopyPath}.ocr`},
            ).catch(() => undefined);
        }
        if (isAbortError(indexError)) {
            throw indexError;
        }
        const indexErrorMessage = getErrorMessage(indexError);
        options.log('error', `Failed to stage OCR text catalog: ${indexErrorMessage}`);
        throw new Error(`Failed to stage OCR text catalog: ${indexErrorMessage}`, {cause: indexError});
    }

    return [];
}

/**
 * The v4 writer updates one shard at a time and bounds each input batch by
 * the shard size. Keep the checkpoint stream lazy while adapting the worker's
 * 5,000-page processing windows to that smaller write unit.
 */
async function* toOcrIndexPageBatches(
    pageData: readonly IOcrPageWithWords[] | AsyncIterable<IOcrPageWithWords>,
    signal: AbortSignal,
): AsyncGenerator<readonly IOcrPageWithWords[]> {
    const batch: IOcrPageWithWords[] = [];
    for await (const page of pageData) {
        if (signal.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('OCR job aborted');
        }
        batch.push(page);
        if (batch.length === OCR_SHARD_SIZE) {
            yield batch.splice(0, batch.length);
        }
    }
    if (batch.length > 0) {
        yield batch;
    }
}
