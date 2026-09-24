import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { QPDF_TIMEOUT_MS } from '@electron/pdf/pdfPageCount';

// The catalog walk stops at 100,000 outline and page-label nodes.
const PDF_CATALOG_MAX_BYTES = 64 * 1024 * 1024;

/** Reads a PDF's outline and page labels as the JSON evb-pdf-page-ops prints. */
export async function readNativePdfCatalog(
    binaryPath: string,
    inputPath: string,
    options: {
        commandLabel: string;
        signal?: AbortSignal;
        cancelGroup?: string;
    },
): Promise<unknown> {
    const {stdout} = await runNativeToolCommand(binaryPath, [
        'read-catalog',
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
