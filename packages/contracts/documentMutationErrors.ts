import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { isRecord } from '@contracts/runtimeGuards';
import {
    decodeSerializableErrorEnvelope,
    SERIALIZABLE_ERROR_ENVELOPE_SCHEMA,
} from '@contracts/serializableError';
import * as v from 'valibot';

export const DOCUMENT_MUTATION_ERROR_PREFIX = 'EVB_DOCUMENT_MUTATION_ERROR:';

const DOCUMENT_MUTATION_ERROR_CODES = [
    'MISSING_REVISION',
    'STALE_REVISION',
    'WORKING_COPY_SYNC_REQUIRED',
] as const;

export type TDocumentMutationErrorCode = typeof DOCUMENT_MUTATION_ERROR_CODES[number];

const documentMutationErrorDetailsInputSchema = v.object({
    documentRef: v.optional(v.unknown()),
    expectedRevision: v.optional(v.unknown()),
    actualRevision: v.optional(v.unknown()),
});

const documentMutationErrorDetailsSchema = v.pipe(
    documentMutationErrorDetailsInputSchema,
    // Branded document references and revisions keep their canonical parsers.
    v.transform(details => {
        const documentRef = parseDocumentRef(details.documentRef);
        const expectedRevision = details.expectedRevision === null
            ? null
            : parseDocumentRevisionToken(details.expectedRevision);
        const actualRevision = details.actualRevision === null
            ? null
            : parseDocumentRevisionToken(details.actualRevision);
        return {
            ...(documentRef === null ? {} : {documentRef}),
            ...(expectedRevision !== null || details.expectedRevision === null ? {expectedRevision} : {}),
            ...(actualRevision !== null || details.actualRevision === null ? {actualRevision} : {}),
        };
    }),
);

const documentMutationErrorEnvelopeSchema = v.pipe(
    v.object({
        ...SERIALIZABLE_ERROR_ENVELOPE_SCHEMA.entries,
        code: v.picklist(DOCUMENT_MUTATION_ERROR_CODES),
        details: v.optional(documentMutationErrorDetailsSchema),
    }),
    v.transform(envelope => ({
        ...envelope,
        message: envelope.message.length > 0
            ? envelope.message
            : getDefaultDocumentMutationErrorMessage(envelope.code),
    })),
);

export type IDocumentMutationErrorPayload = v.InferOutput<typeof documentMutationErrorEnvelopeSchema>;

export class DocumentMutationError extends Error {
    readonly code: TDocumentMutationErrorCode;
    readonly documentRef: TDocumentRef | undefined;
    readonly expectedRevision: TDocumentRevisionToken | null | undefined;
    readonly actualRevision: TDocumentRevisionToken | null | undefined;

    constructor(payload: IDocumentMutationErrorPayload) {
        super(encodeDocumentMutationError(payload));
        this.name = 'DocumentMutationError';
        this.code = payload.code;
        this.documentRef = payload.details?.documentRef;
        this.expectedRevision = payload.details?.expectedRevision;
        this.actualRevision = payload.details?.actualRevision;
    }
}

export function encodeDocumentMutationError(payload: IDocumentMutationErrorPayload) {
    return `${DOCUMENT_MUTATION_ERROR_PREFIX}${JSON.stringify(payload)}`;
}

