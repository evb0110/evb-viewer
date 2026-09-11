import { getErrorMessage } from '@electron/utils/error';
import {
    open,
    stat,
} from 'node:fs/promises';
import {
    decodeDocumentSaveUtilityRequest,
    getDocumentSaveUtilityReusePlan,
    type TDocumentSaveUtilityResult,
} from '@electron/features/documents/main/documentSaveUtilityProtocol';
import {fingerprintFileBounded} from '@electron/features/documents/main/fingerprintFileBounded';
import {validateTargetedPdfObjects} from '@electron/features/documents/main/validateTargetedPdfObjects';
import {atomicReplace} from '@electron/utils/atomicReplace';
import {
    cancelNativeCommandGroupAndWait,
    runNativeCommand,
} from '@electron/native-tools/runNativeCommand';

interface IUtilityParentPort {
    on(eventName: string, listener: (event: {data: unknown}) => void): unknown;
    postMessage(value: unknown): void;
}

function isUtilityParentPort(value: unknown): value is IUtilityParentPort {
    return typeof value === 'object'
        && value !== null
        && 'on' in value
        && typeof value.on === 'function'
        && 'postMessage' in value
        && typeof value.postMessage === 'function';
}

const rawParentPort: unknown = process.parentPort;
if (!isUtilityParentPort(rawParentPort)) {
    throw new Error('Document save utility started without a parent port');
}
const utilityParentPort = rawParentPort;

async function inspectPdf(
    path: string,
    expectedBytes: number,
    options: {
        sha256?: string;
        tailCheck?: boolean;
    } = {},
) {
    const fingerprint = options.sha256 === undefined
        ? await fingerprintFileBounded(path, expectedBytes)
        : {
            bytes: expectedBytes,
            sha256: options.sha256,
        };
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size !== expectedBytes) {
        throw new Error('PDF save staging file size changed after receipt validation');
    }
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(5);
        await handle.read(header, 0, header.length, 0);
        if (header.toString('ascii') !== '%PDF-') throw new Error('PDF save staging file has an invalid header');
        if (options.tailCheck !== true) {
            const tailBytes = Math.min(fingerprint.bytes, 64 * 1024);
            const tail = Buffer.alloc(tailBytes);
            await handle.read(tail, 0, tailBytes, fingerprint.bytes - tailBytes);
            if (!tail.includes(Buffer.from('%%EOF'))) throw new Error('PDF save staging file has no end-of-file marker');
        }
    } finally { await handle.close(); }
    return fingerprint;
}

let validationSequence = 0;
const activeValidationGroups = new Set<string>();

let shutdownInFlight: Promise<boolean> | null = null;
let shutdownRequested = false;

function cancelActiveValidationGroupsAndWait() {
    if (shutdownInFlight) {
        return shutdownInFlight;
    }
    const attempt = Promise.all(
        [...activeValidationGroups].map(cancelGroup => cancelNativeCommandGroupAndWait(cancelGroup)),
    ).then(results => results.every(Boolean));
    shutdownInFlight = attempt;
    void attempt.then(terminated => {
        if (!terminated && shutdownInFlight === attempt) {
            shutdownInFlight = null;
        }
    });
    return attempt;
}

process.once('SIGTERM', () => {
    const exitTimer = setTimeout(() => process.exit(143), 5_000);
    exitTimer.unref();
    void cancelActiveValidationGroupsAndWait().finally(() => {
        clearTimeout(exitTimer);
        // `once` already restored the default disposition, so re-raising ends the
        // process by the signal itself. Chromium then reports the app's own
        // teardown as `killed`; exit(143) surfaced as `abnormal-exit` and raised
        // an error report after every successful fingerprint and save.
        process.kill(process.pid, 'SIGTERM');
    });
});

