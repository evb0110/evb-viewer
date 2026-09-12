import { SEARCH_RESULT_LIMIT } from '@electron/config/constants';
import { SEARCH_WIRE_CODEC } from '@contracts/search';
import {
    parseRequestId,
    type TRequestId,
} from '@contracts/shared';
import type {
    ISearchResponse,
    ISearchWorkerShutdownResult,
    TSearchWorkerOutboundMessage,
} from '@electron/features/search/protocol';
import {
    isFiniteWorkerMessageNumber,
    isWorkerMessageRecord,
} from '@electron/utils/workerMessage';

type TSearchMatch = ISearchResponse['results'][number];

const SEARCH_OUTBOUND_RESULT_LIMIT = Math.max(1, SEARCH_RESULT_LIMIT);
const SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS = 4_096;
const SEARCH_OUTBOUND_WORD_LIMIT = 2_048;
const SEARCH_OUTBOUND_WORD_TEXT_MAX_CHARS = 4_096;

function parseNonNegativeWorkerInteger(value: unknown) {
    if (!isFiniteWorkerMessageNumber(value) || !Number.isSafeInteger(value) || value < 0) {
        return null;
    }
    return value;
}

function trimSearchTextSegment(value: string, maxLength: number, fromEnd = false) {
    if (value.length <= maxLength) {
        return {
            value,
            truncated: false,
        };
    }
    return {
        value: fromEnd ? value.slice(-maxLength) : value.slice(0, maxLength),
        truncated: true,
    };
}

function capSearchMatch(match: TSearchMatch) {
    let truncated = false;
    const before = trimSearchTextSegment(match.excerpt.before, SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS, true);
    const matchedText = trimSearchTextSegment(match.excerpt.match, SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS);
    const after = trimSearchTextSegment(match.excerpt.after, SEARCH_OUTBOUND_EXCERPT_TEXT_MAX_CHARS);
    truncated = before.truncated || matchedText.truncated || after.truncated;

    let words = match.words;
    if (words !== undefined) {
        if (words.length > SEARCH_OUTBOUND_WORD_LIMIT) {
            words = words.slice(0, SEARCH_OUTBOUND_WORD_LIMIT);
            truncated = true;
        }
        words = words.map((word) => {
            if (word.text.length <= SEARCH_OUTBOUND_WORD_TEXT_MAX_CHARS) {
                return word;
            }
            truncated = true;
            return {
                ...word,
                text: word.text.slice(0, SEARCH_OUTBOUND_WORD_TEXT_MAX_CHARS),
            };
        });
    }

    return {
        match: {
            ...match,
            excerpt: {
                prefix: match.excerpt.prefix || before.truncated,
                suffix: match.excerpt.suffix || after.truncated || matchedText.truncated,
                before: before.value,
                match: matchedText.value,
                after: after.value,
            },
            ...(words === undefined ? {} : {words}),
        } satisfies TSearchMatch,
        truncated,
    };
}

export function capSearchResponse(
    response: ISearchResponse,
    maxResults = SEARCH_OUTBOUND_RESULT_LIMIT,
): ISearchResponse {
    let truncated = response.truncated || response.results.length > maxResults;
    const results: TSearchMatch[] = [];
    for (const result of response.results.slice(0, maxResults)) {
        const capped = capSearchMatch(result);
        results.push(capped.match);
        truncated = truncated || capped.truncated;
    }
    return {
        results,
        truncated,
        ...(response.canceled === undefined ? {} : {canceled: response.canceled}),
    };
}

function parseSearchMatch(value: unknown, pageCount?: number) {
    return SEARCH_WIRE_CODEC.decodeResult(value, pageCount);
}

