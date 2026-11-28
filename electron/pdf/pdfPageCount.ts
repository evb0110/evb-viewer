import {open} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolvePdfPageOpsWasmPath} from '@node-runtime/pdfPageOpsWasmRunner';
import {parsePdfPageSizeSidecarHeader} from '@evb/scan-cleanup/core/pdfPageSizes';
import {runDesktopPageOpsWasm} from '@electron/native-tools/pdfPageOpsWorkerClient';
import {runDesktopQpdfWasm} from '@electron/native-tools/qpdfWasmWorkerClient';
import type {IJobBrokerRunContext, TTerminationProofSink} from '@electron/resources/jobBroker';
import {runtimeConfig} from '@electron/runtimeConfig';
import {abortErrorFromSignal, isAbortError} from '@electron/utils/abort';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {usingManagedScratchScope} from '@electron/utils/managedScratchTemp';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
import {getQpdfPageCountArgs, parseQpdfPageCount, QPDF_SUCCESS_EXIT_CODES} from '@pdf-core/qpdfCommands';

export const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
export const QPDF_OUTPUT_SUCCESS_EXIT_CODES = QPDF_SUCCESS_EXIT_CODES;

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');
const PAGE_SIZES_HEADER_READ_BYTES = 1024;
const PAGE_OPS_PAGE_COUNT_COMMAND_LABEL = 'evb-pdf-page-ops(page-count)';
const PAGE_OPS_TIMEOUT_PATTERN = /timed out after \d+ms$/u;

export interface IPdfPageCountOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
    brokerRun?: IJobBrokerRunContext;
    onTerminationProof?: TTerminationProofSink;
}

function resolvePageOpsWasmPathForPageCount(): string | null {
    return resolvePdfPageOpsWasmPath({
        currentDir: __dirname,
        ...(runtimeConfig.pdfPageOpsPath === undefined ? {} : {envOverridePath: runtimeConfig.pdfPageOpsPath}),
        isPackaged,
    });
}

async function readPageCountFromSidecarHeader(sidecarPath: string): Promise<number | null> {
    const fileHandle = await open(sidecarPath, 'r');
    try {
        const buffer = Buffer.alloc(PAGE_SIZES_HEADER_READ_BYTES);
        const {bytesRead} = await fileHandle.read(buffer, 0, buffer.length, 0);
        if (bytesRead <= 0) {
            return null;
        }
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        const newlineIndex = text.indexOf('\n');
        const headerLine = newlineIndex >= 0 ? text.slice(0, newlineIndex) : text;
        const header = parsePdfPageSizeSidecarHeader(JSON.parse(headerLine) as unknown);
        return header.pageCount;
    } finally {
        await fileHandle.close();
    }
}

async function tryGetPdfPageCountWithPageOps(pdfPath: string, options: IPdfPageCountOptions): Promise<number | null> {
    const wasmPath = resolvePageOpsWasmPathForPageCount();
    if (!wasmPath) {
        return null;
    }
    return usingManagedScratchScope('pdf-page-ops-', getAppTempDir(), async (scratchDir) => {
        const sidecarPath = join(scratchDir, 'page-sizes.jsonl');
        await runDesktopPageOpsWasm(wasmPath, ['page-sizes', '--input', pdfPath, '--output', sidecarPath, '--metadata-only'], {
            timeoutMs: QPDF_TIMEOUT_MS,
            commandLabel: PAGE_OPS_PAGE_COUNT_COMMAND_LABEL,
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
            ...(options.brokerRun ? {brokerRun: options.brokerRun} : {}),
            ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
        });
        return readPageCountFromSidecarHeader(sidecarPath);
    });
}

function shouldRethrowPageOpsError(error: unknown, signal?: AbortSignal): boolean {
    if (getUnprovenNativeTerminationDetail(error) !== undefined || isAbortError(error) || signal?.aborted) {
        return true;
    }
    return error instanceof Error && PAGE_OPS_TIMEOUT_PATTERN.test(error.message);
}

/**
 * Reads a PDF's exact page count, preferring the pooled `evb-pdf-page-ops` WASM
 * worker to avoid cold-instantiating a fresh `qpdf` Emscripten module just for
 * `--show-npages`. Falls back to `qpdf` on encrypted, damaged, or non-standard
 * PDFs so exact error and warning-exit semantics stay unchanged.
 */
export async function getPdfPageCount(pdfPath: string, options: IPdfPageCountOptions = {}) {
    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }

    try {
        const pageCount = await tryGetPdfPageCountWithPageOps(pdfPath, options);
        if (pageCount !== null) {
            return pageCount;
        }
    } catch (error) {
        if (shouldRethrowPageOpsError(error, options.signal)) {
            if (options.signal?.aborted && !isAbortError(error) && getUnprovenNativeTerminationDetail(error) === undefined) {
                throw abortErrorFromSignal(options.signal);
            }
            throw error;
        }
        // Encrypted, damaged, or non-standard PDFs fall back to qpdf below.
    }

    const result = await runDesktopQpdfWasm(getQpdfPageCountArgs(pdfPath), {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: QPDF_OUTPUT_SUCCESS_EXIT_CODES,
        commandLabel: 'qpdf(page-count)',
        ...(options.signal ? {signal: options.signal} : {}),
        ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
        ...(options.brokerRun ? {brokerRun: options.brokerRun} : {}),
        ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
    });
    const pageCount = parseQpdfPageCount(result.stdout);
    if (pageCount === null) {
        throw new Error('Failed to read PDF page count');
    }

    return pageCount;
}
