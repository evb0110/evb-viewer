import {createBrandedId, isBrandedString, parseBranded} from '@contracts/brand';
import type {TBrand} from '@contracts/brand';

export type TDocumentInstanceId = TBrand<string, 'DocumentInstanceId'>;

const DOCUMENT_INSTANCE_ID_MAX_LENGTH = 512;

export function isDocumentInstanceId(value: unknown): value is TDocumentInstanceId {
    return isBrandedString<'DocumentInstanceId'>(value, DOCUMENT_INSTANCE_ID_MAX_LENGTH);
}

export function parseDocumentInstanceId(value: unknown): TDocumentInstanceId | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return parseBranded(normalized, isDocumentInstanceId);
}

export function requireDocumentInstanceId(value: unknown): TDocumentInstanceId {
    const parsed = parseDocumentInstanceId(value);
    if (parsed === null) {
        throw new TypeError('Document instance ID must be a non-empty string');
    }
    return parsed;
}

export function createDocumentInstanceId(prefix = 'document'): TDocumentInstanceId {
    return createBrandedId(prefix, isDocumentInstanceId);
}
