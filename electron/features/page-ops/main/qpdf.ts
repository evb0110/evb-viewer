import {stat} from 'fs/promises';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/main/resolveNativePageOpsPath';
import {
    runDesktopQpdfWasm,
    type IRunDesktopQpdfWasmOptions,
} from '@electron/native-tools/qpdfWasmWorkerClient';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
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

type TRunQpdfCommandOptions = IRunDesktopQpdfWasmOptions & {scratchDirectory?: string};

export async function runQpdfCommand(
    args: string[],
    options: TRunQpdfCommandOptions,
) {
    const {
        scratchDirectory: _unusedScratchDirectory,
        ...qpdfOptions
    } = options;
    await runDesktopQpdfWasm(args, qpdfOptions);
}

/** Strict reopen/xref gate: warning-corrupt output is not promotable. */
export async function verifyPdfStructureStrict(pdfPath: string, options: IQpdfOperationOptions = {}) {
    // Page operations rewrite objects, never stream data, so a full reparse and
    // rewrite without stream decoding covers what they can break. `qpdf --check`
    // also decodes every image, which takes most of a minute on a large scan.
    try {
        await runDesktopQpdfWasm([
            '--decode-level=none',
            '--compress-streams=n',
            pdfPath,
            '/dev/null',
        ], {
            timeoutMs: QPDF_TIMEOUT_MS,
            allowedExitCodes: [0],
            commandLabel: 'qpdf(strict-structure-check)',
            ...options,
        });
    } catch (error) {
        if (hasNativeErrorCode(error) && error.code === 'too-large') {
            // A single PDF stream > 2 GiB exceeds wasm32's 32-bit std::string
            // limit inside qpdf; verify full structure through evb-pdf-page-ops.wasm
            // (64-bit host-file streaming) instead of refusing a valid save.
            const pageOpsPath = resolveNativePageOpsPath();
            if (!pageOpsPath) {
                throw error;
            }
            const {stdout} = await runNativeToolCommand(pageOpsPath, [
                'pdf-conformance',
                '--input',
                pdfPath,
                '--strict',
            ], {
                timeoutMs: QPDF_TIMEOUT_MS,
                allowedExitCodes: [0],
                maxStdoutBytes: 64 * 1024,
                rejectOnStdoutTruncation: true,
                commandLabel: 'evb-pdf-page-ops(strict-structure-check)',
                ...options,
            });
            const parsed = JSON.parse(stdout) as Record<string, unknown>;
            if (typeof parsed.isEncrypted !== 'boolean' || typeof parsed.isSigned !== 'boolean') {
                throw new Error('evb-pdf-page-ops(strict-structure-check) returned invalid conformance payload');
            }
            return;
        }
        throw error;
    }
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
