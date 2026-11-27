import {open, stat} from 'node:fs/promises';
import {mainJobBroker, type IJobBrokerRunContext, type TTerminationProofSink} from '@electron/resources/jobBroker';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {
    decodeDocumentSaveUtilityRequest,
    getDocumentSaveUtilityReusePlan,
    type IDocumentSaveUtilityValidateRequest,
} from '@electron/features/documents/main/documentSaveUtilityProtocol';
import {fingerprintFileBounded} from '@electron/features/documents/main/fingerprintFileBounded';
import {validatePdfStructureFromPath} from '@electron/features/documents/main/pdfConformancePathAnalysis';
import {validateTargetedPdfObjects} from '@electron/features/documents/main/validateTargetedPdfObjects';
import {runNativeToolCommand, type IRunNativeToolCommandOptions} from '@electron/native-tools/runNativeToolCommand';
import {abortErrorFromSignal, raceWithAbortSignal} from '@electron/utils/abort';
import {getErrorMessage} from '@electron/utils/error';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';

const ADMISSION_TIMEOUT_MS = 15_000;
const FINGERPRINT_TIMEOUT_MS = 2 * 60_000;

export interface IDocumentSaveUtilityResult {
    bytes: number;
    sha256: string;
    contentFingerprint?: string;
}

async function inspectPdf(
    path: string,
    expectedBytes: number,
    options: {
        sha256?: string;
        tailCheck?: boolean;
        signal?: AbortSignal;
    } = {},
): Promise<IDocumentSaveUtilityResult> {
    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }
    const fingerprint =
        options.sha256 === undefined
            ? await fingerprintFileBounded(path, expectedBytes, options.signal)
            : {
                  bytes: expectedBytes,
                  sha256: options.sha256,
              };
    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }
    const fileStat = await raceWithAbortSignal(stat(path), options.signal);
    if (!fileStat.isFile() || fileStat.size !== expectedBytes) {
        throw new Error('PDF save staging file size changed after receipt validation');
    }
    const openPromise = open(path, 'r');
    let handle;
    try {
        handle = await raceWithAbortSignal(openPromise, options.signal);
    } catch (error) {
        void openPromise.then(
            (opened) => opened.close().catch(() => undefined),
            () => undefined,
        );
        throw error;
    }
    try {
        const header = Buffer.alloc(5);
        await raceWithAbortSignal(handle.read(header, 0, header.length, 0), options.signal);
        if (header.toString('ascii') !== '%PDF-') {
            throw new Error('PDF save staging file has an invalid header');
        }
        if (options.tailCheck !== true) {
            const tailBytes = Math.min(fingerprint.bytes, 64 * 1024);
            const tail = Buffer.alloc(tailBytes);
            await raceWithAbortSignal(handle.read(tail, 0, tailBytes, fingerprint.bytes - tailBytes), options.signal);
            if (!tail.includes(Buffer.from('%%EOF'))) {
                throw new Error('PDF save staging file has no end-of-file marker');
            }
        }
    } finally {
        if (options.signal?.aborted) {
            void handle.close().catch(() => undefined);
        } else {
            await handle.close();
        }
    }
    return fingerprint;
}

