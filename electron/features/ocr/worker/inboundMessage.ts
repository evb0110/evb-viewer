import { isRecord } from '@contracts/runtimeGuards';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionAuthority,
} from '@contracts/documentRevision';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import {parseDocumentRef} from '@contracts/documentRef';
import {parseEpochMs} from '@contracts/timestamps';
import {
    parseJobId,
    type TJobId,
    type TRequestId,
} from '@contracts/shared';
import type {
    IOcrWorkerStartPayload,
    TOcrWorkerInboundMessage,
} from '@electron/ocr/worker/types';
import {
    OcrPayloadValidationError,
    validateCancelRequestId,
    validateCreateSearchablePdfPayload,
} from '@electron/features/ocr/contracts';

const DOCUMENT_REVISION_AUTHORITIES: ReadonlySet<TDocumentRevisionAuthority> = new Set([
    'browser-document-store',
    'electron-working-copy',
]);

function parseDocumentRevisionInfo(value: unknown): IDocumentRevisionInfo | null {
    const authority = isRecord(value) ? value.authority : undefined;
    const token = isRecord(value) ? parseDocumentRevisionToken(value.token) : null;
    const documentRef = isRecord(value) ? parseDocumentRef(value.documentRef) : null;
    const mintedAt = isRecord(value) ? parseEpochMs(value.mintedAt) : null;
    if (
        !isRecord(value)
        || value.version !== 1
        || documentRef === null
        || typeof authority !== 'string'
        || !DOCUMENT_REVISION_AUTHORITIES.has(authority as TDocumentRevisionAuthority)
        || token === null
        || typeof value.contentRevision !== 'number'
        || !Number.isSafeInteger(value.contentRevision)
        || value.contentRevision < 1
        || mintedAt === null
    ) {
        return null;
    }

    return {
        version: 1,
        documentRef,
        authority: authority as TDocumentRevisionAuthority,
        token,
        contentRevision: value.contentRevision,
        mintedAt,
    };
}

export function parseOcrWorkerStartPayload(value: unknown): IOcrWorkerStartPayload | null {
    if (!isRecord(value)) {
        return null;
    }

    try {
        const documentRevision = parseDocumentRevisionInfo(value.documentRevision);
        if (!documentRevision) {
            return null;
        }
        const validated = validateCreateSearchablePdfPayload(
            value.sourcePdfPath,
            value.pages,
            'worker-start',
            value.options ?? value.renderDpi,
        );
        const payload: IOcrWorkerStartPayload = {
            sourcePdfPath: validated.sourcePdfPath,
            documentRevision,
            pages: validated.pages,
        };
        if (validated.options.renderDpi !== undefined) {
            payload.renderDpi = validated.options.renderDpi;
        }
        if (isRecord(value.options)) {
            payload.options = validated.options;
        }
        return payload;
    } catch (error) {
        if (error instanceof OcrPayloadValidationError) {
            return null;
        }
        throw error;
    }
}

function parseValidatedRequestId(value: unknown): TRequestId | null {
    try {
        return validateCancelRequestId(value);
    } catch (error) {
        if (error instanceof OcrPayloadValidationError) {
            return null;
        }
        throw error;
    }
}

function parseResourceAcquiredDpi(value: unknown) {
    if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || !Number.isInteger(value)
        || value < 1
    ) {
        return null;
    }
    return value;
}

function isValidWorkerId(value: unknown) {
    if (typeof value !== 'string') {
        return false;
    }
    try {
        validateCreateSearchablePdfPayload(
            '/worker-control-placeholder.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            value,
            180,
        );
        return true;
    } catch (error) {
        if (error instanceof OcrPayloadValidationError) {
            return false;
        }
        throw error;
    }
}

function parseValidatedWorkerId(value: unknown): TJobId | null {
    if (!isValidWorkerId(value)) {
        return null;
    }
    return parseJobId(value);
}

export function parseOcrWorkerInboundMessage(value: unknown): TOcrWorkerInboundMessage | null {
    if (!isRecord(value)) {
        return null;
    }
    const jobId = parseValidatedWorkerId(value.jobId);
    if (jobId === null) {
        return null;
    }

    if (value.type === 'cancel') {
        return {
            type: 'cancel',
            jobId,
        };
    }

    if (value.type === 'resource-acquired') {
        const effectiveDpi = parseResourceAcquiredDpi(value.effectiveDpi);
        const requestId = parseValidatedRequestId(value.requestId);
        if (
            requestId === null
            || typeof value.token !== 'string'
            || effectiveDpi === null
        ) {
            return null;
        }
        const token = value.token;
        return {
            type: 'resource-acquired',
            jobId,
            requestId,
            token,
            effectiveDpi,
        };
    }

    if (value.type === 'resource-denied') {
        const requestId = parseValidatedRequestId(value.requestId);
        if (
            requestId === null
            || typeof value.reason !== 'string'
            || value.reason.trim().length === 0
        ) {
            return null;
        }
        return {
            type: 'resource-denied',
            jobId,
            requestId,
            reason: value.reason,
        };
    }

    if (value.type !== 'start') {
        return null;
    }

    const data = parseOcrWorkerStartPayload(value.data);
    if (!data) {
        return null;
    }

    return {
        type: 'start',
        jobId,
        data,
    };
}

export function parseInvalidOcrWorkerStartMessage(value: unknown) {
    if (!isRecord(value) || value.type !== 'start') {
        return null;
    }
    const jobId = parseValidatedWorkerId(value.jobId);
    if (jobId === null) {
        return null;
    }

    if (parseOcrWorkerStartPayload(value.data) !== null) {
        return null;
    }

    return {
        jobId,
        error: 'Invalid OCR worker start payload',
    };
}