function parseSearchResponse(value: unknown, pageCount?: number) {
    if (!isWorkerMessageRecord(value) || !Array.isArray(value.results) || typeof value.truncated !== 'boolean') {
        return null;
    }
    if (value.canceled !== undefined && typeof value.canceled !== 'boolean') {
        return null;
    }
    const results: TSearchMatch[] = [];
    for (const result of value.results) {
        const parsedResult = parseSearchMatch(result, pageCount);
        if (!parsedResult) {
            return null;
        }
        results.push(parsedResult);
    }
    return capSearchResponse({
        results,
        truncated: value.truncated,
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
    });
}

export function parseSearchWorkerOutboundMessage(
    value: unknown,
    resolvePageCount: (requestId: TRequestId) => number | undefined,
): TSearchWorkerOutboundMessage | null {
    if (!isWorkerMessageRecord(value) || typeof value.type !== 'string') {
        return null;
    }
    const requestId = parseRequestId(value.requestId);
    if (requestId === null) {
        return null;
    }
    const pageCount = resolvePageCount(requestId);
    switch (value.type) {
        case 'progress': {
            if (
                !isFiniteWorkerMessageNumber(value.processed)
                || !isFiniteWorkerMessageNumber(value.total)
                || value.processed < 0
                || value.total < 0
                || (value.results !== undefined && !Array.isArray(value.results))
            ) {
                return null;
            }
            const parsedResultsStartIndex = value.resultsStartIndex === undefined
                ? undefined
                : parseNonNegativeWorkerInteger(value.resultsStartIndex);
            if (parsedResultsStartIndex === null) {
                return null;
            }
            const resultsStartIndex = parsedResultsStartIndex;
            if (value.truncated !== undefined && typeof value.truncated !== 'boolean') {
                return null;
            }
            if (value.canceled !== undefined && typeof value.canceled !== 'boolean') {
                return null;
            }
            if (Array.isArray(value.results)) {
                const results: TSearchMatch[] = [];
                for (const result of value.results) {
                    const parsedResult = parseSearchMatch(result, pageCount);
                    if (!parsedResult) {
                        return null;
                    }
                    results.push(parsedResult);
                }
                const maxResults = resultsStartIndex === undefined
                    ? SEARCH_OUTBOUND_RESULT_LIMIT
                    : Math.max(0, SEARCH_OUTBOUND_RESULT_LIMIT - resultsStartIndex);
                const cappedResponse = capSearchResponse({
                    results,
                    truncated: Boolean(value.truncated),
                    ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
                }, maxResults);
                return {
                    type: 'progress',
                    requestId,
                    processed: value.processed,
                    total: value.total,
                    results: cappedResponse.results,
                    ...(resultsStartIndex === undefined ? {} : {resultsStartIndex}),
                    truncated: cappedResponse.truncated,
                    ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
                };
            }
            return {
                type: 'progress',
                requestId,
                processed: value.processed,
                total: value.total,
                ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
            };
        }
        case 'complete': {
            const response = parseSearchResponse(value.response, pageCount);
            return response ? {
                type: 'complete',
                requestId,
                response,
            } : null;
        }
        case 'matching-started':
            return {
                type: 'matching-started',
                requestId,
            };
        case 'cancelled':
            return {
                type: 'cancelled',
                requestId,
            };
        case 'error':
            if (typeof value.error !== 'string') {
                return null;
            }
            return {
                type: 'error',
                requestId,
                error: value.error,
                ...(value.errorCode === 'SEARCH_REGEX_LIMIT' ? {errorCode: value.errorCode} : {}),
            };
        default:
            return null;
    }
}

export function getSearchWorkerOutboundRequestId(value: unknown) {
    return isWorkerMessageRecord(value) ? parseRequestId(value.requestId) : null;
}

export function parseSearchWorkerShutdownResult(value: unknown): ISearchWorkerShutdownResult | null {
    if (!isWorkerMessageRecord(value) || value.type !== 'shutdown-complete') {
        return null;
    }
    if (value.error !== undefined && (typeof value.error !== 'string' || value.error.trim().length === 0)) {
        return null;
    }
    return {
        type: 'shutdown-complete',
        ...(typeof value.error === 'string' ? {error: value.error} : {}),
    };
}
