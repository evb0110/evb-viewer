import type { TOcrWorkerOutboundMessage } from '@electron/ocr/worker/types';
import type {
    IOcrDiagnostic,
    IOcrErrorEnvelope,
} from '@contracts/electronApiOcr';
import {
    OCR_DIAGNOSTIC_CODES,
    OCR_ERROR_CODES,
    OCR_PROGRESS_PHASES,
} from '@contracts/electronApiOcr';
import { isAbortError } from '@electron/utils/abort';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import {
    parseJobId,
    parseRequestId,
    requireJobId,
    type TRequestId,
} from '@contracts/shared';
import {parseDocumentRef} from '@contracts/documentRef';
import {parseEpochMs} from '@contracts/timestamps';
import { requirePageNumber } from '@contracts/pageNumbers';

export { isAbortError };

function parseOptionalProgressPhase(value: unknown) {
    return isOneOf(OCR_PROGRESS_PHASES, value)
        ? value
        : undefined;
}

export function createTimeoutError(message: string) {
    const error = new Error(message);
    error.name = 'TimeoutError';
    return error;
}

export function toScopedOcrJobId(webContentsId: number, requestId: TRequestId) {
    return requireJobId(`${webContentsId}:${requestId}`);
}

export type TOcrWorkerManagerMessage = Exclude<
    TOcrWorkerOutboundMessage,
    { type: 'resource-acquire' } | { type: 'resource-release' }
>;

function parseWorkerLogMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    if (
        (message.level === 'debug' || message.level === 'warn' || message.level === 'error')
        && typeof message.message === 'string'
    ) {
        return {
            type: 'log',
            level: message.level,
            message: message.message,
        };
    }
    return null;
}

function parseWorkerProgressMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    const progress = message.progress;
    const jobId = parseJobId(message.jobId);
    const requestId = isRecord(progress) ? parseRequestId(progress.requestId) : null;
    if (!isRecord(progress) || jobId === null || requestId === null) {
        return null;
    }

    if (
        !isFiniteNumber(progress.currentPage)
        || !isFiniteNumber(progress.processedCount)
        || !isFiniteNumber(progress.totalPages)
    ) {
        return null;
    }

    const parsedProgress: TOcrWorkerManagerMessage = {
        type: 'progress',
        jobId,
        progress: {
            requestId,
            currentPage: progress.currentPage,
            processedCount: progress.processedCount,
            totalPages: progress.totalPages,
        },
    };
    const phase = parseOptionalProgressPhase(progress.phase);
    if (phase !== undefined) {
        parsedProgress.progress.phase = phase;
    }
    if (isFiniteNumber(progress.phaseProgress)) {
        parsedProgress.progress.phaseProgress = progress.phaseProgress;
    }
    return parsedProgress;
}

function parseSuccessfulCompleteResult(
    result: Record<string, unknown>,
    errors: string[],
    diagnostics: IOcrDiagnostic[] | undefined,
) {
    const normalizedPdfPath = typeof result.pdfPath === 'string'
        ? result.pdfPath.trim()
        : '';
    const sourceDocumentRevisionToken = parseDocumentRevisionToken(result.sourceDocumentRevisionToken);
    const pdfPath = parseDocumentRef(normalizedPdfPath);
    const resultSha256 = typeof result.resultSha256 === 'string' && /^[a-f0-9]{64}$/u.test(result.resultSha256)
        ? result.resultSha256
        : null;
    if (
        pdfPath === null
        || sourceDocumentRevisionToken === null
        || resultSha256 === null
        || typeof result.requiresCleanupAck !== 'boolean'
    ) {
        return null;
    }

    return {
        success: true as const,
        pdfPath,
        sourceDocumentRevisionToken,
        resultSha256,
        requiresCleanupAck: result.requiresCleanupAck,
        errors,
        ...(diagnostics === undefined ? {} : {diagnostics}),
    };
}

function parseOcrErrorEnvelope(value: unknown): IOcrErrorEnvelope | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const timestamp = parseEpochMs(value.timestamp);
    if (
        !isOneOf(OCR_ERROR_CODES, value.code)
        || typeof value.message !== 'string'
        || typeof value.retryable !== 'boolean'
        || timestamp === null
    ) {
        return undefined;
    }
    if (value.details !== undefined && typeof value.details !== 'string') {
        return undefined;
    }

    return {
        code: value.code,
        message: value.message,
        retryable: value.retryable,
        timestamp,
        ...(value.details === undefined ? {} : {details: value.details}),
    };
}

function parseOcrDiagnostics(value: unknown): IOcrDiagnostic[] | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        return null;
    }
    const diagnostics: Array<IOcrDiagnostic | null> = value.map((diagnostic) => {
        if (
            !isRecord(diagnostic)
            || !isOneOf(OCR_DIAGNOSTIC_CODES, diagnostic.code)
            || (diagnostic.severity !== 'info' && diagnostic.severity !== 'warning')
            || typeof diagnostic.message !== 'string'
            || (diagnostic.pageNumber !== undefined && (
                typeof diagnostic.pageNumber !== 'number'
                || !Number.isSafeInteger(diagnostic.pageNumber)
                || diagnostic.pageNumber < 1
            ))
        ) {
            return null;
        }
        return {
            code: diagnostic.code,
            severity: diagnostic.severity,
            message: diagnostic.message,
            ...(diagnostic.pageNumber === undefined
                ? {}
                : {pageNumber: requirePageNumber(diagnostic.pageNumber)}),
        };
    });
    return diagnostics.some(diagnostic => diagnostic === null)
        ? null
        : diagnostics.flatMap(diagnostic => diagnostic === null ? [] : [diagnostic]);
}

