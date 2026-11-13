import {writeFile} from 'fs/promises';
import {join} from 'path';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { usingManagedScratchScope } from '@electron/utils/managedScratchTemp';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/main/resolveNativePageOpsPath';
import { QPDF_TIMEOUT_MS } from '@electron/pdf/pdfPageCount';

export interface IPageStructureOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
}

type TPageStructureCommand = 'delete-pages' | 'extract-pages' | 'reorder-pages' | 'insert-pages' | 'merge-pages';

interface IPageStructureArguments {
    /** Page numbers or inclusive `first-last` ranges, in output order. */
    pages?: readonly string[];
    sources?: readonly string[];
    afterPage?: number;
}

function requirePageOpsBinary() {
    const binary = resolveNativePageOpsPath();
    if (!binary) throw new Error('Native page operations are unavailable');
    return binary;
}

/**
 * Runs one page-structure edit in the native engine. It writes a fresh PDF
 * and publishes it at `outputPath` atomically, so `outputPath` may be the
 * input: a failure leaves it untouched.
 */
export async function runPageStructureCommand(
    command: TPageStructureCommand,
    inputPath: string,
    outputPath: string,
    args: IPageStructureArguments,
    options: IPageStructureOptions = {},
) {
    const binary = requirePageOpsBinary();
    await usingManagedScratchScope('pdf-page-ops-', getAppTempDir(), async scratch => {
        const commandArgs = [command, '--input', inputPath, '--output', outputPath];
        if (args.pages) {
            const pagesPath = join(scratch, 'pages.txt');
            await writeFile(pagesPath, args.pages.join('\n'), 'utf8');
            commandArgs.push('--pages-file', pagesPath);
        }
        for (const source of args.sources ?? []) commandArgs.push('--source', source);
        if (args.afterPage !== undefined) commandArgs.push('--after-page', String(args.afterPage));
        await runNativeToolCommand(binary, commandArgs, {
            timeoutMs: QPDF_TIMEOUT_MS,
            commandLabel: `pdf-page-ops(${command})`,
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.cancelGroup ? {cancelGroup: options.cancelGroup} : {}),
        });
    });
}
