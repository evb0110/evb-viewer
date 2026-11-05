import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type { Tagged } from 'type-fest';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    isEpochMs,
    type TEpochMs,
} from '@contracts/timestamps';

export type TDocumentRevisionToken = Tagged<string, 'DocumentRevisionToken'>;
/** Receives a revision the operation itself committed. */
export type TDocumentCommitReceipt = (revision: TDocumentRevisionToken) => void;
export type TDocumentRevisionAuthority = 'electron-working-copy' | 'browser-document-store';

export type TDocumentRevisionChangeReason =
    | 'open'
    | 'write'
    | 'replace-working-copy'
    | 'page-ops'
    | 'ocr-apply'
    | 'save-sync'
    | 'native-mutation'
    | 'browser-handle-refresh'
    | 'unknown';

const DOCUMENT_REVISION_CHANGE_REASONS = [
    'open',
    'write',
    'replace-working-copy',
    'page-ops',
    'ocr-apply',
    'save-sync',
    'native-mutation',
    'browser-handle-refresh',
    'unknown',
] as const satisfies readonly TDocumentRevisionChangeReason[];
const DOCUMENT_REVISION_TOKEN_MAX_LENGTH = 512;
const DOCUMENT_REVISION_REF_MAX_LENGTH = 32_768;

function isDocumentRevisionToken(value: string): value is TDocumentRevisionToken {
    return value.length > 0 && value.length <= DOCUMENT_REVISION_TOKEN_MAX_LENGTH;
}

export function parseDocumentRevisionToken(value: unknown): TDocumentRevisionToken | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return isDocumentRevisionToken(normalized) ? normalized : null;
}

export function requireDocumentRevisionToken(value: unknown): TDocumentRevisionToken {
    const parsed = parseDocumentRevisionToken(value);
    if (parsed === null) {
        throw new TypeError('Document revision token must be a non-empty string');
    }
    return parsed;
}

export interface IDocumentRevisionStamp {readonly token: TDocumentRevisionToken;}

export interface IDocumentRevisionInfo extends IDocumentRevisionStamp {
    readonly version: 1;
    readonly documentRef: TDocumentRef;
    readonly authority: TDocumentRevisionAuthority;
    readonly contentRevision: number;
    readonly mintedAt: TEpochMs;
}

export interface IDocumentRevisionChangedEvent extends IDocumentRevisionInfo {
    readonly previousToken?: TDocumentRevisionToken;
    readonly reason: TDocumentRevisionChangeReason;
}

export function isDocumentRevisionInfo(value: unknown): value is IDocumentRevisionInfo {
    const documentRef = isRecord(value) ? parseDocumentRef(value.documentRef) : null;
    return isRecord(value)
        && value.version === 1
        && parseDocumentRevisionToken(value.token) !== null
        && documentRef !== null
        && documentRef.length > 0
        && documentRef.length <= DOCUMENT_REVISION_REF_MAX_LENGTH
        && (value.authority === 'electron-working-copy' || value.authority === 'browser-document-store')
        && typeof value.contentRevision === 'number'
        && Number.isSafeInteger(value.contentRevision)
        && value.contentRevision >= 0
        && isEpochMs(value.mintedAt)
        && value.mintedAt > 0;
}

export function decodeDocumentRevisionChangedEvent(value: unknown): IDocumentRevisionChangedEvent | null {
    const candidate = isRecord(value) ? value : null;
    const previousToken = candidate?.previousToken === undefined
        ? undefined
        : parseDocumentRevisionToken(candidate.previousToken);
    if (
        candidate === null
        || !isDocumentRevisionInfo(candidate)
        || typeof candidate.reason !== 'string'
        || !isOneOf(DOCUMENT_REVISION_CHANGE_REASONS, candidate.reason)
        || previousToken === null
    ) {
        return null;
    }
    return {
        version: candidate.version,
        token: candidate.token,
        documentRef: candidate.documentRef,
        authority: candidate.authority,
        contentRevision: candidate.contentRevision,
        mintedAt: candidate.mintedAt,
        reason: candidate.reason,
        ...(previousToken === undefined ? {} : {previousToken}),
    };
}
