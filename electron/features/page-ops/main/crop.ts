import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import {decodePageGeometry} from '@contracts/decodePageGeometry';
import { measureElectronPerfAsync } from '@electron/utils/measureElectronPerfAsync';
import {
    runNativeCropPages,
    runNativeRemoveCrop,
} from '@electron/features/page-ops/main/nativeCrop';
import { getErrorMessage } from '@electron/utils/error';
import { hasNativeErrorCode } from '@contracts/nativeErrors';
import {
    abortErrorFromSignal,
    isAbortError,
} from '@electron/utils/abort';
import {
    mainJobBroker,
    type TTerminationProofSink,
} from '@electron/resources/jobBroker';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/main/resolveNativePageOpsPath';
import {
    PdfPageOpsCapabilityError,
    type TPdfPageOpsCapabilityErrorCode,
} from '@electron/features/page-ops/main/pageOpsErrors';

const PAGE_GEOMETRY_NATIVE_TIMEOUT_MS = 2 * 60 * 1000;
const PAGE_GEOMETRY_MAX_OUTPUT_BYTES = 64 * 1024;

function runBrokeredCropTask(
    type: 'crop' | 'removeCrop',
    workingCopyPath: string,
    pageCount: number,
    senderWebContentsId: number | undefined,
    signal: AbortSignal | undefined,
    work: (onTerminationProof: TTerminationProofSink) => Promise<void>,
) {
    return mainJobBroker.run({
        ownerId: senderWebContentsId !== undefined
            ? `page-ops-crop:${senderWebContentsId}:${workingCopyPath}`
            : `page-ops-crop:${workingCopyPath}`,
        kind: 'page-ops-crop',
        priority: 'user',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 256 * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 3,
        },
        ...(signal ? { signal } : {}),
    }, ({onTerminationProof}) => measureElectronPerfAsync(`page-ops:${type}`, () => work(onTerminationProof), {
        thresholdMs: 25,
        details: {
            workingCopyPath,
            pageCount,
        },
    }));
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

export async function cropPages(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
    senderWebContentsId?: number,
    signal?: AbortSignal,
) {
    await runBrokeredCropTask(
        'crop',
        workingCopyPath,
        pages.length,
        senderWebContentsId,
        signal,
        onTerminationProof => runNativeCropPages(workingCopyPath, pages, margins, {
            ...(signal ? { signal } : {}),
            onTerminationProof,
        }),
    );
}

export async function removeCropFromPages(
    workingCopyPath: string,
    pages: number[],
    senderWebContentsId?: number,
    signal?: AbortSignal,
) {
    await runBrokeredCropTask(
        'removeCrop',
        workingCopyPath,
        pages.length,
        senderWebContentsId,
        signal,
        onTerminationProof => runNativeRemoveCrop(workingCopyPath, pages, {
            ...(signal ? { signal } : {}),
            onTerminationProof,
        }),
    );
}

export async function getPageGeometry(
    workingCopyPath: string,
    pageNumber: number,
    _senderWebContentsId?: number,
    signal?: AbortSignal,
): Promise<IPageGeometry> {
    throwIfAborted(signal);
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new PdfPageOpsCapabilityError(
            'native-unavailable',
            'Native page geometry is unavailable because evb-pdf-page-ops was not found',
            { operation: 'get-page-geometry' },
        );
    }

    try {
        const args = [
            'page-geometry',
            '--input',
            workingCopyPath,
            '--page',
            String(pageNumber),
        ];
        const qpdfPath = getPdfNativeToolPaths().qpdf;
        if (qpdfPath) {
            args.push('--qpdf', qpdfPath);
        }
        const {stdout} = await runNativeToolCommand(binaryPath, args, {
            timeoutMs: PAGE_GEOMETRY_NATIVE_TIMEOUT_MS,
            maxStdoutBytes: PAGE_GEOMETRY_MAX_OUTPUT_BYTES,
            maxStderrBytes: PAGE_GEOMETRY_MAX_OUTPUT_BYTES,
            rejectOnStdoutTruncation: true,
            commandLabel: 'evb-pdf-page-ops(page-geometry)',
            ...(signal ? { signal } : {}),
        });
        throwIfAborted(signal);
        const result = decodePageGeometry(JSON.parse(stdout));
        if (!result) {
            throw new Error('Native page geometry returned an invalid result');
        }
        return result;
    } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
            throw error;
        }
        if (error instanceof PdfPageOpsCapabilityError) {
            throw error;
        }
        throw createNativePageGeometryFailure(error);
    }
}
