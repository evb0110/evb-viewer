import { existsSync } from 'fs';
import {
    readFile,
    stat,
} from 'fs/promises';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import {decodePageGeometry} from '@contracts/decodePageGeometry';
import { createLogger } from '@electron/utils/createLogger';
import { measureElectronPerfAsync } from '@electron/utils/measureElectronPerfAsync';
import {
    cropPagesLocal,
    removeCropFromPagesLocal,
} from '@electron/features/page-ops/main/cropLocal';
import { assertPageOpsLocalFallbackAllowed } from '@electron/features/page-ops/main/nativeCrop';
import { getErrorMessage } from '@electron/utils/error';
import { hasNativeErrorCode } from '@contracts/nativeErrors';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import {
    resolveUnpackedWorkerPath,
    runResultWorkerTask,
} from '@electron/utils/workerTask';
import { WORKER_BUNDLES_BY_ID } from '@electron-worker-bundles/electronWorkerBundles.js';
import type { TCropWorkerInput } from '@electron/features/page-ops/main/cropWorkerProtocol';
import { materializePageOperationWorkingCopy } from '@electron/features/page-ops/main/qpdf';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { usingManagedScratchScope } from '@electron/utils/managedScratchTemp';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/main/nativePageOpsPath';
import {
    PdfPageOpsCapabilityError,
    type TPdfPageOpsCapabilityErrorCode,
} from '@electron/features/page-ops/main/pageOpsErrors';

const log = createLogger('page-ops-crop');
const __dirname = dirname(fileURLToPath(import.meta.url));
const CROP_WORKER_FILENAME = WORKER_BUNDLES_BY_ID['page-ops-crop'].fileName;
const CROP_WORKER_TIMEOUT_MS = 2 * 60 * 1000;
const PAGE_GEOMETRY_NATIVE_TIMEOUT_MS = 2 * 60 * 1000;
const PAGE_GEOMETRY_MAX_OUTPUT_BYTES = 64 * 1024;

class CropWorkerUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CropWorkerUnavailableError';
    }
}

function resolveCropWorkerPath() {
    return resolveUnpackedWorkerPath(__dirname, CROP_WORKER_FILENAME);
}

function decodeUndefinedResult(data: unknown): undefined | null {
    return data === undefined ? undefined : null;
}


async function runCropWorkerTask<T>(
    workerInput: TCropWorkerInput,
    decodeResult: (data: unknown) => T | null,
    signal?: AbortSignal,
): Promise<T> {
    const workerPath = resolveCropWorkerPath();
    if (!existsSync(workerPath)) {
        throw new CropWorkerUnavailableError(`Crop worker unavailable at path: ${workerPath}`);
    }

    return measureElectronPerfAsync(`page-ops:${workerInput.type}`, () => runResultWorkerTask<T>({
        workerPath,
        workerData: workerInput,
        invalidPayloadMessage: 'Crop worker returned an invalid payload',
        invalidResultMessage: 'Crop worker returned an invalid result',
        createStartupError: message => new CropWorkerUnavailableError(`Crop worker startup failed: ${message}`),
        createStartupExitError: code => new CropWorkerUnavailableError(`Crop worker exited before startup with code ${code}`),
        createWorkerExitError: code => new Error(`Crop worker exited with code ${code}`),
        timeoutMs: CROP_WORKER_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        createCancelMessage: () => ({type: 'cancel'}),
        resourceLimits: {
            maxOldGenerationSizeMb: 512,
            maxYoungGenerationSizeMb: 64,
            stackSizeMb: 8,
        },
        decodeResult,
    }), {
        thresholdMs: 25,
        details: {
            workingCopyPath: workerInput.workingCopyPath,
            pageCount: 'pages' in workerInput ? workerInput.pages.length : 1,
        },
    });
}

