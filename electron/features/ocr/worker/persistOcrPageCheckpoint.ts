import {randomUUID} from 'node:crypto';
import {
    copyFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {abortErrorFromSignal} from '@electron/utils/abort';
import type {TOcrJobStorageBudget} from '@electron/features/ocr/worker/ocrJobStorageBudget';

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
    const releaseReservation = await options.storageBudget.reserve(ocrPdfSize);
    try {
        try {
            await copyFile(options.sourcePdfPath, checkpointTempPdf);
        } finally {
            releaseReservation();
        }
        await options.storageBudget.assertWithinBudget();
        const checkpointPdfStat = await stat(checkpointTempPdf);
        if (!checkpointPdfStat.isFile() || checkpointPdfStat.size <= 0) {
            throw new Error(`OCR page ${options.pageNumber} produced an empty PDF checkpoint`);
        }
        const checkpoint = {
            ...options.checkpointData,
            version: 2,
            pdfSize: checkpointPdfStat.size,
            pdfSha256: await options.sha256File(checkpointTempPdf),
        };
        await writeFile(checkpointTempJson, JSON.stringify(checkpoint), 'utf8');
        if (isAborted()) throw abortErrorFromSignal(options.signal);
        await rename(checkpointTempPdf, options.checkpointPdfPath);
        if (isAborted()) throw abortErrorFromSignal(options.signal);
        await rename(checkpointTempJson, options.checkpointJsonPath);
    } finally {
        await Promise.all([
            rm(checkpointTempPdf, {force: true}),
            rm(checkpointTempJson, {force: true}),
        ]).catch(() => undefined);
    }
}
