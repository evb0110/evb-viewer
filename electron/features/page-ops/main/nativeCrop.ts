import { constants } from 'fs';
import {
    copyFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import type { ICropMargins } from '@contracts/shared';
import { normalizeCropMargins } from '@contracts/shared';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { hasNativeErrorCode } from '@contracts/nativeErrors';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import type { TTerminationProofSink } from '@electron/resources/jobBroker';
import {
    PdfPageOpsCapabilityError,
    type TPdfPageOpsCapabilityErrorCode,
} from '@electron/features/page-ops/main/pageOpsErrors';
import {
    cleanupTempOutput,
    makeTempPdfOutputPath,
    replaceTempOutput,
} from '@electron/features/page-ops/main/tempOutput';
import { createManagedScratchTempDir } from '@electron/utils/managedScratchTemp';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/main/resolveNativePageOpsPath';

type TCropOperation = 'crop' | 'remove-crop';

export interface INativeCropExecutionOptions {
    signal?: AbortSignal;
    onTerminationProof?: TTerminationProofSink;
}

const log = createLogger('native-page-ops-crop');
const NATIVE_PAGE_OPS_TIMEOUT_MS = 2 * 60 * 1000;

function capabilityError(
    code: TPdfPageOpsCapabilityErrorCode,
    message: string,
    operation: string,
    cause?: unknown,
) {
    return new PdfPageOpsCapabilityError(code, message, {
        operation,
        ...(cause === undefined ? {} : {cause}),
    });
}

function nativeFailureCode(error: unknown): TPdfPageOpsCapabilityErrorCode {
    return hasNativeErrorCode(error) && error.code === 'too-large'
        ? 'too-large'
        : 'native-failure';
}

function createPageFileContents(pages: number[]) {
    return `${pages.map(page => String(page)).join('\n')}\n`;
}

function createNativeCropArgs(
    operation: TCropOperation,
    workingCopyPath: string,
    outputPath: string,
    pagesFilePath: string,
    qpdfPath: string,
    margins?: ICropMargins,
) {
    const args = [
        operation,
        '--input',
        workingCopyPath,
        '--output',
        outputPath,
        '--pages-file',
        pagesFilePath,
        '--qpdf',
        qpdfPath,
    ];

    if (operation === 'crop' && margins) {
        if (margins.physical) args.push('--physical');
        args.push(
            '--top',
            String(margins.top),
            '--bottom',
            String(margins.bottom),
            '--left',
            String(margins.left),
            '--right',
            String(margins.right),
        );
    }

    return args;
}

async function assertNativeOutputReady(outputPath: string) {
    const outputStat = await stat(outputPath);
    if (outputStat.size === 0) {
        throw new Error('Native page crop produced an empty PDF');
    }
}

async function runNativeCropOperation(
    operation: TCropOperation,
    workingCopyPath: string,
    pages: number[],
    margins?: ICropMargins,
    options?: INativeCropExecutionOptions,
) {
    const signal = options?.signal;
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw capabilityError(
            'native-unavailable',
            `Native page operation ${operation} is unavailable because evb-pdf-page-ops was not found`,
            operation,
        );
    }

    const tempPath = makeTempPdfOutputPath(workingCopyPath);
    const tempDir = await createManagedScratchTempDir('pdf-page-ops-', getAppTempDir());
    const pagesFilePath = join(tempDir, 'pages.txt');

    try {
        await writeFile(pagesFilePath, createPageFileContents(pages));
        await copyFile(workingCopyPath, tempPath, constants.COPYFILE_FICLONE);
        await runNativeToolCommand(binaryPath, createNativeCropArgs(
            operation,
            tempPath,
            tempPath,
            pagesFilePath,
            getPdfNativeToolPaths().qpdf,
            margins,
        ), {
            timeoutMs: NATIVE_PAGE_OPS_TIMEOUT_MS,
            commandLabel: `evb-pdf-page-ops(${operation})`,
            ...(signal ? { signal } : {}),
            ...(options?.onTerminationProof ? { onTerminationProof: options.onTerminationProof } : {}),
        });
        await assertNativeOutputReady(tempPath);
        if (signal?.aborted) {
            throw abortErrorFromSignal(signal);
        }
        await replaceTempOutput(tempPath, workingCopyPath);
    } catch (error) {
        await cleanupTempOutput(tempPath, log, 'native page crop temp file');
        if (isAbortError(error) || signal?.aborted) {
            throw error;
        }
        if (error instanceof PdfPageOpsCapabilityError) {
            throw error;
        }
        throw capabilityError(
            nativeFailureCode(error),
            `Native page operation ${operation} failed: ${getErrorMessage(error)}`,
            operation,
            error,
        );
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

export function runNativeCropPages(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
    options?: INativeCropExecutionOptions,
) {
    const normalizedMargins = normalizeCropMargins(margins);
    return runNativeCropOperation('crop', workingCopyPath, pages, normalizedMargins, options);
}

export function runNativeRemoveCrop(
    workingCopyPath: string,
    pages: number[],
    options?: INativeCropExecutionOptions,
) {
    return runNativeCropOperation('remove-crop', workingCopyPath, pages, undefined, options);
}
