import {rm, stat, writeFile} from 'fs/promises';
import {join} from 'path';
import type {ICropMargins, IPageGeometry} from '@contracts/shared';
import {normalizeCropMargins} from '@contracts/shared';
import {decodePageGeometry} from '@contracts/decodePageGeometry';
import {measureElectronPerfAsync} from '@electron/utils/measureElectronPerfAsync';
import {getErrorMessage} from '@electron/utils/error';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {abortErrorFromSignal, isAbortError} from '@electron/utils/abort';
import {mainJobBroker, type IJobBrokerRunContext} from '@electron/resources/jobBroker';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/main/resolveNativePageOpsPath';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {createManagedScratchTempDir} from '@electron/utils/managedScratchTemp';
import {PdfPageOpsCapabilityError, type TPdfPageOpsCapabilityErrorCode} from '@electron/features/page-ops/main/pageOpsErrors';

const PAGE_GEOMETRY_NATIVE_TIMEOUT_MS = 2 * 60 * 1000;
const PAGE_GEOMETRY_MAX_OUTPUT_BYTES = 64 * 1024;

function createNativeModifiedAt() {
    const date = new Date();
    const pad = (value: number, length = 2) => String(value).padStart(length, '0');
    return `D:${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function runBrokeredCropTask(
    type: 'crop' | 'removeCrop',
    workingCopyPath: string,
    pageCount: number,
    senderWebContentsId: number | undefined,
    signal: AbortSignal | undefined,
    work: (brokerRun: IJobBrokerRunContext) => Promise<void>,
) {
    return mainJobBroker.run(
        {
            ownerId:
                senderWebContentsId !== undefined
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
            ...(signal ? {signal} : {}),
        },
        (brokerRun) =>
            measureElectronPerfAsync(`page-ops:${type}`, () => work(brokerRun), {
                thresholdMs: 25,
                details: {
                    workingCopyPath,
                    pageCount,
                },
            }),
    );
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function nativeFailureCode(error: unknown): TPdfPageOpsCapabilityErrorCode {
    return hasNativeErrorCode(error) && error.code === 'too-large' ? 'too-large' : 'native-failure';
}

function createNativePageGeometryFailure(error: unknown) {
    return new PdfPageOpsCapabilityError(nativeFailureCode(error), `Native page geometry failed: ${getErrorMessage(error)}`, {
        operation: 'get-page-geometry',
        cause: error,
    });
}

/**
 * Appends crop or remove-crop page dictionary updates directly onto `pdfPath`
 * via `save-mutations --append --append-in-place`, matching `rotatePages` and
 * avoiding full-file copies.
 */
async function appendPageCropMutations(
    operation: 'crop' | 'remove-crop',
    pdfPath: string,
    mutations: Record<string, unknown>,
    options: {
        signal?: AbortSignal;
        brokerRun?: IJobBrokerRunContext;
    },
) {
    throwIfAborted(options.signal);
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        throw new PdfPageOpsCapabilityError(
            'native-unavailable',
            `Native page operation ${operation} is unavailable because evb-pdf-page-ops was not found`,
            {operation},
        );
    }

    const tempDir = await createManagedScratchTempDir('pdf-page-ops-', getAppTempDir());
    const mutationsPath = join(tempDir, 'mutations.json');
    try {
        await writeFile(mutationsPath, JSON.stringify(mutations), 'utf8');
        await runNativeToolCommand(
            binaryPath,
            [
                'save-mutations',
                '--input',
                pdfPath,
                '--output',
                pdfPath,
                '--mutations-file',
                mutationsPath,
                '--modified-at',
                createNativeModifiedAt(),
                '--append',
                '--append-in-place',
            ],
            {
                timeoutMs: PAGE_GEOMETRY_NATIVE_TIMEOUT_MS,
                commandLabel: `evb-pdf-page-ops(${operation})`,
                ...(options.signal ? {signal: options.signal} : {}),
                ...(options.brokerRun ? {brokerRun: options.brokerRun} : {}),
            },
        );
        const outputStat = await stat(pdfPath);
        if (outputStat.size === 0) {
            throw new Error('Native page crop produced an empty PDF');
        }
    } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) {
            throw error;
        }
        if (error instanceof PdfPageOpsCapabilityError) {
            throw error;
        }
        throw new PdfPageOpsCapabilityError(
            nativeFailureCode(error),
            `Native page operation ${operation} failed: ${getErrorMessage(error)}`,
            {
                operation,
                cause: error,
            },
        );
    } finally {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
}

export async function cropPages(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
    senderWebContentsId?: number,
    signal?: AbortSignal,
) {
    const normalizedMargins = normalizeCropMargins(margins);
    await runBrokeredCropTask('crop', workingCopyPath, pages.length, senderWebContentsId, signal, (brokerRun) =>
        appendPageCropMutations(
            'crop',
            workingCopyPath,
            {
                pageCrops: pages.map((page) => ({
                    pageIndex: page - 1,
                    top: normalizedMargins.top,
                    bottom: normalizedMargins.bottom,
                    left: normalizedMargins.left,
                    right: normalizedMargins.right,
                    ...(normalizedMargins.physical ? {physical: true} : {}),
                })),
            },
            {
                ...(signal ? {signal} : {}),
                brokerRun,
            },
        ),
    );
}

export async function removeCropFromPages(workingCopyPath: string, pages: number[], senderWebContentsId?: number, signal?: AbortSignal) {
    await runBrokeredCropTask('removeCrop', workingCopyPath, pages.length, senderWebContentsId, signal, (brokerRun) =>
        appendPageCropMutations(
            'remove-crop',
            workingCopyPath,
            {
                pageCropRemovals: pages.map((page) => page - 1),
            },
            {
                ...(signal ? {signal} : {}),
                brokerRun,
            },
        ),
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
            {operation: 'get-page-geometry'},
        );
    }

    try {
        const args = ['page-geometry', '--input', workingCopyPath, '--page', String(pageNumber)];
        const {stdout} = await runNativeToolCommand(binaryPath, args, {
            timeoutMs: PAGE_GEOMETRY_NATIVE_TIMEOUT_MS,
            maxStdoutBytes: PAGE_GEOMETRY_MAX_OUTPUT_BYTES,
            maxStderrBytes: PAGE_GEOMETRY_MAX_OUTPUT_BYTES,
            rejectOnStdoutTruncation: true,
            commandLabel: 'evb-pdf-page-ops(page-geometry)',
            ...(signal ? {signal} : {}),
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