function parseDocumentMutationError(value: unknown): IDocumentMutationErrorPayload | null {
    const result = v.safeParse(documentMutationErrorEnvelopeSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

function decodeDocumentMutationErrorMessage(message: string): IDocumentMutationErrorPayload | null {
    const markerIndex = message.indexOf(DOCUMENT_MUTATION_ERROR_PREFIX);
    if (markerIndex < 0) {
        return null;
    }
    return decodeSerializableErrorEnvelope(
        message.slice(markerIndex + DOCUMENT_MUTATION_ERROR_PREFIX.length),
        documentMutationErrorEnvelopeSchema,
        {allowBareJsonString: true},
    );
}

function documentMutationErrorDetails(error: Record<string, unknown>) {
    return {
        ...(error.documentRef === undefined ? {} : {documentRef: error.documentRef}),
        ...(error.expectedRevision === undefined ? {} : {expectedRevision: error.expectedRevision}),
        ...(error.actualRevision === undefined ? {} : {actualRevision: error.actualRevision}),
    };
}

export function getDocumentMutationErrorPayload(error: unknown): IDocumentMutationErrorPayload | null {
    if (error instanceof DocumentMutationError) {
        const details = {
            ...(error.documentRef === undefined ? {} : {documentRef: error.documentRef}),
            ...(error.expectedRevision === undefined ? {} : {expectedRevision: error.expectedRevision}),
            ...(error.actualRevision === undefined ? {} : {actualRevision: error.actualRevision}),
        };
        return decodeDocumentMutationErrorMessage(error.message) ?? parseDocumentMutationError({
            code: error.code,
            message: getDefaultDocumentMutationErrorMessage(error.code),
            ...(Object.keys(details).length === 0 ? {} : {details}),
        });
    }
    if (isRecord(error)) {
        const legacyDetails = error.details === undefined ? documentMutationErrorDetails(error) : null;
        const envelope = parseDocumentMutationError(legacyDetails === null
            ? error
            : {
                ...error,
                ...(Object.keys(legacyDetails).length === 0 ? {} : {details: legacyDetails}),
            });
        if (envelope) {
            return envelope;
        }
        const causePayload = getDocumentMutationErrorPayload(error.cause);
        if (causePayload) {
            return causePayload;
        }
    }
    return decodeDocumentMutationErrorMessage(getErrorMessage(error));
}

export function isDocumentMutationErrorCode(error: unknown, code: TDocumentMutationErrorCode) {
    return getDocumentMutationErrorPayload(error)?.code === code;
}

function getDefaultDocumentMutationErrorMessage(code: TDocumentMutationErrorCode) {
    if (code === 'MISSING_REVISION') {
        return 'Document revision token is required';
    }
    if (code === 'STALE_REVISION') {
        return 'Document revision is stale';
    }
    return 'Working copy must be resynced before further edits';
}

export function isMissingRevisionError(error: unknown) {
    return isDocumentMutationErrorCode(error, 'MISSING_REVISION');
}

export function isStaleRevisionError(error: unknown) {
    return isDocumentMutationErrorCode(error, 'STALE_REVISION');
}

export function isWorkingCopySyncRequiredError(error: unknown) {
    return isDocumentMutationErrorCode(error, 'WORKING_COPY_SYNC_REQUIRED');
}

export function createStaleRevisionError(payload: {
    documentRef?: TDocumentRef;
    expectedRevision?: TDocumentRevisionToken | null;
    actualRevision?: TDocumentRevisionToken | null;
    message?: string;
}) {
    const details = {
        ...(payload.documentRef === undefined ? {} : {documentRef: payload.documentRef}),
        ...(payload.expectedRevision === undefined ? {} : {expectedRevision: payload.expectedRevision}),
        ...(payload.actualRevision === undefined ? {} : {actualRevision: payload.actualRevision}),
    };
    return new DocumentMutationError({
        code: 'STALE_REVISION',
        message: payload.message ?? 'Document changed while this edit was being prepared',
        ...(Object.keys(details).length === 0 ? {} : {details}),
    });
}

export function createMissingRevisionError(payload: {
    documentRef?: TDocumentRef;
    message?: string;
}) {
    return new DocumentMutationError({
        code: 'MISSING_REVISION',
        message: payload.message ?? 'Document revision token is required',
        ...(payload.documentRef === undefined ? {} : {details: {documentRef: payload.documentRef}}),
    });
}

export function createWorkingCopySyncRequiredError(payload: {
    documentRef?: TDocumentRef;
    message?: string;
}) {
    return new DocumentMutationError({
        code: 'WORKING_COPY_SYNC_REQUIRED',
        message: payload.message ?? 'Working copy must be resynced before further edits',
        ...(payload.documentRef === undefined ? {} : {details: {documentRef: payload.documentRef}}),
    });
}
