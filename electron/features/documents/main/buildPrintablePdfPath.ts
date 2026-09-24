import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IPdfPathPrintOptions } from '@contracts/electronApiDocuments';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { resolveNativePageOpsPath } from '@electron/features/page-ops/public/nativePageOpsPath';
import { usingManagedScratchScope } from '@electron/utils/managedScratchTemp';

const PDF_PRINT_LAYOUT_TIMEOUT_MS = 10 * 60_000;

/**
 * Lays the selected pages out on print sheets with `pdf-page-ops print-layout`.
 */
export async function buildPrintablePdfPath(options: {
    inputPath: string;
    outputPath: string;
    printOptions: IPdfPathPrintOptions;
    signal?: AbortSignal;
}) {
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new Error('Native print layout is unavailable');
    }
    const {pageNumbers} = options.printOptions;
    await usingManagedScratchScope('pdf-page-ops-', async (scratchPath) => {
        const pagesArgs: string[] = [];
        if (pageNumbers?.length) {
            const pagesFile = join(scratchPath, 'pages.txt');
            await writeFile(pagesFile, pageNumbers.join('\n'), 'utf8');
            pagesArgs.push('--pages-file', pagesFile);
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
            ...pagesArgs,
        ], {
            timeoutMs: PDF_PRINT_LAYOUT_TIMEOUT_MS,
            commandLabel: 'evb-pdf-page-ops(print-layout)',
            ...(options.signal ? {signal: options.signal} : {}),
        });
    });
}