function parseFailedCompleteResult(
    result: Record<string, unknown>,
    errors: string[],
    diagnostics: IOcrDiagnostic[] | undefined,
) {
    const errorEnvelope = parseOcrErrorEnvelope(result.errorEnvelope);
    return {
        success: false as const,
        errors,
        ...(diagnostics === undefined ? {} : {diagnostics}),
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    };
}

function parseWorkerCompleteResult(result: unknown) {
    if (!isRecord(result) || typeof result.success !== 'boolean') {
        return null;
    }
    const errors = result.errors;
    if (!isStringArray(errors)) {
        return null;
    }
    const diagnostics = parseOcrDiagnostics(result.diagnostics);
    if (diagnostics === null) {
        return null;
    }

    return result.success
        ? parseSuccessfulCompleteResult(result, errors, diagnostics)
        : parseFailedCompleteResult(result, errors, diagnostics);
}

function parseWorkerCompleteMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    const jobId = parseJobId(message.jobId);
    if (jobId === null) {
        return null;
    }

    const result = parseWorkerCompleteResult(message.result);
    return result
        ? {
            type: 'complete',
            jobId,
            result,
        }
        : null;
}

function parseWorkerCleanupCompleteMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    const jobId = parseJobId(message.jobId);
    return jobId !== null
        ? {
            type: 'cleanup-complete',
            jobId,
        }
        : null;
}

function parseNativeChildProcessIdentity(value: unknown) {
    if (!isRecord(value) || !isOneOf([
        'linux-proc-start-time',
        'opaque',
    ] as const, value.kind)) {
        return null;
    }
    const normalizedValue = typeof value.value === 'string' ? value.value.trim() : '';
    return normalizedValue.length > 0
        ? {
            kind: value.kind,
            value: normalizedValue,
        }
        : null;
}

function parseNativeChildId(value: unknown) {
    return parseRequestId(value);
}

function parseNativeChildIntentMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    const jobId = parseJobId(message.jobId);
    const childId = parseNativeChildId(message.childId);
    const commandLabel = typeof message.commandLabel === 'string' ? message.commandLabel.trim() : '';
    return jobId !== null && childId !== null && commandLabel.length > 0
        ? {
            type: 'native-child-intent',
            jobId,
            childId,
            commandLabel,
        }
        : null;
}

function parseNativeChildRegisterMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    const jobId = parseJobId(message.jobId);
    const childId = parseNativeChildId(message.childId);
    const processIdentity = parseNativeChildProcessIdentity(message.processIdentity);
    return jobId !== null
        && childId !== null
        && processIdentity !== null
        && typeof message.pid === 'number'
        && Number.isSafeInteger(message.pid)
        && message.pid > 0
        ? {
            type: 'native-child-register',
            jobId,
            childId,
            pid: message.pid,
            processIdentity,
        }
        : null;
}

function parseNativeChildExitMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    const jobId = parseJobId(message.jobId);
    const childId = parseNativeChildId(message.childId);
    const processIdentity = parseNativeChildProcessIdentity(message.processIdentity);
    return jobId !== null
        && childId !== null
        && processIdentity !== null
        && typeof message.pid === 'number'
        && Number.isSafeInteger(message.pid)
        && message.pid > 0
        ? {
            type: 'native-child-exit',
            jobId,
            childId,
            pid: message.pid,
            processIdentity,
        }
        : null;
}

function parseNativeChildNoSpawnMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    const jobId = parseJobId(message.jobId);
    const childId = parseNativeChildId(message.childId);
    return jobId !== null && childId !== null
        ? {
            type: 'native-child-no-spawn',
            jobId,
            childId,
        }
        : null;
}

function parseNativeChildUnprovenMessage(message: Record<string, unknown>): TOcrWorkerManagerMessage | null {
    const jobId = parseJobId(message.jobId);
    const childId = parseNativeChildId(message.childId);
    const detail = typeof message.detail === 'string' ? message.detail.trim() : '';
    return jobId !== null && childId !== null && detail.length > 0
        ? {
            type: 'native-child-unproven',
            jobId,
            childId,
            detail,
        }
        : null;
}

export function parseWorkerMessage(message: unknown): TOcrWorkerManagerMessage | null {
    if (!isRecord(message) || typeof message.type !== 'string') {
        return null;
    }

    switch (message.type) {
        case 'log':
            return parseWorkerLogMessage(message);
        case 'progress':
            return parseWorkerProgressMessage(message);
        case 'complete':
            return parseWorkerCompleteMessage(message);
        case 'cleanup-complete':
            return parseWorkerCleanupCompleteMessage(message);
        case 'native-child-intent':
            return parseNativeChildIntentMessage(message);
        case 'native-child-register':
            return parseNativeChildRegisterMessage(message);
        case 'native-child-exit':
            return parseNativeChildExitMessage(message);
        case 'native-child-no-spawn':
            return parseNativeChildNoSpawnMessage(message);
        case 'native-child-unproven':
            return parseNativeChildUnprovenMessage(message);
        default:
            return null;
    }
}
