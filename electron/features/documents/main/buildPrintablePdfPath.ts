import {
    stat,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES} from '@contracts/shared';
import {extractPages} from '@electron/features/page-ops/public';
import type { IPdfPathPrintOptions } from '@contracts/electronApiDocuments';
import * as v from 'valibot';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {scanPdfSidecarLines} from '@electron/features/documents/main/pdfSidecarLineIndex';
import {
    PDF_PRINT_ANNOTATION_INDEX_HEADER_SCHEMA, PDF_PRINT_ANNOTATION_INDEX_CHUNK_SCHEMA,
} from '@contracts/pdfPathPrintOptions';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { resolveNativePageOpsPath } from '@electron/features/page-ops/public/nativePageOpsPath';
import { getAppTempDir } from '@electron/utils/appTempDir';
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
    await usingManagedScratchScope('pdf-page-ops-', getAppTempDir(), async (scratchPath) => {
        let inputPath = options.inputPath;
        let {pageNumbers} = options.printOptions;
        if ((await stat(inputPath)).size > PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES && pageNumbers?.length) {
            inputPath = join(scratchPath, 'selected.pdf');
            await extractPages(options.inputPath, inputPath, pageNumbers, options.signal ? {signal: options.signal} : {});
            pageNumbers = undefined;
        }
        if ((await stat(inputPath)).size > PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES) {
            throw new Error('PDF is too large for advanced print layout');
        }
        const pagesArgs: string[] = [];
        if (pageNumbers?.length) {
            const pagesFile = join(scratchPath, 'pages.txt');
            await writeFile(pagesFile, pageNumbers.join('\n'), 'utf8');
            pagesArgs.push('--pages-file', pagesFile);
        }
        await runNativeToolCommand(binaryPath, [
            'print-layout',
            '--input',
            inputPath,
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

/** Read print appearance facts from the existing bounded annotation index. */
export async function pdfPagesNeedPrintAppearances(inputPath: string, pageNumbers: readonly number[] | undefined, signal: AbortSignal) {
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) throw new Error('Native print annotation indexing is unavailable');
    return usingManagedScratchScope('pdf-page-ops-', getAppTempDir(), async (scratchPath) => {
        const indexPath = join(scratchPath, 'annotations.jsonl');
        await runNativeToolCommand(binaryPath, [
            'annotation-index',
            '--input',
            inputPath,
            '--output',
            indexPath,
            '--qpdf',
            getPdfNativeToolPaths().qpdf,
        ], {
            timeoutMs: PDF_PRINT_LAYOUT_TIMEOUT_MS,
            commandLabel: 'evb-pdf-page-ops(print-annotation-index)',
            signal,
        });
        let needsAppearance = false;
        await scanPdfSidecarLines(indexPath, {
            maxLineBytes: 4 * 1024 * 1024,
            signal,
            label: 'Print annotation index',
            decodeHeader: value => v.parse(PDF_PRINT_ANNOTATION_INDEX_HEADER_SCHEMA, value).pageCount,
            decodeDataLine: (value) => {
                const {entries} = v.parse(PDF_PRINT_ANNOTATION_INDEX_CHUNK_SCHEMA, value);
                needsAppearance ||= entries.some(entry => entry.needsPrintAppearance && (!pageNumbers || pageNumbers.includes(entry.pageIndex + 1)));
                return entries;
            },
        });
        return needsAppearance;
    });
}
