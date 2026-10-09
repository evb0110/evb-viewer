import {
    createHash, randomUUID,
} from 'node:crypto';
import {
    copyFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {abortErrorFromSignal} from '@electron/utils/abort';
import type {TOcrJobStorageBudget} from '@electron/features/ocr/pipeline/ocrJobStorageBudget';

import {
    EARLY_PRINT_MODEL_CODES,
    OCR_LANGUAGE_MODEL_SHA256,
    type TOcrModelCode,
} from '@contracts/ocrLanguages';
import {canReadEarlyPrint} from '@electron/features/ocr/pipeline/earlyPrintReading';
import {
    getNativeToolBuildIdentity,
    getRuntimeToolArchiveIdentity,
} from '@electron/native-tools/runNativeToolCommand';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import type {
    IOcrSearchablePdfOptions,
    TOcrSearchablePdfPages,
} from '@contracts/electronApiOcr';

/** Bump the recipe when TypeScript raster/preprocess/recognition semantics change. */
export function createOcrCheckpointFingerprint(job: {
    sourcePdfPath: string;
    documentRevision: Pick<IDocumentRevisionInfo, 'token'>;
    pages: TOcrSearchablePdfPages;
    options: IOcrSearchablePdfOptions;
}) {
    const selection = job.pages;
    const languages = Array.isArray(selection) ? selection.flatMap(page => page.languages)
        : selection.kind === 'pages' ? selection.pages.flatMap(page => page.languages) : selection.languages;
    const models = [...new Set([
        ...languages,
        ...(canReadEarlyPrint(languages) ? EARLY_PRINT_MODEL_CODES : []),
    ])].sort() as TOcrModelCode[];
    return createHash('sha256').update(JSON.stringify({
        sourcePdfPath: job.sourcePdfPath,
        documentRevision: job.documentRevision.token,
        pages: selection,
        options: job.options,
        recipe: {
            version: 3,
            scanCleanup: getNativeToolBuildIdentity('evb-scan-cleanup'),
            pageOps: getNativeToolBuildIdentity('evb-pdf-page-ops'),
            tesseract: getRuntimeToolArchiveIdentity('tesseract'),
            poppler: getRuntimeToolArchiveIdentity('poppler'),
            qpdf: getRuntimeToolArchiveIdentity('qpdf'),
            models: models.map(model => [
                model,
                OCR_LANGUAGE_MODEL_SHA256[model],
            ]),
        },
    })).digest('hex');
}

interface IPersistOcrPageCheckpointOptions {
    checkpointJsonPath: string;
    checkpointPdfPath: string;
    checkpointData: Record<string, unknown>;
    pageNumber: number;
    sha256File: (path: string) => Promise<string>;
    signal: AbortSignal;
    sourcePdfPath: string;
    storageBudget: TOcrJobStorageBudget;
}

export async function persistOcrPageCheckpoint(options: IPersistOcrPageCheckpointOptions) {
    const checkpointTempPdf = `${options.checkpointPdfPath}.${process.pid}.${randomUUID()}.tmp`;
    const checkpointTempJson = `${options.checkpointJsonPath}.${process.pid}.${randomUUID()}.tmp`;
    const isAborted = () => options.signal.aborted;
    const ocrPdfSize = (await stat(options.sourcePdfPath)).size;
    const pdfReservation = await options.storageBudget.reserve(ocrPdfSize);
    let jsonReservation: Awaited<ReturnType<TOcrJobStorageBudget['reserve']>> | null = null;
    try {
        await copyFile(options.sourcePdfPath, checkpointTempPdf);
        await options.storageBudget.assertWithinBudget();
        const checkpointPdfStat = await stat(checkpointTempPdf);
        if (!checkpointPdfStat.isFile() || checkpointPdfStat.size <= 0) {
            throw new Error(`OCR page ${options.pageNumber} produced an empty PDF checkpoint`);
        }
        const checkpoint = {
            ...options.checkpointData,
            version: 4,
            pdfSize: checkpointPdfStat.size,
            pdfSha256: await options.sha256File(checkpointTempPdf),
        };
        const checkpointJson = JSON.stringify(checkpoint);
        jsonReservation = await options.storageBudget.reserve(Buffer.byteLength(checkpointJson));
        await writeFile(checkpointTempJson, checkpointJson, 'utf8');
        if (isAborted()) throw abortErrorFromSignal(options.signal);
        await rename(checkpointTempPdf, options.checkpointPdfPath);
        if (isAborted()) throw abortErrorFromSignal(options.signal);
        await rename(checkpointTempJson, options.checkpointJsonPath);
        options.storageBudget.commitCheckpoint([
            pdfReservation,
            jsonReservation,
        ], [
            {
                path: options.checkpointPdfPath,
                bytes: checkpointPdfStat.size,
            },
            {
                path: options.checkpointJsonPath,
                bytes: Buffer.byteLength(checkpointJson),
            },
        ]);
    } finally {
        pdfReservation.release();
        jsonReservation?.release();
        await Promise.all([
            rm(checkpointTempPdf, {force: true}),
            rm(checkpointTempJson, {force: true}),
        ]).catch(() => undefined);
    }
}
