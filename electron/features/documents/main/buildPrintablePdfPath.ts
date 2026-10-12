import type { IPdfPathPrintOptions } from '@contracts/electronApiDocuments';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { resolveNativePageOpsPath } from '@electron/features/page-ops/public/nativePageOpsPath';

const PDF_PRINT_LAYOUT_TIMEOUT_MS = 10 * 60_000;

/**
 * Prepares every page for printing with `pdf-page-ops print-layout`. Single
 * pages in Auto keep their geometry and gain only missing annotation
 * appearances; nothing is written when none are missing.
 */
export async function buildPrintablePdfPath(options: {
    inputPath: string;
    outputPath: string;
    printOptions: Pick<IPdfPathPrintOptions, 'viewMode' | 'orientation'>;
    signal?: AbortSignal;
}) {
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Native print layout is unavailable');
    }
    await runNativeToolCommand(binaryPath, [
        'print-layout',
        '--input',
        options.inputPath,
        '--output',
        options.outputPath,
        '--view-mode',
        options.printOptions.viewMode,
        '--orientation',
        options.printOptions.orientation,
        '--qpdf',
        getPdfNativeToolPaths().qpdf,
    ], {
        timeoutMs: PDF_PRINT_LAYOUT_TIMEOUT_MS,
        commandLabel: 'evb-pdf-page-ops(print-layout)',
        ...(options.signal ? {signal: options.signal} : {}),
    });
}