function shouldFallbackToLocalCrop(error: unknown) {
    return error instanceof CropWorkerUnavailableError;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function nativePageGeometryFailureCode(error: unknown): TPdfPageOpsCapabilityErrorCode {
    return hasNativeErrorCode(error) && error.code === 'too-large'
        ? 'too-large'
        : 'native-failure';
}

function createNativePageGeometryFailure(error: unknown) {
    return new PdfPageOpsCapabilityError(
        nativePageGeometryFailureCode(error),
        `Native page geometry failed: ${getErrorMessage(error)}`,
        {
            operation: 'get-page-geometry',
            cause: error,
        },
    );
}

async function tryGetPageGeometryWithNativePageOps(
    workingCopyPath: string,
    pageNumber: number,
    signal?: AbortSignal,
): Promise<IPageGeometry | null> {
    throwIfAborted(signal);
    if (isNativePageOpsDisabled()) {
        await assertPageOpsLocalFallbackAllowed(
            workingCopyPath,
            'get-page-geometry',
            signal,
            'native-unavailable',
        );
        return null;
    }

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        await assertPageOpsLocalFallbackAllowed(
            workingCopyPath,
            'get-page-geometry',
            signal,
            'native-unavailable',
        );
        return null;
    }

    return usingManagedScratchScope('pdf-page-ops-', async (scratchPath) => {
        const outputPath = join(scratchPath, 'page-geometry.json');
        try {
            const args = [
                'page-geometry',
                '--input',
                workingCopyPath,
                '--output',
                outputPath,
                '--page',
                String(pageNumber),
            ];
            const qpdfPath = getPdfNativeToolPaths().qpdf;
            if (qpdfPath) {
                args.push('--qpdf', qpdfPath);
            }
            await runNativeToolCommand(binaryPath, args, {
                timeoutMs: PAGE_GEOMETRY_NATIVE_TIMEOUT_MS,
                maxStdoutBytes: PAGE_GEOMETRY_MAX_OUTPUT_BYTES,
                maxStderrBytes: PAGE_GEOMETRY_MAX_OUTPUT_BYTES,
                rejectOnStdoutTruncation: true,
                commandLabel: 'evb-pdf-page-ops(page-geometry)',
                ...(signal ? { signal } : {}),
            });
            throwIfAborted(signal);
            const outputStat = await stat(outputPath);
            if (outputStat.size > PAGE_GEOMETRY_MAX_OUTPUT_BYTES) {
                throw new Error('Native page geometry produced an oversized result');
            }
            const resultJson = await readFile(outputPath, 'utf8');
            throwIfAborted(signal);
            const result = decodePageGeometry(JSON.parse(resultJson));
            if (!result) {
                throw new Error('Native page geometry returned an invalid result');
            }
            return result;
        } catch (error) {
            if (isAbortError(error) || signal?.aborted) {
                throw error;
            }
            await assertPageOpsLocalFallbackAllowed(
                workingCopyPath,
                'get-page-geometry',
                signal,
                nativePageGeometryFailureCode(error),
                error,
            );
            log.debug(createNativePageGeometryFailure(error).message);
            return null;
        }
    });
}

export async function cropPages(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
    senderWebContentsId?: number,
    signal?: AbortSignal,
) {
    const materializedPath = await materializePageOperationWorkingCopy(
        workingCopyPath,
        senderWebContentsId,
        signal,
    );
    try {
        await runCropWorkerTask<undefined>({
            type: 'crop',
            workingCopyPath: materializedPath,
            pages,
            margins,
            ...(senderWebContentsId !== undefined ? { senderWebContentsId } : {}),
        }, decodeUndefinedResult, signal);
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        await assertPageOpsLocalFallbackAllowed(materializedPath, 'crop', signal);
        log.warn(`Crop worker unavailable, falling back to in-process crop: ${getErrorMessage(error)}`);
        await cropPagesLocal(materializedPath, pages, margins, signal);
    }
}

export async function removeCropFromPages(
    workingCopyPath: string,
    pages: number[],
    senderWebContentsId?: number,
    signal?: AbortSignal,
) {
    const materializedPath = await materializePageOperationWorkingCopy(
        workingCopyPath,
        senderWebContentsId,
        signal,
    );
    try {
        await runCropWorkerTask<undefined>({
            type: 'removeCrop',
            workingCopyPath: materializedPath,
            pages,
            ...(senderWebContentsId !== undefined ? { senderWebContentsId } : {}),
        }, decodeUndefinedResult, signal);
    } catch (error) {
        if (!shouldFallbackToLocalCrop(error)) {
            throw error;
        }
        await assertPageOpsLocalFallbackAllowed(materializedPath, 'remove-crop', signal);
        log.warn(`Crop worker unavailable, falling back to in-process crop reset: ${getErrorMessage(error)}`);
        await removeCropFromPagesLocal(materializedPath, pages, signal);
    }
}

export async function getPageGeometry(
    workingCopyPath: string,
    pageNumber: number,
    senderWebContentsId?: number,
    signal?: AbortSignal,
): Promise<IPageGeometry> {
    const materializedPath = await materializePageOperationWorkingCopy(
        workingCopyPath,
        senderWebContentsId,
        signal,
    );
    const nativeGeometry = await tryGetPageGeometryWithNativePageOps(
        materializedPath,
        pageNumber,
        signal,
    );
    if (nativeGeometry) {
        return nativeGeometry;
    }
    await assertPageOpsLocalFallbackAllowed(materializedPath, 'get-page-geometry', signal);
    throw new PdfPageOpsCapabilityError(
        'native-failure',
        'Native page geometry was unavailable and no JavaScript fallback is permitted',
        {operation: 'get-page-geometry'},
    );
}
