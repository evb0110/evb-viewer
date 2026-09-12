import type {
    ISearchErrorEnvelope,
    ISearchErrorEnvelopeCarrier,
    TSearchErrorCode,
} from '@contracts/search';
import {createEpochMs} from '@contracts/timestamps';
import { getErrorMessage } from '@electron/utils/error';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import {encodeSerializableErrorEnvelope} from '@contracts/serializableError';

const SEARCH_ERROR_DETAILS_MAX_LENGTH = 1_000;

function trimSearchErrorDetails(details: string) {
    const trimmed = details.trim();
    if (trimmed.length <= SEARCH_ERROR_DETAILS_MAX_LENGTH) {
        return trimmed;
    }
    return `${trimmed.slice(0, SEARCH_ERROR_DETAILS_MAX_LENGTH - 3)}...`;
}

export class SearchIpcError extends Error implements ISearchErrorEnvelopeCarrier {
    readonly errorEnvelope: ISearchErrorEnvelope;
    readonly code: TSearchErrorCode;
    readonly subsystem = 'search';

    constructor(envelope: ISearchErrorEnvelope) {
        super(encodeSerializableErrorEnvelope(envelope));
        this.name = 'SearchIpcError';
        this.errorEnvelope = envelope;
        this.code = envelope.code;
    }
}

export function buildSearchErrorEnvelope(
    code: TSearchErrorCode,
    message: string,
    options: {
        retryable?: boolean;
        details?: string;
    } = {},
): ISearchErrorEnvelope {
    return {
        code,
        message,
        retryable: options.retryable ?? false,
        timestamp: createEpochMs(),
        ...(options.details ? {details: trimSearchErrorDetails(options.details)} : {}),
    };
}

export function toSearchIpcError(
    error: unknown,
    fallbackCode: TSearchErrorCode = 'SEARCH_INTERNAL',
    retryable = false,
) {
    if (error instanceof SearchIpcError) {
        return error;
    }
    if (hasNativeErrorCode(error)) {
        const code: TSearchErrorCode = error.code === 'invalid-request'
            ? 'SEARCH_INVALID_PAYLOAD'
            : error.code === 'too-large'
                ? 'SEARCH_WORKER_LIMIT'
                : 'SEARCH_WORKER_ERROR';
        return new SearchIpcError(buildSearchErrorEnvelope(
            code,
            getErrorMessage(error) || 'Native search failed',
            {retryable: error.code === 'io' || error.code === 'native-failure'},
        ));
    }
    return new SearchIpcError(buildSearchErrorEnvelope(
        fallbackCode,
        getErrorMessage(error) || 'Search failed',
        {retryable},
    ));
}
