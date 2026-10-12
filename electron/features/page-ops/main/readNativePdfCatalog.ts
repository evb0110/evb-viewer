import { isRecord } from '@contracts/runtimeGuards';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { QPDF_TIMEOUT_MS } from '@electron/pdf/pdfPageCount';

// The catalog walk stops at 100,000 outline and page-label nodes.
const PDF_CATALOG_MAX_BYTES = 64 * 1024 * 1024;

interface INativePdfCatalogReadOptions {
    commandLabel: string;
    signal?: AbortSignal;
    cancelGroup?: string;
}

async function readCatalogJson(
    operation: 'read-catalog' | 'read-document-catalog',
    binaryPath: string,
    inputPath: string,
    options: INativePdfCatalogReadOptions,
): Promise<unknown> {
    const {stdout} = await runNativeToolCommand(binaryPath, [
        operation,
        '--input',
        inputPath,
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        maxStdoutBytes: PDF_CATALOG_MAX_BYTES,
        rejectOnStdoutTruncation: true,
        ...options,
    });
    return JSON.parse(stdout);
}

/**
 * Reads a PDF's outline and page labels as a PDF combine carries them, and
 * refuses a source it cannot carry.
 */
export function readNativePdfCatalog(binaryPath: string, inputPath: string, options: INativePdfCatalogReadOptions) {
    return readCatalogJson('read-catalog', binaryPath, inputPath, options);
}

/**
 * Reads one part of the catalog a document shows. The outline and the page
 * labels are read on their own, so only this part's own failure fails the read.
 */
export async function readNativePdfCatalogPart(
    binaryPath: string,
    inputPath: string,
    part: 'bookmarks' | 'pageLabels',
    options: INativePdfCatalogReadOptions,
): Promise<unknown[]> {
    const catalog = await readCatalogJson('read-document-catalog', binaryPath, inputPath, options);
    const value = isRecord(catalog) ? catalog[part] : undefined;
    if (!Array.isArray(value)) {
        const error = isRecord(catalog) ? catalog[`${part}Error`] : undefined;
        throw new Error(typeof error === 'string' ? error : `Native PDF catalog read returned no ${part}`);
    }
    return value as unknown[];
}
