import { getErrorMessage } from '@electron/utils/error';
import {runOcrCommand} from '@electron/features/ocr/worker/runOcrCommand';
import type {
    IOcrPageGeometry, TWorkerLog,
} from '@electron/ocr/worker/types';
import {
    readPdfPageSizeChunks,
    type IPdfPageSizeChunk,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import type {TScanCleanupRunCommand} from '@evb/scan-cleanup/core/types';

export interface IOcrPageSizeInches extends Partial<IOcrPageGeometry> {
    width: number;
    height: number;
}

export type TOcrPageSizeProbeResult =
    | {
        status: 'available';
        pageSizes: Map<number, IOcrPageSizeInches>;
    }
    | {
        status: 'degraded';
        reason: 'native-tool-unavailable' | 'native-tool-failed';
        message: string;
        pageSizes: Map<number, IOcrPageSizeInches>;
    };

export interface IOcrPageSizeProbeInput {
    pdfPath: string;
    pdfPageOpsBinary?: string;
    qpdfBinary?: string;
    tempDir: string;
    pageNumbers?: readonly number[];
    signal?: AbortSignal;
    log?: TWorkerLog;
    runCommand?: TScanCleanupRunCommand;
}

function abortIfRequested(signal?: AbortSignal) {
    if (!signal?.aborted) {
        return;
    }
    throw signal.reason instanceof Error ? signal.reason : new Error('OCR job aborted');
}

async function readNativePageSizes(
    input: IOcrPageSizeProbeInput & {pdfPageOpsBinary: string},
): Promise<Map<number, IOcrPageSizeInches>> {
    abortIfRequested(input.signal);
    const requestedPageNumbers = input.pageNumbers === undefined
        ? null
        : new Set(input.pageNumbers);
    const pageSizes = new Map<number, IOcrPageSizeInches>();
    const runCommand = input.runCommand ?? runOcrCommand;
    const options = {
        pdfPageOpsBinary: input.pdfPageOpsBinary,
        ...(input.qpdfBinary === undefined ? {} : {qpdfBinary: input.qpdfBinary}),
        tempDir: input.tempDir,
        ...(input.signal === undefined ? {} : {signal: input.signal}),
        log: input.log ?? (() => undefined),
        runCommand,
    };
    for await (const chunk of readPdfPageSizeChunks(input.pdfPath, options)) {
        addPageSizeChunk(pageSizes, chunk, requestedPageNumbers);
        abortIfRequested(input.signal);
    }
    return pageSizes;
}

function addPageSizeChunk(
    pageSizes: Map<number, IOcrPageSizeInches>,
    chunk: IPdfPageSizeChunk,
    requestedPageNumbers: Set<number> | null,
) {
    for (const page of chunk.pages) {
        if (requestedPageNumbers !== null && !requestedPageNumbers.has(page.pageNumber)) {
            continue;
        }
        pageSizes.set(page.pageNumber, {
            width: page.widthPoints / 72,
            height: page.heightPoints / 72,
            xPoints: page.xPoints,
            yPoints: page.yPoints,
            widthPoints: page.widthPoints,
            heightPoints: page.heightPoints,
            rotation: (() => {
                if (page.rotation !== 0 && page.rotation !== 90 && page.rotation !== 180 && page.rotation !== 270) {
                    throw new Error(`unsupported source rotation ${page.rotation}`);
                }
                return page.rotation;
            })(),
        });
    }
}

export async function readOcrPdfPageSizesInches(
    input: IOcrPageSizeProbeInput,
): Promise<TOcrPageSizeProbeResult> {
    const pdfPageOpsBinary = input.pdfPageOpsBinary;
    if (pdfPageOpsBinary === undefined) {
        const message = 'Native PDF page-size inspection is unavailable; OCR resource budgeting is using conservative defaults';
        input.log?.('warn', message);
        return {
            status: 'degraded',
            reason: 'native-tool-unavailable',
            message,
            pageSizes: new Map(),
        };
    }

    try {
        return {
            status: 'available',
            pageSizes: await readNativePageSizes({
                ...input,
                pdfPageOpsBinary,
            }),
        };
    } catch (error) {
        abortIfRequested(input.signal);
        const message = `Native PDF page-size inspection failed; OCR resource budgeting is using conservative defaults: ${getErrorMessage(error)}`;
        input.log?.('warn', message);
        return {
            status: 'degraded',
            reason: 'native-tool-failed',
            message,
            pageSizes: new Map(),
        };
    }
}
