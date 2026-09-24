import {
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import type { ICropMargins } from '@contracts/shared';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { hasNativeErrorCode } from '@contracts/nativeErrors';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
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
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';

type TCropOperation = 'crop' | 'remove-crop';

const log = createLogger('native-page-ops-crop');
const NATIVE_PAGE_OPS_TIMEOUT_MS = 2 * 60 * 1000;
const PAGE_OPS_LOCAL_FALLBACK_MAX_BYTES = 16 * 1024 * 1024;

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

export async function assertPageOpsLocalFallbackAllowed(
    workingCopyPath: string,
    operation: string,
    signal?: AbortSignal,
    failureCode: TPdfPageOpsCapabilityErrorCode = 'too-large',
    cause?: unknown,
) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }

    let inputStat: Awaited<ReturnType<typeof stat>>;
    try {
        inputStat = await stat(workingCopyPath);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        throw capabilityError(
            'native-unavailable',
            `Unable to inspect the page-operation input "${workingCopyPath}": ${getErrorMessage(error)}`,
            operation,
            error,
        );
    }
    if (!inputStat.isFile()) {
        throw capabilityError(
            'native-failure',
            `Page-operation input is not a regular file: ${workingCopyPath}`,
            operation,
            cause,
        );
    }
    if (inputStat.size > PAGE_OPS_LOCAL_FALLBACK_MAX_BYTES) {
        const maxMb = Math.floor(PAGE_OPS_LOCAL_FALLBACK_MAX_BYTES / (1024 * 1024));
        throw capabilityError(
            failureCode,
            `Native page operation ${operation} failed and the JavaScript compatibility path is limited to ${maxMb} MiB PDFs`,
            operation,
            cause,
        );
    }
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

async function tryRunNativeCropOperation(
    operation: TCropOperation,
    workingCopyPath: string,
    pages: number[],
    margins?: ICropMargins,
    signal?: AbortSignal,
) {
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        await assertPageOpsLocalFallbackAllowed(
            workingCopyPath,
            operation,
            signal,
            'native-unavailable',
        );
        return false;
    }

    const tempPath = makeTempPdfOutputPath(workingCopyPath);
    const tempDir = await createManagedScratchTempDir('pdf-page-ops-');
    const pagesFilePath = join(tempDir, 'pages.txt');

    try {
        await writeFile(pagesFilePath, createPageFileContents(pages));
        await copyFileCopyOnWrite(workingCopyPath, tempPath);
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
        });
        await assertNativeOutputReady(tempPath);
        await replaceTempOutput(tempPath, workingCopyPath);
        return true;
    } catch (error) {
        await cleanupTempOutput(tempPath, log, 'native page crop temp file');
        if (isAbortError(error) || signal?.aborted) {
            throw error;
        }
        await assertPageOpsLocalFallbackAllowed(
            workingCopyPath,
            operation,
            signal,
            nativeFailureCode(error),
            error,
        );
        log.debug(`Native page crop failed: ${getErrorMessage(error)}`);
        return false;
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

export function tryCropPagesWithNativePageOps(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
    signal?: AbortSignal,
) {
    return tryRunNativeCropOperation('crop', workingCopyPath, pages, margins, signal);
}

export function tryRemoveCropWithNativePageOps(
    workingCopyPath: string,
    pages: number[],
    signal?: AbortSignal,
) {
    return tryRunNativeCropOperation('remove-crop', workingCopyPath, pages, undefined, signal);
}