async function runValidationCommand(
    validationBinary: string,
    args: string[],
    allowedExitCodes: number[],
) {
    const cancelGroup = `document-save-utility:${process.pid}:${validationSequence++}`;
    activeValidationGroups.add(cancelGroup);
    try {
        return await runNativeCommand(validationBinary, args, {
            allowedExitCodes,
            cancelGroup,
            timeoutMs: 5 * 60_000,
            maxStdoutBytes: 4 * 1024 * 1024,
            maxStderrBytes: 4 * 1024 * 1024,
            windowsHide: true,
        });
    } finally {
        activeValidationGroups.delete(cancelGroup);
    }
}

async function validatePdf(path: string, validationBinary?: string) {
    if (!validationBinary) {
        return;
    }
    try {
        const result = await runValidationCommand(validationBinary, [
            '--check',
            path,
        ], [
            0,
            3,
        ]);
        if (result.exitCode === 3) {
            return;
        }
    } catch (error) {
        const exitCode: unknown = (error as {code?: unknown}).code;
        if (exitCode !== 3 && exitCode !== '3') {
            throw new Error(`PDF save staging file failed qpdf validation: ${getErrorMessage(error)}`);
        }
    }
}

utilityParentPort.on('message', (event) => {
    if (
        typeof event.data === 'object'
        && event.data !== null
        && 'type' in event.data
        && event.data.type === 'shutdown'
        && 'requestId' in event.data
        && typeof event.data.requestId === 'string'
        && event.data.requestId.length > 0
    ) {
        shutdownRequested = true;
        const requestId = event.data.requestId;
        void cancelActiveValidationGroupsAndWait().then(terminated => {
            utilityParentPort.postMessage({
                type: 'shutdown-complete',
                requestId,
                terminated,
            });
        });
        return;
    }
    void (async () => {
        const request = decodeDocumentSaveUtilityRequest(event.data);
        if (!request) throw new Error('Invalid document save utility request');
        if (shutdownRequested) throw new Error('Document save utility is shutting down');
        if (request.type === 'inspect') {
            const inspection = await fingerprintFileBounded(request.sourcePath, request.expectedBytes);
            const result: TDocumentSaveUtilityResult = {
                type: 'result',
                ok: true,
                ...inspection,
            };
            utilityParentPort.postMessage(result);
            return;
        }
        const reuse = getDocumentSaveUtilityReusePlan(request);
        let receiptSha256: string | undefined;
        if (reuse.fingerprint) {
            if (
                request.stagedArtifact === undefined
                || request.stagedArtifact.receiptVersion !== 1
            ) {
                throw new Error('Document save receipt reuse was enabled without an artifact');
            }
            receiptSha256 = request.stagedArtifact.sha256;
        }
        const inspection = await inspectPdf(request.sourcePath, request.expectedBytes, {
            ...(receiptSha256 === undefined ? {} : {sha256: receiptSha256}),
            ...(reuse.tailCheck ? {tailCheck: true} : {}),
        });
        if (!reuse.qpdfCheck && !reuse.nativeIncrementalCheck) {
            await validatePdf(request.sourcePath, request.validationBinary);
        }
        const changedObjectRefs = request.changedObjectRefs ?? [];
        if (
            changedObjectRefs.length > 0
            && !reuse.changedObjectRefsCheck
            && request.validationBinary
        ) {
            await validateTargetedPdfObjects(
                request.sourcePath,
                request.validationBinary,
                changedObjectRefs,
            );
        }
        if (request.validateOnly !== true) {
            await atomicReplace(request.sourcePath, request.targetPath, {durable: reuse.fileSync !== true});
        }
        const result: TDocumentSaveUtilityResult = {
            type: 'result',
            ok: true,
            ...inspection,
        };
        utilityParentPort.postMessage(result);
    })().catch((error: unknown) => {
        const result: TDocumentSaveUtilityResult = {
            type: 'result',
            ok: false,
            error: error instanceof Error ? getErrorMessage(error) : 'Document save utility failed',
        };
        utilityParentPort.postMessage(result);
    });
});
