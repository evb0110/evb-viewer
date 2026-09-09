import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import {OCR_SHARD_SIZE} from '@contracts/ocrIndex';
import type {
    IOcrPageWithWords,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import {resolveSafeOcrIndexBasePath} from '@electron/ocr/worker/indexWriter';
import {
    prepareOcrCatalogV4Generation,
    rollbackPreparedOcrCatalogV4,
} from '@electron/features/ocr/worker/indexWriterV4';
import type {TOcrJobStorageBudget} from '@electron/features/ocr/worker/ocrJobStorageBudget';
import {isAbortError} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';

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