function createOperationSignal(signal: AbortSignal | undefined, timeoutMs: number) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export async function validateDocumentSaveStagingFile(
    rawRequest: IDocumentSaveUtilityValidateRequest,
    options: {
        timeoutMs: number;
        signal?: AbortSignal;
        brokerRun?: IJobBrokerRunContext;
        onTerminationProof?: TTerminationProofSink;
    },
): Promise<IDocumentSaveUtilityResult> {
    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }
    const request = decodeDocumentSaveUtilityRequest(rawRequest);
    if (!request || request.type !== 'validate') {
        throw new Error('Invalid document save validation request');
    }
    const operationSignal = createOperationSignal(options.signal, options.timeoutMs);
    const runValidationCommand = (validationBinary: string, args: string[], commandOptions: IRunNativeToolCommandOptions = {}) => {
        if (options.signal?.aborted) {
            return Promise.reject(abortErrorFromSignal(options.signal));
        }
        return runNativeToolCommand(validationBinary, args, {
            timeoutMs: 5 * 60_000,
            maxStdoutBytes: 4 * 1024 * 1024,
            maxStderrBytes: 4 * 1024 * 1024,
            ...commandOptions,
            signal: operationSignal,
            ...(options.brokerRun ? {brokerRun: options.brokerRun} : {}),
            ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
        });
    };

    const reuse = getDocumentSaveUtilityReusePlan(request);
    let receiptSha256: string | undefined;
    if (reuse.fingerprint) {
        if (request.stagedArtifact === undefined || request.stagedArtifact.receiptVersion !== 1) {
            throw new Error('Document save receipt reuse was enabled without an artifact');
        }
        receiptSha256 = request.stagedArtifact.sha256;
    }
    const inspection = await inspectPdf(request.sourcePath, request.expectedBytes, {
        ...(receiptSha256 === undefined ? {} : {sha256: receiptSha256}),
        ...(reuse.tailCheck ? {tailCheck: true} : {}),
        signal: operationSignal,
    });
    let strictStructuralValidated = false;
    if (!reuse.qpdfCheck && !reuse.nativeIncrementalCheck && request.validationBinary) {
        try {
            const result = await runValidationCommand(request.validationBinary, ['--check', request.sourcePath], {
                allowedExitCodes: [0, 3],
            });
            if (result.exitCode !== 0 && result.exitCode !== 3) {
                throw new Error(`qpdf exited with code ${result.exitCode}`);
            }
        } catch (error) {
            if (getUnprovenNativeTerminationDetail(error) !== undefined || options.signal?.aborted || operationSignal.aborted) {
                throw options.signal?.aborted && getUnprovenNativeTerminationDetail(error) === undefined
                    ? abortErrorFromSignal(options.signal)
                    : error;
            }
            if (hasNativeErrorCode(error) && error.code === 'too-large') {
                await validatePdfStructureFromPath(request.sourcePath, {
                    strict: true,
                    timeoutMs: options.timeoutMs,
                    signal: operationSignal,
                    ...(options.brokerRun ? {brokerRun: options.brokerRun} : {}),
                    ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
                });
                strictStructuralValidated = true;
            } else {
                const exitCode: unknown = (error as {code?: unknown}).code;
                if (exitCode !== 3 && exitCode !== '3') {
                    throw new Error(`PDF save staging file failed qpdf validation: ${getErrorMessage(error)}`);
                }
            }
        }
    }
    const changedObjectRefs = request.changedObjectRefs ?? [];
    if (changedObjectRefs.length > 0 && !reuse.changedObjectRefsCheck && request.validationBinary) {
        try {
            await validateTargetedPdfObjects(request.sourcePath, request.validationBinary, changedObjectRefs, runValidationCommand);
        } catch (error) {
            if (getUnprovenNativeTerminationDetail(error) !== undefined || options.signal?.aborted || operationSignal.aborted) {
                throw options.signal?.aborted && getUnprovenNativeTerminationDetail(error) === undefined
                    ? abortErrorFromSignal(options.signal)
                    : error;
            }
            if (hasNativeErrorCode(error) && error.code === 'too-large') {
                if (!strictStructuralValidated) {
                    await validatePdfStructureFromPath(request.sourcePath, {
                        strict: true,
                        timeoutMs: options.timeoutMs,
                        signal: operationSignal,
                        ...(options.brokerRun ? {brokerRun: options.brokerRun} : {}),
                        ...(options.onTerminationProof ? {onTerminationProof: options.onTerminationProof} : {}),
                    });
                }
            } else {
                throw error;
            }
        }
    }
    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }
    operationSignal.throwIfAborted();
    return inspection;
}

export async function fingerprintFileWithUtilityProcess(path: string, signal?: AbortSignal): Promise<IDocumentSaveUtilityResult> {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
    const admissionSignal = createOperationSignal(signal, ADMISSION_TIMEOUT_MS);
    const {size} = await raceWithAbortSignal(stat(path), admissionSignal);
    return mainJobBroker.run(
        {
            ownerId: `document-fingerprint:${path}`,
            kind: 'document-save-utility',
            priority: 'foreground',
            admissionClass: 'interactive',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 256 * 1024 * 1024,
                nativeProcesses: 0,
                ioWeight: 1,
            },
            signal: admissionSignal,
        },
        () => {
            const operationSignal = createOperationSignal(signal, FINGERPRINT_TIMEOUT_MS);
            return fingerprintFileBounded(path, size, operationSignal);
        },
    );
}
