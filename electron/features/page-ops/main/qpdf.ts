import {
    symlink,
    stat,
    writeFile,
} from 'fs/promises';
import {devNull} from 'node:os';
import {
    dirname, join, resolve,
} from 'path';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { usingManagedScratchScope } from '@electron/utils/managedScratchTemp';
import {
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
} from '@electron/pdf/pdfPageCount';

// qpdf runs what the native page engine does not do: image export's page
// preparation and the strict structure check before a page edit commits.
export {
    getPdfPageCount,
    QPDF_OUTPUT_SUCCESS_EXIT_CODES,
    QPDF_TIMEOUT_MS,
};

export interface IQpdfOperationOptions {
    signal?: AbortSignal;
    cancelGroup?: string;
}

type TRunQpdfCommandOptions = Parameters<typeof runNativeToolCommand>[2]
    & {scratchDirectory?: string};

function getQpdfBinary() {
    return getPdfNativeToolPaths().qpdf;
}

export async function runQpdfCommand(
    args: string[],
    options: TRunQpdfCommandOptions,
) {
    const {
        scratchDirectory,
        ...nativeOptions
    } = options;
    const runWithArguments = async (tempDir: string) => {
        const argsPath = join(tempDir, 'args.txt');
        if (/[\r\n]/u.test(argsPath)) throw new TypeError('qpdf argument scratch path contains a line break');
        const binary = getQpdfBinary();
        const aliases = new Map<string, string>();
        const encoded: string[] = [];
        // The supported commands put CR/LF only in path operands. A symlink
        // preserves their spelling, including a not-yet-created staged output.
        for (const arg of args) {
            if (!/[\r\n]/u.test(arg)) {
                encoded.push(arg);
                continue;
            }
            const target = resolve(nativeOptions.cwd ?? dirname(binary), arg);
            let alias = aliases.get(target);
            if (alias === undefined) {
                alias = join(tempDir, `path-${aliases.size}.pdf`);
                await symlink(target, alias, 'file');
                aliases.set(target, alias);
            }
            encoded.push(alias);
        }
        await writeFile(argsPath, encoded.join('\n'));
        await runNativeToolCommand(binary, [`@${argsPath}`], nativeOptions);
    };
    if (scratchDirectory === undefined) {
        await usingManagedScratchScope('qpdfArgs-', getAppTempDir(), runWithArguments);
    } else {
        await runWithArguments(scratchDirectory);
    }
}

/** Strict reopen/xref gate: warning-corrupt output is not promotable. */
export async function verifyPdfStructureStrict(pdfPath: string, options: IQpdfOperationOptions = {}) {
    // Page operations rewrite objects, never stream data, so a full reparse and
    // rewrite without stream decoding covers what they can break. `qpdf --check`
    // also decodes every image, which takes most of a minute on a large scan.
    await runNativeToolCommand(getQpdfBinary(), [
        '--decode-level=none',
        '--compress-streams=n',
        pdfPath,
        devNull,
    ], {
        timeoutMs: QPDF_TIMEOUT_MS,
        allowedExitCodes: [0],
        commandLabel: 'qpdf(strict-structure-check)',
        ...options,
    });
}

export async function assertNonEmptyPdfOutput(outputPath: string, operationLabel: string) {
    let outputStat: Awaited<ReturnType<typeof stat>>;
    try {
        outputStat = await stat(outputPath);
    } catch (error) {
        throw new Error(`${operationLabel} failed: qpdf did not produce an output file`, {cause: error});
    }

    if (outputStat.size === 0) {
        throw new Error(`${operationLabel} failed: qpdf produced an empty PDF`);
    }
}
