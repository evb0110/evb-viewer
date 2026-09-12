import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import {parseRequestId} from '@contracts/shared';
import type {
    ISearchWorkerRequest,
    TSearchWorkerInboundMessage,
} from '@electron/features/search/protocol';
import {isWorkerMessageRecord} from '@electron/utils/workerMessage';
import {normalizePdfSearchRequestPayload} from '@electron/features/search/searchRequestPayload';

function parseSearchWorkerRequest(value: unknown): ISearchWorkerRequest | null {
    if (!isWorkerMessageRecord(value)) {
        return null;
    }
    const requestId = parseRequestId(value.requestId);
    const documentRevision = parseDocumentRevisionToken(value.documentRevision);
    if (requestId === null || documentRevision === null) {
        return null;
    }
    if (
        (value.matchCase !== undefined && typeof value.matchCase !== 'boolean')
        || (value.wholeWord !== undefined && typeof value.wholeWord !== 'boolean')
        || (value.useRegex !== undefined && typeof value.useRegex !== 'boolean')
        || (value.warmup !== undefined && typeof value.warmup !== 'boolean')
        || (value.regexBudgetMs !== undefined && (
            typeof value.regexBudgetMs !== 'number'
            || !Number.isFinite(value.regexBudgetMs)
            || value.regexBudgetMs < 0
        ))
    ) {
        return null;
    }
    try {
        const normalized = normalizePdfSearchRequestPayload({
            ...value,
            requestId,
        });
        const warmup = value.warmup;
        return {
            ...normalized,
            requestId,
            documentRevision,
            ...(warmup === undefined ? {} : {warmup}),
            ...(value.regexBudgetMs === undefined ? {} : {regexBudgetMs: value.regexBudgetMs}),
        };
    } catch {
        return null;
    }
}

export function parseSearchWorkerInboundMessage(value: unknown): TSearchWorkerInboundMessage | null {
    if (!isWorkerMessageRecord(value) || typeof value.type !== 'string') {
        return null;
    }
    switch (value.type) {
        case 'cancel':
        {
            const requestId = parseRequestId(value.requestId);
            return requestId === null
                ? null
                : {
                    type: 'cancel',
                    requestId,
                };
        }
        case 'reset-cache':
            return {type: 'reset-cache'};
        case 'reset-state':
            return {type: 'reset-state'};
        case 'shutdown':
            return typeof value.reason === 'string' && value.reason.trim().length > 0
                ? {
                    type: 'shutdown',
                    reason: value.reason,
                }
                : null;
        case 'search': {
            const payload = parseSearchWorkerRequest(value.payload);
            return payload
                ? {
                    type: 'search',
                    payload,
                }
                : null;
        }
        default:
            return null;
    }
}
