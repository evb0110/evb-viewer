import { getErrorMessage } from '@electron/utils/error';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import type {TWorkerLog} from '@electron/features/ocr/pipeline/types';
import {
    createPdfPageSizeStore,
    type IPdfPageSizeStore,
} from '@evb/scan-cleanup/core/pdfPageSizes';
import type {TScanCleanupRunCommand} from '@evb/scan-cleanup/core/types';

export interface IOcrPageSizeInches {
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

export interface IOcrPageSizeSourceInput {
    pdfPageOpsBinary?: string;
    qpdfBinary?: string;
    tempDir: string;
    signal?: AbortSignal;
    log?: TWorkerLog;
    runCommand?: TScanCleanupRunCommand;
}

export interface IOcrPageSizeSource {
    read: (pdfPath: string, pageNumbers: readonly number[]) => Promise<TOcrPageSizeProbeResult>;
    close: () => Promise<void>;
}

function abortIfRequested(signal?: AbortSignal) {
    if (!signal?.aborted) {
        return;
    }
    throw signal.reason instanceof Error ? signal.reason : new Error('OCR job aborted');
}

async function readPageSizes(
    store: IPdfPageSizeStore,
    pageNumbers: readonly number[],
    signal?: AbortSignal,
): Promise<Map<number, IOcrPageSizeInches>> {
    abortIfRequested(signal);
    const pageSizes = new Map<number, IOcrPageSizeInches>();
    // Ascending reads move the store's one cursor forward through the sidecar.
    for (const pageNumber of [...pageNumbers].sort((left, right) => left - right)) {
        if (store.pageCount !== null && pageNumber > store.pageCount) {
            break;
        }
        try {
            const page = await store.getPage(pageNumber);
            pageSizes.set(pageNumber, {
                width: page.widthPoints / 72,
                height: page.heightPoints / 72,
            });
        } catch (error) {
            // A page past the document's end has no geometry; it is not a failed probe.
            if (error instanceof RangeError && store.pageCount !== null && pageNumber > store.pageCount) {
                break;
            }
            throw error;
        }
        abortIfRequested(signal);
    }
    return pageSizes;
}

/**
 * The page geometry of one OCR job. Each source path gets one bounded
 * metadata-only store whose sidecar the job's request batches read forward,
 * so a job runs the native probe once rather than once per batch, and never
 * analyzes page images it does not use. The job closes the source when it
 * ends, which deletes the sidecar.
 */
export function createOcrPageSizeSource(input: IOcrPageSizeSourceInput): IOcrPageSizeSource {
    let opened: {
        pdfPath: string;
        store: IPdfPageSizeStore
    } | null = null;
    // Closing never rejects: the sidecar lives in the job's temp directory,
    // which the job cleans anyway, and a failed close must neither leave a
    // closed store cached nor replace the job's result in its cleanup.
    const closeOpened = async () => {
        const store = opened?.store;
        opened = null;
        await store?.close().catch((error: unknown) => {
            input.log?.('warn', `OCR page-size source did not close cleanly: ${getErrorMessage(error)}`);
        });
    };
    const openStore = async (pdfPath: string, pdfPageOpsBinary: string) => {
        if (opened?.pdfPath === pdfPath) {
            return opened.store;
        }
        await closeOpened();
        opened = {
            pdfPath,
            store: createPdfPageSizeStore(pdfPath, {
                pdfPageOpsBinary,
                ...(input.qpdfBinary === undefined ? {} : {qpdfBinary: input.qpdfBinary}),
                tempDir: input.tempDir,
                ...(input.signal === undefined ? {} : {signal: input.signal}),
                log: input.log ?? (() => undefined),
                runCommand: input.runCommand ?? runNativeToolCommand,
                nativeMetadataOnly: true,
            }),
        };
        return opened.store;
    };
    return {
        async read(pdfPath, pageNumbers) {
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
                    pageSizes: await readPageSizes(await openStore(pdfPath, pdfPageOpsBinary), pageNumbers, input.signal),
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
        },
        close: closeOpened,
    };
}
